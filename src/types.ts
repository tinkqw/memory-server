// Memory MCP Server — 类型定义

export type MemoryType = 'work' | 'observation' | 'entity' | 'profile';
export type MemoryStatus = 'active' | 'deleted' | 'archived';

// Entity 生命周期状态（列 status 的受控枚举，注入可见性唯一判据）。
// 仅 active 进注入；archived/retired 仍可 get_entity 查（「对注入隐藏」≠「消失」）；deleted 走 deleteEntity。
// 运营阶段（planning/设计中 等）属 attributes.phase，不在此枚举、不参与过滤。
export type EntityStatus = 'active' | 'archived' | 'retired' | 'deleted';
// store_entity 可写入的生命周期（删除走 deleteEntity，故不含 deleted）
export const ENTITY_WRITABLE_STATUS: readonly EntityStatus[] = ['active', 'archived', 'retired'];

export type MemoryRelation = 'update' | 'extend';

export interface Memory {
  id: number;
  type: MemoryType;
  title: string;
  tags: string;
  summary: string;
  artifacts: string; // JSON array string
  status: MemoryStatus;
  source: string;
  created_at: string;
  updated_at: string;
  last_retrieved_at: string | null;
  retrieval_count: number;
  embedding: string | null; // JSON array string
  embedding_model: string;
  user_id: string;
  // v6-1: 关系版本化
  parent_id: number | null;
  root_id: number | null;
  relation: MemoryRelation | null;
  version: number;
  is_latest: number; // 0/1
  // v6-2: 静态标记 + 事件时间 + 自动过期
  event_date: string | null;  // YYYY-MM-DD
  is_static: number; // 0/1
  forget_after: string | null; // YYYY-MM-DD
  // v13: 失效标记（A2）。is_latest=0 之外再记「什么时候、为什么不再成立」——
  // 光看 is_latest=0 分不出「被新版本取代」和「这条事实本身作废了」。
  invalid_from: string | null;   // YYYY-MM-DD，事实停止成立的日期
  invalid_reason: string | null; // 失效理由（人写的一句话）
}

export interface StoreMemoryParams {
  title: string;
  tags: string;
  summary: string;
  type: MemoryType;
  artifacts?: string; // JSON array string
  force?: boolean; // 跳过去重检查，仅在 Claude 判断 similar_found 后决定 store 时使用
  // v6-1: 关系版本化
  parent_id?: number;
  relation?: MemoryRelation | 'merge'; // merge 向后兼容，自动映射为 update
  // v6-2: 静态标记 + 事件时间 + 自动过期
  event_date?: string;    // YYYY-MM-DD
  is_static?: boolean;
  forget_after?: string;  // YYYY-MM-DD
  // 写入端 embedding 策略：'defer' = 跳过同步 embedding（不 fork BGE-M3 worker），纯 FTS 写入，
  // 向量由 daemon backfillEmbeddings 后补。短命写入 CLI（cli-store）用，避免 embedding 挂起拖死写路径。
  // 默认（undefined）= 'sync'：daemon 等常驻进程同步生成向量。
  embed?: 'sync' | 'defer';
}

export interface SearchMemoryParams {
  query: string;
  type?: MemoryType;
  limit?: number;
  date_from?: string;  // ISO date string, e.g. '2026-03-01'
  date_to?: string;    // ISO date string, e.g. '2026-03-31'
  // v6-1
  include_history?: boolean; // 默认 false，设为 true 返回全部版本（含 is_latest=0）
  root_id?: number;          // 查整条记忆链
  // 只读模式：跳过 retrieval_count/last_retrieved_at 更新 + query.jsonl 日志。
  // 给批量扫描（consolidation job 等）用，避免污染「检索即巩固」衰减信号 + query 语料。
  readOnly?: boolean;
}

export interface ListRecentParams {
  count?: number;
  type?: MemoryType;
  // Gateway reads must not affect retrieval-based decay signals.
  readOnly?: boolean;
}

export type GatewayOperation = 'memory_write' | 'memory_update';
// P2 v1.2 has one implemented lifecycle. Other retention modes remain a future contract change.
export type GatewayRetentionIntent = 'durable';
export type GatewayRequestOutcome = 'accepted' | 'rejected';

export interface GatewayMutationContext {
  request_id?: string;
  project_id?: string;
  evidence_ref?: string;
  // Runtime input remains a string so malformed values reach the gateway rejection audit.
  retention_intent?: string;
  idempotency_key?: string;
}

export interface GatewayAuditRecord {
  request_id: string | null;
  runtime_id: string;
  client_id: string;
  session_id: string | null;
  project_id: string | null;
  evidence_ref: string | null;
  retention_intent: GatewayRetentionIntent | null;
  idempotency_key: string | null;
  operation: GatewayOperation;
  payload_hash: string;
}

export interface GatewayLedgerRecord extends GatewayAuditRecord {
  // The ledger records only committed mutations. Rejected attempts live in the audit table.
  outcome: 'accepted';
  reason: null;
  memory_id: number;
  created_at: string;
}

export interface ListAllParams {
  type: MemoryType;
  offset?: number;  // 默认 0
  limit?: number;   // 默认 50，最大 100
}

export interface DeleteMemoryParams {
  id: number;
  force?: boolean;
}

export interface StoreResult {
  stored: boolean;
  id?: number;
  reason?: string;
  similar_id?: number;
  similar_title?: string;
  similar_summary?: string; // 前 200 字，供 Claude 对比决策
  action_required?: string; // "decide: skip / update / extend / store"
  // v6-1 返回值
  parent_id?: number;
  root_id?: number;
  relation?: string;
  version?: number;
  deprecation?: string; // merge 兼容提示
}

export interface DeleteResult {
  deleted: boolean;
  id?: number;
  title?: string;
  reason?: string;
}

export interface RestoreMemoryParams {
  id: number;
}

export interface RestoreResult {
  restored: boolean;
  id?: number;
  title?: string;
  reason?: string;
}

// v13 (A2): 事后补建取代链 / 无后继失效。
// 写入时不知道被取代的是哪条（digest、session 总结都不带 parent_id，实测 update 仅 154/4345），
// 所以取代关系必须能事后补——否则「B 取代 A」这件已知的事在库里无处可写，
// A 就一直以现行事实的身份被检索到。
export interface SupersedeMemoryParams {
  old_id: number;            // 不再成立的那条
  new_id?: number;           // 取代它的那条；省略 = 只作废、无后继
  reason: string;            // 为什么不再成立，必填
  invalid_from?: string;     // YYYY-MM-DD，默认今天（北京时间）
}

export interface SupersedeResult {
  superseded: boolean;
  reason?: string;           // 失败原因码
  old_id?: number;
  old_title?: string;
  new_id?: number | null;
  new_title?: string | null;
  root_id?: number | null;
  invalid_from?: string;
}

export interface MemoryRecord {
  id: number;
  title: string;
  tags: string;
  summary: string;
  artifacts: string;
  created_at: string;
  source: string;
  score?: number;
  // v6-1
  parent_id?: number | null;
  root_id?: number | null;
  version?: number;
  is_latest?: number;
  // v6-2
  event_date?: string | null;
  is_static?: number;
  forget_after?: string | null;
  // v13
  invalid_from?: string | null;
  invalid_reason?: string | null;
}

// 标签归一化映射表（同义词 → 标准标签）
export const TAG_NORMALIZATION_MAP: Record<string, string> = {
  'lark': '飞书',
  'feishu': '飞书',
  'lark-doc': '飞书文档',
  'feishu-doc': '飞书文档',
  'feishu-wiki': '飞书知识库',
  'lark-wiki': '飞书知识库',
  'deployment': '部署',
  'deploy': '部署',
  'debug': '调试',
  'debugging': '调试',
  'security': '安全',
  'api': '接口',
  'API': '接口',
  'prompt': '提示词',
  'prompt-engineering': '提示词',
  'workflow': '工作流',
  'config': '配置',
  'configuration': '配置',
  'xiaohongshu': '小红书',
  'growth': '增长',
  'brand': '品牌',
  'hiring': '招聘',
  'recruitment': '招聘',
  'okr': 'OKR',
  'content': '内容',
  'research': '调研',
  'memory': '记忆系统',
  'memory-server': '记忆系统',
};

// 标准标签列表
export const STANDARD_TAGS = [
  '飞书', '飞书文档', '飞书知识库', '部署', '调试', '安全',
  '接口', '提示词', '工作流', '配置', '小红书', '增长',
  '品牌', '招聘', 'OKR', '内容', '调研', '记忆系统',
];

// ── Entity 类型 ──

export interface Entity {
  id: number;
  name: string;
  aliases: string[];       // JSON array in DB
  category: string;        // project/person/group/wiki_space/document/team
  attributes: Record<string, any>;  // JSON object in DB
  relations: EntityRelation[];      // JSON array in DB
  status: 'active' | 'deleted';
  source: string;
  created_at: string;
  updated_at: string;
}

export interface EntityRelation {
  type: string;   // belongs_to, stored_in, owns, etc.
  target: string;
}

export interface StoreEntityParams {
  name: string;
  category: string;
  attributes?: Record<string, any>;
  aliases?: string[];
  relations?: EntityRelation[];
  // 生命周期（写列 status）。不传则：复活/新建默认 active，已存在则保持原状态不变。
  // 传入的 attributes.status 一律剥离（生命周期单一真理源 = 列），见 storeEntity。
  status?: EntityStatus;
}

export interface GetEntityParams {
  name: string;
}

export interface SearchEntityParams {
  query: string;
  category?: string;
  limit?: number;
}

export interface StoreEntityResult {
  stored: boolean;
  id?: number;
  updated?: boolean;  // true = upsert updated existing
  reason?: string;
}

export interface EntityRecord {
  id: number;
  name: string;
  aliases: string[];
  category: string;
  attributes: Record<string, any>;
  relations: EntityRelation[];
  source: string;
  created_at: string;
  updated_at: string;
  // 列 status；仅在查询语句 SELECT 了 status 列时填充（getEntity 路径会带，注入/检索路径不依赖此字段）
  status?: EntityStatus;
}

/**
 * 标签归一化：将同义词映射为标准标签
 */
export function normalizeTags(tags: string): string {
  return tags
    .split(/\s+/)
    .filter(Boolean)
    .map(tag => TAG_NORMALIZATION_MAP[tag] || tag)
    .filter((tag, i, arr) => arr.indexOf(tag) === i) // 去重
    .join(' ');
}

/**
 * 输入净化：清除 prompt injection 模式
 */
export function sanitize(text: string): string {
  return text
    // 清除 XML 风格指令标签
    .replace(/<\/?(?:system|instruction|role|prompt|command)[^>]*>/gi, '')
    // 清除行首指令前缀
    .replace(/(?:^|\n)\s*(?:SYSTEM|INSTRUCTION|IMPORTANT|OVERRIDE|IGNORE PREVIOUS):/gi, '\n')
    .trim();
}

/**
 * 工具调用 token 检测：捕获模型生成时把工具调用 XML 误塞进字符串参数的污染
 * 命中即返回命中 token 列表（去重），无命中返回空数组
 *
 * 历史背景：2026-04-30 #1101 因模型连发 store_memory + kb_ingest 两个工具调用时
 * 第一个 invoke 的 summary 字符串没干净闭合，把第二个 invoke 的整段 XML 吞进了 summary
 */
const TOOL_CALL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: '<invoke>', re: /<\/?invoke[\s>]/i },
  { name: '<function_calls>', re: /<\/?function_calls\s*>/i },
  { name: '<parameter>', re: /<\/?parameter[\s>]/i },
  { name: 'antml:', re: /<\/?antml:/i },
  { name: '</summary>', re: /<\/summary\s*>/i },
  { name: '</artifacts>', re: /<\/artifacts\s*>/i },
  { name: '</event_date>', re: /<\/event_date\s*>/i },
];

export function detectToolCallContamination(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const { name, re } of TOOL_CALL_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}
