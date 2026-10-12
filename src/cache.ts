// TTL-LRU Cache — 零依赖，进程内缓存
// 用于 query embedding、entity lookup、search result 的热路径加速

interface CacheEntry<V> {
  value: V;
  expiry: number; // Date.now() + ttlMs
}

export class TTLCache<V> {
  private map = new Map<string, CacheEntry<V>>();
  private maxSize: number;
  private ttlMs: number;

  constructor(opts: { maxSize: number; ttlMs: number }) {
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiry) {
      this.map.delete(key);
      return undefined;
    }

    // LRU: 重新插入到末尾
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    // 如果已存在，先删除（保证 LRU 顺序）
    this.map.delete(key);

    // 淘汰最旧条目
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }

    this.map.set(key, { value, expiry: Date.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.map.delete(key);
  }

  /** 清空全部缓存 */
  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
