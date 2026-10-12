// 机器角色（可选）：~/.claude-host 写一行 `main` 或 `air`，用于两台机器各跑一份 memory-server。
// 两个角色各有一个库：main → ~/Data/memory，air → ~/Data/memory-air；id 也分段，看 id 就知道来源。
// 单机使用不需要这个文件：缺失或内容不是 air 一律按 main。
// MEMORY_DB_PATH 仍可显式覆盖库路径，优先级高于角色（见 store.ts 构造器）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HostRole = 'main' | 'air';

/** id 段：main [1, 1e6)，air [1e6, 2e6)。memories 与 entities 都按此分配，看 id 就知道来源。 */
export const ID_SEGMENT: Record<HostRole, { start: number; end: number }> = {
  main: { start: 1, end: 1_000_000 },
  air: { start: 1_000_000, end: 2_000_000 },
};

export function hostRoleFile(): string {
  return path.join(os.homedir(), '.claude-host');
}

export function readHostRole(): HostRole {
  let raw = '';
  try {
    raw = fs.readFileSync(hostRoleFile(), 'utf8').trim();
  } catch {
    return 'main';
  }
  if (raw === 'air') return 'air';
  if (raw !== '' && raw !== 'main') {
    console.warn(`[host-role] ${hostRoleFile()} 内容 "${raw}" 不是 main / air，按 main 处理`);
  }
  return 'main';
}

export function memoryDirForRole(role: HostRole = readHostRole()): string {
  return path.join(os.homedir(), 'Data', role === 'air' ? 'memory-air' : 'memory');
}

export function defaultDbPath(role: HostRole = readHostRole()): string {
  return path.join(memoryDirForRole(role), 'memory.db');
}
