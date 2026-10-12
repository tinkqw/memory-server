#!/usr/bin/env tsx
/**
 * repair-vec-index — 修复 memory_vec / entity_vec 与主表的索引漂移
 *
 * 背景：
 * 一个外部进程把 memory-server 的库 attach 成 `mem` 直接写裸 SQL，其 `saveEmbedding()`
 * 只 `UPDATE mem.memories SET embedding = ?`，
 * **既不写 embedding_model、也不插 memory_vec**。结果是一批记忆主表有合法向量、
 * vec 表却没有行，向量路对它们等于不存在，只能被 FTS 召回；
 * 且因 `embedding_model = ''`，也被 findDuplicate / searchVector 的全表兜底路
 * （`WHERE embedding_model = ?`）一并排除。
 * 反向漂移同理：已删除 / 已被 update 取代的行会在 vec 表留下陈旧向量，污染 KNN。
 *
 * 本脚本只做纯 SQLite 搬运，不调用任何模型。四类处置：
 *   a) 陈旧 vec 行（主表已不该被索引）        → 删除
 *   b) 缺 vec 行、model 标记正确              → 从主表 JSON 建 vec 行
 *   c) 缺 vec 行、model 为空但向量体检通过    → 认领：补 model 标记 + 建 vec 行
 *   d) 缺 vec 行、主表也没有可用 embedding    → 只报数，交给 daemon 的 backfillEmbeddings 重算
 *
 * (c) 的体检门槛：1024 维、全部有限数、L2 范数 ∈ [0.99, 1.01]。
 * bge-m3 输出是归一化单位向量，异模型/损坏数据过不了这关，宁可漏认领也不认错。
 *
 * 用法：
 *   npm run repair:vec              # dry-run，只报告
 *   npm run repair:vec -- --apply   # 实际写入
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { defaultDbPath } from '../src/host-role.js';

const EXPECTED_MODEL = 'Xenova/bge-m3';
const EXPECTED_DIM = 1024;
const NORM_TOLERANCE = 0.01;
const BATCH = 200;

const apply = process.argv.includes('--apply');
const dbPath = process.env.MEMORY_DB_PATH || defaultDbPath(); // 默认路径按 ~/.claude-host 角色

const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
sqliteVec.load(db);
if (apply) db.pragma('busy_timeout=10000');

interface Target {
  label: string;
  vecTable: string;
  mainTable: string;
  /** 主表里「应当被索引」的行的判据 */
  liveWhere: string;
}

const TARGETS: Target[] = [
  { label: 'memory', vecTable: 'memory_vec', mainTable: 'memories', liveWhere: "status = 'active' AND is_latest = 1" },
  { label: 'entity', vecTable: 'entity_vec', mainTable: 'entities', liveWhere: "status = 'active'" },
];

/** 把主表存的 embedding JSON 体检成 Float32Array；不合格返回原因 */
function vetEmbedding(json: string): { ok: true; vec: Float32Array } | { ok: false; reason: string } {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'JSON 解析失败' };
  }
  if (!Array.isArray(arr)) return { ok: false, reason: '不是数组' };
  if (arr.length !== EXPECTED_DIM) return { ok: false, reason: `维度 ${arr.length} != ${EXPECTED_DIM}` };
  let sumSq = 0;
  for (const n of arr) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, reason: '含非有限数' };
    sumSq += n * n;
  }
  const norm = Math.sqrt(sumSq);
  if (Math.abs(norm - 1) > NORM_TOLERANCE) return { ok: false, reason: `L2 范数 ${norm.toFixed(4)} 非单位向量` };
  return { ok: true, vec: new Float32Array(arr as number[]) };
}

let exitCode = 0;

for (const t of TARGETS) {
  const one = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;

  const live = one(`SELECT COUNT(*) AS c FROM ${t.mainTable} WHERE ${t.liveWhere}`);
  const vecBefore = one(`SELECT COUNT(*) AS c FROM ${t.vecTable}`);

  // (a) 陈旧：vec 表里有、但主表侧已不该被索引
  const staleIds = db.prepare(`
    SELECT v.rowid AS id FROM ${t.vecTable} v
    WHERE v.rowid NOT IN (SELECT id FROM ${t.mainTable} WHERE ${t.liveWhere})
  `).all() as { id: number }[];

  // (b) 缺行、model 标记正确
  const tagged = db.prepare(`
    SELECT id, embedding FROM ${t.mainTable}
    WHERE ${t.liveWhere} AND embedding IS NOT NULL AND embedding_model = ?
      AND id NOT IN (SELECT rowid FROM ${t.vecTable})
  `).all(EXPECTED_MODEL) as { id: number; embedding: string }[];

  // (c) 缺行、model 为空（外部写入端留下的孤儿向量）
  const orphans = db.prepare(`
    SELECT id, embedding FROM ${t.mainTable}
    WHERE ${t.liveWhere} AND embedding IS NOT NULL AND COALESCE(embedding_model, '') = ''
      AND id NOT IN (SELECT rowid FROM ${t.vecTable})
  `).all() as { id: number; embedding: string }[];

  // (d) 缺行、主表无可用 embedding → 只报数
  const needsRecompute = one(`
    SELECT COUNT(*) AS c FROM ${t.mainTable}
    WHERE ${t.liveWhere} AND embedding IS NULL
      AND id NOT IN (SELECT rowid FROM ${t.vecTable})
  `);
  // 缺行、有 embedding 但 model 既非本模型也非空（异模型残留）→ 同样交给 backfill
  const foreignModel = one(`
    SELECT COUNT(*) AS c FROM ${t.mainTable}
    WHERE ${t.liveWhere} AND embedding IS NOT NULL
      AND COALESCE(embedding_model, '') != '' AND embedding_model != ?
      AND id NOT IN (SELECT rowid FROM ${t.vecTable})
  `, EXPECTED_MODEL);

  const vet = (rows: { id: number; embedding: string }[]) => {
    const good: { id: number; vec: Float32Array }[] = [];
    const bad: { id: number; reason: string }[] = [];
    for (const r of rows) {
      const v = vetEmbedding(r.embedding);
      if (v.ok) good.push({ id: r.id, vec: v.vec });
      else bad.push({ id: r.id, reason: v.reason });
    }
    return { good, bad };
  };

  const taggedVet = vet(tagged);
  const orphanVet = vet(orphans);
  const rejected = [...taggedVet.bad, ...orphanVet.bad];

  console.log(`\n=== ${t.label} (${t.vecTable}) ===`);
  console.log(`  主表应索引行数            : ${live}`);
  console.log(`  vec 表现有行数            : ${vecBefore}`);
  console.log(`  a) 陈旧 vec 行（待删）    : ${staleIds.length}`);
  console.log(`  b) 缺行·model 正确        : ${tagged.length}（体检通过 ${taggedVet.good.length}）`);
  console.log(`  c) 缺行·孤儿向量待认领    : ${orphans.length}（体检通过 ${orphanVet.good.length}）`);
  console.log(`  d) 缺行·需重算 embedding  : ${needsRecompute + foreignModel}${needsRecompute + foreignModel ? '  ← 交给 backfillEmbeddings，本脚本不处理' : ''}`);

  if (rejected.length > 0) {
    console.log(`  ⚠️  体检未过（不入 vec 表，留给 backfill 重算）: ${rejected.length} 条`);
    for (const r of rejected.slice(0, 10)) console.log(`        #${r.id} — ${r.reason}`);
    if (rejected.length > 10) console.log(`        …另 ${rejected.length - 10} 条`);
    exitCode = 1;
  }

  const toInsert = [...taggedVet.good, ...orphanVet.good];
  const toStamp = orphanVet.good.map(g => g.id); // 认领的需要同时补 model 标记

  if (!apply) {
    console.log(`  [dry-run] 将删除 ${staleIds.length} 行、插入 ${toInsert.length} 行、补 model 标记 ${toStamp.length} 条`);
    continue;
  }

  const delStmt = db.prepare(`DELETE FROM ${t.vecTable} WHERE rowid = ?`);
  const insStmt = db.prepare(`INSERT OR REPLACE INTO ${t.vecTable} (rowid, embedding) VALUES (?, ?)`);
  const stampStmt = db.prepare(`UPDATE ${t.mainTable} SET embedding_model = ? WHERE id = ? AND COALESCE(embedding_model, '') = ''`);

  let deleted = 0, inserted = 0, stamped = 0;

  const delBatch = db.transaction((ids: number[]) => {
    for (const id of ids) { delStmt.run(BigInt(id)); deleted++; }
  });
  const insBatch = db.transaction((items: { id: number; vec: Float32Array }[], stampSet: Set<number>) => {
    for (const it of items) {
      if (stampSet.has(it.id)) { stamped += stampStmt.run(EXPECTED_MODEL, it.id).changes; }
      insStmt.run(BigInt(it.id), it.vec);
      inserted++;
    }
  });

  const stampSet = new Set(toStamp);
  for (let i = 0; i < staleIds.length; i += BATCH) delBatch(staleIds.slice(i, i + BATCH).map(s => s.id));
  for (let i = 0; i < toInsert.length; i += BATCH) insBatch(toInsert.slice(i, i + BATCH), stampSet);

  // 复验
  const vecAfter = one(`SELECT COUNT(*) AS c FROM ${t.vecTable}`);
  const remainingStale = one(`
    SELECT COUNT(*) AS c FROM ${t.vecTable} v
    WHERE v.rowid NOT IN (SELECT id FROM ${t.mainTable} WHERE ${t.liveWhere})`);
  const remainingMissing = one(`
    SELECT COUNT(*) AS c FROM ${t.mainTable}
    WHERE ${t.liveWhere} AND id NOT IN (SELECT rowid FROM ${t.vecTable})`);
  const expectedMissing = needsRecompute + foreignModel + rejected.length;

  console.log(`  ✅ 删除 ${deleted} · 插入 ${inserted} · 补 model 标记 ${stamped} → vec 表 ${vecBefore} → ${vecAfter}`);
  console.log(`  复验：仍陈旧 ${remainingStale}（应为 0）· 仍缺行 ${remainingMissing}（应为 ${expectedMissing}）`);

  if (remainingStale !== 0) {
    console.error(`  ❌ ${t.vecTable} 仍有 ${remainingStale} 行陈旧向量`);
    exitCode = 2;
  }
  if (remainingMissing !== expectedMissing) {
    console.error(`  ❌ ${t.vecTable} 缺行数与预期不符`);
    exitCode = 2;
  }
}

db.close();
console.log(apply ? '\n完成。' : '\n以上为 dry-run，加 --apply 实际写入。');
process.exit(exitCode);
