#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import { defaultDbPath } from '../src/host-role.js';

const dbPath = process.env.MEMORY_DB_PATH || defaultDbPath(); // 默认路径按 ~/.claude-host 角色

const db = new Database(dbPath, {
  readonly: true,
  fileMustExist: true,
});

try {
  db.pragma('query_only=ON');
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  const userVersion = db.pragma('user_version', { simple: true }) as number;
  const memories = db.prepare("select count(*) as count from memories where status = 'active' and is_latest = 1").get() as { count: number };
  const entities = db.prepare("select count(*) as count from entities").get() as { count: number };

  console.log(JSON.stringify({
    dbPath,
    integrity,
    userVersion,
    activeLatestMemories: memories.count,
    entities: entities.count,
  }, null, 2));

  if (integrity !== 'ok') {
    process.exitCode = 2;
  }
} finally {
  db.close();
}

