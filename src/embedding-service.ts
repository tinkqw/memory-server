// Embedding Service — IPC client to an isolated ONNX worker process.
// BGE-M3 (onnxruntime-node) 在 Node 22 + macOS arm64 上有间歇性 native mutex
// 崩溃/挂起。把推理放到 fork 出的子进程，配合请求超时 +
// 崩溃自动重启 + 失败返回 null，使 embedding 故障对 storeMemory「非致命降级」
// （embed 返回 null → 存 FTS-only，embedding 由 backfillEmbeddings 后续补全）。
//
// 接口与旧 in-process 版本保持一致：embed / embedBatch / isAvailable / modelName
// + static cosineSimilarity / findTopK，store.ts 无需改动。

import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const MODEL_NAME = 'Xenova/bge-m3';
const RESTART_DELAY_MS = 5000;
const RESTART_MAX_ATTEMPTS = 3;
const READY_TIMEOUT_MS = 30000; // worker 必须在 30s 内加载完模型，否则判不可用 → 降级
const REQUEST_TIMEOUT_MS = 25000; // 单条 embed 上限（store 关键路径，须 < 父进程 cli-store 超时）
const BATCH_PER_ITEM_MS = 3000; // embedBatch 每条预算（backfill 后台用，宽松）

// 短命钩子 CLI（cli-observation-block / cli-core-block，每条 prompt 新起一个进程）设
// EMBED_FAST_FAIL=1：不重启 + 就绪等待收紧到 6s，让 embedding 故障在钩子 10s 外层
// alarm 预算内 fail-fast 降级到 FTS；而非走 MCP 常驻进程那套 30s 就绪 + 3 次重启退避
// （累计挂 30-60s → 被 alarm 砍成 exit=124 → 静默丢检索，2026-05-31 实测）。
const FAST_FAIL = process.env.EMBED_FAST_FAIL === '1';
const EFFECTIVE_READY_TIMEOUT_MS = FAST_FAIL ? 6000 : READY_TIMEOUT_MS;
const EFFECTIVE_MAX_RESTARTS = FAST_FAIL ? 0 : RESTART_MAX_ATTEMPTS;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class EmbeddingService {
  private worker: ChildProcess | null = null;
  private _isAvailable = false;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private restartAttempts = 0;
  private shuttingDown = false;

  constructor() {
    this.ready = new Promise(resolve => { this.readyResolve = resolve; });
    this.spawnWorker();
  }

  private spawnWorker(): void {
    const workerPath = path.join(__dirname, 'embedding-worker.js');
    this.worker = fork(workerPath, [], { silent: false });

    // 就绪看门狗：worker 卡在模型加载（never 'ready'）时，超时判不可用，
    // 让 `await this.ready` 解阻塞 → embed 返回 null → FTS 降级。
    // 短命进程（cli-store）尤其依赖此边界，否则会和旧版一样无限挂起。
    this.readyTimer = setTimeout(() => {
      if (!this._isAvailable) {
        console.error('[EmbeddingService] worker not ready within timeout, marking unavailable');
        this.readyResolve();
      }
    }, EFFECTIVE_READY_TIMEOUT_MS);
    this.readyTimer.unref?.();

    this.worker.on('message', (msg: any) => {
      if (msg.type === 'ready') {
        this._isAvailable = msg.available;
        this.restartAttempts = 0;
        if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
        this.readyResolve();
        console.error(`[EmbeddingService] worker ready (available=${msg.available})`);
      } else if (msg.type === 'result' || msg.type === 'batchResult') {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          pending.resolve(msg.data);
        }
      }
    });

    this.worker.on('exit', (code, signal) => {
      console.error(`[EmbeddingService] worker exited (code=${code}, signal=${signal})`);
      this._isAvailable = false;

      // 拒绝所有挂起请求 → 调用方拿到 null → 降级
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Embedding worker crashed'));
      }
      this.pendingRequests.clear();

      if (this.shuttingDown) return;

      // 退避自动重启（仅对常驻进程如 MCP server 有意义；短命 CLI FAST_FAIL=0 不重启）
      if (this.restartAttempts < EFFECTIVE_MAX_RESTARTS) {
        this.restartAttempts++;
        const delay = RESTART_DELAY_MS * this.restartAttempts;
        console.error(`[EmbeddingService] restarting worker (attempt ${this.restartAttempts}, delay ${delay}ms)`);
        this.ready = new Promise(resolve => { this.readyResolve = resolve; });
        const t = setTimeout(() => this.spawnWorker(), delay);
        t.unref?.();
      } else {
        // 永久不可用：立即解阻塞所有 awaiter（embed → null → FTS 降级），
        // 不再让其干等悬空的 readyTimer（旧洞：await this.ready 挂到 30s）。
        console.error('[EmbeddingService] worker exceeded max restart attempts, disabling');
        if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
        this.readyResolve();
      }
    });
  }

  private sendRequest(type: 'embed' | 'embedBatch', payload: Record<string, any>, timeoutMs: number): Promise<any> {
    if (!this.worker || !this._isAvailable) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Embedding request timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.worker!.send({ ...payload, type, id });
    });
  }

  get isAvailable(): boolean {
    return this._isAvailable;
  }

  /** 是否为短命 CLI 模式（EMBED_FAST_FAIL=1）。后台任务据此决定「等就绪」还是「立即降级」 */
  get isFastFail(): boolean {
    return FAST_FAIL;
  }

  /**
   * 等 worker 就绪（或就绪看门狗超时判不可用）后返回。
   *
   * 为什么需要它：`isAvailable` 是同步字段，构造后要等 worker 加载完模型才会变 true。
   * 常驻进程里在构造阶段就同步读它的后台任务（backfillEmbeddings）永远读到 false 而直接 return，
   * 表现是「补齐任务从来没跑过」，且无任何报错 —— 2026-08-29 实测 18 条无向量记忆
   * 在 daemon 反复重启两个月后仍未被补上，即此因。需要等就绪的调用方用本方法，
   * 不要自己读 `isAvailable`。
   */
  async waitUntilReady(): Promise<void> {
    await this.ready;
  }

  get modelName(): string {
    return MODEL_NAME;
  }

  async embed(
    text: string,
    _taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' = 'RETRIEVAL_DOCUMENT',
  ): Promise<number[] | null> {
    await this.ready;
    if (!this._isAvailable) return null;
    try {
      return await this.sendRequest('embed', { text }, REQUEST_TIMEOUT_MS);
    } catch (err: any) {
      console.error('[EmbeddingService] embed failed:', err?.message);
      return null;
    }
  }

  async embedBatch(
    texts: string[],
    _taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' = 'RETRIEVAL_DOCUMENT',
  ): Promise<(number[] | null)[]> {
    await this.ready;
    if (!this._isAvailable) return texts.map(() => null);
    // backfill 一次最多 100 条；超时按条数放宽，下限 30s
    const timeoutMs = Math.max(30000, texts.length * BATCH_PER_ITEM_MS);
    try {
      const result = await this.sendRequest('embedBatch', { texts }, timeoutMs);
      return result ?? texts.map(() => null);
    } catch (err: any) {
      console.error('[EmbeddingService] embedBatch failed:', err?.message);
      return texts.map(() => null);
    }
  }

  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  static findTopK(
    queryEmbedding: number[],
    candidates: { id: number; embedding: number[] }[],
    k: number,
    minSimilarity: number = 0.5,
  ): { id: number; similarity: number }[] {
    return candidates
      .map(c => ({
        id: c.id,
        similarity: EmbeddingService.cosineSimilarity(queryEmbedding, c.embedding),
      }))
      .filter(s => s.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
    }
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Shutting down'));
    }
    this.pendingRequests.clear();
  }
}
