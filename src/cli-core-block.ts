#!/usr/bin/env node
// memory-core-block CLI — emits markdown core block for SessionStart hook injection.
// Commit 2: real data from MemoryStore + PROJECT.md/HANDOFF.md parsing + entity co-occurrence.

import path from 'node:path';
import fs from 'node:fs';
import { MemoryStore } from './store.js';
import type { MemoryRecord } from './types.js';

interface CliArgs {
  project?: string;
  cwd?: string;
  days: number;
  top: number;
  maxChars: number;
}

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

  if (!args.project && !args.cwd) {
    process.stderr.write('Usage: memory-core-block (--project <name> | --cwd <path>) [--days 30] [--top 8] [--max-chars 8000]\n');
    process.exit(2);
  }

  return {
    project: args.project,
    cwd: args.cwd,
    days: args.days ? parseInt(args.days, 10) : 30,
    top: args.top ? parseInt(args.top, 10) : 8,
    maxChars: args['max-chars'] ? parseInt(args['max-chars'], 10) : 8000,
  };
}

function findProjectMd(startDir: string): string | null {
  // 归档项目跳过（design 风险条目：_archived/ 下的旧 HANDOFF 不维护，识别到会输出脏内容）
  if (startDir.includes('/_archived/')) return null;

  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, 'PROJECT.md');
    if (fs.existsSync(f)) return f;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 判断 cwd 是否位于 Claude workspace 内（用 .claude/settings.json 作为锚点）
function findWorkspaceRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'settings.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readProjectName(projectMdPath: string): string | null {
  try {
    const content = fs.readFileSync(projectMdPath, 'utf8');
    const m = content.match(/^#\s*PROJECT\s*[—\-]\s*(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// HANDOFF 缺失时的 fallback：取 PROJECT.md H1 后第一段非引用的正文
function readProjectPreamble(projectMdPath: string): string | null {
  try {
    const content = fs.readFileSync(projectMdPath, 'utf8');
    const afterH1 = content.replace(/^#[^\n]*\n+/, '');
    // 丢掉 "> 更新时间" 等元信息引用块
    const stripped = afterH1.replace(/^>[^\n]*\n+/gm, '');
    const firstPara = stripped.trim().split(/\n\s*\n/)[0];
    if (!firstPara) return null;
    return firstPara.replace(/\s+/g, ' ').trim().slice(0, 250);
  } catch { return null; }
}

interface HandoffSections {
  current: string;
  inProgress: string[];
  todo: string[];
  paused: boolean;
}

function parseHandoff(handoffPath: string): HandoffSections | null {
  if (!fs.existsSync(handoffPath)) return null;

  let content: string;
  try { content = fs.readFileSync(handoffPath, 'utf8'); }
  catch { return null; }

  const lines = content.split('\n');
  const sections: Record<string, string[]> = {};
  let currentSection = '';
  let buf: string[] = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (currentSection) sections[currentSection] = buf;
      currentSection = m[1].trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (currentSection) sections[currentSection] = buf;

  const truncateItem = (s: string, max = 120): string => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  };

  const extractItems = (sectionLines: string[]): string[] => {
    // 仅取 list 顶层项，丢弃缩进的 sub-bullet（避免一项跨多行被截碎）
    return sectionLines
      .map(l => {
        const m = l.match(/^-\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/);
        return m ? truncateItem(m[1]) : null;
      })
      .filter((s): s is string => s !== null && s !== '无' && s.length > 0);
  };

  const collapseWhitespace = (s: string) => s.replace(/\s+/g, ' ').trim();
  const paused = /状态：已暂停/.test(content);

  return {
    current: collapseWhitespace((sections['当前状态'] ?? []).join(' ')).slice(0, 300),
    inProgress: extractItems(sections['进行中'] ?? []).slice(0, 3),
    todo: extractItems(sections['待实现'] ?? []).slice(0, 5),
    paused,
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

interface Context {
  projectName: string;
  aliases: string[];
  entityId?: number;
  projectDir?: string;
}

function resolveProject(args: CliArgs, store?: MemoryStore): Context | null {
  if (args.cwd) {
    const md = findProjectMd(args.cwd);
    if (md) {
      const name = readProjectName(md);
      if (name) return { projectName: name, aliases: [], projectDir: path.dirname(md) };
    }
  }
  if (args.project && store) {
    // 从 entity attributes.path 反查 projectDir（P1-redo）
    const entity = store.getEntity({ name: args.project });
    if (entity) {
      const attrs = entity.attributes || {};
      const relPath = typeof attrs.path === 'string' ? attrs.path : null;
      if (relPath && !relPath.includes('/_archived/')) {
        const wsRoot = args.cwd ? findWorkspaceRoot(args.cwd) : null;
        const absPath = relPath.startsWith('/')
          ? relPath
          : (wsRoot ? path.join(wsRoot, relPath) : null);
        if (absPath && fs.existsSync(absPath)) {
          return {
            projectName: entity.name,
            aliases: Array.isArray(entity.aliases) ? entity.aliases : [],
            entityId: entity.id,
            projectDir: absPath,
          };
        }
      }
      // entity 存在但无可用 path：仍返回 name + aliases，HANDOFF/PROJECT.md 段会显示 fallback
      return {
        projectName: entity.name,
        aliases: Array.isArray(entity.aliases) ? entity.aliases : [],
        entityId: entity.id,
      };
    }
    return { projectName: args.project, aliases: [] };
  }
  if (args.project) {
    return { projectName: args.project, aliases: [] };
  }
  return null;
}

function renderCoreBlock(opts: {
  ctx: Context;
  handoff: HandoffSections | null;
  projectPreamble: string | null;
  memories: MemoryRecord[];
  coEntities: Array<{ id: number; name: string; aliases: string[]; mentions: number }>;
  days: number;
  top: number;
}): string {
  const { ctx, handoff, projectPreamble, memories, coEntities, days, top } = opts;
  const out: string[] = [];

  out.push(`## 🧠 项目记忆 — ${ctx.projectName}`);
  if (ctx.aliases.length > 0) {
    out.push(`> aliases: ${ctx.aliases.join(' / ')}`);
  }
  out.push('');

  // 当前状态
  out.push('### 当前状态');
  if (handoff) {
    if (handoff.paused) out.push('> ⏸️ 已暂停');
    if (handoff.current) out.push(handoff.current);
    if (handoff.inProgress.length > 0) {
      out.push('');
      out.push('**进行中**：');
      for (const item of handoff.inProgress) out.push(`- ${item}`);
    }
    if (handoff.todo.length > 0) {
      out.push('');
      out.push(`**待实现**（前 ${handoff.todo.length}）：`);
      for (const item of handoff.todo) out.push(`- ${item}`);
    }
  } else if (projectPreamble) {
    out.push(`> _HANDOFF.md 未找到，降级到 PROJECT.md 描述_`);
    out.push(projectPreamble);
  } else {
    out.push('_无 HANDOFF.md 或 PROJECT.md 描述可用_');
  }
  out.push('');

  // 近期记忆
  out.push(`### 近期相关记忆（${days}d, top ${top}）`);
  if (memories.length === 0) {
    out.push('_无匹配记忆_');
  } else {
    memories.forEach((m, i) => {
      const meta = m.score !== undefined
        ? `[score=${m.score.toFixed(2)}, ${formatAge(m.created_at)}]`
        : `[${formatAge(m.created_at)}]`;
      out.push(`[${i + 1}] #${m.id} ${meta} ${m.title}`);
      const summarySnip = m.summary.replace(/\s+/g, ' ').trim().slice(0, 100);
      if (summarySnip) out.push(`    ${summarySnip}`);
    });
  }
  out.push('');

  // 项目相关 entity
  out.push('### 项目相关 entity');
  if (coEntities.length === 0) {
    out.push('_无共现 entity_');
  } else {
    for (const e of coEntities) {
      const aliasStr = e.aliases.length > 0 ? ` (${e.aliases.join(', ')})` : '';
      out.push(`- **${e.name}**${aliasStr} — ${e.mentions} 次共现`);
    }
  }

  return out.join('\n') + '\n';
}

function renderWorkspaceFallback(memories: MemoryRecord[]): string {
  const out: string[] = [];
  out.push('## 🧠 Workspace 通用记忆 — 全局近期');
  out.push('> _未识别到项目（cwd 无 PROJECT.md），降级到 workspace 级最近记忆_');
  out.push('');
  if (memories.length === 0) {
    out.push('_暂无近期记忆_');
  } else {
    memories.forEach((m, i) => {
      out.push(`[${i + 1}] #${m.id} [${formatAge(m.created_at)}] ${m.title}`);
      const summarySnip = m.summary.replace(/\s+/g, ' ').trim().slice(0, 100);
      if (summarySnip) out.push(`    ${summarySnip}`);
    });
  }
  return out.join('\n') + '\n';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.MEMORY_SOURCE = process.env.MEMORY_SOURCE || 'session-hook';

  const store = new MemoryStore();
  const ctx = resolveProject(args, store);

  // Workspace 级降级：找不到项目但 cwd 在 workspace 内 → 输出 listRecent fallback
  // cwd 在 workspace 外 → 静默退出（Q5）
  if (!ctx) {
    try {
      const workspace = args.cwd ? findWorkspaceRoot(args.cwd) : null;
      if (!workspace) {
        process.stderr.write('[memory-core-block] no project resolved and cwd outside workspace, skip\n');
        return;
      }
      const recent = store.listRecent({ count: 5 });
      let output = renderWorkspaceFallback(recent);
      if (output.length > args.maxChars) {
        output = output.slice(0, args.maxChars - 20) + '\n\n_(truncated)_\n';
      }
      process.stdout.write(output);
    } finally {
      store.close();
    }
    return;
  }

  try {
    // 查 entity（拿 aliases 和 id）— 仅 cwd 路径下需要补查；--project 路径已在 resolveProject 内做过
    if (ctx.entityId === undefined) {
      const entity = store.getEntity({ name: ctx.projectName });
      if (entity) {
        ctx.entityId = entity.id;
        ctx.aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
      }
    }

    // searchMemory: 用 name + aliases 拼 OR query，date_from = today - Nd
    const queryTerms = [ctx.projectName, ...ctx.aliases].filter(t => t && t.length >= 2);
    const query = queryTerms.join(' ');
    const dateFrom = new Date(Date.now() - args.days * 86400_000).toISOString().slice(0, 10);

    const memories = await store.searchMemory({
      query,
      date_from: dateFrom,
      limit: args.top,
    });

    // HANDOFF（缺失时降级到 PROJECT.md preamble）
    const handoff = ctx.projectDir ? parseHandoff(path.join(ctx.projectDir, 'HANDOFF.md')) : null;
    const projectPreamble = (!handoff && ctx.projectDir)
      ? readProjectPreamble(path.join(ctx.projectDir, 'PROJECT.md'))
      : null;

    // 共现 entity
    const coEntities = ctx.entityId ? store.getCoOccurringEntities(ctx.entityId, 10) : [];

    let output = renderCoreBlock({
      ctx,
      handoff,
      projectPreamble,
      memories,
      coEntities,
      days: args.days,
      top: args.top,
    });

    if (output.length > args.maxChars) {
      output = output.slice(0, args.maxChars - 20) + '\n\n_(truncated)_\n';
    }

    process.stdout.write(output);
  } finally {
    store.close();
  }
}

main().catch(err => {
  // 失败静默降级（Q5）
  process.stderr.write(`[memory-core-block] ${(err as Error).stack || err}\n`);
  process.exit(0);
});
