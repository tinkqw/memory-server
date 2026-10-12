import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MemoryStore } from '../src/store.js';

type StoreWithDb = MemoryStore & { db: Database.Database };

function createFixture(): {
  store: StoreWithDb;
  replaceStore: (next: StoreWithDb) => void;
  dbPath: string;
  cleanup: () => void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-server-p2-'));
  const dbPath = path.join(directory, 'memory.db');
  let store = new MemoryStore(dbPath, { skipBackfill: true }) as StoreWithDb;
  return {
    get store() { return store; },
    replaceStore: (next) => { store = next; },
    dbPath,
    cleanup: () => {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function createUpdateChain(store: StoreWithDb): Promise<{ parentId: number; childId: number }> {
  const db = store.db;
  const now = '2026-08-08T00:00:00.000+08:00';
  db.prepare(`
    INSERT INTO entities (name, aliases, category, attributes, relations, status, source, created_at, updated_at)
    VALUES (?, '[]', 'project', '{}', '[]', 'active', 'fixture', ?, ?)
  `).run('Acme', now, now);

  const parent = await store.storeMemory({
    title: 'Acme parent', tags: 'fixture', summary: 'Acme parent summary', type: 'work', force: true, embed: 'defer',
  });
  assert.ok(parent.id);

  const embedding = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));
  db.prepare(`UPDATE memories SET embedding = ?, embedding_model = 'fixture' WHERE id = ?`).run(JSON.stringify(embedding), parent.id);
  db.prepare(`INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)`).run(BigInt(parent.id), new Float32Array(embedding));

  const child = await store.storeMemory({
    title: 'Acme child', tags: 'fixture', summary: 'Acme child summary', type: 'work', force: true,
    parent_id: parent.id, relation: 'update', embed: 'defer',
  });
  assert.ok(child.id);
  const childEmbedding = Array.from({ length: 1024 }, (_, index) => (index === 1 ? 1 : 0));
  db.prepare(`UPDATE memories SET embedding = ?, embedding_model = 'fixture' WHERE id = ?`).run(JSON.stringify(childEmbedding), child.id);
  db.prepare(`INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)`).run(BigInt(child.id), new Float32Array(childEmbedding));
  return { parentId: parent.id, childId: child.id };
}

function count(db: Database.Database, sql: string, value: number): number {
  return (db.prepare(sql).get(value) as { count: number }).count;
}

function runCliStore(dbPath: string, payload: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli-store.js'], {
      cwd: process.cwd(),
      env: { ...process.env, MEMORY_DB_PATH: dbPath, MEMORY_SOURCE: 'fixture-cli-store' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('normal startup does not rebuild FTS, while explicit maintenance does', async () => {
  const fixture = createFixture();
  try {
    const stored = await fixture.store.storeMemory({
      title: 'startup parent', tags: 'fixture', summary: 'startup summary', type: 'work', force: true, embed: 'defer',
    });
    assert.ok(stored.id);
    fixture.store.db.prepare(`
      INSERT INTO memories_fts (rowid, title, tags, summary) VALUES (999999, 'canary', '', '')
    `).run();
    fixture.store.close();

    const second = new MemoryStore(fixture.dbPath, { skipBackfill: true }) as StoreWithDb;
    fixture.replaceStore(second);
    assert.equal(count(second.db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', 999999), 1);

    second.rebuildSearchIndexesForMaintenance();
    assert.equal(count(second.db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', 999999), 0);
    assert.equal(count(second.db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', stored.id), 1);
  } finally {
    fixture.cleanup();
  }
});

test('legacy FTS tables migrate and rebuild only during the migration', async () => {
  const fixture = createFixture();
  try {
    const stored = await fixture.store.storeMemory({
      title: 'legacy migration', tags: 'fixture', summary: 'legacy summary', type: 'work', force: true, embed: 'defer',
    });
    assert.ok(stored.id);
    fixture.store.close();

    const raw = new Database(fixture.dbPath);
    raw.exec(`DROP TABLE memories_fts`);
    raw.exec(`DROP TABLE entities_fts`);
    raw.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        title, tags, summary, content='memories', content_rowid='id', tokenize='ascii'
      )
    `);
    raw.exec(`
      CREATE VIRTUAL TABLE entities_fts USING fts5(
        name, aliases, category, attributes, content='entities', content_rowid='id', tokenize='ascii'
      )
    `);
    raw.close();

    const migrated = new MemoryStore(fixture.dbPath, { skipBackfill: true }) as StoreWithDb;
    fixture.replaceStore(migrated);
    assert.equal(count(migrated.db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', stored.id), 1);
  } finally {
    fixture.cleanup();
  }
});

test('maintenance lock preserves a concurrent cli-store write and its FTS entry', async () => {
  const fixture = createFixture();
  try {
    const anchor = await fixture.store.storeMemory({
      title: 'maintenance anchor', tags: 'fixture', summary: 'anchor summary', type: 'work', force: true, embed: 'defer',
    });
    assert.ok(anchor.id);

    const cliStore = runCliStore(fixture.dbPath, {
      title: 'concurrent cli write', tags: 'fixture', summary: 'digest-compatible write', type: 'work', force: true,
    });
    fixture.store.db.exec('BEGIN IMMEDIATE');
    try {
      // Let the independent cli process reach SQLite while this connection owns the same write lock.
      await wait(500);
      (fixture.store as unknown as { rebuildSearchIndexes: () => void }).rebuildSearchIndexes();
      fixture.store.db.exec('COMMIT');
    } catch (err) {
      fixture.store.db.exec('ROLLBACK');
      throw err;
    }

    const result = await cliStore;
    assert.equal(result.code, 0, result.stderr);
    const match = /^MEMORY_ID=(\d+)$/m.exec(result.stdout);
    assert.ok(match, result.stdout);
    const cliId = Number(match[1]);
    assert.equal(count(fixture.store.db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', cliId), 1);
  } finally {
    fixture.cleanup();
  }
});

test('deleting an update child restores every parent-derived index', async () => {
  const fixture = createFixture();
  try {
    const { parentId, childId } = await createUpdateChain(fixture.store);
    const result = fixture.store.deleteMemory({ id: childId });
    assert.equal(result.deleted, true);

    const db = fixture.store.db;
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memories WHERE id = ? AND status = \'active\' AND is_latest = 1', parentId), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', parentId), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memory_vec WHERE rowid = ?', parentId), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memory_entities WHERE memory_id = ?', parentId), 1);
  } finally {
    fixture.cleanup();
  }
});

test('restoring an update child moves the full latest index set back to the child', async () => {
  const fixture = createFixture();
  try {
    const { parentId, childId } = await createUpdateChain(fixture.store);
    fixture.store.deleteMemory({ id: childId });
    const restored = fixture.store.restoreMemory({ id: childId });
    assert.equal(restored.restored, true);

    const db = fixture.store.db;
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memories WHERE root_id = ? AND status = \'active\' AND is_latest = 1', parentId), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', parentId), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memory_vec WHERE rowid = ?', parentId), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memory_entities WHERE memory_id = ?', parentId), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', childId), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memory_vec WHERE rowid = ?', childId), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS count FROM memory_entities WHERE memory_id = ?', childId), 1);
  } finally {
    fixture.cleanup();
  }
});
