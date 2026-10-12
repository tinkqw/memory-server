// SQLite CRUD + FTS5 + sqlite-vec — Memory Store

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import os from 'os';
import fs from 'fs';
import nodejieba from 'nodejieba';
import { EmbeddingService } from './embedding-service.js';
import { TTLCache } from './cache.js';
import { readHostRole, defaultDbPath, ID_SEGMENT, type HostRole } from './host-role.js';

/** 返回北京时间 ISO 格式字符串：YYYY-MM-DDTHH:MM:SS.sss+08:00
 *  确定性实现：手动计算 UTC+8 偏移，不依赖 locale 格式输出 */
function nowBeijing(): string {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc8.getUTCDate()).padStart(2, '0');
  const h = String(utc8.getUTCHours()).padStart(2, '0');
  const mi = String(utc8.getUTCMinutes()).padStart(2, '0');
  const s = String(utc8.getUTCSeconds()).padStart(2, '0');
  const ms = String(utc8.getUTCMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${d}T${h}:${mi}:${s}.${ms}+08:00`;
}

// 启动时校验格式（防止未来重构引入格式变化）
const _tsCheck = nowBeijing();
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/.test(_tsCheck)) {
  throw new Error(`[FATAL] nowBeijing() format assertion failed: ${_tsCheck}`);
}
import { segment, segmentForQuery } from './tokenizer.js';
import {
  type Memory,
  type MemoryType,
  type StoreMemoryParams,
  type SearchMemoryParams,
  type ListRecentParams,
  type ListAllParams,
  type DeleteMemoryParams,
  type RestoreMemoryParams,
  type SupersedeMemoryParams,
  type SupersedeResult,
  type StoreResult,
  type DeleteResult,
  type RestoreResult,
  type MemoryRecord,
  type StoreEntityParams,
  type GetEntityParams,
  type SearchEntityParams,
  type StoreEntityResult,
  type EntityRecord,
  type EntityStatus,
  type GatewayAuditRecord,
  type GatewayLedgerRecord,
  ENTITY_WRITABLE_STATUS,
  normalizeTags,
  sanitize,
  detectToolCallContamination,
} from './types.js';

const SCHEMA_VERSION = 13;
const DUPLICATE_THRESHOLD = 0.85;

// 无 embedding 时的降级去重闸：标题相同**且正文近乎逐字相同**才判重复。
//
// 为什么不能只比标题：这条路径是所有 digest 写入端的实际去重口（cli-store 用
// embed:'defer'，embedding 恒为 null），而 digest 标题是「[渠道 日期] 主题」——
// 同一天同一主题下两封不同的邮件标题必然相同。实测同一线程里一封「确认排期」、
// 一封「回复确认纳入活动」是两件事，只比标题会把
// 后到的那封静默丢掉（SIMILAR 是终态成功，不报错、不重试、不通知）。
//
// 为什么阈值取 0.75 这么高（2026-08-08 实测 12 对同题/近题样本）：
//   必须放行的「同题不同事」区间 0.152–0.405
//   真重复（同一源被 digest 两遍）区间 0.392–0.508
//   两个区间**重叠**——独立两次 LLM 摘要同一份源，措辞差异比两封不同邮件还大，
//   所以文本相似度根本分不开这两类。既然分不开，就只保守拦「几乎逐字相同」的，
//   宁可漏拦重复（重复占空间，可事后合并）也不能误杀独立事件（丢事实，不可见）。
// 真正的根治不在这里：应按**源锚点**去重（doc_token / 邮件 block key），
// 两个 digest 脚本都已各自维护 block 级 state，见 HANDOFF 待办。
const FTS_DUP_JACCARD = 0.75;

/** 字符二元组 Jaccard 相似度（中英混排安全，无需分词）。 */
function jaccardSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return ga.size === gb.size ? 1 : 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

// memory_history 只记**内容变更**，不记检索计数这类元数据 bump。
// 2026-08-08 修：原触发器无 WHEN 守卫，每次检索更新 retrieval_count / last_retrieved_at 都会
// 把整行（含 ~1.5KB summary）复制一份进 history。实测 47,117 行里 100% 的 old_summary 与当前值完全相同
// （即零条真实内容变更），却占掉 77.9 MB / 全库 44%，且随「读」线性增长，每日备份再整份复制一遍。
// 守卫后 history 才真正承担"这条记忆以前写的是什么"的职责。
// 注意：IS NOT 而非 <>，NULL 安全（<> 遇 NULL 返回 NULL，守卫会被静默跳过）。
const MEMORY_HISTORY_WHEN = `
      WHEN OLD.title IS NOT NEW.title
        OR OLD.summary IS NOT NEW.summary
        OR OLD.tags IS NOT NEW.tags
        OR OLD.type IS NOT NEW.type
        OR OLD.artifacts IS NOT NEW.artifacts
        OR OLD.status IS NOT NEW.status
        OR OLD.source IS NOT NEW.source
        OR OLD.parent_id IS NOT NEW.parent_id
        OR OLD.is_latest IS NOT NEW.is_latest
        OR OLD.is_static IS NOT NEW.is_static
        OR OLD.forget_after IS NOT NEW.forget_after`;
const TIME_DECAY_LAMBDA = 0.02; // e^(-0.02 * days): 7d=0.87, 30d=0.55, 90d=0.17
const COARSE_LIMIT = 50;
const VECTOR_MIN_SIMILARITY = 0.5;
// Entity 检索常量（entity 总量 ~100，粗排取 20 即可；name 短，相似度阈值放低）
const ENTITY_COARSE_LIMIT = 20;
const ENTITY_VEC_MIN_SIMILARITY = 0.4;
const ENTITY_FTS_WEIGHT = 0.5;
const ENTITY_VEC_WEIGHT = 0.5;
const ENTITY_EXACT_NAME_SCORE = 1.5;   // name 完全匹配（保底排第一）
const ENTITY_EXACT_ALIAS_SCORE = 1.4;  // alias 完全匹配
// P4: 不传 type filter 时默认排除 observation/profile（蒸馏专用，进搜索池会污染业务结果）
const DEFAULT_EXCLUDED_TYPES = ['observation', 'profile'] as const;

// vec 索引对账（reconcileVecIndex）：单次构造最多补多少行。
// 纯 SQLite + JSON.parse，无模型调用；1024 维 JSON 单条约 20 KB，200 条 ≈ 4 MB 解析，
// 在 hook 的 10s alarm 预算内可忽略。积压更多时靠多次构造摊平，不在单次构造里做长任务。
const VEC_RECONCILE_LIMIT = 200;
const EMBEDDING_DIM = 1024;
const EMBEDDING_NORM_TOLERANCE = 0.01;

/** 体检主表存的 embedding JSON：合格返回 Float32Array，不合格返回 null（交给 backfill 重算）*/
function vetStoredEmbedding(json: string): Float32Array | null {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length !== EMBEDDING_DIM) return null;
  let sumSq = 0;
  for (const n of arr) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    sumSq += n * n;
  }
  if (Math.abs(Math.sqrt(sumSq) - 1) > EMBEDDING_NORM_TOLERANCE) return null;
  return new Float32Array(arr as number[]);
}

// P11: 查询类型感知权重（启发式 4 分支）
// 设计参考：Supermemory hybrid search guide / Meganova 3-tier routing cascade
type QueryClass = 'named_entity' | 'exact' | 'short_lexical' | 'semantic';

interface QueryWeights {
  fts: number;
  vec: number;
  time: number;
  titleBoost: number;
}

const QUERY_WEIGHTS: Record<QueryClass, QueryWeights> = {
  // 专名查询：人名/项目名/CamelCase/中英混合 → 重 FTS + 重 title boost
  named_entity:  { fts: 0.55, vec: 0.15, time: 0.10, titleBoost: 0.20 },
  // 标识符：日期/URL/书名号 → 几乎纯 FTS
  exact:         { fts: 0.70, vec: 0.10, time: 0.20, titleBoost: 0.15 },
  // 短词：≤4 中文字 / ≤2 英文词 → 重 FTS，保留向量
  short_lexical: { fts: 0.60, vec: 0.30, time: 0.10, titleBoost: 0.15 },
  // 语义：长 query → 现有平衡公式
  semantic:      { fts: 0.40, vec: 0.40, time: 0.20, titleBoost: 0.15 },
};

function classifyQuery(query: string): QueryClass {
  const q = query.trim();

  // exact: 标识符模式（日期 / URL / 书名号 / 长数字 / 引号包裹）
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(q) ||
      /\d{1,2}[-/]\d{1,2}/.test(q) ||
      /https?:\/\//.test(q) ||
      /[《》"""'']/.test(q) ||
      /\b\d{6,}\b/.test(q)) {
    return 'exact';
  }

  const cjkCount = (q.match(/[一-龥]/g) || []).length;
  const asciiTokens = q.split(/\s+/).filter(t => /[a-zA-Z0-9]/.test(t));

  // semantic: 长查询（≥8 中文字 或 ≥4 英文词）
  if (cjkCount >= 8 || asciiTokens.length >= 4) {
    return 'semantic';
  }

  // named_entity: 专名特征（CamelCase / 中英混合 / 连字符）
  if (/[A-Z][a-z]+/.test(q) ||
      (/[一-龥]/.test(q) && /[A-Za-z]/.test(q)) ||
      /-/.test(q)) {
    return 'named_entity';
  }

  // short_lexical: 短查询（≤4 中文字 / ≤2 英文词，且无专名特征）
  return 'short_lexical';
}

/**
 * P1-redo 纯函数：从 entity 行中检测 project 提及。
 * 抽出便于 cli-detect-project 直接开 raw DB 查询调用，
 * 跳过 MemoryStore 完整初始化（FTS rebuild / embedding service）以满足 <50ms 目标。
 *
 * - 生命周期过滤由调用方按列 status='active' 完成（v11 起列 status 为唯一判据）；此处仅过滤 path 含 /_archived/
 * - 全 ASCII name/alias 用 word-boundary 匹配（避免 mcp 误匹配 mcp__memory）
 * - 含非 ASCII 字符的 name/alias 用子串匹配（中文文本无明确 word boundary）
 * - 长度 < 2 的候选跳过
 */
export function detectProjectMentionsRaw(
  text: string,
  entityRows: Array<{ id: number; name: string; aliases: string; attributes: string }>,
  workspaceRoot: string,
): Array<{ id: number; name: string; path: string }> {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const matched: Array<{ id: number; name: string; path: string }> = [];

  for (const r of entityRows) {
    let attrs: Record<string, any> = {};
    try { attrs = JSON.parse(r.attributes || '{}'); } catch { /* ignore */ }

    const projectPath = typeof attrs.path === 'string' ? attrs.path : '';
    if (!projectPath || projectPath.includes('/_archived/')) continue;

    const candidates: string[] = [r.name];
    try {
      const aliases = JSON.parse(r.aliases || '[]');
      if (Array.isArray(aliases)) candidates.push(...aliases);
    } catch { /* ignore */ }

    let hit = false;
    for (const c of candidates) {
      if (!c || c.length < 2) continue;
      const lc = c.toLowerCase();
      const isAscii = /^[\x00-\x7f]+$/.test(c);
      if (isAscii) {
        const escaped = lc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[^a-z0-9_])${escaped}(?![a-z0-9_])`, 'i');
        if (re.test(lowerText)) { hit = true; break; }
      } else {
        if (lowerText.includes(lc)) { hit = true; break; }
      }
    }

    if (hit) {
      const absPath = projectPath.startsWith('/')
        ? projectPath
        : path.join(workspaceRoot, projectPath);
      matched.push({ id: r.id, name: r.name, path: absPath });
    }
  }
  return matched;
}

export class MemoryStore {
  private db: Database.Database;
  private _embeddingService: EmbeddingService | null = null;
  // 懒构造：首次访问时才 new EmbeddingService()（构造即 fork BGE-M3 worker）。
  // 短命写入端（cli-store：embed='defer' + skipBackfill，从不检索）永不访问 → 永不 fork worker，
  // 彻底避开模型加载 / native mutex 崩溃压在写路径上。daemon 首次 backfill/检索时照常构造。
  private get embeddingService(): EmbeddingService {
    if (!this._embeddingService) this._embeddingService = new EmbeddingService();
    return this._embeddingService;
  }
  private source: string;

  // ── Caches ──
  // Query embedding: 避免重复 BGE-M3 推理（~2s/次）
  private embeddingCache = new TTLCache<number[]>({ maxSize: 100, ttlMs: 5 * 60 * 1000 });
  // Entity lookup: 高频 get_entity 调用加速
  private entityCache = new TTLCache<EntityRecord | null>({ maxSize: 50, ttlMs: 10 * 60 * 1000 });

  // 机器角色（~/.claude-host 一行 main / air）：决定默认库路径与 id 段，见 host-role.ts
  private role: HostRole;

  constructor(dbPath?: string, opts?: { skipBackfill?: boolean; source?: string }) {
    this.role = readHostRole();
    // 优先级：显式参数 > MEMORY_DB_PATH > 角色默认路径（main → ~/Data/memory，air → ~/Data/memory-air）
    const resolvedPath = dbPath || process.env.MEMORY_DB_PATH || defaultDbPath(this.role);

    // 确保目录存在
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.source = opts?.source || process.env.MEMORY_SOURCE || 'unknown';

    this.initialize(opts?.skipBackfill);
  }

  private initialize(skipBackfill?: boolean): void {
    // 加载 sqlite-vec 扩展
    sqliteVec.load(this.db);

    // WAL + busy timeout
    this.db.pragma('journal_mode=WAL');
    this.db.pragma('busy_timeout=5000');

    // Schema version check
    const currentVersion = this.db.pragma('user_version', { simple: true }) as number;

    if (currentVersion < 1) {
      this.runSchemaUpgrade(1, () => this.createSchema());
    }
    if (currentVersion < 2) {
      this.runSchemaUpgrade(2, () => this.createEntitiesSchema());
    }
    if (currentVersion < 3) {
      this.runSchemaUpgrade(3, () => this.createVecSchema());
    }
    if (currentVersion < 4) {
      this.runSchemaUpgrade(4, () => this.upgradeToLocalEmbedding());
    }
    if (currentVersion < 5) {
      this.runSchemaUpgrade(5, () => this.createHistorySchema());
    }
    if (currentVersion < 6) {
      this.runSchemaUpgrade(6, () => this.upgradeToV6());
    }
    if (currentVersion < 7) {
      this.runSchemaUpgrade(7, () => this.upgradeToV7());
    }
    if (currentVersion < 8) {
      this.runSchemaUpgrade(8, () => this.upgradeToV8());
    }
    if (currentVersion < 9) {
      this.runSchemaUpgrade(9, () => this.upgradeToV9());
    }
    if (currentVersion < 10) {
      this.runSchemaUpgrade(10, () => this.upgradeToV10());
    }
    if (currentVersion < 11) {
      this.runSchemaUpgrade(11, () => this.upgradeToV11());
    }
    if (currentVersion < 12) {
      this.runSchemaUpgrade(12, () => this.upgradeToV12());
    }
    if (currentVersion < 13) {
      this.runSchemaUpgrade(13, () => this.upgradeToV13());
    }

    // FTS contentless 迁移：仅旧结构迁移后在同一维护事务中重建。
    // 普通客户端启动绝不全量重建。
    this.migrateFTSToContentless();

    // 重建 history triggers（确保已有数据库使用 UTC+8 时间）
    this.rebuildHistoryTriggers();

    // 创建/重建 knowledge_meta 视图（Bot 兼容，含 v6 字段）
    this.db.exec(`DROP VIEW IF EXISTS knowledge_meta`);
    this.db.exec(`
      CREATE VIEW knowledge_meta AS
      SELECT
        id, title, tags, summary, artifacts, status,
        created_at, last_retrieved_at, retrieval_count,
        embedding, '' as session_key, '' as obsidian_path,
        user_id, 1 as source_count,
        parent_id, root_id, relation, version, is_latest,
        event_date, is_static, forget_after,
        invalid_from, invalid_reason
      FROM memories
    `);

    // 启动时清理过期记忆（v6-2）
    this.cleanupExpiredMemories();

    // 周期清理过期记忆（每 24h）：长期 stdio 进程不重启时避免 forget_after 过期记录滞留
    const cleanupTimer = setInterval(() => {
      try {
        this.cleanupExpiredMemories();
      } catch (err) {
        console.error('[Store] Periodic cleanup failed:', err);
      }
    }, 24 * 60 * 60 * 1000);
    cleanupTimer.unref();

    // vec 索引对账（纯 SQLite，不 fork worker，与 backfill 同一 skipBackfill 开关）。
    // 必须在 backfill 之前跑：它把「主表已有合法向量、vec 表却缺行」的记忆直接搬进 vec 表，
    // 省掉 backfill 的重算；backfill 只负责主表也没有可用 embedding 的那部分。
    if (!skipBackfill) {
      try {
        this.reconcileVecIndex();
      } catch (err) {
        console.error('[Store] Vec index reconcile failed:', err);
      }
    }

    // 后台补全 embedding（短命写入端传 skipBackfill=true 跳过：它只写一行，补向量是 daemon 的职责；
    // 且 backfill 会经 embedBatch fork BGE-M3 worker —— 短命进程里是被 force-exit 砍掉的无用 fork + mutex 崩噪）
    if (!skipBackfill) {
      this.backfillEmbeddings().catch(err => {
        console.error('[Store] Embedding backfill failed:', err);
      });
    }
  }

  private runSchemaUpgrade(targetVersion: number, upgrade: () => void): void {
    const tx = this.db.transaction(() => {
      upgrade();
      this.db.pragma(`user_version=${targetVersion}`);
    });
    tx();
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const escapedTable = table.replace(/"/g, '""');
    const columns = new Set(
      (this.db.prepare(`PRAGMA table_info("${escapedTable}")`).all() as { name: string }[])
        .map(c => c.name),
    );
    if (!columns.has(column)) {
      this.db.exec(`ALTER TABLE "${escapedTable}" ADD COLUMN ${column} ${definition}`);
    }
  }

  /** 一次性迁移：content-synced FTS → contentless FTS */
  private migrateFTSToContentless(): boolean {
    if (!this.hasLegacyFTS()) return false;

    return this.withImmediateWriteTransaction(() => {
      // 取得锁后再次检查，避免两个启动中的客户端重复迁移。
      if (!this.hasLegacyFTS()) return false;

      console.error('[Store] Migrating FTS tables to contentless...');
      this.db.exec(`DROP TABLE IF EXISTS memories_fts`);
      this.db.exec(`DROP TABLE IF EXISTS entities_fts`);
      this.db.exec(`
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          title, tags, summary, content='', tokenize='ascii'
        )
      `);
      this.db.exec(`
        CREATE VIRTUAL TABLE entities_fts USING fts5(
          name, aliases, category, attributes, content='', tokenize='ascii'
        )
      `);
      const { memories, entities } = this.rebuildSearchIndexes();
      console.error(`[Store] FTS migration complete: memories=${memories}, entities=${entities}`);
      return true;
    });
  }

  private hasLegacyFTS(): boolean {
    const definitions = this.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name IN ('memories_fts', 'entities_fts')
    `).all() as { sql: string | null }[];
    return definitions.some(({ sql }) => !/content\s*=\s*''/i.test(sql ?? ''));
  }

  /** 仅由显式维护事务调用；调用者须在读取前持有写锁。 */
  private rebuildMemoriesFTS(): number {
    const rows = this.db.prepare(`
      SELECT id, title, tags, summary FROM memories WHERE status = 'active'
    `).all() as { id: number; title: string; tags: string; summary: string }[];

    // contentless FTS5 不支持 DELETE FROM，用 'delete-all' 命令清空
    this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('delete-all')`);

    const insert = this.db.prepare(`
      INSERT INTO memories_fts (rowid, title, tags, summary) VALUES (?, ?, ?, ?)
    `);
    for (const r of rows) {
      insert.run(r.id, segment(r.title), segment(r.tags), segment(r.summary));
    }
    return rows.length;
  }

  /** 仅由显式维护事务调用；调用者须在读取前持有写锁。 */
  private rebuildEntitiesFTS(): number {
    const rows = this.db.prepare(`
      SELECT id, name, aliases, category, attributes FROM entities WHERE status = 'active'
    `).all() as { id: number; name: string; aliases: string; category: string; attributes: string }[];

    this.db.exec(`INSERT INTO entities_fts(entities_fts) VALUES('delete-all')`);

    const insert = this.db.prepare(`
      INSERT INTO entities_fts (rowid, name, aliases, category, attributes) VALUES (?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      insert.run(r.id, segment(r.name), segment(r.aliases), segment(r.category), segment(r.attributes));
    }
    return rows.length;
  }

  /**
   * 显式维护入口：在任何源行读取前取得 RESERVED 写锁，避免与并发写入交错。
   * 不注册为 MCP 工具；正常客户端构造不会调用它。
   */
  rebuildSearchIndexesForMaintenance(): { memories: number; entities: number } {
    const result = this.withImmediateWriteTransaction(() => this.rebuildSearchIndexes());
    console.error(`[Store] search indexes rebuilt: memories=${result.memories}, entities=${result.entities}`);
    return result;
  }

  private rebuildSearchIndexes(): { memories: number; entities: number } {
    return {
      memories: this.rebuildMemoriesFTS(),
      entities: this.rebuildEntitiesFTS(),
    };
  }

  private withImmediateWriteTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 已在事务里就直接跑，否则套一层 BEGIN IMMEDIATE（嵌套 BEGIN 会被 SQLite 拒绝）。 */
  private inWriteTransaction<T>(work: () => T): T {
    if (this.db.inTransaction) return work();
    return this.withImmediateWriteTransaction(work);
  }

  /**
   * 按机器角色在 id 段内分配下一个 id（见 host-role.ts）。
   * main [1, 1e6)，air [1e6, 2e6)，memories 与 entities 都按此分配。
   * 不能靠 AUTOINCREMENT：SQLite 取「表内出现过的最大 id + 1」，第二台机器的记录导回主机后，
   * 主机自己的下一条就会从 1,000,001 起、与第二台撞号（实测）。
   * 必须在 BEGIN IMMEDIATE 事务内调用，否则两个写进程可能算出同一个 id。
   */
  private nextId(table: 'memories' | 'entities'): number {
    const { start, end } = ID_SEGMENT[this.role];
    const row = this.db.prepare(`SELECT MAX(id) AS m FROM ${table} WHERE id >= ? AND id < ?`)
      .get(start, end) as { m: number | null };
    const next = row.m === null ? start : row.m + 1;
    if (next >= end) {
      throw new Error(`[Store] ${table} id 段已用尽：role=${this.role} 段 [${start}, ${end})`);
    }
    return next;
  }

  getGatewayRequest(clientId: string, idempotencyKey: string): GatewayLedgerRecord | null {
    const row = this.db.prepare(`
      SELECT request_id, runtime_id, client_id, session_id, project_id, evidence_ref,
             retention_intent, idempotency_key, operation, payload_hash, outcome, reason,
             memory_id, created_at
      FROM memory_gateway_requests
      WHERE client_id = ? AND idempotency_key = ?
    `).get(clientId, idempotencyKey) as GatewayLedgerRecord | undefined;
    return row ?? null;
  }

  recordGatewayRejection(record: GatewayAuditRecord, reason: string): void {
    this.withImmediateWriteTransaction(() => {
      this.insertGatewayAudit(record, 'rejected', reason, null, nowBeijing());
    });
  }

  recordGatewayReplay(record: GatewayAuditRecord, result: GatewayLedgerRecord): void {
    const transaction = this.db.transaction(() => {
      this.insertGatewayAudit(
        record,
        result.outcome,
        result.outcome === 'accepted' ? 'idempotent_replay' : result.reason ?? 'idempotent_replay',
        result.memory_id,
        nowBeijing(),
      );
    });
    transaction();
  }

  private insertGatewayAccepted(record: GatewayAuditRecord, memoryId: number): void {
    const createdAt = nowBeijing();
    this.insertGatewayLedger(record, memoryId, createdAt);
    this.insertGatewayAudit(record, 'accepted', null, memoryId, createdAt);
  }

  private insertGatewayLedger(
    record: GatewayAuditRecord,
    memoryId: number,
    createdAt: string,
  ): void {
    if (!record.idempotency_key) {
      throw new Error('gateway ledger requires idempotency_key');
    }
    this.db.prepare(`
      INSERT INTO memory_gateway_requests (
        client_id, idempotency_key, request_id, runtime_id, session_id, project_id,
        evidence_ref, retention_intent, operation, payload_hash, outcome, reason,
        memory_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.client_id, record.idempotency_key, record.request_id, record.runtime_id,
      record.session_id, record.project_id, record.evidence_ref, record.retention_intent,
      record.operation, record.payload_hash, 'accepted', null, memoryId, createdAt,
    );
  }

  private insertGatewayAudit(
    record: GatewayAuditRecord,
    outcome: 'accepted' | 'rejected',
    reason: string | null,
    memoryId: number | null,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO memory_gateway_audit (
        request_id, runtime_id, client_id, session_id, project_id, evidence_ref,
        retention_intent, idempotency_key, operation, payload_hash, outcome, reason,
        memory_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.request_id, record.runtime_id, record.client_id, record.session_id,
      record.project_id, record.evidence_ref, record.retention_intent, record.idempotency_key,
      record.operation, record.payload_hash, outcome, reason,
      memoryId, createdAt,
    );
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        type            TEXT NOT NULL DEFAULT 'work',
        title           TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '',
        summary         TEXT NOT NULL,
        artifacts       TEXT DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'active',
        source          TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        last_retrieved_at TEXT,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        embedding       TEXT,
        embedding_model TEXT NOT NULL DEFAULT '',
        user_id         TEXT NOT NULL DEFAULT '',
        CONSTRAINT chk_type CHECK (type IN ('work', 'observation', 'entity', 'profile'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, tags, summary,
        content='',
        tokenize='ascii'
      );
    `);
  }

  private createEntitiesSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        aliases     TEXT NOT NULL DEFAULT '[]',
        category    TEXT NOT NULL,
        attributes  TEXT NOT NULL DEFAULT '{}',
        relations   TEXT NOT NULL DEFAULT '[]',
        status      TEXT NOT NULL DEFAULT 'active',
        source      TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        embedding   TEXT,
        embedding_model TEXT NOT NULL DEFAULT ''
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name ON entities(name) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category);
      CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);

      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name, aliases, category, attributes,
        content='',
        tokenize='ascii'
      );
    `);
  }

  private createVecSchema(): void {
    // 创建 vec0 虚拟表（1024 维，匹配 BGE-M3）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
        embedding float[1024]
      )
    `);

    // 迁移已有 embedding 到 vec 表
    const rows = this.db.prepare(`
      SELECT id, embedding FROM memories
      WHERE status = 'active' AND embedding IS NOT NULL
    `).all() as { id: number; embedding: string }[];

    if (rows.length > 0) {
      console.log(`[Store] Migrating ${rows.length} embeddings to vec0 table...`);
      const insertVec = this.db.prepare(`
        INSERT OR IGNORE INTO memory_vec (rowid, embedding) VALUES (?, ?)
      `);

      const transaction = this.db.transaction(() => {
        for (const row of rows) {
          try {
            const vec = JSON.parse(row.embedding) as number[];
            insertVec.run(BigInt(row.id), new Float32Array(vec));
          } catch { /* skip malformed */ }
        }
      });
      transaction();
      console.log(`[Store] Vec0 migration complete`);
    }
  }

  private upgradeToLocalEmbedding(): void {
    // 从 Gemini 768d 迁移到 BGE-M3 1024d
    // 1. 删除旧 vec 表（768d）
    this.db.exec(`DROP TABLE IF EXISTS memory_vec`);
    // 2. 创建新 vec 表（1024d）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
        embedding float[1024]
      )
    `);
    // 3. 清除旧 embedding（backfillEmbeddings 会用新模型重新生成）
    this.db.exec(`
      UPDATE memories SET embedding = NULL, embedding_model = '' WHERE embedding IS NOT NULL
    `);
    console.log('[Store] Upgraded to local embedding (BGE-M3 1024d). All embeddings cleared for re-generation.');
  }

  private createHistorySchema(): void {
    this.db.exec(`
      -- 记忆变更历史表
      CREATE TABLE IF NOT EXISTS memory_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id   INTEGER NOT NULL,
        operation   TEXT NOT NULL,
        old_type    TEXT,
        old_title   TEXT,
        old_tags    TEXT,
        old_summary TEXT,
        old_artifacts TEXT,
        old_status  TEXT,
        old_source  TEXT,
        changed_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
        changed_by  TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_mh_memory_id ON memory_history(memory_id);
      CREATE INDEX IF NOT EXISTS idx_mh_changed_at ON memory_history(changed_at);

      -- Entity 变更历史表
      CREATE TABLE IF NOT EXISTS entity_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   INTEGER NOT NULL,
        operation   TEXT NOT NULL,
        old_name    TEXT,
        old_aliases TEXT,
        old_category TEXT,
        old_attributes TEXT,
        old_relations TEXT,
        old_status  TEXT,
        old_source  TEXT,
        changed_at  TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
        changed_by  TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_eh_entity_id ON entity_history(entity_id);
      CREATE INDEX IF NOT EXISTS idx_eh_changed_at ON entity_history(changed_at);

      -- Trigger: memories UPDATE 前记录旧数据（仅内容变更，见 MEMORY_HISTORY_WHEN）
      CREATE TRIGGER IF NOT EXISTS trg_memories_before_update
      BEFORE UPDATE ON memories
      FOR EACH ROW
      ${MEMORY_HISTORY_WHEN}
      BEGIN
        INSERT INTO memory_history (memory_id, operation, old_type, old_title, old_tags, old_summary, old_artifacts, old_status, old_source, changed_at)
        VALUES (OLD.id, 'UPDATE', OLD.type, OLD.title, OLD.tags, OLD.summary, OLD.artifacts, OLD.status, OLD.source, datetime('now', '+8 hours'));
      END;

      -- Trigger: memories DELETE 前记录旧数据
      CREATE TRIGGER IF NOT EXISTS trg_memories_before_delete
      BEFORE DELETE ON memories
      FOR EACH ROW
      BEGIN
        INSERT INTO memory_history (memory_id, operation, old_type, old_title, old_tags, old_summary, old_artifacts, old_status, old_source, changed_at)
        VALUES (OLD.id, 'DELETE', OLD.type, OLD.title, OLD.tags, OLD.summary, OLD.artifacts, OLD.status, OLD.source, datetime('now', '+8 hours'));
      END;

      -- Trigger: entities UPDATE 前记录旧数据
      CREATE TRIGGER IF NOT EXISTS trg_entities_before_update
      BEFORE UPDATE ON entities
      FOR EACH ROW
      BEGIN
        INSERT INTO entity_history (entity_id, operation, old_name, old_aliases, old_category, old_attributes, old_relations, old_status, old_source, changed_at)
        VALUES (OLD.id, 'UPDATE', OLD.name, OLD.aliases, OLD.category, OLD.attributes, OLD.relations, OLD.status, OLD.source, datetime('now', '+8 hours'));
      END;

      -- Trigger: entities DELETE 前记录旧数据
      CREATE TRIGGER IF NOT EXISTS trg_entities_before_delete
      BEFORE DELETE ON entities
      FOR EACH ROW
      BEGIN
        INSERT INTO entity_history (entity_id, operation, old_name, old_aliases, old_category, old_attributes, old_relations, old_status, old_source, changed_at)
        VALUES (OLD.id, 'DELETE', OLD.name, OLD.aliases, OLD.category, OLD.attributes, OLD.relations, OLD.status, OLD.source, datetime('now', '+8 hours'));
      END;
    `);
    console.log('[Store] Created history tables and triggers (schema v5).');
  }

  private upgradeToV6(): void {
    // v6-1: 关系版本化
    this.addColumnIfMissing('memories', 'parent_id', 'INTEGER REFERENCES memories(id)');
    this.addColumnIfMissing('memories', 'root_id', 'INTEGER REFERENCES memories(id)');
    this.addColumnIfMissing('memories', 'relation', 'TEXT');
    this.addColumnIfMissing('memories', 'version', 'INTEGER DEFAULT 1');
    this.addColumnIfMissing('memories', 'is_latest', 'INTEGER DEFAULT 1');

    // v6-2: 静态标记 + 事件时间 + 自动过期
    this.addColumnIfMissing('memories', 'event_date', 'TEXT');
    this.addColumnIfMissing('memories', 'is_static', 'INTEGER DEFAULT 0');
    this.addColumnIfMissing('memories', 'forget_after', 'TEXT');

    // 索引
    this.db.exec(`CREATE INDEX idx_memories_root_id ON memories(root_id) WHERE root_id IS NOT NULL`);
    this.db.exec(`CREATE INDEX idx_memories_is_latest ON memories(is_latest) WHERE is_latest = 1`);
    this.db.exec(`CREATE INDEX idx_memories_event_date ON memories(event_date) WHERE event_date IS NOT NULL`);
    this.db.exec(`CREATE INDEX idx_memories_forget_after ON memories(forget_after) WHERE forget_after IS NOT NULL`);

    // 审计修复 #14: 重建 memory history trigger，记录 v6 字段
    this.addColumnIfMissing('memory_history', 'old_parent_id', 'INTEGER');
    this.addColumnIfMissing('memory_history', 'old_is_latest', 'INTEGER');
    this.addColumnIfMissing('memory_history', 'old_is_static', 'INTEGER');
    this.addColumnIfMissing('memory_history', 'old_forget_after', 'TEXT');

    this.db.exec(`DROP TRIGGER IF EXISTS trg_memories_before_update`);
    this.db.exec(`
      CREATE TRIGGER trg_memories_before_update
      BEFORE UPDATE ON memories FOR EACH ROW
      ${MEMORY_HISTORY_WHEN}
      BEGIN
        INSERT INTO memory_history (
          memory_id, operation,
          old_type, old_title, old_tags, old_summary, old_artifacts, old_status, old_source,
          old_parent_id, old_is_latest, old_is_static, old_forget_after,
          changed_at
        ) VALUES (
          OLD.id, 'UPDATE',
          OLD.type, OLD.title, OLD.tags, OLD.summary, OLD.artifacts, OLD.status, OLD.source,
          OLD.parent_id, OLD.is_latest, OLD.is_static, OLD.forget_after,
          datetime('now', '+8 hours')
        );
      END
    `);

    console.log('[Store] Upgraded to schema v6 (relation versioning + static/event_date/forget_after).');
  }

  /** P8-a: v7 — entity_vec 虚拟表（entity 语义检索基础设施）*/
  private upgradeToV7(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec USING vec0(
        embedding float[1024]
      )
    `);

    // backfill：把 entities 表已有 embedding 复制到 entity_vec
    const rows = this.db.prepare(`
      SELECT id, embedding FROM entities
      WHERE status = 'active' AND embedding IS NOT NULL
    `).all() as { id: number; embedding: string }[];

    if (rows.length > 0) {
      const insertVec = this.db.prepare(`
        INSERT OR IGNORE INTO entity_vec (rowid, embedding) VALUES (?, ?)
      `);
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          try {
            const vec = JSON.parse(r.embedding) as number[];
            insertVec.run(BigInt(r.id), new Float32Array(vec));
          } catch { /* skip malformed */ }
        }
      });
      tx();
    }
    console.log(`[Store] Upgraded to schema v7 (entity_vec virtual table, ${rows.length} entities indexed).`);
  }

  /** P9: v8 — memory_entities 反向索引联结表（entity → mentions）*/
  private upgradeToV8(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entities (
        memory_id INTEGER NOT NULL,
        entity_id INTEGER NOT NULL,
        PRIMARY KEY (memory_id, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);
    `);

    // backfill：扫描所有 active 记忆，提取 entity 提及
    const memories = this.db.prepare(`
      SELECT id, title, tags, summary FROM memories WHERE status = 'active'
    `).all() as { id: number; title: string; tags: string; summary: string }[];

    const entityList = this.loadActiveEntityList();
    if (entityList.length === 0 || memories.length === 0) {
      console.log(`[Store] Upgraded to schema v8 (memory_entities, 0 mentions backfilled — empty entities or memories).`);
      return;
    }

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)
    `);
    let totalLinks = 0;
    const tx = this.db.transaction(() => {
      for (const m of memories) {
        const text = `${m.title} ${m.tags} ${m.summary}`;
        const ids = this.extractEntityMentions(text, entityList);
        for (const eid of ids) {
          insertStmt.run(m.id, eid);
          totalLinks++;
        }
      }
    });
    tx();
    console.log(`[Store] Upgraded to schema v8 (memory_entities, ${totalLinks} mentions backfilled across ${memories.length} memories).`);
  }

  /** v9: 用 word-boundary 算法重建 memory_entities（修正 v8 子串匹配的误命中）*/
  private upgradeToV9(): void {
    const memories = this.db.prepare(`
      SELECT id, title, tags, summary FROM memories WHERE status = 'active'
    `).all() as { id: number; title: string; tags: string; summary: string }[];

    const entityList = this.loadActiveEntityList();
    if (entityList.length === 0 || memories.length === 0) {
      this.db.exec(`DELETE FROM memory_entities`);
      console.log(`[Store] Upgraded to schema v9 (memory_entities cleared — empty entities or memories).`);
      return;
    }

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)
    `);
    let totalLinks = 0;
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM memory_entities`);
      for (const m of memories) {
        const text = `${m.title} ${m.tags} ${m.summary}`;
        const ids = this.extractEntityMentions(text, entityList);
        for (const eid of ids) {
          insertStmt.run(m.id, eid);
          totalLinks++;
        }
      }
    });
    tx();
    console.log(`[Store] Upgraded to schema v9 (memory_entities rebuilt with word-boundary algo, ${totalLinks} mentions across ${memories.length} memories).`);
  }

  /** v10: 清掉 history 版本（is_latest=0）的 memory_entities 链接
   *  v8/v9 backfill 用 status='active' 不限 is_latest，会把 history 版本的 mention 算入 getCoOccurringEntities 计数
   *  storeMemory 走 update 关系时旧版本的链接也未清理（line ~1216 只清了 vec/FTS）
   */
  private upgradeToV10(): void {
    const result = this.db.prepare(`
      DELETE FROM memory_entities
      WHERE memory_id IN (SELECT id FROM memories WHERE is_latest = 0)
    `).run();
    console.log(`[Store] Upgraded to schema v10 (memory_entities filtered by is_latest=1, ${result.changes} stale links removed).`);
  }

  /** v11: entity 生命周期收敛为单一权威字段（列 status）。
   *  治理 D（上下文系统 caveat / 反漂移 L1）：此前生命周期在列 status(仅active/deleted) 与 attributes.status(自由文本,
   *  混了 archived/retired 生命周期 + planning/设计中 运营阶段) 双字段表达 → 漂移源。
   *  收敛规则（只动列=active 的行；deleted 行不碰）：
   *   - attributes.status ∈ {archived}                  → 列 status='archived'（移出注入）
   *   - attributes.status 含 '已退役' / 'retired'        → 列 status='retired' （移出注入）
   *   - attributes.status ∈ {planning,准备中,设计中,...} → 运营阶段，列保持 active，值迁 attributes.phase
   *   - 一律删除 attributes.status（生命周期此后单一真理源=列；冗余的 'active' 也清掉，杜绝再漂）
   *  注入侧 SQL 本就按列 status='active' 过滤，故收敛后归档/退役自动落选，配套删除 getCoOccurringEntities /
   *  detectProjectMentions 里基于 attributes.status 的 L0 临时补丁。
   */
  private upgradeToV11(): void {
    // 死亡态关键词 → 列 status 目标值（其余 attributes.status 视为运营阶段，迁 phase）
    const DEAD_TO_STATUS = (s: string): EntityStatus | null => {
      const v = s.trim();
      if (v === 'archived') return 'archived';
      if (v === 'retired' || v.startsWith('已退役')) return 'retired';
      return null; // 运营阶段（planning/准备中/设计稿…）或冗余 'active'
    };

    // 全表扫描：剥离所有行的 attributes.status（含 deleted 行，杜绝复活时把 status 带回 active）；
    // 仅对列=active 的行做生命周期归类（dead→列 / phase→attributes.phase）。非 active 行只剥不动列。
    const rows = this.db.prepare(`
      SELECT id, status, attributes FROM entities
    `).all() as { id: number; status: string; attributes: string }[];

    const updateStmt = this.db.prepare(`UPDATE entities SET status = ?, attributes = ?, updated_at = ? WHERE id = ?`);
    const now = nowBeijing();
    let toArchived = 0, toRetired = 0, toPhase = 0, strippedActive = 0, strippedDead = 0;

    for (const r of rows) {
      let attrs: Record<string, any>;
      try { attrs = JSON.parse(r.attributes || '{}'); } catch { continue; }
      if (!('status' in attrs)) continue;

      let newColStatus = r.status as EntityStatus;

      if (r.status === 'active') {
        const rawStatus = String(attrs.status ?? '');
        const deadStatus = DEAD_TO_STATUS(rawStatus);
        if (deadStatus) {
          newColStatus = deadStatus;
          if (deadStatus === 'archived') toArchived++; else toRetired++;
        } else if (rawStatus && rawStatus !== 'active') {
          // 运营阶段：迁 attributes.phase（不参与过滤），列保持 active
          attrs.phase = rawStatus;
          toPhase++;
        } else {
          strippedActive++; // 冗余的 attributes.status='active'
        }
      } else {
        strippedDead++; // 非 active（deleted 等）：只剥 attributes.status，列不动
      }

      delete attrs.status; // 生命周期单一真理源=列，attributes.status 全表清除
      updateStmt.run(newColStatus, JSON.stringify(attrs), now, r.id);
    }

    console.log(`[Store] Upgraded to schema v11 (entity lifecycle → 列 status: ${toArchived} archived, ${toRetired} retired, ${toPhase} → attributes.phase, ${strippedActive} redundant active stripped, ${strippedDead} non-active stripped).`);
  }

  /** v12: agent-neutral gateway 的幂等 ledger 与不可变审计。 */
  private upgradeToV12(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_gateway_requests (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id         TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        request_id        TEXT,
        runtime_id        TEXT NOT NULL,
        session_id        TEXT,
        project_id        TEXT,
        evidence_ref      TEXT,
        retention_intent  TEXT,
        operation         TEXT NOT NULL,
        payload_hash      TEXT NOT NULL,
        outcome           TEXT NOT NULL,
        reason            TEXT,
        memory_id         INTEGER,
        created_at        TEXT NOT NULL,
        CONSTRAINT chk_gateway_operation CHECK (operation IN ('memory_write', 'memory_update')),
        CONSTRAINT chk_gateway_ledger_committed_write CHECK (
          outcome = 'accepted' AND reason IS NULL AND memory_id IS NOT NULL AND
          request_id IS NOT NULL AND session_id IS NOT NULL AND project_id IS NOT NULL AND
          evidence_ref IS NOT NULL AND retention_intent IS 'durable'
        ),
        UNIQUE (client_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS memory_gateway_audit (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id        TEXT,
        runtime_id        TEXT NOT NULL,
        client_id         TEXT NOT NULL,
        session_id        TEXT,
        project_id        TEXT,
        evidence_ref      TEXT,
        retention_intent  TEXT,
        idempotency_key   TEXT,
        operation         TEXT NOT NULL,
        payload_hash      TEXT NOT NULL,
        outcome           TEXT NOT NULL,
        reason            TEXT,
        memory_id         INTEGER,
        created_at        TEXT NOT NULL,
        CONSTRAINT chk_gateway_audit_operation CHECK (operation IN ('memory_write', 'memory_update')),
        CONSTRAINT chk_gateway_audit_outcome CHECK (outcome IN ('accepted', 'rejected')),
        CONSTRAINT chk_gateway_audit_accepted_provenance CHECK (
          outcome = 'rejected' OR (
            request_id IS NOT NULL AND session_id IS NOT NULL AND project_id IS NOT NULL AND
            evidence_ref IS NOT NULL AND retention_intent IS 'durable'
          )
        )
      );

      CREATE INDEX IF NOT EXISTS idx_memory_gateway_audit_request ON memory_gateway_audit(request_id);
      CREATE INDEX IF NOT EXISTS idx_memory_gateway_audit_memory ON memory_gateway_audit(memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_gateway_audit_created ON memory_gateway_audit(created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_gateway_requests_session_outcome
        ON memory_gateway_requests(client_id, session_id, outcome);

      CREATE TRIGGER IF NOT EXISTS trg_memory_gateway_requests_no_update
      BEFORE UPDATE ON memory_gateway_requests
      BEGIN SELECT RAISE(ABORT, 'memory gateway ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_memory_gateway_requests_no_delete
      BEFORE DELETE ON memory_gateway_requests
      BEGIN SELECT RAISE(ABORT, 'memory gateway ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_memory_gateway_audit_no_update
      BEFORE UPDATE ON memory_gateway_audit
      BEGIN SELECT RAISE(ABORT, 'memory gateway audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_memory_gateway_audit_no_delete
      BEFORE DELETE ON memory_gateway_audit
      BEGIN SELECT RAISE(ABORT, 'memory gateway audit is append-only'); END;
    `);
  }

  /**
   * v13 (A2): 失效标记。
   *
   * 在此之前，全系统对「事实过时」的唯一处理是时间衰减降权（exp(-0.02 * days)）——
   * 那是 recency 信号，不是 validity 信号：一条仍然成立的旧事实和一条已经作废的旧事实
   * 被同等降权。真正的失效只有 relation='update' + is_latest 一条路，而它只在写入方
   * 显式传 parent_id 时才走（迁移时实测 154 / 4345）。
   *
   * 这两列不参与检索过滤——失效靠 is_latest=0 生效（该过滤在 FTS / vec / fallback /
   * listRecent / listAll / vec 表不变量六处已经一致存在，不再新开一条容易漏的过滤线）。
   * 它们只回答 is_latest=0 之后的那个问题：什么时候、为什么不再成立。
   */
  private upgradeToV13(): void {
    this.addColumnIfMissing('memories', 'invalid_from', 'TEXT');
    this.addColumnIfMissing('memories', 'invalid_reason', 'TEXT');
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_invalid_from ON memories(invalid_from) WHERE invalid_from IS NOT NULL`);
    console.log('[Store] Upgraded to schema v13 (invalid_from / invalid_reason).');
  }

  /** 加载所有 active entity 的 name + aliases，用于 P9 反向索引提取 */
  private loadActiveEntityList(): { id: number; name: string; aliases: string }[] {
    return this.db.prepare(`
      SELECT id, name, aliases FROM entities WHERE status = 'active'
    `).all() as { id: number; name: string; aliases: string }[];
  }

  /**
   * P1-redo: 从 text 中检测 project entity 提及（实例方法，使用 store.db）
   * 详见 detectProjectMentionsRaw 纯函数。
   */
  detectProjectMentions(
    text: string,
    workspaceRoot: string,
  ): Array<{ id: number; name: string; path: string }> {
    if (!text) return [];
    const rows = this.db.prepare(`
      SELECT id, name, aliases, attributes
      FROM entities
      WHERE status = 'active' AND category = 'project'
    `).all() as { id: number; name: string; aliases: string; attributes: string }[];
    return detectProjectMentionsRaw(text, rows, workspaceRoot);
  }

  /**
   * P9: 从 text 中提取 entity 提及。
   * - 全 ASCII 候选用 word-boundary 匹配（避免 "Onn" 命中 "Sonnet"、"mcp" 命中 "mcp__memory"）
   * - 含非 ASCII 字符的候选用子串匹配（中文文本无明确 word boundary）
   * - 长度 < 2 的候选跳过；英文不区分大小写
   * 算法与 detectProjectMentionsRaw 一致（v9 统一）
   */
  private extractEntityMentions(
    text: string,
    entityList?: { id: number; name: string; aliases: string }[],
  ): number[] {
    if (!text) return [];
    const list = entityList ?? this.loadActiveEntityList();
    const lowerText = text.toLowerCase();
    const matched: number[] = [];

    for (const e of list) {
      const candidates: string[] = [e.name];
      try {
        const aliases = JSON.parse(e.aliases || '[]') as string[];
        if (Array.isArray(aliases)) candidates.push(...aliases);
      } catch { /* 忽略损坏的 aliases JSON */ }

      for (const c of candidates) {
        if (!c || c.length < 2) continue;
        const lc = c.toLowerCase();
        const isAscii = /^[\x00-\x7f]+$/.test(c);
        if (isAscii) {
          const escaped = lc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(^|[^a-z0-9_])${escaped}(?![a-z0-9_])`, 'i');
          if (re.test(lowerText)) { matched.push(e.id); break; }
        } else {
          if (lowerText.includes(lc)) { matched.push(e.id); break; }
        }
      }
    }
    return matched;
  }

  /** 每次启动重建 history triggers，确保使用 UTC+8 时间 */
  private rebuildHistoryTriggers(): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS trg_memories_before_update;
      CREATE TRIGGER trg_memories_before_update
      BEFORE UPDATE ON memories FOR EACH ROW
      ${MEMORY_HISTORY_WHEN}
      BEGIN
        INSERT INTO memory_history (
          memory_id, operation,
          old_type, old_title, old_tags, old_summary, old_artifacts, old_status, old_source,
          old_parent_id, old_is_latest, old_is_static, old_forget_after,
          changed_at
        ) VALUES (
          OLD.id, 'UPDATE',
          OLD.type, OLD.title, OLD.tags, OLD.summary, OLD.artifacts, OLD.status, OLD.source,
          OLD.parent_id, OLD.is_latest, OLD.is_static, OLD.forget_after,
          datetime('now', '+8 hours')
        );
      END;

      DROP TRIGGER IF EXISTS trg_memories_before_delete;
      CREATE TRIGGER trg_memories_before_delete
      BEFORE DELETE ON memories FOR EACH ROW
      BEGIN
        INSERT INTO memory_history (
          memory_id, operation,
          old_type, old_title, old_tags, old_summary, old_artifacts, old_status, old_source,
          old_parent_id, old_is_latest, old_is_static, old_forget_after,
          changed_at
        ) VALUES (
          OLD.id, 'DELETE',
          OLD.type, OLD.title, OLD.tags, OLD.summary, OLD.artifacts, OLD.status, OLD.source,
          OLD.parent_id, OLD.is_latest, OLD.is_static, OLD.forget_after,
          datetime('now', '+8 hours')
        );
      END;

      DROP TRIGGER IF EXISTS trg_entities_before_update;
      CREATE TRIGGER trg_entities_before_update
      BEFORE UPDATE ON entities FOR EACH ROW
      BEGIN
        INSERT INTO entity_history (entity_id, operation, old_name, old_aliases, old_category, old_attributes, old_relations, old_status, old_source, changed_at)
        VALUES (OLD.id, 'UPDATE', OLD.name, OLD.aliases, OLD.category, OLD.attributes, OLD.relations, OLD.status, OLD.source, datetime('now', '+8 hours'));
      END;

      DROP TRIGGER IF EXISTS trg_entities_before_delete;
      CREATE TRIGGER trg_entities_before_delete
      BEFORE DELETE ON entities FOR EACH ROW
      BEGIN
        INSERT INTO entity_history (entity_id, operation, old_name, old_aliases, old_category, old_attributes, old_relations, old_status, old_source, changed_at)
        VALUES (OLD.id, 'DELETE', OLD.name, OLD.aliases, OLD.category, OLD.attributes, OLD.relations, OLD.status, OLD.source, datetime('now', '+8 hours'));
      END;
    `);
  }

  private cleanupExpiredMemories(): void {
    const todayBeijing = nowBeijing().slice(0, 10); // "2026-03-27"
    const now = nowBeijing();

    // 先收集要清理的 id（用于同步清理 vec）
    const expiredIds = this.db.prepare(`
      SELECT id FROM memories
      WHERE forget_after IS NOT NULL AND forget_after < ? AND status = 'active'
    `).all(todayBeijing) as { id: number }[];

    if (expiredIds.length === 0) return;

    const transaction = this.db.transaction(() => {
      for (const { id } of expiredIds) {
        this.db.prepare(`DELETE FROM memory_vec WHERE rowid = ?`).run(BigInt(id));
      }
      this.db.prepare(`
        UPDATE memories
        SET status = 'deleted', updated_at = ?
        WHERE forget_after IS NOT NULL
          AND forget_after < ?
          AND status = 'active'
      `).run(now, todayBeijing);
    });
    transaction();

    console.log(`[Store] Cleaned up ${expiredIds.length} expired memories (forget_after < ${todayBeijing})`);
  }

  // ── Entity methods ─────────────────────────────────────────────

  /**
   * store_entity — upsert: 存在则更新，不存在则创建
   */
  async storeEntity(params: StoreEntityParams): Promise<StoreEntityResult> {
    const name = sanitize(params.name).trim();
    if (!name) return { stored: false, reason: 'empty_name' };

    const category = sanitize(params.category).trim();
    const aliases = params.aliases || [];
    const attributes = params.attributes || {};
    const relations = params.relations || [];

    // 生命周期单一真理源 = 列 status（v11）。剥离传入的 attributes.status（杜绝双字段再漂）；
    // 过渡兼容：无显式 status 入参、但 attributes.status 是合法可写枚举时，沿用它作为 status。
    let requestedStatus: EntityStatus | undefined = params.status;
    if (attributes && typeof attributes === 'object' && 'status' in attributes) {
      const attrStatus = String((attributes as Record<string, any>).status ?? '');
      if (!requestedStatus && (ENTITY_WRITABLE_STATUS as readonly string[]).includes(attrStatus)) {
        requestedStatus = attrStatus as EntityStatus;
      }
      delete (attributes as Record<string, any>).status;
    }
    if (requestedStatus && !(ENTITY_WRITABLE_STATUS as readonly string[]).includes(requestedStatus)) {
      return { stored: false, reason: `invalid status "${requestedStatus}" — 可写值: ${ENTITY_WRITABLE_STATUS.join('/')}（删除请用 delete_entity）` };
    }

    // 契约校验：长度硬上限（与 storeMemory 一致策略，不静默截断）
    if ([...name].length > 100) {
      return { stored: false, reason: `name length ${[...name].length} exceeds 100 — please shorten` };
    }
    if ([...category].length > 50) {
      return { stored: false, reason: `category length ${[...category].length} exceeds 50 — please shorten` };
    }

    // 契约校验：工具调用 token 黑名单（防 #1101 类污染，覆盖 storeEntity 全字段）
    const allHits: string[] = [];
    allHits.push(...detectToolCallContamination(name));
    allHits.push(...detectToolCallContamination(category));
    for (const a of aliases) {
      if (typeof a === 'string') allHits.push(...detectToolCallContamination(a));
    }
    const stack: unknown[] = [attributes];
    while (stack.length > 0) {
      const v = stack.pop();
      if (typeof v === 'string') {
        allHits.push(...detectToolCallContamination(v));
      } else if (Array.isArray(v)) {
        for (const item of v) stack.push(item);
      } else if (v && typeof v === 'object') {
        for (const key of Object.keys(v as object)) {
          stack.push((v as Record<string, unknown>)[key]);
        }
      }
    }
    for (const r of relations) {
      allHits.push(...detectToolCallContamination(r.type || ''));
      allHits.push(...detectToolCallContamination(r.target || ''));
    }
    const uniqueHits = [...new Set(allHits)];
    if (uniqueHits.length > 0) {
      return {
        stored: false,
        reason: `tool-call XML detected in input: ${uniqueHits.join(', ')} — re-emit as plain text without tool-call tags`,
      };
    }

    const now = nowBeijing();

    // 精确匹配 name 或 aliases 查找已有 entity（含 active）
    const existing = this.findEntityByName(name);

    // 没有 active entity 时，检查同名 deleted/archived/retired 可复活行（防 INSERT 出同名重复行）
    if (!existing) {
      const reactivatable = this.findReactivatableEntityByName(name);
      if (reactivatable) {
        // 复活语义：deleted 默认转 active（沿用既有恢复行为）；archived/retired 默认保持原状态
        // （store 仅更新数据，不静默 un-archive），显式传 status 时以入参为准。
        const prevStatus = (reactivatable.status ?? 'deleted') as EntityStatus;
        const newStatus: EntityStatus = requestedStatus ?? (prevStatus === 'deleted' ? 'active' : prevStatus);

        const mergedAliases = [...new Set([...reactivatable.aliases, ...aliases])];
        const mergedAttributes = { ...reactivatable.attributes, ...attributes };
        delete (mergedAttributes as Record<string, any>).status; // 守 v11 不变量：复活时不把旧 attributes.status 带回
        const mergedRelations = relations.length > 0 ? relations : reactivatable.relations;

        this.db.prepare(`
          UPDATE entities SET
            status = ?, aliases = ?, category = ?, attributes = ?, relations = ?,
            source = ?, updated_at = ?
          WHERE id = ?
        `).run(newStatus, JSON.stringify(mergedAliases), category || reactivatable.category, JSON.stringify(mergedAttributes), JSON.stringify(mergedRelations), this.source, now, reactivatable.id);

        // 重建 FTS（contentless FTS5 用 delete command）
        this.deleteFromEntitiesFTS(reactivatable.id, reactivatable.name, reactivatable.aliases.join(' '), reactivatable.category, JSON.stringify(reactivatable.attributes));
        this.db.prepare(`
          INSERT INTO entities_fts (rowid, name, aliases, category, attributes)
          VALUES (?, ?, ?, ?, ?)
        `).run(reactivatable.id, segment(name), segment(mergedAliases.join(' ')), segment(category || reactivatable.category), segment(JSON.stringify(mergedAttributes)));

        this.generateEntityEmbedding(reactivatable.id, name, mergedAliases, category || reactivatable.category, mergedAttributes).catch(err => console.warn('[Store] Entity embedding failed:', (err as Error).message));

        console.log(`[Store] Reactivated entity #${reactivatable.id} "${name}" (${prevStatus} → ${newStatus})`);
        this.invalidateEntityCache(name, mergedAliases);
        return { stored: true, id: reactivatable.id, updated: true };
      }
    }

    if (existing) {
      // Upsert: 合并 aliases（去重），覆盖 attributes 和 relations
      const mergedAliases = [...new Set([...existing.aliases, ...aliases])];
      const mergedAttributes = { ...existing.attributes, ...attributes };
      delete (mergedAttributes as Record<string, any>).status; // 守 v11 不变量：attributes 不存生命周期
      const mergedRelations = relations.length > 0 ? relations : existing.relations;
      // existing 来自 findEntityByName（仅 active），故无 status 入参时保持 active；传入则按入参（如归档）
      const newStatus: EntityStatus = requestedStatus ?? 'active';

      const aliasesJson = JSON.stringify(mergedAliases);
      const attrsJson = JSON.stringify(mergedAttributes);
      const relationsJson = JSON.stringify(mergedRelations);

      this.db.prepare(`
        UPDATE entities SET
          status = ?, aliases = ?, category = ?, attributes = ?, relations = ?,
          source = ?, updated_at = ?
        WHERE id = ?
      `).run(newStatus, aliasesJson, category || existing.category, attrsJson, relationsJson, this.source, now, existing.id);

      // 更新 FTS（contentless FTS5 用 delete command）
      this.deleteFromEntitiesFTS(existing.id, existing.name, existing.aliases.join(' '), existing.category, JSON.stringify(existing.attributes));
      this.db.prepare(`
        INSERT INTO entities_fts (rowid, name, aliases, category, attributes)
        VALUES (?, ?, ?, ?, ?)
      `).run(existing.id, segment(name), segment(mergedAliases.join(' ')), segment(category || existing.category), segment(JSON.stringify(mergedAttributes)));

      // 更新 embedding
      this.generateEntityEmbedding(existing.id, name, mergedAliases, category || existing.category, mergedAttributes).catch(err => console.warn('[Store] Entity embedding failed:', (err as Error).message));

      this.invalidateEntityCache(name, mergedAliases);
      return { stored: true, id: existing.id, updated: true };
    }

    // 新建
    const aliasesJson = JSON.stringify(aliases);
    const attrsJson = JSON.stringify(attributes);
    const relationsJson = JSON.stringify(relations);
    const newStatus: EntityStatus = requestedStatus ?? 'active';

    // id 按角色段显式分配；SELECT MAX 与 INSERT 放同一个 BEGIN IMMEDIATE 里防并发撞号
    const id = this.inWriteTransaction(() => {
      const newId = this.nextId('entities');
      this.db.prepare(`
        INSERT INTO entities (id, name, aliases, category, attributes, relations, status, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newId, name, aliasesJson, category, attrsJson, relationsJson, newStatus, this.source, now, now);

      // FTS
      this.db.prepare(`
        INSERT INTO entities_fts (rowid, name, aliases, category, attributes)
        VALUES (?, ?, ?, ?, ?)
      `).run(newId, segment(name), segment(aliases.join(' ')), segment(category), segment(attrsJson));
      return newId;
    });

    // Embedding（后台）
    this.generateEntityEmbedding(id, name, aliases, category, attributes).catch(err => console.warn('[Store] Entity embedding failed:', (err as Error).message));

    this.invalidateEntityCache(name, aliases);
    return { stored: true, id };
  }

  /** 失效 entity 缓存：name + 所有 aliases 对应的 key */
  private invalidateEntityCache(name: string, aliases: string[]): void {
    this.entityCache.invalidate(name.toLowerCase());
    for (const alias of aliases) {
      this.entityCache.invalidate(alias.toLowerCase());
    }
  }

  /**
   * delete_entity — 软删除实体
   */
  deleteEntity(params: { id: number; confirm?: boolean }): DeleteResult {
    if (!params.confirm) {
      return { deleted: false, reason: 'Entity 删除需要 confirm: true 确认' };
    }

    const row = this.db.prepare(`
      SELECT id, name, aliases, category, attributes FROM entities WHERE id = ? AND status = 'active'
    `).get(params.id) as { id: number; name: string; aliases: string; category: string; attributes: string } | undefined;

    if (!row) {
      return { deleted: false, reason: 'not_found' };
    }

    const now = nowBeijing();
    const aliases: string[] = JSON.parse(row.aliases || '[]');

    // 清理 FTS
    this.deleteFromEntitiesFTS(row.id, row.name, aliases.join(' '), row.category, row.attributes);

    // 清理 vec
    try {
      this.db.prepare(`DELETE FROM entity_vec WHERE rowid = ?`).run(BigInt(row.id));
    } catch { /* vec 可能不存在 */ }

    // soft delete
    this.db.prepare(`UPDATE entities SET status = 'deleted', updated_at = ? WHERE id = ?`).run(now, row.id);

    this.invalidateEntityCache(row.name, aliases);
    return { deleted: true, id: row.id, title: row.name };
  }

  /**
   * Contentless FTS5 删除：必须提供原始索引值，不能用 DELETE WHERE rowid
   * https://www.sqlite.org/fts5.html#the_delete_command
   */
  private deleteFromMemoriesFTS(rowid: number, title: string, tags: string, summary: string): void {
    this.db.prepare(`
      INSERT INTO memories_fts(memories_fts, rowid, title, tags, summary)
      VALUES('delete', ?, ?, ?, ?)
    `).run(rowid, segment(title), segment(tags), segment(summary));
  }

  private deleteFromEntitiesFTS(rowid: number, name: string, aliases: string, category: string, attributes: string): void {
    this.db.prepare(`
      INSERT INTO entities_fts(entities_fts, rowid, name, aliases, category, attributes)
      VALUES('delete', ?, ?, ?, ?, ?)
    `).run(rowid, segment(name), segment(aliases), segment(category), segment(attributes));
  }

  /**
   * 将 active 记忆恢复为链的最新版本，并在同一事务内重建全部派生索引。
   * 仅供 delete/restore rollback 路径使用，调用者负责已在事务中。
   */
  private restoreLatestMemoryIndexes(memoryId: number, now: string): void {
    const memory = this.db.prepare(`
      SELECT id, title, tags, summary, embedding
      FROM memories WHERE id = ? AND status = 'active'
    `).get(memoryId) as { id: number; title: string; tags: string; summary: string; embedding: string | null } | undefined;

    if (!memory) {
      throw new Error(`Cannot restore indexes for inactive memory ${memoryId}`);
    }

    // v13: 重新成为现行事实，就不能再挂着「已失效」的标记
    this.db.prepare(`
      UPDATE memories SET is_latest = 1, invalid_from = NULL, invalid_reason = NULL, updated_at = ? WHERE id = ?
    `).run(now, memory.id);
    this.db.prepare(`
      INSERT INTO memories_fts (rowid, title, tags, summary) VALUES (?, ?, ?, ?)
    `).run(memory.id, segment(memory.title), segment(memory.tags), segment(memory.summary));

    this.db.prepare(`DELETE FROM memory_vec WHERE rowid = ?`).run(BigInt(memory.id));
    if (memory.embedding) {
      try {
        const vector = JSON.parse(memory.embedding) as unknown;
        if (!Array.isArray(vector) || vector.length !== 1024 || !vector.every(value => typeof value === 'number')) {
          throw new Error('invalid embedding');
        }
        this.db.prepare(`INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)`).run(
          BigInt(memory.id), new Float32Array(vector),
        );
      } catch {
        // 让既有 backfill 机制选择该行，而非留下永远不会被修复的损坏 embedding。
        this.db.prepare(`UPDATE memories SET embedding = NULL, embedding_model = '' WHERE id = ?`).run(memory.id);
      }
    }

    this.db.prepare(`DELETE FROM memory_entities WHERE memory_id = ?`).run(memory.id);
    const mentions = this.extractEntityMentions(`${memory.title} ${memory.tags} ${memory.summary}`);
    const link = this.db.prepare(`
      INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)
    `);
    for (const entityId of mentions) {
      link.run(memory.id, entityId);
    }
  }

  /**
   * `restoreLatestMemoryIndexes` 的反向操作：把一条记忆从「现行事实」降为历史版本。
   * is_latest → 0，并同步撤掉三处检索侧派生索引（vec / FTS / memory_entities）——
   * 少撤任何一处，那条已作废的事实都会从该路继续被召回。
   *
   * invalid_from / invalid_reason 记录「什么时候、为什么不再成立」：光看 is_latest=0
   * 分不出「被新版本取代」与「这条事实作废了、没有后继」。
   *
   * 调用者负责已在事务中。
   */
  private retireMemoryIndexes(memoryId: number, now: string, invalidFrom: string, invalidReason: string): void {
    const memory = this.db.prepare(`
      SELECT id, title, tags, summary FROM memories WHERE id = ?
    `).get(memoryId) as { id: number; title: string; tags: string; summary: string } | undefined;

    if (!memory) {
      throw new Error(`Cannot retire indexes for missing memory ${memoryId}`);
    }

    this.db.prepare(`
      UPDATE memories SET is_latest = 0, invalid_from = ?, invalid_reason = ?, updated_at = ? WHERE id = ?
    `).run(invalidFrom, invalidReason, now, memory.id);
    this.db.prepare(`DELETE FROM memory_vec WHERE rowid = ?`).run(BigInt(memory.id));
    this.deleteFromMemoriesFTS(memory.id, memory.title, memory.tags, memory.summary);
    this.db.prepare(`DELETE FROM memory_entities WHERE memory_id = ?`).run(memory.id);
  }

  /**
   * get_entity — 精确匹配 name 或 aliases
   */
  getEntity(params: GetEntityParams): EntityRecord | null {
    const name = params.name.trim();
    if (!name) return null;

    // 缓存命中直接返回
    const cacheKey = name.toLowerCase();
    const cached = this.entityCache.get(cacheKey);
    if (cached !== undefined) return cached;

    // 注入对 archived/retired 隐藏，但 get_entity 仍应查得到（「对注入隐藏」≠「消失」）
    const entity = this.findEntityByNameIncludingArchived(name);
    this.entityCache.set(cacheKey, entity);
    return entity;
  }

  /**
   * P9 reverse-index 应用：返回与 project entity 共现频次最高的 entity
   * 用于 SessionStart hook 的「项目相关 entity」段
   */
  getCoOccurringEntities(
    projectEntityId: number,
    limit: number,
  ): Array<{ id: number; name: string; aliases: string[]; mentions: number }> {
    const rows = this.db.prepare(`
      SELECT e.id, e.name, e.aliases, COUNT(DISTINCT me.memory_id) AS mentions
      FROM memory_entities me
      JOIN entities e ON e.id = me.entity_id
      JOIN memories m ON m.id = me.memory_id
      WHERE m.status = 'active'
        AND m.is_latest = 1
        AND e.status = 'active'   -- v11: 列 status 为注入可见性唯一判据（archived/retired 已落选）
        AND e.id != ?
        AND me.memory_id IN (SELECT memory_id FROM memory_entities WHERE entity_id = ?)
      GROUP BY e.id
      ORDER BY mentions DESC
      LIMIT ?
    `).all(projectEntityId, projectEntityId, limit) as { id: number; name: string; aliases: string; mentions: number }[];

    return rows.map(r => {
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(r.aliases || '[]');
        if (Array.isArray(parsed)) aliases = parsed;
      } catch { /* ignore malformed */ }
      return { id: r.id, name: r.name, aliases, mentions: r.mentions };
    });
  }

  /**
   * search_entity — 混合检索实体：精确匹配 + FTS5 + 向量 KNN
   * - 精确匹配（name/alias lowercase 相等）保底排第一
   * - FTS5 与向量各取粗排 ENTITY_COARSE_LIMIT，归一化加权合并
   * - 向量降级为纯 FTS5
   */
  async searchEntity(params: SearchEntityParams): Promise<EntityRecord[]> {
    const query = params.query.trim();
    if (!query) return [];

    const limit = Math.min(params.limit || 10, 20);
    const categoryFilter = params.category;

    const exactIds = this.findExactEntityMatches(query, categoryFilter);
    const ftsResults = this.searchEntityFTS(query, ENTITY_COARSE_LIMIT, categoryFilter);
    const vectorResults = await this.searchEntityVector(query, ENTITY_COARSE_LIMIT, categoryFilter);

    return this.mergeEntityResults(exactIds, ftsResults, vectorResults, limit);
  }

  /** 精确匹配：name 或 aliases 中任一项 lowercase 等于 query。返回 [{id, kind}] kind=name|alias */
  private findExactEntityMatches(query: string, categoryFilter?: string): Array<{ id: number; kind: 'name' | 'alias' }> {
    const q = query.toLowerCase();
    const categoryClause = categoryFilter ? `AND category = ?` : '';
    const params: any[] = [];
    if (categoryFilter) params.push(categoryFilter);

    // name 精确匹配
    const nameRows = this.db.prepare(`
      SELECT id FROM entities WHERE status='active' AND LOWER(name) = ? ${categoryClause}
    `).all(q, ...params) as { id: number }[];

    // aliases LIKE 粗筛 + 精确比对
    const aliasCandidates = this.db.prepare(`
      SELECT id, aliases FROM entities WHERE status='active' AND LOWER(aliases) LIKE ? ${categoryClause}
    `).all(`%${q}%`, ...params) as { id: number; aliases: string }[];

    const nameIds = new Set(nameRows.map(r => r.id));
    const aliasIds: number[] = [];
    for (const r of aliasCandidates) {
      if (nameIds.has(r.id)) continue;
      try {
        const list = JSON.parse(r.aliases || '[]') as string[];
        if (Array.isArray(list) && list.some(a => typeof a === 'string' && a.toLowerCase() === q)) {
          aliasIds.push(r.id);
        }
      } catch { /* ignore */ }
    }

    const result: Array<{ id: number; kind: 'name' | 'alias' }> = [];
    for (const id of nameIds) result.push({ id, kind: 'name' });
    for (const id of aliasIds) result.push({ id, kind: 'alias' });
    return result;
  }

  /** FTS5 路 */
  private searchEntityFTS(query: string, limit: number, categoryFilter?: string): { id: number; rank: number }[] {
    const ftsQuery = segmentForQuery(query);
    if (!ftsQuery) return [];

    try {
      const categoryClause = categoryFilter ? `AND e.category = ?` : '';
      const params: any[] = [ftsQuery];
      if (categoryFilter) params.push(categoryFilter);
      params.push(limit);

      const rows = this.db.prepare(`
        SELECT e.id, fts.rank
        FROM entities_fts fts
        JOIN entities e ON e.id = fts.rowid
        WHERE entities_fts MATCH ? AND e.status = 'active' ${categoryClause}
        ORDER BY fts.rank
        LIMIT ?
      `).all(...params) as { id: number; rank: number }[];
      return rows;
    } catch (err) {
      console.warn('[Store] Entity FTS5 search error:', (err as Error).message);
      return [];
    }
  }

  /** 向量 KNN 路（sqlite-vec entity_vec） */
  private async searchEntityVector(
    query: string, limit: number, categoryFilter?: string,
  ): Promise<{ id: number; similarity: number }[]> {
    if (!this.embeddingService.isAvailable) return [];

    const cacheKey = `eq:${query}`;
    let queryEmbedding = this.embeddingCache.get(cacheKey) ?? null;
    if (!queryEmbedding) {
      queryEmbedding = await this.embeddingService.embed(query, 'RETRIEVAL_QUERY');
      if (queryEmbedding) this.embeddingCache.set(cacheKey, queryEmbedding);
    }
    if (!queryEmbedding) return [];

    try {
      const vecRows = this.db.prepare(`
        SELECT v.rowid, v.distance
        FROM entity_vec v
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `).all(new Float32Array(queryEmbedding), limit * 3) as { rowid: number; distance: number }[];

      if (vecRows.length === 0) return [];

      const ids = vecRows.map(r => r.rowid);
      const placeholders = ids.map(() => '?').join(',');
      const filterClauses = [`id IN (${placeholders})`, `status = 'active'`];
      const filterParams: any[] = [...ids];
      if (categoryFilter) {
        filterClauses.push(`category = ?`);
        filterParams.push(categoryFilter);
      }
      const filtered = this.db.prepare(`
        SELECT id FROM entities WHERE ${filterClauses.join(' AND ')}
      `).all(...filterParams) as { id: number }[];
      const filteredIds = new Set(filtered.map(r => r.id));

      // L2 → cosine：归一化向量下 sim ≈ 1 - dist²/2
      return vecRows
        .filter(r => filteredIds.has(r.rowid))
        .map(r => ({ id: r.rowid, similarity: Math.max(0, 1 - (r.distance * r.distance) / 2) }))
        .filter(r => r.similarity >= ENTITY_VEC_MIN_SIMILARITY)
        .slice(0, limit);
    } catch (err) {
      console.warn('[Store] Entity vec search error:', (err as Error).message);
      return [];
    }
  }

  /** 合并精确匹配 + FTS + 向量，归一化加权 */
  private mergeEntityResults(
    exactMatches: Array<{ id: number; kind: 'name' | 'alias' }>,
    ftsResults: { id: number; rank: number }[],
    vectorResults: { id: number; similarity: number }[],
    limit: number,
  ): EntityRecord[] {
    const scoreMap = new Map<number, number>();

    // 精确匹配：保底高分（同 id 取最高 kind 分）
    for (const m of exactMatches) {
      const s = m.kind === 'name' ? ENTITY_EXACT_NAME_SCORE : ENTITY_EXACT_ALIAS_SCORE;
      const prev = scoreMap.get(m.id) ?? 0;
      if (s > prev) scoreMap.set(m.id, s);
    }

    // FTS5 归一化（rank 越小越好，单候选给满分）
    if (ftsResults.length > 0) {
      const absRanks = ftsResults.map(r => Math.abs(r.rank));
      const minRank = Math.min(...absRanks);
      const maxRank = Math.max(...absRanks);
      const range = maxRank - minRank;
      for (const r of ftsResults) {
        const norm = range === 0 ? 1.0 : (Math.abs(r.rank) - minRank) / range;
        const add = norm * ENTITY_FTS_WEIGHT;
        const prev = scoreMap.get(r.id) ?? 0;
        // 精确匹配命中过的项不被加权分覆盖（保持高分），但允许向量+FTS 的加权累加
        scoreMap.set(r.id, prev >= ENTITY_EXACT_ALIAS_SCORE ? prev : prev + add);
      }
    }

    // 向量归一化（similarity 越大越好，单候选给满分）
    if (vectorResults.length > 0) {
      const sims = vectorResults.map(r => r.similarity);
      const minSim = Math.min(...sims);
      const maxSim = Math.max(...sims);
      const range = maxSim - minSim;
      for (const r of vectorResults) {
        const norm = range === 0 ? 1.0 : (r.similarity - minSim) / range;
        const add = norm * ENTITY_VEC_WEIGHT;
        const prev = scoreMap.get(r.id) ?? 0;
        scoreMap.set(r.id, prev >= ENTITY_EXACT_ALIAS_SCORE ? prev : prev + add);
      }
    }

    if (scoreMap.size === 0) return [];

    const sorted = Array.from(scoreMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    const ids = sorted.map(([id]) => id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, name, aliases, category, attributes, relations, source, created_at, updated_at
      FROM entities WHERE id IN (${placeholders})
    `).all(...ids) as any[];
    const rowMap = new Map(rows.map(r => [r.id, r]));

    const result: EntityRecord[] = [];
    for (const [id] of sorted) {
      const row = rowMap.get(id);
      if (row) result.push(this.parseEntityRow(row));
    }
    return result;
  }

  /**
   * 查找同名「可复活」entity（deleted/archived/retired，即非 active）——storeEntity 用，
   * 避免对同名归档/退役/删除行误 INSERT 出重复 active 行。返回含列 status 供复活语义判断。
   */
  private findReactivatableEntityByName(name: string): EntityRecord | null {
    const nameLower = name.toLowerCase();
    const row = this.db.prepare(`
      SELECT id, name, aliases, category, attributes, relations, source, created_at, updated_at, status
      FROM entities WHERE status IN ('deleted','archived','retired') AND LOWER(name) = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(nameLower) as any;
    return row ? this.parseEntityRow(row) : null;
  }

  /**
   * 精确查找：name 完全匹配 OR aliases 包含
   */
  private findEntityByName(name: string): EntityRecord | null {
    const nameLower = name.toLowerCase();

    // 先试 name 精确匹配
    const byName = this.db.prepare(`
      SELECT id, name, aliases, category, attributes, relations, source, created_at, updated_at
      FROM entities WHERE status = 'active' AND LOWER(name) = ?
    `).get(nameLower) as any;

    if (byName) return this.parseEntityRow(byName);

    // 再扫 aliases（JSON 数组，LIKE 粗筛 + 精确匹配）
    const candidates = this.db.prepare(`
      SELECT id, name, aliases, category, attributes, relations, source, created_at, updated_at
      FROM entities WHERE status = 'active' AND LOWER(aliases) LIKE ?
    `).all(`%${nameLower}%`) as any[];

    for (const row of candidates) {
      const aliases: string[] = JSON.parse(row.aliases || '[]');
      if (aliases.some(a => a.toLowerCase() === nameLower)) {
        return this.parseEntityRow(row);
      }
    }

    return null;
  }

  /** get_entity 专用：查 active + archived + retired（非 deleted），让归档/退役项目仍可被查到。
   *  active 优先（同名 active 命中即返回），再回退 archived/retired，最后扫 aliases。返回含列 status。 */
  private findEntityByNameIncludingArchived(name: string): EntityRecord | null {
    const nameLower = name.toLowerCase();

    // name 精确匹配：active 优先，其次 archived/retired
    const byName = this.db.prepare(`
      SELECT id, name, aliases, category, attributes, relations, source, created_at, updated_at, status
      FROM entities WHERE status IN ('active','archived','retired') AND LOWER(name) = ?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1
    `).get(nameLower) as any;
    if (byName) return this.parseEntityRow(byName);

    // 再扫 aliases（active 优先）
    const candidates = this.db.prepare(`
      SELECT id, name, aliases, category, attributes, relations, source, created_at, updated_at, status
      FROM entities WHERE status IN ('active','archived','retired') AND LOWER(aliases) LIKE ?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
    `).all(`%${nameLower}%`) as any[];

    for (const row of candidates) {
      const aliases: string[] = JSON.parse(row.aliases || '[]');
      if (aliases.some(a => a.toLowerCase() === nameLower)) {
        return this.parseEntityRow(row);
      }
    }

    return null;
  }

  private parseEntityRow(row: any): EntityRecord {
    return {
      id: row.id,
      name: row.name,
      aliases: JSON.parse(row.aliases || '[]'),
      category: row.category,
      attributes: JSON.parse(row.attributes || '{}'),
      relations: JSON.parse(row.relations || '[]'),
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      status: row.status as EntityStatus | undefined, // 仅在 SELECT 了 status 列时有值
    };
  }

  private async generateEntityEmbedding(
    id: number, name: string, aliases: string[], category: string, attributes: Record<string, any>,
  ): Promise<void> {
    if (!this.embeddingService.isAvailable) return;
    const text = `${name} ${aliases.join(' ')} ${category} ${JSON.stringify(attributes)}`.substring(0, 8000);
    const embedding = await this.embeddingService.embed(text, 'RETRIEVAL_DOCUMENT');
    if (embedding) {
      this.db.prepare(`UPDATE entities SET embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(embedding), this.embeddingService.modelName, nowBeijing(), id);
      // P8-a: 同步写入 entity_vec 虚拟表（INSERT OR REPLACE 处理 update 场景）
      try {
        this.db.prepare(`INSERT OR REPLACE INTO entity_vec (rowid, embedding) VALUES (?, ?)`)
          .run(BigInt(id), new Float32Array(embedding));
      } catch (err) {
        console.warn('[Store] entity_vec insert failed:', (err as Error).message);
      }
    }
  }

  /**
   * store_memory — 存储记忆
   */
  async storeMemory(params: StoreMemoryParams): Promise<StoreResult> {
    return this.storeMemoryInternal(params);
  }

  /** Gateway 专用：成功写入会与 ledger/audit 在同一 SQLite 事务中提交。 */
  async storeMemoryWithGatewayAudit(
    params: StoreMemoryParams,
    audit: GatewayAuditRecord,
    maxAcceptedWritesPerSession: number,
  ): Promise<StoreResult> {
    return this.storeMemoryInternal(params, audit, maxAcceptedWritesPerSession);
  }

  private async storeMemoryInternal(
    params: StoreMemoryParams,
    gatewayAudit?: GatewayAuditRecord,
    maxAcceptedWritesPerSession?: number,
  ): Promise<StoreResult> {
    // 输入净化
    const title = sanitize(params.title);
    const summary = sanitize(params.summary);
    const tags = normalizeTags(sanitize(params.tags));
    const type = params.type || 'work';
    const artifacts = params.artifacts || '[]';

    // 契约校验：长度硬上限（不静默截断，让模型重写）
    const titleLen = [...title].length;
    const summaryLen = [...summary].length;
    if (titleLen > 60) {
      return { stored: false, reason: `title length ${titleLen} exceeds 60 — please shorten` };
    }
    if (summaryLen > 1500) {
      return { stored: false, reason: `summary length ${summaryLen} exceeds 1500 — please shorten` };
    }

    // 契约校验：工具调用 token 黑名单（防 #1101 类污染）
    const titleHits = detectToolCallContamination(title);
    const summaryHits = detectToolCallContamination(summary);
    const tagsHits = detectToolCallContamination(tags);
    const artifactsHits = detectToolCallContamination(artifacts);
    const allHits = [...new Set([...titleHits, ...summaryHits, ...tagsHits, ...artifactsHits])];
    if (allHits.length > 0) {
      return {
        stored: false,
        reason: `tool-call XML detected in input: ${allHits.join(', ')} — re-emit as plain text without tool-call tags`,
      };
    }

    // 契约校验：artifacts 必须是合法 JSON array
    try {
      const parsed = JSON.parse(artifacts);
      if (!Array.isArray(parsed)) {
        return { stored: false, reason: `artifacts must be a JSON array, got ${typeof parsed}` };
      }
    } catch (err) {
      return { stored: false, reason: `artifacts is not valid JSON: ${(err as Error).message}` };
    }

    // v6-2: is_static + forget_after 互斥校验（审计修复 #13）
    if (params.is_static && params.forget_after) {
      return { stored: false, reason: 'is_static and forget_after are mutually exclusive' };
    }

    // v6-1: merge 向后兼容（审计修复 #18）
    let relation = params.relation;
    let deprecation: string | undefined;
    if (relation === 'merge') {
      relation = 'update';
      deprecation = 'merge is deprecated, use update';
    }

    // 同步生成 embedding（缓存命中时跳过 BGE-M3 推理）。
    // embed='defer'（短命写入端）：跳过 embedding 生成、不访问 embeddingService（→ 不 fork worker），
    // 走 embedding=null 的纯 FTS 写入；向量由 daemon backfillEmbeddings 后补。
    const combinedText = `${title} ${tags} ${summary}`;
    const docCacheKey = `d:${combinedText}`;
    let embedding = this.embeddingCache.get(docCacheKey) ?? null;
    if (!embedding && params.embed !== 'defer') {
      embedding = await this.embeddingService.embed(combinedText, 'RETRIEVAL_DOCUMENT');
      if (embedding) this.embeddingCache.set(docCacheKey, embedding);
    }

    // 写入前去重（force=true 或有 parent_id 时跳过）
    if (!params.force && !params.parent_id) {
      if (embedding) {
        const similar = this.findDuplicate(embedding);
        if (similar) {
          return {
            stored: false,
            reason: 'similar_found',
            similar_id: similar.id,
            similar_title: similar.title,
            similar_summary: similar.summary.substring(0, 200),
            action_required: 'decide: skip / update / extend / store',
          };
        }
      } else {
        const ftsDuplicate = this.findFTSDuplicate(title, summary);
        if (ftsDuplicate) {
          return {
            stored: false,
            reason: 'similar_found',
            similar_id: ftsDuplicate.id,
            similar_title: ftsDuplicate.title,
            similar_summary: '',
            action_required: 'decide: skip / update / extend / store',
          };
        }
      }
    }

    const now = nowBeijing();
    const segTitle = segment(title);
    const segTags = segment(tags);
    const segSummary = segment(summary);
    const embeddingJson = embedding ? JSON.stringify(embedding) : null;
    const embeddingModel = embedding ? this.embeddingService.modelName : '';

    // Gateway writes acquire the lock before quota/index work so concurrent clients cannot bypass the session ceiling.
    const writeMemory = () => {
      if (gatewayAudit && maxAcceptedWritesPerSession !== undefined) {
        this.assertGatewaySessionWriteLimit(gatewayAudit, maxAcceptedWritesPerSession);
      }
      let parentId: number | null = params.parent_id ?? null;
      let rootId: number | null = null;
      let version = 1;

      if (parentId && relation) {
        // 查找 parent
        const parent = this.db.prepare(`
          SELECT id, root_id, version FROM memories WHERE id = ? AND status = 'active'
        `).get(parentId) as { id: number; root_id: number | null; version: number } | undefined;

        if (!parent) {
          throw new Error(`parent_id ${parentId} not found or not active`);
        }

        rootId = parent.root_id ?? parent.id;

        // 审计修复 #9: 环形引用校验
        // 不允许新记忆的 root 指向自身链
        // （实际上新记忆还没 id，这里只校验 parent 链的合法性）

        if (relation === 'update') {
          version = parent.version + 1;
          // is_latest → 0 + 清 vec / FTS / memory_entities（审计修复 #16、v10）。
          // v13: 同一把 retire 也写下 invalid_from / invalid_reason，
          // 让「写入时取代」和「事后 supersede_memory 补链」留下同一种痕迹。
          this.retireMemoryIndexes(parentId, now, now.slice(0, 10), `superseded by a newer version (relation=update)`);
        }
        // extend: version = 1, parent 不变
      }

      // id 按角色段显式分配（nextId），不用 AUTOINCREMENT
      const id = this.nextId('memories');
      this.db.prepare(`
        INSERT INTO memories (
          id, type, title, tags, summary, artifacts, status, source,
          created_at, updated_at, embedding, embedding_model, user_id,
          parent_id, root_id, relation, version, is_latest,
          event_date, is_static, forget_after
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, '',
          ?, ?, ?, ?, 1,
          ?, ?, ?
        )
      `).run(
        id, type, title, tags, summary, artifacts,
        this.source, now, now,
        embeddingJson, embeddingModel,
        parentId, rootId, relation ?? null, version,
        params.event_date ?? null,
        params.is_static ? 1 : 0,
        params.forget_after ?? null,
      );

      // 取代链的后继 id 到这里才存在，回填进被取代那条的 invalid_reason。
      // 单独改 invalid_reason 不触发 history（WHEN 守卫不含该列），不产生额外 history 行。
      if (parentId && relation === 'update') {
        this.db.prepare(`UPDATE memories SET invalid_reason = ? WHERE id = ?`).run(`superseded by #${id}`, parentId);
      }

      // 写后读验证：按 id 回读，对比关键字段并复跑黑名单
      // 命中即抛错 → 事务回滚（INSERT 自动撤销）
      const readback = this.db.prepare(`
        SELECT title, tags, summary, artifacts FROM memories WHERE id = ?
      `).get(id) as { title: string; tags: string; summary: string; artifacts: string } | undefined;
      if (!readback) {
        throw new Error(`readback failed: id ${id} not found after insert`);
      }
      if (readback.title !== title || readback.tags !== tags || readback.summary !== summary || readback.artifacts !== artifacts) {
        throw new Error(`readback mismatch: stored data differs from input for id ${id}`);
      }
      const readbackHits = [
        ...detectToolCallContamination(readback.title),
        ...detectToolCallContamination(readback.tags),
        ...detectToolCallContamination(readback.summary),
        ...detectToolCallContamination(readback.artifacts),
      ];
      if (readbackHits.length > 0) {
        throw new Error(`readback contamination: ${[...new Set(readbackHits)].join(', ')}`);
      }

      // FTS
      this.db.prepare(`
        INSERT INTO memories_fts (rowid, title, tags, summary) VALUES (?, ?, ?, ?)
      `).run(id, segTitle, segTags, segSummary);

      // vec
      if (embedding) {
        this.db.prepare(`INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)`).run(BigInt(id), new Float32Array(embedding));
      }

      // P9: 反向索引 — 提取 entity 提及并写入 memory_entities
      const mentions = this.extractEntityMentions(`${title} ${tags} ${summary}`);
      if (mentions.length > 0) {
        const linkStmt = this.db.prepare(`
          INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)
        `);
        for (const eid of mentions) {
          linkStmt.run(id, eid);
        }
      }

      if (gatewayAudit) {
        this.insertGatewayAccepted(gatewayAudit, id);
      }

      return { id, parentId, rootId, version };
    };
    // 两条路都走 BEGIN IMMEDIATE：id 由 nextId 的 SELECT MAX 分配，deferred 事务里先读后写
    // 会在并发写时撞 SQLITE_BUSY_SNAPSHOT（2026-10-07 随 id 分段一起改）。
    const transaction = gatewayAudit
      ? () => this.withImmediateWriteTransaction(writeMemory)
      : this.db.transaction(writeMemory).immediate;

    const result = transaction();

    const storeResult: StoreResult = {
      stored: true,
      id: result.id,
    };
    if (result.parentId) {
      storeResult.parent_id = result.parentId;
      storeResult.root_id = result.rootId ?? undefined;
      storeResult.relation = relation ?? undefined;
      storeResult.version = result.version;
    }
    if (deprecation) {
      storeResult.deprecation = deprecation;
    }
    return storeResult;
  }

  private assertGatewaySessionWriteLimit(record: GatewayAuditRecord, maxAcceptedWritesPerSession: number): void {
    if (!Number.isInteger(maxAcceptedWritesPerSession) || maxAcceptedWritesPerSession < 1) {
      throw new Error('gateway session write limit must be a positive integer');
    }
    if (!record.session_id) {
      throw new Error('gateway quota requires session_id');
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM memory_gateway_requests
      WHERE client_id = ? AND session_id = ? AND outcome = 'accepted'
    `).get(record.client_id, record.session_id) as { count: number };
    if (row.count >= maxAcceptedWritesPerSession) {
      throw new Error('gateway_session_write_limit_exceeded');
    }
  }

  /**
   * 向量去重：sqlite-vec KNN 查最近邻，cosine > 0.85 视为相似
   */
  private findDuplicate(embedding: number[]): { id: number; title: string; summary: string } | null {
    try {
      // sqlite-vec 用 L2 距离，取 top 1 后转 cosine 验证
      const row = this.db.prepare(`
        SELECT v.rowid, v.distance, m.title, m.summary
        FROM memory_vec v
        JOIN memories m ON m.id = v.rowid
        WHERE v.embedding MATCH ? AND k = 5 AND m.status = 'active'
        ORDER BY v.distance
        LIMIT 1
      `).get(new Float32Array(embedding)) as { rowid: number; distance: number; title: string; summary: string } | undefined;

      if (!row) return null;

      // 从 memories 表取 embedding JSON 做精确 cosine 验证
      const embRow = this.db.prepare(`
        SELECT embedding FROM memories WHERE id = ? AND embedding IS NOT NULL
      `).get(row.rowid) as { embedding: string } | undefined;

      if (embRow) {
        const existingEmbedding = JSON.parse(embRow.embedding) as number[];
        const similarity = EmbeddingService.cosineSimilarity(embedding, existingEmbedding);
        if (similarity > DUPLICATE_THRESHOLD) {
          return { id: row.rowid, title: row.title, summary: row.summary };
        }
      }
      return null;
    } catch (err) {
      console.warn('[Store] Vec findDuplicate error, falling back to full scan:', (err as Error).message);
      // 降级：全表扫描（兼容 vec 表为空的情况）
      return this.findDuplicateFallback(embedding);
    }
  }

  /**
   * 全表 cosine 降级（vec 表出错时使用）
   */
  private findDuplicateFallback(embedding: number[]): { id: number; title: string; summary: string } | null {
    const rows = this.db.prepare(`
      SELECT id, title, summary, embedding FROM memories
      WHERE status = 'active' AND embedding IS NOT NULL AND embedding_model = ?
    `).all(this.embeddingService.modelName) as { id: number; title: string; summary: string; embedding: string }[];

    for (const row of rows) {
      try {
        const existingEmbedding = JSON.parse(row.embedding) as number[];
        const similarity = EmbeddingService.cosineSimilarity(embedding, existingEmbedding);
        if (similarity > DUPLICATE_THRESHOLD) {
          return { id: row.id, title: row.title, summary: row.summary };
        }
      } catch { continue; }
    }
    return null;
  }

  /**
   * FTS5 去重降级（无 embedding 时走这条）：标题相同 **且正文实质重合** 才算重复。
   *
   * 不能只比标题。这条路径是所有 digest 写入端的实际去重口（cli-store 用 embed:'defer'，
   * embedding 恒为 null），而 digest 的标题是「[渠道 日期] 主题」——同一天同一主题下
   * 完全不同的两封邮件标题必然相同：实测同一线程里「确认排期」与「回复确认纳入活动」
   * 同题不同事，只比标题会把后到的那封
   * 静默丢掉（SIMILAR 是终态成功，不报错、不重试、不通知）。
   * 所以再加一道正文 Jaccard 闸：≥0.6 判重复，否则放行。
   */
  private findFTSDuplicate(title: string, summary: string): { id: number; title: string } | null {
    const rows = this.db.prepare(`
      SELECT id, title, summary FROM memories
      WHERE status = 'active' AND title = ?
    `).all(title) as { id: number; title: string; summary: string }[];

    for (const row of rows) {
      if (jaccardSimilarity(summary, row.summary) >= FTS_DUP_JACCARD) {
        return { id: row.id, title: row.title };
      }
    }
    return null;
  }

  /**
   * search_memory — 搜索记忆（FTS5 + 向量混合）
   */
  async searchMemory(params: SearchMemoryParams): Promise<MemoryRecord[]> {
    const limit = Math.min(params.limit || 8, 15);
    const typeFilter = params.type;
    const dateFrom = params.date_from;
    const dateTo = params.date_to;
    const includeHistory = params.include_history ?? false;

    // v6-1: root_id 链查询
    if (params.root_id) {
      const rows = this.db.prepare(`
        SELECT id, title, tags, summary, artifacts, created_at, source,
               parent_id, root_id, version, is_latest, event_date, is_static, forget_after
        FROM memories
        WHERE (root_id = ? OR id = ?) AND status = 'active'
        ORDER BY version ASC
      `).all(params.root_id, params.root_id) as MemoryRecord[];
      return rows;
    }

    // 粗排：FTS5 + 向量各 top 50
    const ftsResults = this.searchFTS(params.query, COARSE_LIMIT, typeFilter, dateFrom, dateTo, includeHistory);
    const vectorResults = await this.searchVector(params.query, COARSE_LIMIT, typeFilter, dateFrom, dateTo, includeHistory);

    // 合并去重 + 归一化加权
    const merged = this.mergeResults(ftsResults, vectorResults, limit, params.query);

    // 只读模式：批量扫描（consolidation 等）跳过副作用，避免污染检索即巩固衰减信号 + query 语料
    if (params.readOnly) {
      return merged;
    }

    // 副作用：更新 retrieval_count 和 last_retrieved_at
    const now = nowBeijing();
    const updateStmt = this.db.prepare(`
      UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ? WHERE id = ?
    `);
    const updateTransaction = this.db.transaction(() => {
      for (const record of merged) {
        updateStmt.run(now, record.id);
      }
    });
    updateTransaction();

    // 记录查询日志（一行 jsonl，未来积累真实 query 用于扩展 golden set）
    try {
      const logPath = path.join(path.dirname(this.db.name), 'query.jsonl');
      const logLine = JSON.stringify({
        ts: now,
        source: this.source,
        query: params.query,
        type: typeFilter ?? null,
        limit,
        date_from: dateFrom ?? null,
        date_to: dateTo ?? null,
        result_ids: merged.map(r => r.id),
        result_count: merged.length,
      }) + '\n';
      fs.appendFile(logPath, logLine, () => {});
    } catch { /* 日志失败不影响搜索 */ }

    return merged;
  }

  /**
   * FTS5 搜索路
   */
  private searchFTS(
    query: string,
    limit: number,
    typeFilter?: MemoryType,
    dateFrom?: string,
    dateTo?: string,
    includeHistory?: boolean,
  ): { id: number; rank: number }[] {
    const ftsQuery = segmentForQuery(query);
    if (!ftsQuery) return [];

    try {
      const todayBeijing = nowBeijing().slice(0, 10);
      const latestClause = includeHistory ? '' : `AND m.is_latest = 1`;
      const forgetClause = `AND (m.forget_after IS NULL OR m.forget_after >= ?)`;
      const typeClause = typeFilter
        ? `AND m.type = ?`
        : `AND m.type NOT IN ('${DEFAULT_EXCLUDED_TYPES.join("','")}')`;
      const dateFromClause = dateFrom
        ? `AND (m.created_at >= ? OR (m.event_date IS NOT NULL AND m.event_date >= ?))`
        : '';
      const dateToClause = dateTo
        ? `AND (m.created_at <= ? OR (m.event_date IS NOT NULL AND m.event_date <= ?))`
        : '';

      const queryParams: any[] = [ftsQuery, todayBeijing];
      if (typeFilter) queryParams.push(typeFilter);
      if (dateFrom) queryParams.push(dateFrom, dateFrom);
      if (dateTo) queryParams.push(dateTo + 'T23:59:59.999Z', dateTo);
      queryParams.push(limit);

      const rows = this.db.prepare(`
        SELECT m.id, fts.rank
        FROM memories_fts fts
        JOIN memories m ON m.id = fts.rowid
        WHERE memories_fts MATCH ? AND m.status = 'active' ${latestClause} ${forgetClause} ${typeClause} ${dateFromClause} ${dateToClause}
        ORDER BY fts.rank
        LIMIT ?
      `).all(...queryParams) as { id: number; rank: number }[];

      return rows;
    } catch (err) {
      console.warn('[Store] FTS5 search error:', (err as Error).message);
      return [];
    }
  }

  /**
   * 向量搜索路（sqlite-vec KNN）
   */
  private async searchVector(
    query: string,
    limit: number,
    typeFilter?: MemoryType,
    dateFrom?: string,
    dateTo?: string,
    includeHistory?: boolean,
  ): Promise<{ id: number; similarity: number }[]> {
    if (!this.embeddingService.isAvailable) return [];

    // 缓存 query embedding，避免重复推理
    const cacheKey = `q:${query}`;
    let queryEmbedding = this.embeddingCache.get(cacheKey) ?? null;
    if (!queryEmbedding) {
      queryEmbedding = await this.embeddingService.embed(query, 'RETRIEVAL_QUERY');
      if (queryEmbedding) this.embeddingCache.set(cacheKey, queryEmbedding);
    }
    if (!queryEmbedding) return [];

    try {
      // sqlite-vec KNN 查询（审计修复 #16: vec 表只含 active + is_latest=1；
      // 该不变量由 reconcileVecIndex 在每次构造时对账兜底 —— 写路径漏写不会再静默累积）
      const vecRows = this.db.prepare(`
        SELECT v.rowid, v.distance
        FROM memory_vec v
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `).all(new Float32Array(queryEmbedding), limit * 3) as { rowid: number; distance: number }[];

      if (vecRows.length === 0) return [];

      const ids = vecRows.map(r => r.rowid);
      const todayBeijing = nowBeijing().slice(0, 10);

      const placeholders = ids.map(() => '?').join(',');
      const filterClauses: string[] = [`id IN (${placeholders})`, `status = 'active'`];
      const filterParams: any[] = [...ids];

      // v6-1: is_latest 过滤
      if (!includeHistory) {
        filterClauses.push(`is_latest = 1`);
      }
      // v6-2: forget_after 过滤
      filterClauses.push(`(forget_after IS NULL OR forget_after >= ?)`);
      filterParams.push(todayBeijing);

      if (typeFilter) {
        filterClauses.push(`type = ?`);
        filterParams.push(typeFilter);
      } else {
        // P4: 默认排除 observation/profile
        filterClauses.push(`type NOT IN ('${DEFAULT_EXCLUDED_TYPES.join("','")}')`);
      }
      if (dateFrom) {
        filterClauses.push(`(created_at >= ? OR (event_date IS NOT NULL AND event_date >= ?))`);
        filterParams.push(dateFrom, dateFrom);
      }
      if (dateTo) {
        filterClauses.push(`(created_at <= ? OR (event_date IS NOT NULL AND event_date <= ?))`);
        filterParams.push(dateTo + 'T23:59:59.999Z', dateTo);
      }

      const filtered = this.db.prepare(`
        SELECT id FROM memories WHERE ${filterClauses.join(' AND ')}
      `).all(...filterParams) as { id: number }[];

      const filteredIds = new Set(filtered.map(r => r.id));

      // L2 distance → 近似 cosine similarity: sim ≈ 1 - dist²/2（归一化向量）
      return vecRows
        .filter(r => filteredIds.has(r.rowid))
        .map(r => ({
          id: r.rowid,
          similarity: Math.max(0, 1 - (r.distance * r.distance) / 2),
        }))
        .filter(r => r.similarity >= VECTOR_MIN_SIMILARITY)
        .slice(0, limit);
    } catch (err) {
      console.warn('[Store] Vec search error, falling back:', (err as Error).message);
      return this.searchVectorFallback(queryEmbedding, limit, typeFilter, dateFrom, dateTo, includeHistory);
    }
  }

  /**
   * 向量搜索降级（vec 表出错时使用全表 cosine）
   */
  private searchVectorFallback(
    queryEmbedding: number[],
    limit: number,
    typeFilter?: MemoryType,
    dateFrom?: string,
    dateTo?: string,
    includeHistory?: boolean,
  ): { id: number; similarity: number }[] {
    const todayBeijing = nowBeijing().slice(0, 10);
    const latestClause = includeHistory ? '' : `AND is_latest = 1`;
    const forgetClause = `AND (forget_after IS NULL OR forget_after >= ?)`;
    const typeClause = typeFilter
      ? `AND type = ?`
      : `AND type NOT IN ('${DEFAULT_EXCLUDED_TYPES.join("','")}')`;
    const dateFromClause = dateFrom ? `AND created_at >= ?` : '';
    const dateToClause = dateTo ? `AND created_at <= ?` : '';
    const queryParams: any[] = [this.embeddingService.modelName, todayBeijing];
    if (typeFilter) queryParams.push(typeFilter);
    if (dateFrom) queryParams.push(dateFrom);
    if (dateTo) queryParams.push(dateTo + 'T23:59:59.999Z');

    const rows = this.db.prepare(`
      SELECT id, embedding FROM memories
      WHERE status = 'active' AND embedding IS NOT NULL AND embedding_model = ? ${latestClause} ${forgetClause} ${typeClause} ${dateFromClause} ${dateToClause}
    `).all(...queryParams) as { id: number; embedding: string }[];

    const candidates = rows
      .map(row => {
        try {
          return { id: row.id, embedding: JSON.parse(row.embedding) as number[] };
        } catch { return null; }
      })
      .filter((c): c is { id: number; embedding: number[] } => c !== null);

    return EmbeddingService.findTopK(queryEmbedding, candidates, limit, VECTOR_MIN_SIMILARITY);
  }

  /**
   * 精排：粗排 top 20 → Min-Max 归一化 + 时间衰减 + 加权求和 → top K
   */
  private mergeResults(
    ftsResults: { id: number; rank: number }[],
    vectorResults: { id: number; similarity: number }[],
    limit: number,
    query?: string,
  ): MemoryRecord[] {
    // P11: 按查询类型选权重
    const queryClass = query ? classifyQuery(query) : 'semantic';
    const weights = QUERY_WEIGHTS[queryClass];

    const scoreMap = new Map<number, { ftsNorm: number; vecNorm: number }>();

    // FTS5 归一化（rank 是负数，越小越好，取绝对值后越大越好）
    // P5: 单候选归一化退化修复——只有 1 条命中时给满分 1.0（孤儿候选 = 100% 相对得分）
    if (ftsResults.length > 0) {
      const absRanks = ftsResults.map(r => Math.abs(r.rank));
      const minRank = Math.min(...absRanks);
      const maxRank = Math.max(...absRanks);
      const range = maxRank - minRank;

      for (const r of ftsResults) {
        const norm = range === 0 ? 1.0 : (Math.abs(r.rank) - minRank) / range;
        scoreMap.set(r.id, { ftsNorm: norm, vecNorm: 0 });
      }
    }

    // 向量归一化（同样的单候选退化修复）
    if (vectorResults.length > 0) {
      const sims = vectorResults.map(r => r.similarity);
      const minSim = Math.min(...sims);
      const maxSim = Math.max(...sims);
      const range = maxSim - minSim;

      for (const r of vectorResults) {
        const norm = range === 0 ? 1.0 : (r.similarity - minSim) / range;
        const existing = scoreMap.get(r.id);
        if (existing) {
          existing.vecNorm = norm;
        } else {
          scoreMap.set(r.id, { ftsNorm: 0, vecNorm: norm });
        }
      }
    }

    if (scoreMap.size === 0) return [];

    // 审计修复 #5: 查 created_at + event_date + is_static + title/tags 用于时间衰减和标题加分
    const allIds = Array.from(scoreMap.keys());
    const placeholders = allIds.map(() => '?').join(',');
    const metaRows = this.db.prepare(`
      SELECT id, created_at, event_date, is_static, last_retrieved_at, title, tags FROM memories WHERE id IN (${placeholders})
    `).all(...allIds) as { id: number; created_at: string; event_date: string | null; is_static: number; last_retrieved_at: string | null; title: string; tags: string | null }[];
    const metaMap = new Map(metaRows.map(r => [r.id, r]));

    // title+tags 命中加分：查询关键词出现在 title 或 tags 中时加 TITLE_BOOST
    // 分词策略：空格拆原始词 + jieba 细分，合并去重，保留 >= 2 字符的 token
    let queryTokens: string[] = [];
    if (query) {
      const rawTokens = query.split(/\s+/).map(w => w.trim().toLowerCase()).filter(w => w.length >= 2);
      const jiebaTokens = nodejieba.cut(query).map(w => w.trim().toLowerCase()).filter(w => w.length >= 2 && !/^[\s\p{P}]+$/u.test(w));
      queryTokens = [...new Set([...rawTokens, ...jiebaTokens])];
    }

    const now = Date.now();

    // 加权合并 + 时间衰减（v6-2: is_static + event_date）+ 标题加分 + 排序
    const scored = Array.from(scoreMap.entries())
      .map(([id, scores]) => {
        const info = metaMap.get(id);
        let timeDecay: number;

        if (info?.is_static === 1) {
          // v6-2: 静态记忆不衰减
          timeDecay = 1.0;
        } else {
          // v6-2: 优先用 event_date，fallback created_at；检索即巩固：取内容时间和最近检索时间中更近的
          const contentDate = info?.event_date ?? info?.created_at;
          const retrievedDate = info?.last_retrieved_at;
          const latestDate = retrievedDate && contentDate
            ? (new Date(retrievedDate) > new Date(contentDate) ? retrievedDate : contentDate)
            : contentDate;
          const daysSince = latestDate
            ? (now - new Date(latestDate).getTime()) / (1000 * 60 * 60 * 24)
            : 30;
          timeDecay = Math.exp(-TIME_DECAY_LAMBDA * daysSince);
        }

        // title+tags 命中加分
        let titleBoost = 0;
        if (queryTokens.length > 0 && info) {
          const titleLower = (info.title || '').toLowerCase();
          const tagsLower = (info.tags || '').toLowerCase();
          const haystack = titleLower + ' ' + tagsLower;
          const hitCount = queryTokens.filter(t => haystack.includes(t)).length;
          if (hitCount > 0) {
            titleBoost = weights.titleBoost * (hitCount / queryTokens.length);
          }
        }

        return {
          id,
          score:
            scores.ftsNorm * weights.fts +
            scores.vecNorm * weights.vec +
            timeDecay * weights.time +
            titleBoost,
        };
      })
      .sort((a, b) => b.score - a.score);

    const finalScored = scored.slice(0, limit);

    // 查询完整记录
    const topIds = finalScored.map(s => s.id);
    const topPlaceholders = topIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, title, tags, summary, artifacts, created_at, source
      FROM memories WHERE id IN (${topPlaceholders})
    `).all(...topIds) as MemoryRecord[];

    // 按分数排序
    const rowMap = new Map(rows.map(r => [r.id, r]));
    const result: MemoryRecord[] = [];
    for (const s of finalScored) {
      const row = rowMap.get(s.id);
      if (row) {
        result.push({ ...row, score: s.score });
      }
    }
    return result;
  }

  /**
   * list_recent — 最近记忆
   * P3: 同步更新 retrieval_count（list 也是检索行为；list_all 蒸馏专用不计入）
   */
  listRecent(params: ListRecentParams): MemoryRecord[] {
    const count = Math.min(params.count || 10, 20);
    const typeFilter = params.type;
    const todayBeijing = nowBeijing().slice(0, 10);

    const typeClause = typeFilter ? `AND type = ?` : '';
    const queryParams: any[] = [todayBeijing];
    if (typeFilter) queryParams.push(typeFilter);
    queryParams.push(count);

    // v6-1: is_latest 过滤；v6-2: forget_after 过滤
    const rows = this.db.prepare(`
      SELECT id, title, tags, summary, artifacts, created_at, source,
             parent_id, root_id, version, is_latest, event_date, is_static, forget_after
      FROM memories
      WHERE status = 'active' AND is_latest = 1
        AND (forget_after IS NULL OR forget_after >= ?)
        ${typeClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...queryParams) as MemoryRecord[];

    // P3: 写 retrieval_count 与 last_retrieved_at（与 searchMemory 行为一致）
    if (!params.readOnly && rows.length > 0) {
      const now = nowBeijing();
      const updateStmt = this.db.prepare(`
        UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ? WHERE id = ?
      `);
      const tx = this.db.transaction(() => {
        for (const r of rows) updateStmt.run(now, r.id);
      });
      tx();
    }

    return rows;
  }

  /**
   * list_all — 分页读取指定类型的全量记忆（蒸馏用）
   */
  listAll(params: ListAllParams): { items: MemoryRecord[]; total: number; has_more: boolean } {
    const offset = params.offset || 0;
    const limit = Math.min(params.limit || 50, 100);
    const type = params.type;

    const total = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM memories WHERE status = 'active' AND is_latest = 1 AND type = ?
    `).get(type) as { cnt: number };

    const rows = this.db.prepare(`
      SELECT id, title, tags, summary, artifacts, created_at, source,
             parent_id, root_id, version, is_latest, event_date, is_static, forget_after
      FROM memories
      WHERE status = 'active' AND is_latest = 1 AND type = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(type, limit, offset) as MemoryRecord[];

    return {
      items: rows,
      total: total.cnt,
      has_more: offset + rows.length < total.cnt,
    };
  }

  /**
   * delete_memory — 软删除
   */
  deleteMemory(params: DeleteMemoryParams): DeleteResult {
    const row = this.db.prepare(`
      SELECT id, title, tags, summary, is_latest, parent_id, root_id, is_static FROM memories WHERE id = ? AND status = 'active'
    `).get(params.id) as { id: number; title: string; tags: string; summary: string; is_latest: number; parent_id: number | null; root_id: number | null; is_static: number } | undefined;

    if (!row) {
      return { deleted: false, reason: 'not_found' };
    }

    // is_static 保护：永久知识不可随意删除，需显式 force
    if (row.is_static === 1 && !params.force) {
      return { deleted: false, reason: `is_static 记忆受保护，如确需删除请传 force: true（#${row.id} "${row.title}"）` };
    }

    const now = nowBeijing();

    const transaction = this.db.transaction(() => {
      // v6-1: 删除链端时恢复祖先的 is_latest（审计修复 #1）
      if (row.is_latest === 1 && row.parent_id != null) {
        const parent = this.db.prepare(`
          SELECT id, status FROM memories WHERE id = ?
        `).get(row.parent_id) as { id: number; status: string } | undefined;

        if (parent && parent.status === 'active') {
          this.restoreLatestMemoryIndexes(parent.id, now);
        } else {
          // 沿链向上找最近的 active 祖先
          const ancestor = this.findActiveAncestor(row.root_id, row.parent_id);
          if (ancestor) {
            this.restoreLatestMemoryIndexes(ancestor, now);
          }
        }
      }

      // 审计修复 #16: 清理 vec 残留
      this.db.prepare(`DELETE FROM memory_vec WHERE rowid = ?`).run(BigInt(params.id));

      // 清理 FTS（contentless FTS5 用 delete command）
      this.deleteFromMemoriesFTS(params.id, row.title, row.tags, row.summary);
      this.db.prepare(`DELETE FROM memory_entities WHERE memory_id = ?`).run(params.id);

      // soft delete
      this.db.prepare(`
        UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?
      `).run(now, params.id);
    });

    transaction();

    return { deleted: true, id: row.id, title: row.title };
  }

  /**
   * supersede_memory — 事后补建取代链 / 无后继失效（v13，A2）
   *
   * 解决的是「取代关系只能在写入那一刻表达」：storeMemory 要求写入方在插入时就知道
   * 被取代的是哪条并传 parent_id，而实际写入方（digest 定时任务、session 总结）都不带，
   * 迁移时实测 relation='update' 仅 154 / 4345。于是「B 取代 A」这件已经知道的事在库里
   * 无处可写，A 就一直以现行事实的身份被检索到——典型例：一条旧规则与后来改写它的新规则
   * 并列为 is_latest=1。
   *
   * 失效沿用 is_latest=0 生效，不新开过滤线（见 upgradeToV13 注释）。
   * 旧版本不删除，`include_history: true` 与 `root_id` 链查仍能取回——对照业界共识
   * 「不删除，要取代」（Zep 失效边 / Mem0^g mark invalid）。
   */
  supersedeMemory(params: SupersedeMemoryParams): SupersedeResult {
    const reason = (params.reason ?? '').trim();
    if (!reason) {
      return { superseded: false, reason: 'reason_required' };
    }

    const invalidFrom = params.invalid_from ?? nowBeijing().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invalidFrom)) {
      return { superseded: false, reason: 'invalid_from_must_be_YYYY-MM-DD' };
    }

    const old = this.db.prepare(`
      SELECT id, title, root_id, version, is_latest FROM memories WHERE id = ? AND status = 'active'
    `).get(params.old_id) as { id: number; title: string; root_id: number | null; version: number; is_latest: number } | undefined;

    if (!old) return { superseded: false, reason: 'old_not_found_or_not_active' };
    if (old.is_latest !== 1) return { superseded: false, reason: 'old_already_superseded' };

    const rootId = old.root_id ?? old.id;
    let next: { id: number; title: string; parent_id: number | null } | null = null;

    if (params.new_id != null) {
      if (params.new_id === params.old_id) {
        return { superseded: false, reason: 'cannot_supersede_itself' };
      }

      const row = this.db.prepare(`
        SELECT id, title, parent_id, is_latest FROM memories WHERE id = ? AND status = 'active'
      `).get(params.new_id) as { id: number; title: string; parent_id: number | null; is_latest: number } | undefined;

      if (!row) return { superseded: false, reason: 'new_not_found_or_not_active' };
      if (row.is_latest !== 1) return { superseded: false, reason: 'new_is_not_latest' };
      // 已在链上的记忆不改写既有父指针——重挂会动 root_id / is_latest 的检索语义，
      // 且旧链的取代顺序会被悄悄改掉。需要重挂时先把它从链上解开。
      if (row.parent_id != null) return { superseded: false, reason: 'new_already_has_parent' };

      // 防环：new 一旦成为 old 的子节点，old 就不能是 new 的后代
      if (this.isDescendantOf(params.old_id, params.new_id)) {
        return { superseded: false, reason: 'would_create_cycle' };
      }

      next = { id: row.id, title: row.title, parent_id: row.parent_id };
    }

    const now = nowBeijing();
    const transaction = this.db.transaction(() => {
      if (next) {
        // new 自己可能已经是一条子链的根（实测 252 / 2795 现行记忆有子节点），
        // 整棵子树的 root_id 要跟着挪到 old 的链根上，否则 root_id 链查会把它们查漏。
        this.db.prepare(`UPDATE memories SET root_id = ? WHERE root_id = ?`).run(rootId, next.id);
        this.db.prepare(`
          UPDATE memories
          SET parent_id = ?, root_id = ?, relation = 'update', version = ?, updated_at = ?
          WHERE id = ?
        `).run(old.id, rootId, old.version + 1, now, next.id);
      }

      if (old.root_id == null) {
        // old 原本是孤立记忆，现在成了链根
        this.db.prepare(`UPDATE memories SET root_id = ? WHERE id = ?`).run(rootId, old.id);
      }

      this.retireMemoryIndexes(old.id, now, invalidFrom, reason);
    });

    transaction();

    return {
      superseded: true,
      old_id: old.id,
      old_title: old.title,
      new_id: next?.id ?? null,
      new_title: next?.title ?? null,
      root_id: rootId,
      invalid_from: invalidFrom,
    };
  }

  /** candidateId 是否在 ancestorId 的后代链上（沿 parent_id 向上走，带防环） */
  private isDescendantOf(candidateId: number, ancestorId: number): boolean {
    let currentId: number | null = candidateId;
    const visited = new Set<number>();

    while (currentId != null) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      if (currentId === ancestorId) return true;

      const row = this.db.prepare(`
        SELECT parent_id FROM memories WHERE id = ?
      `).get(currentId) as { parent_id: number | null } | undefined;
      if (!row) return false;
      currentId = row.parent_id;
    }
    return false;
  }

  /**
   * 沿记忆链向上查找最近的 active 祖先
   */
  private findActiveAncestor(rootId: number | null, startParentId: number | null): number | null {
    let currentId = startParentId;
    const visited = new Set<number>();

    while (currentId != null) {
      if (visited.has(currentId)) break; // 防环
      visited.add(currentId);

      const row = this.db.prepare(`
        SELECT id, parent_id, status FROM memories WHERE id = ?
      `).get(currentId) as { id: number; parent_id: number | null; status: string } | undefined;

      if (!row) break;
      if (row.status === 'active') return row.id;
      currentId = row.parent_id;
    }
    return null;
  }

  /**
   * restore_memory — 恢复已删除的记忆
   * 完整恢复：status + vec 重建 + is_latest 冲突处理
   */
  restoreMemory(params: RestoreMemoryParams): RestoreResult {
    const row = this.db.prepare(`
      SELECT id, title, tags, summary, embedding, parent_id, root_id, relation, is_latest
      FROM memories WHERE id = ? AND status = 'deleted'
    `).get(params.id) as {
      id: number; title: string; tags: string; summary: string; embedding: string | null;
      parent_id: number | null; root_id: number | null;
      relation: string | null; is_latest: number;
    } | undefined;

    if (!row) {
      return { restored: false, reason: 'not_found_or_not_deleted' };
    }

    const now = nowBeijing();

    const transaction = this.db.transaction(() => {
      // 恢复 status
      this.db.prepare(`
        UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?
      `).run(now, params.id);

      // is_latest 冲突处理：如果恢复的是 update 关系的子记忆，
      // 需要把 parent 的 is_latest 重新设为 0
      if (row.relation === 'update' && row.parent_id != null) {
        const parent = this.db.prepare(`
          SELECT id, status, is_latest FROM memories WHERE id = ?
        `).get(row.parent_id) as { id: number; status: string; is_latest: number } | undefined;

        if (parent && parent.status === 'active' && parent.is_latest === 1) {
          // parent 不再是 latest：is_latest → 0 并清 vec / FTS / memory_entities
          this.retireMemoryIndexes(parent.id, now, now.slice(0, 10), `superseded by #${params.id}`);
        }
      }

      this.restoreLatestMemoryIndexes(params.id, now);
    });

    transaction();

    return { restored: true, id: row.id, title: row.title };
  }

  /**
   * vec 索引对账 —— 纯 SQLite 搬运，不调模型、不 fork worker。
   *
   * 存在的理由：memory_vec / entity_vec 的维护散在十余处写路径里，任何一条漏写就静默漂移，
   * 而漂移的表现是「检索结果变差」，没有报错、没有告警。2026-08-29 实测积累到
   * 852 条 active 记忆有合法向量却不在 vec 表（占 30%），只能被 FTS 召回；源头是
   * 一个外部进程 attach 本库直接写裸 SQL（`UPDATE mem.memories SET embedding = ?`），
   * 既不写 embedding_model 也不插 vec 行。源头已修，但只要还有外部写入端，
   * 这里就得有一道与写入端无关的兜底。
   *
   * 三件事：① 删掉主表侧已不该被索引的陈旧 vec 行；② 把缺行但主表有合法向量的补进 vec；
   * ③ 顺带给 ② 里 embedding_model 为空的补上标记 —— 否则它们仍被 findDuplicate /
   * searchVector 的全表兜底路（`WHERE embedding_model = ?`）排除在外。
   *
   * 认领门槛（宁可漏认领，不认错）：维度 1024、全部有限数、L2 范数 ∈ [0.99, 1.01]。
   * bge-m3 输出为归一化单位向量，异模型/损坏数据过不了这关，留给 backfillEmbeddings 重算。
   */
  private reconcileVecIndex(): void {
    const targets = [
      { vecTable: 'memory_vec', mainTable: 'memories', liveWhere: "status = 'active' AND is_latest = 1" },
      { vecTable: 'entity_vec', mainTable: 'entities', liveWhere: "status = 'active'" },
    ];

    for (const t of targets) {
      // ① 陈旧行
      const staleResult = this.db.prepare(`
        DELETE FROM ${t.vecTable}
        WHERE rowid NOT IN (SELECT id FROM ${t.mainTable} WHERE ${t.liveWhere})
      `).run();

      // ②③ 缺行但主表有 embedding（含 model 为空的孤儿）
      const candidates = this.db.prepare(`
        SELECT id, embedding, COALESCE(embedding_model, '') AS model FROM ${t.mainTable}
        WHERE ${t.liveWhere}
          AND embedding IS NOT NULL
          AND (embedding_model = ? OR COALESCE(embedding_model, '') = '')
          AND id NOT IN (SELECT rowid FROM ${t.vecTable})
        LIMIT ?
      `).all(this.embeddingService.modelName, VEC_RECONCILE_LIMIT) as
        { id: number; embedding: string; model: string }[];

      if (staleResult.changes === 0 && candidates.length === 0) continue;

      const insStmt = this.db.prepare(`INSERT OR REPLACE INTO ${t.vecTable} (rowid, embedding) VALUES (?, ?)`);
      const stampStmt = this.db.prepare(
        `UPDATE ${t.mainTable} SET embedding_model = ? WHERE id = ? AND COALESCE(embedding_model, '') = ''`
      );

      let inserted = 0;
      let rejected = 0;
      const run = this.db.transaction(() => {
        for (const row of candidates) {
          const vec = vetStoredEmbedding(row.embedding);
          if (!vec) { rejected++; continue; }
          if (row.model === '') stampStmt.run(this.embeddingService.modelName, row.id);
          insStmt.run(BigInt(row.id), vec);
          inserted++;
        }
      });
      run();

      if (staleResult.changes > 0 || inserted > 0 || rejected > 0) {
        console.log(
          `[Store] Vec reconcile ${t.vecTable}: -${staleResult.changes} stale, +${inserted} indexed` +
          (rejected > 0 ? `, ${rejected} rejected (left to backfill)` : '')
        );
      }
    }
  }

  /**
   * 后台补全缺失的 embedding
   */
  private async backfillEmbeddings(): Promise<void> {
    // 常驻进程：必须等 worker 就绪再判可用性。isAvailable 是同步字段，构造阶段恒为 false，
    // 早先在这里直接读它 → 每次启动都立刻 return，补齐任务实际从未执行过（2026-08-29 实测：
    // 18 条无向量记忆在 daemon 反复重启两个月后仍未被补上，且无任何报错）。
    // 短命 CLI（EMBED_FAST_FAIL=1）保持原来的立即降级语义，不为补齐拖住 hook 的 alarm 预算。
    if (!this.embeddingService.isFastFail) {
      await this.embeddingService.waitUntilReady();
    }
    if (!this.embeddingService.isAvailable) return;

    const rows = this.db.prepare(`
      SELECT id, title, tags, summary FROM memories
      WHERE status = 'active' AND is_latest = 1 AND (embedding IS NULL OR embedding_model != ?)
      LIMIT 100
    `).all(this.embeddingService.modelName) as { id: number; title: string; tags: string; summary: string }[];

    if (rows.length === 0) return;

    console.log(`[Store] Backfilling ${rows.length} embeddings...`);

    const texts = rows.map(r => `${r.title} ${r.tags} ${r.summary}`);
    const embeddings = await this.embeddingService.embedBatch(texts, 'RETRIEVAL_DOCUMENT');

    const updateStmt = this.db.prepare(`
      UPDATE memories SET embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ?
    `);
    const insertVec = this.db.prepare(`
      INSERT OR REPLACE INTO memory_vec (rowid, embedding) VALUES (?, ?)
    `);

    const now = nowBeijing();
    let count = 0;

    const transaction = this.db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        if (embeddings[i]) {
          updateStmt.run(JSON.stringify(embeddings[i]), this.embeddingService.modelName, now, rows[i].id);
          insertVec.run(BigInt(rows[i].id), new Float32Array(embeddings[i]!));
          count++;
        }
      }
    });

    transaction();
    console.log(`[Store] Backfilled ${count}/${rows.length} embeddings`);
  }

  /**
   * 直接插入记忆（迁移用，跳过去重和 embedding 生成）
   */
  insertRaw(memory: {
    type: string;
    title: string;
    tags: string;
    summary: string;
    artifacts: string;
    status: string;
    source: string;
    created_at: string;
    updated_at: string;
    last_retrieved_at: string | null;
    retrieval_count: number;
    embedding: string | null;
    embedding_model: string;
    user_id: string;
  }): number {
    const insertMemory = this.db.prepare(`
      INSERT INTO memories (id, type, title, tags, summary, artifacts, status, source, created_at, updated_at, last_retrieved_at, retrieval_count, embedding, embedding_model, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFTS = this.db.prepare(`
      INSERT INTO memories_fts (rowid, title, tags, summary)
      VALUES (?, ?, ?, ?)
    `);

    const segTitle = segment(memory.title);
    const segTags = segment(memory.tags);
    const segSummary = segment(memory.summary);

    const transaction = this.db.transaction(() => {
      const id = this.nextId('memories');
      insertMemory.run(
        id,
        memory.type, memory.title, memory.tags, memory.summary, memory.artifacts,
        memory.status, memory.source, memory.created_at, memory.updated_at,
        memory.last_retrieved_at, memory.retrieval_count,
        memory.embedding, memory.embedding_model, memory.user_id,
      );
      insertFTS.run(id, segTitle, segTags, segSummary);
      return id;
    });

    return transaction.immediate();
  }

  /**
   * 统计信息
   */
  getStats(): { total: number; active: number; nullEmbedding: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as any).c;
    const active = (this.db.prepare(`SELECT COUNT(*) as c FROM memories WHERE status = 'active'`).get() as any).c;
    const nullEmbedding = (this.db.prepare(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND embedding IS NULL`).get() as any).c;
    return { total, active, nullEmbedding };
  }

  /**
   * 批量取某类型 active 记忆的原始 embedding（JSON 文本，1024d）。
   * 给 consolidation 这类需要**两两真 cosine**的离线扫描用——searchMemory 的 score 是结果集内
   * 的相对排序分，不能当相似度比固定阈值（2026-08-08 修，见 cli-consolidate.ts 头注）。
   * 只读，不触发 embedding worker、不更新检索计数。
   */
  listEmbeddingsByType(type: string): { id: number; embedding: string | null }[] {
    return this.db.prepare(`
      SELECT id, embedding FROM memories
      WHERE status = 'active' AND is_latest = 1 AND type = ?
      ORDER BY id
    `).all(type) as { id: number; embedding: string | null }[];
  }

  /**
   * 按 query 算每条候选的**原始 cosine**（不是 searchMemory 的混合排序分）。
   *
   * 存在的理由：searchMemory 的 score 是结果集内的相对排序分（min-max 归一化 + 时间衰减 + 标题加分），
   * 拿它比固定阈值判「相关不相关」是类别错误。实测「帮我订一张明天去上海的高铁票」这种完全无关的
   * query，注入项 score 仍有 0.54–0.60，而真实 cosine 只有 0.377–0.428；相关 query 的真实 cosine
   * 则在 0.65 上下。要做绝对相关度判断（注入闸、去重闸）必须回到原始 cosine。
   *
   * 无 embedding 的候选返回 0（宁可漏注入，不可乱注入）。embedding 不可用时返回空 Map，
   * 调用方据此降级为不过滤（保持原行为，不因向量故障把注入整个打空）。
   */
  async cosineAgainstQuery(query: string, ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (ids.length === 0) return out;

    // 不查 isAvailable：短命 CLI 里 BGE-M3 worker 要 ~1s 才就绪，构造后立刻查必然是 false
    // （searchVector 就是这么被静默跳过的）。直接 await embed——内部等 ready，
    // FAST_FAIL 下 6s 封顶，失败返回 null，由下面降级为"不过滤"。
    const cacheKey = `q:${query}`;
    let queryEmbedding = this.embeddingCache.get(cacheKey) ?? null;
    if (!queryEmbedding) {
      queryEmbedding = await this.embeddingService.embed(query, 'RETRIEVAL_QUERY');
      if (queryEmbedding) this.embeddingCache.set(cacheKey, queryEmbedding);
    }
    if (!queryEmbedding) return out;

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, embedding FROM memories WHERE id IN (${placeholders})
    `).all(...ids) as { id: number; embedding: string | null }[];

    for (const r of rows) {
      if (!r.embedding) { out.set(r.id, 0); continue; }
      try {
        const v = JSON.parse(r.embedding) as number[];
        out.set(r.id, EmbeddingService.cosineSimilarity(queryEmbedding, v));
      } catch {
        out.set(r.id, 0);
      }
    }
    return out;
  }

  close(): void {
    // 关掉 fork 的 embedding worker，否则短命 CLI（cli-observation-block 等）
    // 子进程吊住事件循环不退出 → 被钩子 alarm 砍成 exit=124 → 已产出的结果被丢弃
    this._embeddingService?.shutdown();
    this.db.close();
  }
}
