#!/usr/bin/env node
// memory-detect-project — UserPromptSubmit hook 阶段 1：纯 SQL 子串匹配
// 输入：--text <prompt> --workspace <root>
// 输出：JSON 数组到 stdout，每项 { id, name, path }
//
// 设计：直接开 better-sqlite3 read-only，跳过 MemoryStore 构造器
// （FTS rebuild + embedding service 启动会到 1.2s）。目标冷启 <50ms。

import Database from 'better-sqlite3';
import { detectProjectMentionsRaw } from './store.js';
import { defaultDbPath } from './host-role.js';

interface CliArgs {
  text: string;
  workspace: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  if (!args.text) {
    process.stderr.write('Usage: memory-detect-project --text <prompt> --workspace <root>\n');
    process.exit(2);
  }
  return {
    text: args.text,
    workspace: args.workspace || process.cwd(),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // 默认路径由 ~/.claude-host 角色决定（main → ~/Data/memory，air → ~/Data/memory-air）
  const dbPath = process.env.MEMORY_DB_PATH || defaultDbPath();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const rows = db.prepare(`
      SELECT id, name, aliases, attributes
      FROM entities
      WHERE status = 'active' AND category = 'project'
    `).all() as Array<{ id: number; name: string; aliases: string; attributes: string }>;

    const matches = detectProjectMentionsRaw(args.text, rows, args.workspace);
    process.stdout.write(JSON.stringify(matches));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`[memory-detect-project] ${(err as Error).stack || err}\n`);
  process.stdout.write('[]');
  process.exit(0);
}
