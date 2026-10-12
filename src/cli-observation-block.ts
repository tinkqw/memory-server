#!/usr/bin/env node
// memory-observation-block CLI — emits markdown observation block for UserPromptSubmit hook.
// 按 prompt 主题实时检索 top-K observation，注入到 system context。
// 长期目标：替代静态的 memory-resident.md（蒸馏预凝练产物）。
//
// 退出码：成功 0（输出 markdown 或空），失败 0（静默降级，stderr 写日志）。
// 仅在以下情况输出非空：query 长度 ≥ MIN_QUERY_LEN，且至少有一条 score ≥ minScore 的 observation 命中。

import { MemoryStore } from './store.js';
import type { MemoryRecord } from './types.js';

const MIN_QUERY_LEN = 10; // 短 prompt（"在吗"/"继续"）跳过检索，避免噪音

interface CliArgs {
  query: string;
  top: number;
  minScore: number;
  minCosine: number;
  maxChars: number;
}

// 注入闸用**原始 cosine**，不用 searchMemory 的混合排序分。
// 2026-08-08 修：原来只卡 score >= 0.3，而 score 是结果集内的相对排序分——无关 query 照样有
// 0.54–0.65 的"高分"命中。实测「帮我订一张明天去上海的高铁票」注入了「流程图职责」（score 0.60 /
// 真实 cosine 0.377）和「会议准备文档定位」（0.54 / 0.428）；「python 列表推导式语法」注入了
// 「第三方平台按钮格式」（0.65 / 0.387）。相关 query（「定时任务失败了怎么排查」）的真实 cosine
// 是 0.648/0.656。这条闸跑在每一轮 prompt 上，卡不住就等于每轮往上下文里塞无关内容。
//
// 阈值用 5 条相关 query（25 个候选）+ 4 条无关 query（20 个候选）标定：
//   相关候选 cosine  min=0.402 / p50=0.616 / max=0.661
//   无关候选 cosine  min=0.310 / p50=0.387 / max=0.523
//   0.50 → 保留相关 23/25，漏掉无关 2/20
//   0.55 → 保留相关 21/25，漏掉无关 0/20   ← 取这个
//   0.60 → 保留相关 15/25，漏掉无关 0/20（开始误伤）
// 取 0.55：注入错的比漏注入贵——错的会污染判断，漏的下一轮还有机会召回。
const DEFAULT_MIN_COSINE = 0.55;

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }

  if (!args.query) {
    process.stderr.write('Usage: memory-observation-block --query <text> [--top 5] [--min-score 0.3] [--min-cosine 0.5] [--max-chars 2000]\n');
    process.exit(2);
  }

  return {
    query: args.query,
    top: args.top ? parseInt(args.top, 10) : 5,
    minScore: args['min-score'] ? parseFloat(args['min-score']) : 0.3,
    minCosine: args['min-cosine'] ? parseFloat(args['min-cosine']) : DEFAULT_MIN_COSINE,
    maxChars: args['max-chars'] ? parseInt(args['max-chars'], 10) : 2000,
  };
}

function formatAge(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  if (isNaN(created)) return '?';
  const diffMs = Date.now() - created;
  const diffH = Math.floor(diffMs / 3_600_000);
  if (diffH < 1) return 'just now';
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  const diffMo = Math.floor(diffD / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  return `${Math.floor(diffD / 365)}y ago`;
}

function renderBlock(memories: MemoryRecord[]): string {
  const out: string[] = [];
  out.push('## 🧭 用户偏好 / 协作风格 — 按主题实时检索');
  out.push('> _按当前 prompt 主题召回 top-K observation；不是常驻规则，仅本轮相关_');
  out.push('');
  memories.forEach((m, i) => {
    const scoreStr = m.score !== undefined ? m.score.toFixed(2) : '?';
    out.push(`[${i + 1}] #${m.id} [score=${scoreStr}, ${formatAge(m.created_at)}] ${m.title}`);
    const summarySnip = m.summary.replace(/\s+/g, ' ').trim().slice(0, 180);
    if (summarySnip) out.push(`    ${summarySnip}`);
  });
  return out.join('\n') + '\n';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.MEMORY_SOURCE = process.env.MEMORY_SOURCE || 'prompt-hook-observation';

  // 短 prompt 跳过（"在吗"/"继续"/"OK" 等无主题信号）
  if (args.query.trim().length < MIN_QUERY_LEN) {
    return;
  }

  const store = new MemoryStore();
  try {
    const all = await store.searchMemory({
      query: args.query,
      type: 'observation',
      limit: args.top,
    });

    const byScore = all.filter(m => (m.score ?? 0) >= args.minScore);
    if (byScore.length === 0) return;

    // 二道闸：原始 cosine。embedding 不可用时 cosMap 为空 → 不过滤，退化回原行为
    const cosMap = await store.cosineAgainstQuery(args.query, byScore.map(m => m.id));
    const filtered = cosMap.size === 0
      ? byScore
      : byScore.filter(m => (cosMap.get(m.id) ?? 0) >= args.minCosine);
    if (filtered.length === 0) return;

    let output = renderBlock(filtered);
    if (output.length > args.maxChars) {
      output = output.slice(0, args.maxChars - 20) + '\n\n_(truncated)_\n';
    }
    process.stdout.write(output);
  } finally {
    store.close();
  }
}

main().catch(err => {
  process.stderr.write(`[memory-observation-block] ${(err as Error).stack || err}\n`);
  process.exit(0);
});
