import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { AgentMemoryGateway, gatewayConfigFromEnvironment, type GatewayMemoryInput } from '../src/gateway.js';
import { MemoryStore } from '../src/store.js';
import type { GatewayAuditRecord } from '../src/types.js';

type StoreWithDb = MemoryStore & { db: Database.Database };

function fixture(maxAcceptedWritesPerSession?: number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-'));
  const dbPath = path.join(directory, 'memory.db');
  const store = new MemoryStore(dbPath, { skipBackfill: true, source: 'fixture' }) as StoreWithDb;
  const gateway = new AgentMemoryGateway(store, {
    runtimeId: 'codex',
    clientId: 'fixture-codex',
    sessionId: 'adapter-session-fixture',
    allowedClients: new Set(['codex:fixture-codex']),
    maxAcceptedWritesPerSession,
  });
  return {
    store,
    gateway,
    cleanup: () => {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function context(key: string) {
  return {
    request_id: `request-${key}`,
    project_id: 'project-memory-server',
    evidence_ref: 'workspace:tests/gateway.test.ts#L1',
    retention_intent: 'durable' as const,
    idempotency_key: key,
  };
}

function input(key: string, overrides: Partial<GatewayMemoryInput> = {}): GatewayMemoryInput {
  return {
    context: context(key),
    title: `gateway fixture ${key}`,
    tags: 'fixture',
    summary: `gateway fixture summary ${key}`,
    type: 'work',
    artifacts: [{ type: 'file', title: 'fixture', ref: 'tests/gateway.test.ts' }],
    ...overrides,
  };
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

function runConcurrentGatewayWorker(
  dbPath: string,
  key: string,
  summary = `concurrent summary ${key}`,
  evidenceRef = 'workspace:tests/gateway.test.ts#L1',
): Promise<{ code: number | null; output: string; error: string }> {
  const gatewayUrl = pathToFileURL(path.join(process.cwd(), 'dist/gateway.js')).href;
  const storeUrl = pathToFileURL(path.join(process.cwd(), 'dist/store.js')).href;
  const script = `
    import { AgentMemoryGateway } from ${JSON.stringify(gatewayUrl)};
    import { MemoryStore } from ${JSON.stringify(storeUrl)};
    const store = new MemoryStore(process.env.MEMORY_DB_PATH, { skipBackfill: true, source: 'fixture-worker' });
    const gateway = new AgentMemoryGateway(store, {
      runtimeId: 'codex', clientId: 'fixture-codex', sessionId: 'adapter-session-fixture',
      allowedClients: new Set(['codex:fixture-codex']), maxAcceptedWritesPerSession: 1,
    });
    const key = process.env.GATEWAY_FIXTURE_KEY;
    const summary = process.env.GATEWAY_FIXTURE_SUMMARY;
    const evidenceRef = process.env.GATEWAY_FIXTURE_EVIDENCE_REF;
    const result = await gateway.write({
      context: {
        request_id: 'request-' + key, project_id: 'project-memory-server',
        evidence_ref: evidenceRef, retention_intent: 'durable', idempotency_key: key,
      },
      title: 'concurrent ' + key, tags: 'fixture', summary, type: 'work',
    });
    process.stdout.write(JSON.stringify(result));
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_DB_PATH: dbPath,
        GATEWAY_FIXTURE_KEY: key,
        GATEWAY_FIXTURE_SUMMARY: summary,
        GATEWAY_FIXTURE_EVIDENCE_REF: evidenceRef,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output, error }));
  });
}

test('gateway writes memory, indexes, ledger, and audit atomically', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const result = await gateway.write(input('valid'));
    assert.deepEqual(result, { outcome: 'accepted', stored: true, id: 1 });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 1);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', 1), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_requests WHERE outcome = 'accepted' AND memory_id = ?", 1), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE outcome = 'accepted' AND memory_id = ?", 1), 1);

    const before = store.db.prepare('SELECT retrieval_count FROM memories WHERE id = 1').get() as { retrieval_count: number };
    assert.equal(gateway.listRecent({ count: 1 }).length, 1);
    const after = store.db.prepare('SELECT retrieval_count FROM memories WHERE id = 1').get() as { retrieval_count: number };
    assert.equal(after.retrieval_count, before.retrieval_count);
  } finally {
    cleanup();
  }
});

test('gateway rejects incomplete provenance without creating a memory', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const invalid = input('missing-evidence');
    delete invalid.context.evidence_ref;
    const result = await gateway.write(invalid);
    assert.deepEqual(result, { outcome: 'rejected', stored: false, reason: 'missing_evidence_ref' });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 0);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE reason = 'missing_evidence_ref'"), 1);
  } finally {
    cleanup();
  }
});

test('gateway permits a corrected validation retry under the same intent key', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const first = input('correct-validation-retry', {
      context: { ...context('correct-validation-retry'), evidence_ref: 'not a portable reference' },
    });
    assert.deepEqual(await gateway.write(first), {
      outcome: 'rejected', stored: false, reason: 'invalid_evidence_ref',
    });
    const corrected = await gateway.write({
      ...first,
      context: { ...first.context, request_id: 'request-correct-validation-retry-fixed', evidence_ref: 'memory:42' },
    });
    assert.equal(corrected.outcome, 'accepted');
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_requests WHERE outcome = 'accepted'"), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE reason = 'invalid_evidence_ref'"), 1);
  } finally {
    cleanup();
  }
});

test('similar_found is audited without reserving its key, then an update uses a new key', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const parentInput = input('similar-parent');
    const parent = await gateway.write(parentInput);
    assert.equal(parent.outcome, 'accepted');
    assert.ok(parent.id);

    const similar = await gateway.write(input('similar-candidate', { title: parentInput.title }));
    assert.equal(similar.outcome, 'rejected');
    assert.equal(similar.reason, 'similar_found');
    assert.equal(similar.similar_id, parent.id);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE reason = 'similar_found'"), 1);

    const update = await gateway.update(input('similar-reviewed-update', { parent_id: parent.id }));
    assert.equal(update.outcome, 'accepted');
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 2);
  } finally {
    cleanup();
  }
});

test('gateway replays a semantic intent and rejects edited content for that same intent', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const first = input('decision:fixture-same-intent');
    const accepted = await gateway.write(first);
    const replay = await gateway.write({
      ...first,
      context: { ...first.context, request_id: 'request-fixture-same-intent-retry' },
    });
    const conflict = await gateway.write({ ...first, summary: 'changed content' });

    assert.equal(accepted.outcome, 'accepted');
    assert.deepEqual(replay, { outcome: 'accepted', stored: true, id: accepted.id, replayed: true });
    assert.deepEqual(conflict, {
      outcome: 'rejected', stored: false, reason: 'idempotency_key_reused_with_different_payload',
    });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 1);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE reason = 'idempotency_key_reused_with_different_payload'"), 1);
  } finally {
    cleanup();
  }
});

test('gateway binds a replayed intent to its original provenance', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const first = input('decision:fixture-provenance');
    const accepted = await gateway.write(first);
    const changedProject = await gateway.write({
      ...first,
      context: { ...first.context, request_id: 'request-fixture-provenance-project', project_id: 'another-project' },
    });
    const changedEvidence = await gateway.write({
      ...first,
      context: {
        ...first.context,
        request_id: 'request-fixture-provenance-evidence',
        evidence_ref: 'workspace:tests/other.test.ts#L1',
      },
    });

    assert.equal(accepted.outcome, 'accepted');
    assert.deepEqual(changedProject, {
      outcome: 'rejected', stored: false, reason: 'idempotency_key_reused_with_different_provenance',
    });
    assert.deepEqual(changedEvidence, {
      outcome: 'rejected', stored: false, reason: 'idempotency_key_reused_with_different_provenance',
    });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 1);
    assert.equal(
      count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE reason = 'idempotency_key_reused_with_different_provenance'"),
      2,
    );
  } finally {
    cleanup();
  }
});

test('gateway rejects malformed evidence references before storage', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const result = await gateway.write(input('bad-evidence', {
      context: { ...context('bad-evidence'), evidence_ref: 'opaque evidence text' },
    }));
    assert.deepEqual(result, { outcome: 'rejected', stored: false, reason: 'invalid_evidence_ref' });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 0);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE reason = 'invalid_evidence_ref'"), 1);
  } finally {
    cleanup();
  }
});

test('gateway accepts only portable evidence references and durable retention', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    assert.equal((await gateway.write(input('evidence-memory', {
      context: { ...context('evidence-memory'), evidence_ref: 'memory:42' },
    }))).outcome, 'accepted');
    assert.equal((await gateway.write(input('evidence-url', {
      context: { ...context('evidence-url'), evidence_ref: 'url:https://example.com/evidence' },
    }))).outcome, 'accepted');

    const nonDurable = input('non-durable', {
      context: { ...context('non-durable'), retention_intent: 'ephemeral' as never },
    });
    assert.deepEqual(await gateway.write(nonDurable), {
      outcome: 'rejected', stored: false, reason: 'retention_intent_must_be_durable',
    });
    assert.deepEqual(await gateway.write(input('no-forget-after', { forget_after: '2026-08-09' })), {
      outcome: 'rejected', stored: false, reason: 'forget_after_is_not_available_through_gateway',
    });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 2);
  } finally {
    cleanup();
  }
});

test('gateway rejects writes after the configured per-session ceiling', async () => {
  const { store, gateway, cleanup } = fixture(1);
  try {
    const firstInput = input('quota-first');
    const first = await gateway.write(firstInput);
    const replay = await gateway.write({
      ...firstInput,
      context: { ...firstInput.context, request_id: 'request-quota-first-retry' },
    });
    const second = await gateway.write(input('quota-second'));
    const conflict = await gateway.write({ ...firstInput, summary: 'edited after quota is full' });
    assert.equal(first.outcome, 'accepted');
    assert.deepEqual(replay, { outcome: 'accepted', stored: true, id: first.id, replayed: true });
    assert.deepEqual(second, {
      outcome: 'rejected', stored: false, reason: 'gateway_session_write_limit_exceeded',
    });
    assert.deepEqual(conflict, {
      outcome: 'rejected', stored: false, reason: 'idempotency_key_reused_with_different_payload',
    });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_requests WHERE outcome = 'accepted'"), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_requests WHERE reason IS NOT NULL"), 0);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE reason = 'gateway_session_write_limit_exceeded'"), 1);
  } finally {
    cleanup();
  }
});

test('gateway updates consume the same session allowance as writes', async () => {
  const { store, gateway, cleanup } = fixture(1);
  try {
    const parent = await gateway.write(input('update-quota-parent'));
    assert.equal(parent.outcome, 'accepted');
    assert.deepEqual(await gateway.update(input('update-quota-child', { parent_id: parent.id })), {
      outcome: 'rejected', stored: false, reason: 'gateway_session_write_limit_exceeded',
    });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 1);
  } finally {
    cleanup();
  }
});

test('concurrent gateway processes cannot bypass the per-session ceiling', async () => {
  const { store, cleanup } = fixture(1);
  try {
    const [left, right] = await Promise.all([
      runConcurrentGatewayWorker(store.db.name, 'concurrent-left'),
      runConcurrentGatewayWorker(store.db.name, 'concurrent-right'),
    ]);
    assert.equal(left.code, 0, left.error);
    assert.equal(right.code, 0, right.error);
    const results = [left, right].map(result => JSON.parse(result.output) as { outcome: string; reason?: string });
    assert.equal(results.filter(result => result.outcome === 'accepted').length, 1);
    assert.equal(results.filter(result => result.reason === 'gateway_session_write_limit_exceeded').length, 1);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 1);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_requests WHERE outcome = 'accepted'"), 1);
  } finally {
    cleanup();
  }
});

test('concurrent reuse of one intent with different content is rejected deterministically', async () => {
  const { store, cleanup } = fixture(2);
  try {
    const [left, right] = await Promise.all([
      runConcurrentGatewayWorker(store.db.name, 'concurrent-same-intent', 'first concurrent content'),
      runConcurrentGatewayWorker(store.db.name, 'concurrent-same-intent', 'second concurrent content'),
    ]);
    assert.equal(left.code, 0, left.error);
    assert.equal(right.code, 0, right.error);
    const results = [left, right].map(result => JSON.parse(result.output) as { outcome: string; reason?: string });
    assert.equal(results.filter(result => result.outcome === 'accepted').length, 1);
    assert.equal(results.filter(result => result.reason === 'idempotency_key_reused_with_different_payload').length, 1);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 1);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 1);
  } finally {
    cleanup();
  }
});

test('concurrent rejected requests are audited without reserving their intent key', async () => {
  const { store, cleanup } = fixture();
  try {
    const [left, right] = await Promise.all([
      runConcurrentGatewayWorker(store.db.name, 'concurrent-invalid', 'same content', 'invalid evidence'),
      runConcurrentGatewayWorker(store.db.name, 'concurrent-invalid', 'same content', 'invalid evidence'),
    ]);
    assert.equal(left.code, 0, left.error);
    assert.equal(right.code, 0, right.error);
    const results = [left, right].map(result => JSON.parse(result.output) as { outcome: string; reason?: string });
    assert.equal(results.filter(result => result.reason === 'invalid_evidence_ref').length, 2);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 0);
    assert.equal(count(store.db, "SELECT COUNT(*) AS count FROM memory_gateway_audit WHERE reason = 'invalid_evidence_ref'"), 2);
  } finally {
    cleanup();
  }
});

test('gateway returns a controlled error when a rejection cannot be audited', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    store.db.exec(`
      CREATE TRIGGER fail_gateway_rejection_audit BEFORE INSERT ON memory_gateway_audit
      BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;
    `);
    const invalid = input('audit-unavailable');
    delete invalid.context.evidence_ref;
    assert.deepEqual(await gateway.write(invalid), {
      outcome: 'rejected', stored: false, reason: 'gateway_audit_unavailable',
    });
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 0);
  } finally {
    cleanup();
  }
});

test('gateway clamps direct recent-list requests to the exposed bounds', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    for (let index = 0; index < 21; index++) {
      await store.storeMemory({
        title: `read bound fixture ${index}`,
        tags: 'fixture',
        summary: `read bound summary ${index}`,
        type: 'work',
        force: true,
        embed: 'defer',
      });
    }
    assert.equal(gateway.listRecent({ count: -100 }).length, 1);
    assert.equal(gateway.listRecent({ count: 100 }).length, 20);
  } finally {
    cleanup();
  }
});

test('legacy MemoryStore writes intentionally do not create gateway ledger rows', async () => {
  const { store, cleanup } = fixture();
  try {
    const result = await store.storeMemory({
      title: 'legacy direct store', tags: 'fixture', summary: 'legacy path', type: 'work', force: true, embed: 'defer',
    });
    assert.equal(result.stored, true);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_audit'), 0);
  } finally {
    cleanup();
  }
});

test('gateway configuration fails closed without complete adapter identity', () => {
  assert.throws(() => gatewayConfigFromEnvironment({}), /gateway requires/);
});

test('gateway rejects permanent-static writes and its audit records are append-only', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const result = await gateway.write(input('static', { is_static: true }));
    assert.deepEqual(result, {
      outcome: 'rejected', stored: false, reason: 'is_static_is_not_available_through_gateway',
    });
    assert.throws(
      () => store.db.prepare('UPDATE memory_gateway_audit SET reason = ?').run('tamper'),
      /append-only/,
    );
    assert.equal((await gateway.write(input('append-only-ledger'))).outcome, 'accepted');
    assert.throws(
      () => store.db.prepare('DELETE FROM memory_gateway_requests').run(),
      /append-only/,
    );
  } finally {
    cleanup();
  }
});

test('gateway updates only through an explicit parent and keeps latest indexes consistent', async () => {
  const { store, gateway, cleanup } = fixture();
  try {
    const parent = await gateway.write(input('parent'));
    assert.equal(parent.outcome, 'accepted');
    const child = await gateway.update(input('child', { parent_id: parent.id }));
    assert.equal(child.outcome, 'accepted');
    assert.ok(parent.id);
    assert.ok(child.id);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories WHERE root_id = ? AND is_latest = 1', parent.id), 1);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', parent.id), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories_fts WHERE rowid = ?', child.id), 1);
  } finally {
    cleanup();
  }
});

test('an audit failure rolls back the candidate memory and index write', async () => {
  const { store, cleanup } = fixture();
  try {
    store.db.exec(`
      CREATE TRIGGER fail_gateway_audit BEFORE INSERT ON memory_gateway_audit
      BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;
    `);
    const audit: GatewayAuditRecord = {
      request_id: 'atomic-request',
      runtime_id: 'codex',
      client_id: 'fixture-codex',
      session_id: 'adapter-session-fixture',
      project_id: 'project-memory-server',
      evidence_ref: 'workspace:tests/gateway.test.ts#L1',
      retention_intent: 'durable',
      idempotency_key: 'atomic-key',
      operation: 'memory_write',
      payload_hash: 'a'.repeat(64),
    };
    await assert.rejects(store.storeMemoryWithGatewayAudit({
      title: 'atomic fixture', tags: 'fixture', summary: 'must roll back', type: 'work', embed: 'defer',
    }, audit, 1), /fixture audit failure/);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories_fts'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 0);
  } finally {
    cleanup();
  }
});

test('database rejects an accepted gateway write with incomplete provenance', async () => {
  const { store, cleanup } = fixture();
  try {
    const audit: GatewayAuditRecord = {
      request_id: 'missing-retention-request',
      runtime_id: 'codex',
      client_id: 'fixture-codex',
      session_id: 'adapter-session-fixture',
      project_id: 'project-memory-server',
      evidence_ref: 'workspace:tests/gateway.test.ts#L1',
      retention_intent: null,
      idempotency_key: 'missing-retention-key',
      operation: 'memory_write',
      payload_hash: 'b'.repeat(64),
    };
    await assert.rejects(store.storeMemoryWithGatewayAudit({
      title: 'incomplete gateway audit', tags: 'fixture', summary: 'must not commit', type: 'work', embed: 'defer',
    }, audit, 1), /chk_gateway_ledger_committed_write/);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memories'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) AS count FROM memory_gateway_requests'), 0);
  } finally {
    cleanup();
  }
});
