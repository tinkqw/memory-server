#!/usr/bin/env node
// memory-consolidate CLI — consolidation 后台 job 的 dry-run 扫描器。
//
// 扫 active observation，直接对 embedding 算两两 cosine 相似度，
// 并查集聚类，产出两类候选清单（绝不 mutate）：
//   - 去重候选：近重复 obs 簇（同一条规则说了多遍）→ 人审后合并 update 链
//   - 升核心候选：跨 ≥2 主题、≥N 成员的主题簇（疑似跨场景不变量）→ 人审过「三关」后升 memory-resident.md
//
// 设计原则（遵 RFC v2 §二 + distill SKILL）：
//   - DRY-RUN：只读 + 出清单。合并/升核心/退役全部由人在对话里审批执行，本 CLI 不动库。
//     （RFC 把去重定为"全自动"，但 v1 先 dry-run 出清单人审；阈值在真实数据上校准、跑稳两轮后再开自动合并。）
//   - 相似度必须用**原始 cosine**，不能用 store.searchMemory 的 score。
//     2026-08-08 修：原实现拿 searchMemory 的 score 比固定阈值 0.72，连续 10 次周跑全 0（obs 52→269 一路 dedup=0）。
//     根因是 score 不是相似度而是结果集内的 min-max 相对排序分（store.ts hybrid 归一化），
//     而 query 就是这条记忆自己的 title+summary → self 必然命中第一名、把归一化分母锚死，
//     真邻居被压到 0.25–0.67（实测 25 条抽样，最好的非 self 邻居 0.673），0.72 结构上不可达。
//     附带缺陷：那个 score 掺了 timeDecay*0.2，越老的记忆越难判为重复——与"清理陈年重复"的目的正好相反。
//   - 阈值按实测分布校准（377 条 obs 全量两两 cosine）：>=0.80 共 6 对（强近重复）/ >=0.75 共 49 对（主区间）/
//     >=0.70 共 261 对（过宽，同族不同条会混入）。BGE-M3 在本语料上最高只到 0.843，故 0.85 同样不可达。
//
// 用法：memory-consolidate [--out <报告路径>] [--threshold 0.75] [--dedup-strong 0.80]
//                          [--min-promote-size 3]
// 退出码：成功 0（写报告 + stdout 末行打 `SUMMARY obs=K dedup=N promote=M`）；失败非 0。

import { MemoryStore } from './store.js';
import type { MemoryRecord } from './types.js';
import * as fs from 'fs';
import * as path from 'path';

interface CliArgs {
  out: string | null;
  type: string;           // 扫哪类记忆（observation / work）
  dedupOnly: boolean;     // 只出去重候选，不出升核心（work 型用）
  threshold: number;      // 建边（入簇）cosine 阈值
  dedupStrong: number;    // 标"强近重复"的 cosine 阈值
  minPromoteSize: number; // 升核心候选最小簇大小
}

// 阈值按类型分别校准——两类语料的相似度分布差一个量级，共用一套阈值必然一边漏一边吵。
//   observation（377 条）：人写的行为规则，措辞发散。全量两两 cosine 最高只到 0.843，
//     >=0.80 共 6 对 / >=0.75 共 49 对 → 取 0.75 入簇、0.80 强近重复。
//   work（1491 条）：会话/文档/邮件摘要，同一事实被不同渠道或不同 token 重复摄入时相似度极高。
//     >=0.95 共 13 对 / >=0.93 共 55 对 / >=0.90 共 136 对 / >=0.88 共 208 对。
//     已确认的三对真重复（三对相似度分别为 0.969、0.963、0.955）全在 0.95 以上，
//     取 0.90 入簇、0.93 强近重复，首轮人审规模 ~55 对可控。
const TYPE_DEFAULTS: Record<string, { threshold: number; dedupStrong: number }> = {
  observation: { threshold: 0.75, dedupStrong: 0.80 },
  work:        { threshold: 0.90, dedupStrong: 0.93 },
};

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = 'true'; }
    }
  }
  const type = args.type && args.type !== 'true' ? args.type : 'observation';
  const def = TYPE_DEFAULTS[type] ?? TYPE_DEFAULTS.observation;
  return {
    out: args.out && args.out !== 'true' ? args.out : null,
    type,
    // 升核心（跨场景不变量）只对 observation 成立；work 是事件流，只查重存
    dedupOnly: args['dedup-only'] === 'true' || type !== 'observation',
    threshold: args.threshold ? parseFloat(args.threshold) : def.threshold,
    dedupStrong: args['dedup-strong'] ? parseFloat(args['dedup-strong']) : def.dedupStrong,
    minPromoteSize: args['min-promote-size'] ? parseInt(args['min-promote-size'], 10) : 3,
  };
}

// 拉全量指定类型的 active 记忆（分页直到读完）
async function loadAllByType(store: MemoryStore, type: string): Promise<MemoryRecord[]> {
  const all: MemoryRecord[] = [];
  let offset = 0;
  const pageSize = 100;
  for (;;) {
    const page = store.listAll({ type: type as never, offset, limit: pageSize });
    all.push(...page.items);
    if (!page.has_more || page.items.length === 0) break;
    offset += pageSize;
  }
  return all;
}

// 并查集
class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root)! !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur)! !== cur) { const nxt = this.parent.get(cur)!; this.parent.set(cur, root); cur = nxt; }
    return root;
  }
  union(a: number, b: number): void { this.parent.set(this.find(a), this.find(b)); }
}

// tags 列在库里有两种历史写法：空格分隔的裸文本，以及 JSON 数组文本（如 `["飞行空投","协作"]`）。
// 只按分隔符切会把 `["飞行空投"` 当成一个标签，撑大 distinctTags → 虚假触发"跨≥2主题"的升核心门槛。
function normTags(tags: string): string[] {
  const raw = (tags || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map(t => String(t).trim()).filter(Boolean);
    } catch { /* 落回按分隔符切 */ }
  }
  return raw
    .split(/[\s,，、]+/)
    .map(t => t.trim().replace(/^["'[\]]+|["'[\]]+$/g, ''))
    .filter(Boolean);
}

function snip(s: string, n = 110): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, n);
}

// resident.md 的 bullet 列表，懒加载一次。用于给同主题簇标出「常驻文件里最相近的是哪条」，
// 人审据此判是「新增 bullet」还是「强化既有 bullet」（distill SKILL Step 2 要的正是这个判断）。
// 路径用绝对路径：本 CLI 可能由 launchd 起，不能靠 CWD。可用 MEMORY_RESIDENT_PATH 覆盖。
const RESIDENT_PATH = process.env.MEMORY_RESIDENT_PATH || `${process.env.HOME}/.claude/rules/memory-resident.md`;
let _residentBullets: string[] | null = null;

function residentBullets(): string[] {
  if (_residentBullets === null) {
    try {
      _residentBullets = fs.readFileSync(RESIDENT_PATH, 'utf-8')
        .split('\n')
        .filter(l => l.trimStart().startsWith('- '))
        .map(l => l.trim().slice(2).trim())
        .filter(l => l.length > 8);
    } catch {
      _residentBullets = [];
    }
  }
  return _residentBullets;
}

/** 字符二元组重合率：簇文本命中某条 resident bullet 的比例（以 bullet 为分母，看它被覆盖多少）。 */
function residentMatch(clusterText: string): { line: string; score: number } | null {
  const bullets = residentBullets();
  if (bullets.length === 0) return null;
  const grams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const cg = grams(clusterText);
  let best: { line: string; score: number } | null = null;
  for (const b of bullets) {
    const bg = grams(b);
    if (bg.size === 0) continue;
    let inter = 0;
    for (const g of bg) if (cg.has(g)) inter++;
    const score = inter / bg.size;
    if (!best || score > best.score) best = { line: snip(b, 76), score };
  }
  return best;
}

// embedding 列是 1024d 的 JSON 数组文本（store.ts 用 JSON.stringify 写入）。
// 预先 L2 归一化，之后点积即 cosine。解析失败/维度不符的返回 null，由调用方计入 skipped。
function parseUnitVector(raw: string | null | undefined, expectedDim: number | null): Float32Array | null {
  if (!raw) return null;
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (expectedDim !== null && arr.length !== expectedDim) return null;
  const v = new Float32Array(arr.length);
  let norm = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = Number(arr[i]);
    if (!Number.isFinite(x)) return null;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

interface ClusterInfo {
  ids: number[];
  maxScore: number;
  minEdgeScore: number;
  distinctTags: Set<string>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.MEMORY_SOURCE = process.env.MEMORY_SOURCE || 'consolidation-scan';

  // 改用原始 cosine 后本 CLI 不再调 searchMemory，因此完全不需要 embedding worker。
  // skipBackfill 让构造阶段也不 fork（向量由常驻 daemon 后补），短命 CLI 退化为纯 SQLite 读，
  // 不再受 worker 吊住事件循环 → 被 launchd 砍成 exit 124 的老问题影响。
  const store = new MemoryStore(undefined, { skipBackfill: true });
  try {
    const obs = await loadAllByType(store, args.type);
    const byId = new Map<number, MemoryRecord>(obs.map(m => [m.id, m]));

    // 建边：全量两两 cosine。obs 数量级在千以内（当前 ~380 → 7 万对），一次全算远快于逐条检索。
    const rawVecs = store.listEmbeddingsByType(args.type);
    let expectedDim: number | null = null;
    const vecs: { id: number; v: Float32Array }[] = [];
    const skipped: number[] = [];
    for (const row of rawVecs) {
      if (!byId.has(row.id)) continue; // 只算本次纳入报告的 obs
      const v = parseUnitVector(row.embedding, expectedDim);
      if (!v) { skipped.push(row.id); continue; }
      if (expectedDim === null) expectedDim = v.length;
      vecs.push({ id: row.id, v });
    }

    // 同一条记忆链上的两条（root_id 相同）不算去重候选——它们的关系用户当初
    // 已经用 update / extend 拍过了，再报一次是纯噪声。实测 2026-08-08：
    // obs 25 对里 1 对（extend 链）、work 81 对里 2 对。
    const chainOf = (id: number): number => byId.get(id)?.root_id ?? id;

    const edges = new Map<string, number>(); // "min-max" -> cosine
    const uf = new UnionFind();
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        const cos = dot(vecs[i].v, vecs[j].v);
        if (cos < args.threshold) continue;
        const a = vecs[i].id, b = vecs[j].id;
        if (chainOf(a) === chainOf(b)) continue;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, cos);
        uf.union(a, b);
      }
    }

    // 聚类：连通分量
    const comps = new Map<number, number[]>();
    for (const m of obs) {
      const root = uf.find(m.id);
      if (!comps.has(root)) comps.set(root, []);
      comps.get(root)!.push(m.id);
    }

    const clusters: ClusterInfo[] = [];
    for (const ids of comps.values()) {
      if (ids.length < 2) continue;
      let maxScore = 0;
      let minEdgeScore = 1;
      // 簇内出现过的边的最小/最大分（只统计实际建过的边）
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = ids[i] < ids[j] ? `${ids[i]}-${ids[j]}` : `${ids[j]}-${ids[i]}`;
          const s = edges.get(key);
          if (s !== undefined) { maxScore = Math.max(maxScore, s); minEdgeScore = Math.min(minEdgeScore, s); }
        }
      }
      const distinctTags = new Set<string>();
      for (const id of ids) normTags(byId.get(id)!.tags).forEach(t => distinctTags.add(t));
      clusters.push({ ids, maxScore, minEdgeScore: minEdgeScore === 1 ? maxScore : minEdgeScore, distinctTags });
    }

    // 分类：
    //   去重候选按**边成对**出，不按连通分量——并查集是单链聚类，会把"同族不同条"串成大簇：
    //   实测「反向追问」家族 9 条记忆被一条 0.81 的边串成 9 条一簇，
    //   照簇合并会直接违反 CLAUDE.md「同主题≠同信息，含独有信息的段落不得删」。成对出则人审粒度就是可合并粒度。
    //   升核心候选相反，要的就是"这一族反复出现"，仍按连通分量（size≥N 且 跨≥2主题）。
    const compSizeOf = new Map<number, number>();
    for (const ids of comps.values()) for (const id of ids) compSizeOf.set(id, ids.length);

    // observation 不出去重候选。2026-08-08 人审实测：25 对候选逐对读全文后 0 对可并——
    // 全部是「同主题不同信息」（各带独有案例或独有判据），按 CLAUDE.md 硬约束不得合并。
    // 原因是结构性的：obs 语料 cosine 最高只到 0.843，任何可达阈值捞出来的都是同主题对，
    // 不是重复对。继续按「去重候选」出，等于每周产出一批永远不可执行的建议。
    // obs 侧的聚类真正有用的去处是**升核心**——今天两条 B 档就是从 11 条「我没看懂」簇里看出来的。
    // 去重腿只留给 work（那边确实有真重复：同一份源被 digest 两遍、批量回灌写三遍）。
    const isObs = args.type === 'observation';

    const dedupPairs = isObs
      ? []
      : Array.from(edges.entries())
          .map(([key, cos]) => {
            const [a, b] = key.split('-').map(Number);
            return { a, b, cos };
          })
          // 强近重复的单边；或孤立成对（整个连通分量就这两条，无家族语境）
          .filter(e => e.cos >= args.dedupStrong || compSizeOf.get(e.a) === 2)
          .sort((x, y) => y.cos - x.cos);

    // 升核心候选：obs 出所有 size≥2 的簇（不预筛），三关判据算好摊在报告里让人拍；
    // 非 obs 沿用原来的 size/跨主题预筛。
    const promote = args.dedupOnly
      ? []
      : isObs
        ? clusters.slice()
        : clusters.filter(c => c.ids.length >= args.minPromoteSize && c.distinctTags.size >= 2);

    // 报告
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const lines: string[] = [];
    lines.push(`# Memory Consolidation 扫描报告（dry-run · type=${args.type}）`);
    lines.push('');
    lines.push(`> 生成：${now} · active ${args.type} 总数 ${obs.length} · 相似度=原始 cosine · 阈值 入簇=${args.threshold}${isObs ? '（obs 不出去重候选，见下）' : `/强近重复=${args.dedupStrong}`}`);
    lines.push(`> 参与比对 ${vecs.length} 条${skipped.length ? ` · 无有效 embedding 跳过 ${skipped.length} 条（#${skipped.slice(0, 10).join(' #')}${skipped.length > 10 ? ' …' : ''}）` : ''}`);
    lines.push(`> ⚠️ 只读扫描，未改动任何记忆。合并/升核心/退役请在对话里人审执行（见 distill SKILL）。`);
    lines.push('');

    if (!isObs) {
    lines.push(`## 去重候选（${dedupPairs.length} 对）— 人审后合并 update 链`);
    lines.push('');
    if (dedupPairs.length === 0) lines.push('- 无');
    dedupPairs.forEach((e, i) => {
      const strong = e.cos >= args.dedupStrong ? '强近重复' : '孤立成对';
      lines.push(`### 对 ${i + 1} [${strong} ${e.cos.toFixed(3)}]`);
      for (const id of [e.a, e.b]) {
        const m = byId.get(id)!;
        lines.push(`- #${id} ${m.title}`);
        lines.push(`    ${snip(m.summary)}`);
      }
      lines.push(`  建议：保留信息最全的一条为 canonical，另一条 \`update\` 并入（守"同主题≠同信息"：含独有信息的不并）。`);
      lines.push('');
    });
    }

    if (!args.dedupOnly) {
    lines.push(`## ${isObs ? '同主题簇' : '升核心候选'}（${promote.length} 组）— 升 resident.md 的审批入口，三关已算好`);
    lines.push('');
    if (isObs) {
      lines.push('> 三关（见 distill SKILL）：跨场景不变 · N≥3（含跨日）· 跨≥2 主题。');
      lines.push('> **N 按独立链数算，不按条数**——同一条链上的 extend 是同一次观察的两个侧面，算一次。');
      lines.push('> resident 覆盖列给出常驻文件里最相近的那条，用来判「新增 bullet」还是「强化既有 bullet」。');
      lines.push('> 这里**不出合并建议**：同主题 ≠ 同信息，簇内各条都留库当检索语料。');
      lines.push('');
    }
    if (promote.length === 0) lines.push('- 无');
    // 排序：先看跨主题广度（跨场景性的代理），再看规模
    promote.sort((a, b) => (b.distinctTags.size - a.distinctTags.size) || (b.ids.length - a.ids.length));
    promote.forEach((c, i) => {
      const chains = new Set(c.ids.map(id => byId.get(id)!.root_id ?? id));
      const days = new Set(c.ids.map(id => (byId.get(id)!.created_at || '').slice(0, 10)).filter(Boolean));
      if (!isObs) {
        lines.push(`### 组 ${i + 1}  size=${c.ids.length} · 跨 ${c.distinctTags.size} 标签 [${[...c.distinctTags].slice(0, 6).join(', ')}]`);
      } else {
        const gateN = chains.size >= 3 && days.size >= 2;
        const gateTopic = c.distinctTags.size >= 2;
        const verdict = gateN && gateTopic
          ? '✅ N 与跨主题两关已过 — 只剩「跨场景不变」要人判'
          : `⛔ 不过：${[!gateN ? `独立链 ${chains.size} / 跨 ${days.size} 日` : '', !gateTopic ? `只跨 ${c.distinctTags.size} 主题` : ''].filter(Boolean).join(' + ')} → 留库当语料`;
        lines.push(`### 组 ${i + 1}  ${c.ids.length} 条 / 独立链 ${chains.size} / 跨 ${days.size} 日 / 跨 ${c.distinctTags.size} 主题 [${[...c.distinctTags].slice(0, 6).join(', ')}]`);
        lines.push(`  判据：${verdict}`);
        const cov = residentMatch(c.ids.map(id => `${byId.get(id)!.title} ${byId.get(id)!.summary}`).join(' '));
        lines.push(`  resident 最相近：${cov ? `[重合 ${(cov.score * 100).toFixed(0)}%] ${cov.line}` : '（未加载到 resident.md，跳过）'}`);
      }
      for (const id of c.ids) {
        const m = byId.get(id)!;
        lines.push(`- #${id} ${m.title}`);
      }
      if (!isObs) {
        lines.push(`  建议：若过三关 → 升 memory-resident.md 并退役这些源 obs（promotion=移动不复制）；只是高频情境则留库。`);
      }
      lines.push('');
    });

    }

    const clusteredIds = new Set<number>();
    clusters.forEach(c => c.ids.forEach(id => clusteredIds.add(id)));
    lines.push(`## 独立情境料：${obs.length - clusteredIds.size} 条（无近邻，健康语料，不动）`);
    lines.push('');

    const report = lines.join('\n') + '\n';
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, report, 'utf-8');
    } else {
      process.stdout.write(report);
    }

    // 末行机读 SUMMARY（wrapper grep 用）
    process.stdout.write(`SUMMARY obs=${obs.length} dedup=${dedupPairs.length} promote=${promote.length}\n`);
  } finally {
    store.close();
  }
}

main().catch(err => {
  process.stderr.write(`[memory-consolidate] ${(err as Error).stack || err}\n`);
  process.exit(1);
});
