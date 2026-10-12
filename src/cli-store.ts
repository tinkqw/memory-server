#!/usr/bin/env node
// memory-store CLI — 直连 MemoryStore.storeMemory()，绕过 MCP 协议。
// 用途：被 Python/Shell 脚本调用，避免为了"写一行 SQLite"而 spawn 完整 claude -p + 全 MCP 启动。
// 典型场景：定时摘要脚本把 LLM 生成与 memory 写入解耦后的写入端。
//
// 输入：stdin 读 JSON（StoreMemoryParams 子集）
// 输出（stdout）：
//   - 写入成功：`MEMORY_ID=<n>`（再无其他行）
//   - 检测到相似且未 force：`MEMORY_ID=SIMILAR similar_id=<n>`（exit 0）
//   - 其他失败：stderr 写 reason，exit 1
//
// 用法：
//   echo '{"title":"...","summary":"...","tags":"...","type":"work","force":true}' \
//     | node dist/cli-store.js
//
// 不接受命令行 JSON 参数（避免 shell escape 难度 + arg length 上限）。

import { MemoryStore } from './store.js';
import type { StoreMemoryParams } from './types.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('[cli-store] empty stdin; expect JSON of StoreMemoryParams\n');
    process.exit(2);
  }

  let params: StoreMemoryParams;
  try {
    params = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[cli-store] invalid JSON: ${(err as Error).message}\n`);
    process.exit(2);
  }

  if (!params.title || !params.summary || !params.type) {
    process.stderr.write('[cli-store] missing required field(s): title / summary / type\n');
    process.exit(2);
  }
  if (params.tags === undefined) params.tags = '';

  process.env.MEMORY_SOURCE = process.env.MEMORY_SOURCE || 'cli-store';

  // 短命写入 CLI：把 embedding 移出写路径。embed='defer' → storeMemory 纯 FTS 写、不 fork BGE-M3 worker；
  // skipBackfill=true → 构造时不跑 backfill（同样会 fork worker）。两者合起来本进程零 worker fork，
  // 写入退化为确定性 SQLite（busy_timeout 封顶），彻底消除「embedding 挂起拖到父进程 60s 超时丢 digest」。
  // 向量由常驻 daemon（MCP / bot）的 backfillEmbeddings 后补——补向量是 daemon 的职责，不是写入端的。
  // （旧做法 process.env.EMBED_FAST_FAIL=1 因 ESM import 提升：在 main() 里设置太晚，
  //   embedding-service.ts 顶层 const FAST_FAIL 早在 import 阶段已求值为 false → 兜底从未生效。）
  if (params.embed === undefined) params.embed = 'defer';

  const store = new MemoryStore(undefined, { skipBackfill: true });
  let exitCode = 0;
  try {
    const result = await store.storeMemory(params);
    if (result.stored && result.id) {
      process.stdout.write(`MEMORY_ID=${result.id}\n`);
    } else if (result.reason === 'similar_found' && result.similar_id) {
      process.stdout.write(`MEMORY_ID=SIMILAR similar_id=${result.similar_id}\n`);
      process.stderr.write(`[cli-store] similar_found: ${result.similar_title ?? ''}\n`);
    } else {
      process.stderr.write(`[cli-store] store failed: ${result.reason ?? 'unknown'}\n`);
      exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`[cli-store] exception: ${(err as Error).stack ?? err}\n`);
    exitCode = 1;
  }
  // 不调 store.close()：BGE-M3 native worker 在进程退出时存在 mutex 竞态（exit 134），
  // 让 OS 回收资源即可。SQLite 写已经 fsync，无丢失风险。
  // 强制 _exit 绕过 worker 清理，避免 native abort 污染 exit code。
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).reallyExit ? (process as any).reallyExit(exitCode) : process.exit(exitCode);
    });
  });
}

main();
