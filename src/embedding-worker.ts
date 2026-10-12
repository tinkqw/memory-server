// Embedding Worker — isolated child process for ONNX inference.
// 把 BGE-M3 (onnxruntime-node) 推理隔离到独立子进程，防止 native C++ mutex
// 崩溃/挂起（SIGABRT）拖垮主进程（cli-store / MCP server）。
// 移植自另一个服务里已验证的方案。ESM 模块，由父进程 fork 调起。

const MODEL_NAME = 'Xenova/bge-m3';
const MAX_TEXT_LENGTH = 8000;

let extractor: any = null;

function log(level: string, msg: string, meta?: any): void {
  const ts = new Date().toISOString();
  const line = meta
    ? `[${ts}] [${level}] [EmbeddingWorker] ${msg} ${JSON.stringify(meta)}`
    : `[${ts}] [${level}] [EmbeddingWorker] ${msg}`;
  // 统一走 stderr，避免污染父进程对 cli-store stdout 的 MEMORY_ID 解析
  console.error(line);
}

async function loadModel(): Promise<boolean> {
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = process.env.HF_CACHE_DIR || `${process.env.HOME}/.cache/memory-server/models`;
    log('INFO', 'Loading BGE-M3 model...');
    extractor = await pipeline('feature-extraction', MODEL_NAME, { dtype: 'q8' });
    log('INFO', 'BGE-M3 loaded (local, 1024d)');
    return true;
  } catch (err: any) {
    log('ERROR', 'Failed to load BGE-M3', { error: err?.message });
    return false;
  }
}

async function embed(text: string): Promise<number[] | null> {
  if (!extractor) return null;
  try {
    const output = await extractor(text.substring(0, MAX_TEXT_LENGTH), {
      pooling: 'cls',
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  } catch (err: any) {
    log('ERROR', 'Embed failed', { error: err?.message });
    return null;
  }
}

async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

function safeSend(msg: any): void {
  try {
    if (process.send) process.send(msg);
  } catch {
    // 父进程已退出 — 无需处理，disconnect 会触发自身退出
  }
}

process.on('message', async (msg: any) => {
  try {
    if (msg.type === 'embed') {
      const result = await embed(msg.text);
      safeSend({ type: 'result', id: msg.id, data: result });
    } else if (msg.type === 'embedBatch') {
      const result = await embedBatch(msg.texts);
      safeSend({ type: 'batchResult', id: msg.id, data: result });
    }
  } catch (err: any) {
    log('ERROR', 'Message handler error', { error: err?.message });
    safeSend({ type: msg.type === 'embedBatch' ? 'batchResult' : 'result', id: msg.id, data: null });
  }
});

// 父进程断开 IPC（含 reallyExit / kill）时自我了断，避免 orphan
process.on('disconnect', () => process.exit(0));

(async () => {
  const ok = await loadModel();
  safeSend({ type: 'ready', available: ok });
})();
