// A2 · 失效机制（supersede_memory）测试
//
// 覆盖两件事：
// 1. 取代生效——旧记忆退出全部检索路（FTS / vec / memory_entities），但没被删掉；
// 2. 拒绝该拒绝的——环、已在链上的 new、已被取代的 old、空 reason。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/store.js';

type StoreWithDb = MemoryStore & { db: Database.Database };

function createFixture(): { store: StoreWithDb; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-server-supersede-'));
  const dbPath = path.join(directory, 'memory.db');
  const store = new MemoryStore(dbPath, { skipBackfill: true }) as StoreWithDb;
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** 写一条记忆并手工装上 vec 行（测试环境不跑 BGE-M3） */
async function seed(store: StoreWithDb, title: string, summary: string, seedIndex: number): Promise<number> {
  const stored = await store.storeMemory({
    title, tags: 'fixture', summary, type: 'work', force: true, embed: 'defer',
  });
  assert.ok(stored.id, `seed failed: ${JSON.stringify(stored)}`);
  const embedding = Array.from({ length: 1024 }, (_, i) => (i === seedIndex ? 1 : 0));
  store.db.prepare(`UPDATE memories SET embedding = ?, embedding_model = 'fixture' WHERE id = ?`)
    .run(JSON.stringify(embedding), stored.id);
  store.db.prepare(`INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)`)
    .run(BigInt(stored.id), new Float32Array(embedding));
  return stored.id!;
}

function rowOf(store: StoreWithDb, id: number): any {
  return store.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
}

function countIn(store: StoreWithDb, table: 'memory_vec' | 'memories_fts' | 'memory_entities', id: number): number {
  const column = table === 'memory_entities' ? 'memory_id' : 'rowid';
  return (store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(id) as { count: number }).count;
}

test('supersede with successor: old leaves every retrieval path but is not deleted', async () => {
  const fixture = createFixture();
  try {
    const store = fixture.store;
    const now = '2026-08-29T00:00:00.000+08:00';
    store.db.prepare(`
      INSERT INTO entities (name, aliases, category, attributes, relations, status, source, created_at, updated_at)
      VALUES ('回复硬格式', '[]', 'project', '{}', '[]', 'active', 'fixture', ?, ?)
    `).run(now, now);

    const oldId = await seed(store, '回复硬格式：首段不超过三行', '回复硬格式 规定首段结论不超过三行', 0);
    const newId = await seed(store, '回复硬格式：改管全文五行', '回复硬格式 改为全文不超过五行', 1);

    // 前置：两条都是现行事实，都在三处索引里
    assert.equal(rowOf(store, oldId).is_latest, 1);
    assert.equal(countIn(store, 'memory_vec', oldId), 1);
    assert.ok(countIn(store, 'memory_entities', oldId) >= 1, 'old should have entity links before supersede');

    const result = store.supersedeMemory({
      old_id: oldId, new_id: newId, reason: '8-09 改为全文 5 行，首段口径作废', invalid_from: '2026-08-09',
    });

    assert.equal(result.superseded, true);
    assert.equal(result.old_id, oldId);
    assert.equal(result.new_id, newId);
    assert.equal(result.root_id, oldId);
    assert.equal(result.invalid_from, '2026-08-09');

    // old：降为历史版本，失效理由留档，但行还在、status 仍是 active
    const oldRow = rowOf(store, oldId);
    assert.equal(oldRow.is_latest, 0);
    assert.equal(oldRow.status, 'active');
    assert.equal(oldRow.invalid_from, '2026-08-09');
    assert.equal(oldRow.invalid_reason, '8-09 改为全文 5 行，首段口径作废');
    assert.equal(oldRow.root_id, oldId, 'old becomes the chain root');

    // 三处派生索引全撤——少撤一处旧事实就还能从那条路被召回
    assert.equal(countIn(store, 'memory_vec', oldId), 0, 'vec row must be gone');
    assert.equal(countIn(store, 'memories_fts', oldId), 0, 'fts row must be gone');
    assert.equal(countIn(store, 'memory_entities', oldId), 0, 'entity links must be gone');

    // new：挂上链，成为链的最新版本
    const newRow = rowOf(store, newId);
    assert.equal(newRow.parent_id, oldId);
    assert.equal(newRow.root_id, oldId);
    assert.equal(newRow.relation, 'update');
    assert.equal(newRow.version, oldRow.version + 1);
    assert.equal(newRow.is_latest, 1);
    assert.equal(countIn(store, 'memory_vec', newId), 1);

    // 检索：默认查不到 old
    const hits = await store.searchMemory({ query: '回复硬格式 首段', limit: 10, readOnly: true });
    assert.ok(!hits.some(h => h.id === oldId), 'superseded memory must not surface in normal search');

    // include_history 也查不到——FTS / vec 行已被撤，两条路都无从命中。
    // 这不是本次引入的：写入时 relation='update' 取代同样如此。取代后唯一的取回口是 root_id 链查。
    const withHistory = await store.searchMemory({ query: '回复硬格式 首段', limit: 10, include_history: true, readOnly: true });
    assert.ok(!withHistory.some(h => h.id === oldId),
      'include_history cannot reach a superseded memory once its FTS/vec rows are dropped');

    // 不删除、只取代：root_id 链查仍完整取得回
    const chain = await store.searchMemory({ query: '', root_id: oldId, readOnly: true });
    const chainIds = chain.map(c => c.id);
    assert.ok(chainIds.includes(oldId), 'root_id chain query must still return the superseded memory');
    assert.ok(chainIds.includes(newId), 'root_id chain query must return the successor');
  } finally {
    fixture.cleanup();
  }
});

test('supersede without successor: fact is invalidated with no replacement', async () => {
  const fixture = createFixture();
  try {
    const store = fixture.store;
    const oldId = await seed(store, '示例项目 OCR 走境外模型', '示例项目 OCR 方案走境外模型 API', 0);

    const result = store.supersedeMemory({ old_id: oldId, reason: 'PIPL 出境红线，方案作废且无替代' });
    assert.equal(result.superseded, true);
    assert.equal(result.new_id, null);

    const row = rowOf(store, oldId);
    assert.equal(row.is_latest, 0);
    assert.equal(row.status, 'active');
    assert.equal(row.parent_id, null);
    assert.equal(row.invalid_reason, 'PIPL 出境红线，方案作废且无替代');
    assert.match(row.invalid_from, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(countIn(store, 'memory_vec', oldId), 0);
    assert.equal(countIn(store, 'memories_fts', oldId), 0);

    const hits = await store.searchMemory({ query: '示例项目 OCR 境外模型', limit: 10, readOnly: true });
    assert.ok(!hits.some(h => h.id === oldId), 'invalidated memory must not surface in normal search');
  } finally {
    fixture.cleanup();
  }
});

test("supersede repoints the successor's whole subtree onto the old chain root", async () => {
  const fixture = createFixture();
  try {
    const store = fixture.store;
    const oldId = await seed(store, '兑换码方案 v1', '兑换码方案第一版', 0);
    const newId = await seed(store, '兑换码方案 v2', '兑换码方案第二版', 1);

    // new 自己已经带了一个 extend 子节点
    const childStored = await store.storeMemory({
      title: '兑换码方案 v2 补充', tags: 'fixture', summary: '兑换码方案第二版的风控补充',
      type: 'work', force: true, embed: 'defer', parent_id: newId, relation: 'extend',
    });
    assert.ok(childStored.id);
    assert.equal(rowOf(store, childStored.id!).root_id, newId);

    const result = store.supersedeMemory({ old_id: oldId, new_id: newId, reason: 'v2 取代 v1' });
    assert.equal(result.superseded, true);

    // 整棵子树跟着挪到 old 的链根，否则 root_id 链查查漏
    assert.equal(rowOf(store, newId).root_id, oldId);
    assert.equal(rowOf(store, childStored.id!).root_id, oldId);

    const chainIds = (await store.searchMemory({ query: '', root_id: oldId, readOnly: true })).map(c => c.id);
    assert.deepEqual(chainIds.sort((a, b) => a - b), [oldId, newId, childStored.id!].sort((a, b) => a - b));
  } finally {
    fixture.cleanup();
  }
});

test('supersede rejects cycles, re-parenting, double supersede and empty reason', async () => {
  const fixture = createFixture();
  try {
    const store = fixture.store;
    const aId = await seed(store, '链头 A', '链头 A 的正文', 0);
    const bId = await seed(store, '后继 B', '后继 B 的正文', 1);
    const cId = await seed(store, '孤立 C', '孤立 C 的正文', 2);

    assert.equal(store.supersedeMemory({ old_id: aId, new_id: bId, reason: '   ' }).reason, 'reason_required');
    assert.equal(store.supersedeMemory({ old_id: aId, new_id: bId, reason: 'ok', invalid_from: '2026/08/09' }).reason,
      'invalid_from_must_be_YYYY-MM-DD');
    assert.equal(store.supersedeMemory({ old_id: aId, new_id: aId, reason: 'ok' }).reason, 'cannot_supersede_itself');
    assert.equal(store.supersedeMemory({ old_id: 999999, new_id: bId, reason: 'ok' }).reason, 'old_not_found_or_not_active');
    assert.equal(store.supersedeMemory({ old_id: aId, new_id: 999999, reason: 'ok' }).reason, 'new_not_found_or_not_active');

    // A ← B 建链后：B 已有 parent，不得再被重挂；A 已被取代，不得重复取代
    assert.equal(store.supersedeMemory({ old_id: aId, new_id: bId, reason: 'B 取代 A' }).superseded, true);
    assert.equal(store.supersedeMemory({ old_id: aId, new_id: cId, reason: '再取代一次' }).reason, 'old_already_superseded');
    assert.equal(store.supersedeMemory({ old_id: cId, new_id: bId, reason: 'B 重挂到 C 下' }).reason, 'new_already_has_parent');

    // 环：A 已经是 B 的祖先，再让 A 取代于 B 之下就成环
    assert.equal(rowOf(store, aId).is_latest, 0);
    store.db.prepare(`UPDATE memories SET is_latest = 1 WHERE id = ?`).run(aId); // 人为造出成环前提
    assert.equal(store.supersedeMemory({ old_id: bId, new_id: aId, reason: '造环' }).reason, 'would_create_cycle');
  } finally {
    fixture.cleanup();
  }
});

test('restoring a superseded memory to latest clears its invalid markers', async () => {
  const fixture = createFixture();
  try {
    const store = fixture.store;
    const oldId = await seed(store, '旧口径', '旧口径的正文', 0);
    const newId = await seed(store, '新口径', '新口径的正文', 1);

    store.supersedeMemory({ old_id: oldId, new_id: newId, reason: '口径变更' });
    assert.equal(rowOf(store, oldId).invalid_reason, '口径变更');

    // 删掉链端 → 祖先重新成为现行事实，失效标记必须一并清掉
    const deleted = store.deleteMemory({ id: newId });
    assert.equal(deleted.deleted, true);

    const restored = rowOf(store, oldId);
    assert.equal(restored.is_latest, 1);
    assert.equal(restored.invalid_from, null);
    assert.equal(restored.invalid_reason, null);
    assert.equal(countIn(store, 'memory_vec', oldId), 1, 'vec row must be rebuilt');
  } finally {
    fixture.cleanup();
  }
});

test('store_memory update path records the same invalid markers', async () => {
  const fixture = createFixture();
  try {
    const store = fixture.store;
    const parentId = await seed(store, '写入时取代 · 父', '父版本正文', 0);

    const child = await store.storeMemory({
      title: '写入时取代 · 子', tags: 'fixture', summary: '子版本正文',
      type: 'work', force: true, embed: 'defer', parent_id: parentId, relation: 'update',
    });
    assert.ok(child.id);

    const parentRow = rowOf(store, parentId);
    assert.equal(parentRow.is_latest, 0);
    assert.match(parentRow.invalid_from, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(parentRow.invalid_reason, `superseded by #${child.id}`);
  } finally {
    fixture.cleanup();
  }
});
