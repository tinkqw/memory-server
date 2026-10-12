#!/usr/bin/env node
// Memory MCP Server — 入口

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryStore } from './store.js';

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
  const diffY = Math.floor(diffD / 365);
  return `${diffY}y ago`;
}

const server = new McpServer({
  name: 'memory-server',
  version: '1.0.0',
});

let store: MemoryStore;

// ── store_memory ──────────────────────────────────────────────

server.tool(
  'store_memory',
  `存储一条记忆。title ≤60 字，summary ≤1500 字，tags 用简洁中文词空格分隔。` +
  `type 语义：work=事件/决策/产出记录，observation=用户偏好/纠正（蒸馏输入），profile=用户画像（蒸馏专用，勿手动存）。` +
  `推荐标签：部署、调试、安全、接口、提示词、工作流、配置、内容、调研、记忆系统。` +
  `artifacts 格式：[{"type": "feishu_doc|file|url", "title": "名称", "ref": "链接或路径"}]。` +
  `如检测到相似记忆会返回摘要供你决策：` +
  `skip=确实重复不写入；update=新结论替换旧结论（传 parent_id + relation='update'）；` +
  `extend=补充细节不否定原内容（传 parent_id + relation='extend'）；store=无关联强制写入（传 force=true）。` +
  `is_static=true 标记永久有效知识，不参与时间衰减且蒸馏时受保护不被删除。适用于：品牌规范、团队分工、操作指南（how-to）、API 调用方法等。` +
  `event_date 记录事件实际发生日期（如"上周三的会议"填上周三日期）。` +
  `forget_after 设定过期日期，到期自动清理。is_static 和 forget_after 互斥。`,
  {
    title: z.string().describe('记忆标题，≤60 字'),
    tags: z.string().describe('标签，空格分隔'),
    summary: z.string().describe('记忆内容摘要，≤1500 字'),
    type: z.enum(['work', 'observation', 'entity', 'profile']).default('work').describe('记忆类型'),
    artifacts: z.string().optional().describe('关联产出物 JSON 数组'),
    force: z.boolean().optional().default(false).describe('跳过去重检查强制写入，仅在收到 similar_found 后决定 store 时使用'),
    parent_id: z.number().optional().describe('父记忆 ID，用于建立 update/extend 关系'),
    relation: z.enum(['update', 'extend']).optional().describe('与父记忆的关系：update=替换旧结论，extend=补充细节'),
    event_date: z.string().optional().describe('事件实际日期 YYYY-MM-DD'),
    is_static: z.boolean().optional().default(false).describe('永久有效标记，不参与时间衰减'),
    forget_after: z.string().optional().describe('过期日期 YYYY-MM-DD，到期自动清理'),
  },
  async (args) => {
    try {
      const result = await store.storeMemory({
        title: args.title,
        tags: args.tags,
        summary: args.summary,
        type: args.type,
        artifacts: args.artifacts,
        force: args.force,
        parent_id: args.parent_id,
        relation: args.relation,
        event_date: args.event_date,
        is_static: args.is_static,
        forget_after: args.forget_after,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── search_memory ─────────────────────────────────────────────

server.tool(
  'search_memory',
  `搜索记忆。提取用户消息中的核心主题词作为 query，不要发用户原文整句。` +
  `返回完整记录（title + tags + summary + artifacts + created_at + source）。` +
  `搜索使用 FTS5 + 向量语义混合排序。`,
  {
    query: z.string().describe('搜索关键词（核心主题词，非原文整句）'),
    type: z.enum(['work', 'observation', 'entity', 'profile']).optional().describe('过滤记忆类型'),
    limit: z.number().optional().describe('返回条数，默认 8，最大 15'),
    date_from: z.string().optional().describe('起始日期（含），格式 YYYY-MM-DD，如 2026-03-01'),
    date_to: z.string().optional().describe('截止日期（含），格式 YYYY-MM-DD，如 2026-03-31'),
    include_history: z.boolean().optional().default(false).describe('是否返回被取代的旧版本（is_latest=0），默认 false'),
    root_id: z.number().optional().describe('查询整条记忆链（传入链根节点 ID）'),
  },
  async (args) => {
    try {
      const results = await store.searchMemory({
        query: args.query,
        type: args.type,
        limit: args.limit,
        date_from: args.date_from,
        date_to: args.date_to,
        include_history: args.include_history,
        root_id: args.root_id,
      });

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '未找到相关记忆。' }],
        };
      }

      const formatted = results.map((r, i) => {
        const meta = r.score !== undefined
          ? ` [score=${r.score.toFixed(2)}, ${formatAge(r.created_at)}]`
          : ` [${formatAge(r.created_at)}]`;
        return `[${i + 1}] #${r.id}${meta} | ${r.title}\n` +
          `    tags: ${r.tags}\n` +
          `    source: ${r.source} | ${r.created_at}\n` +
          `    ${r.summary}\n` +
          (r.artifacts && r.artifacts !== '[]' ? `    artifacts: ${r.artifacts}\n` : '');
      }).join('\n');

      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── list_recent ───────────────────────────────────────────────

server.tool(
  'list_recent',
  `列出最近的记忆，按时间倒序。返回完整记录。` +
  `适用场景：对话开头快速了解最近上下文、查看最新存入的记忆。` +
  `与 search_memory 的区别：list_recent 按时间排序不做语义匹配，search_memory 按相关性排序。`,
  {
    count: z.number().optional().describe('返回条数，默认 10，最大 20'),
    type: z.enum(['work', 'observation', 'entity', 'profile']).optional().describe('过滤记忆类型'),
  },
  async (args) => {
    try {
      const results = store.listRecent({
        count: args.count,
        type: args.type,
      });

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '暂无记忆。' }],
        };
      }

      const formatted = results.map((r, i) =>
        `[${i + 1}] #${r.id} | ${r.title}\n` +
        `    tags: ${r.tags}\n` +
        `    source: ${r.source} | ${r.created_at}\n` +
        `    ${r.summary}\n` +
        (r.artifacts && r.artifacts !== '[]' ? `    artifacts: ${r.artifacts}\n` : ''),
      ).join('\n');

      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── list_all ──────────────────────────────────────────────────

server.tool(
  'list_all',
  `分页读取指定类型的全量记忆（蒸馏用）。返回 items + total + has_more，翻页时递增 offset。`,
  {
    type: z.enum(['work', 'observation', 'profile']).describe('记忆类型（必填）'),
    offset: z.number().optional().describe('起始偏移量，默认 0'),
    limit: z.number().optional().describe('每页条数，默认 50，最大 100'),
  },
  async (args) => {
    try {
      const result = store.listAll({
        type: args.type,
        offset: args.offset,
        limit: args.limit,
      });

      if (result.items.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `${args.type} 类型暂无记忆。total: 0` }],
        };
      }

      const formatted = result.items.map((r, i) =>
        `[${(args.offset || 0) + i + 1}] #${r.id} | ${r.title}\n` +
        `    tags: ${r.tags}\n` +
        `    source: ${r.source} | ${r.created_at}\n` +
        `    ${r.summary}\n` +
        (r.artifacts && r.artifacts !== '[]' ? `    artifacts: ${r.artifacts}\n` : ''),
      ).join('\n');

      const meta = `\n---\ntotal: ${result.total} | showing: ${(args.offset || 0) + 1}-${(args.offset || 0) + result.items.length} | has_more: ${result.has_more}`;

      return {
        content: [{ type: 'text' as const, text: formatted + meta }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── delete_memory ─────────────────────────────────────────────

server.tool(
  'delete_memory',
  `删除一条记忆（soft delete）。is_static=true 的记忆受保护，需传 force=true 才能删除。`,
  {
    id: z.number().describe('要删除的记忆 id'),
    force: z.boolean().optional().describe('强制删除 is_static 记忆（需用户确认）'),
  },
  async (args) => {
    try {
      const result = store.deleteMemory({ id: args.id, force: args.force });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── restore_memory ────────────────────────────────────────────

server.tool(
  'restore_memory',
  `恢复一条已删除的记忆。将 status 从 deleted 恢复为 active。用于误删恢复。`,
  {
    id: z.number().describe('要恢复的记忆 id'),
  },
  async (args) => {
    try {
      const result = store.restoreMemory({ id: args.id });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── supersede_memory ──────────────────────────────────────────

server.tool(
  'supersede_memory',
  `把一条已经不成立的记忆标记为失效（事后补建取代链）。旧记忆不删除：is_latest 置 0，退出全部检索路，` +
  `之后用 search_memory 的 root_id 链查（传返回的 root_id）取回。\n` +
  `什么时候用：发现库里某条记忆讲的事已经被后来的事实推翻——规则改了、方案换了、口径变了。\n` +
  `传 new_id = 取代它的那条记忆（两条挂成一条链）；不传 new_id = 只作废，没有后继。\n` +
  `注意：这是给「写入当时不知道要取代谁」的情况补链用的。写入时就知道的，直接用 store_memory 的 parent_id + relation='update'。`,
  {
    old_id: z.number().describe('不再成立的那条记忆 id'),
    new_id: z.number().optional().describe('取代它的那条记忆 id；省略则只作废、无后继'),
    reason: z.string().describe('为什么不再成立，一句话（会写进 invalid_reason 长期留存）'),
    invalid_from: z.string().optional().describe('停止成立的日期 YYYY-MM-DD，默认今天'),
  },
  async (args) => {
    try {
      const result = store.supersedeMemory({
        old_id: args.old_id,
        new_id: args.new_id,
        reason: args.reason,
        invalid_from: args.invalid_from,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── get_entity ────────────────────────────────────────────────

server.tool(
  'get_entity',
  `精确查找实体（项目、人、群、知识库等）。按 name 或 aliases 精确匹配，返回完整实体信息。` +
  `用于查找具体项目路径、状态、核心文档等结构化信息。找不到返回空。`,
  {
    name: z.string().describe('实体名称（支持别名匹配）'),
  },
  async (args) => {
    try {
      const result = store.getEntity({ name: args.name });

      if (!result) {
        return {
          content: [{ type: 'text' as const, text: `未找到实体「${args.name}」。` }],
        };
      }

      const aliasStr = result.aliases.length > 0 ? `\n    aliases: ${result.aliases.join(', ')}` : '';
      const relStr = result.relations.length > 0
        ? `\n    relations: ${result.relations.map(r => `${r.type} → ${r.target}`).join(', ')}`
        : '';
      // 生命周期非 active 时显式标注（archived/retired 项目对注入隐藏，但 get_entity 仍返回——提醒「已归档/退役，非活跃」）
      const statusStr = result.status && result.status !== 'active' ? ` ⚠️${result.status}` : '';

      const formatted =
        `#${result.id} | ${result.name} [${result.category}]${statusStr}${aliasStr}\n` +
        `    attributes: ${JSON.stringify(result.attributes)}${relStr}\n` +
        `    source: ${result.source} | created: ${result.created_at} | updated: ${result.updated_at}`;

      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── search_entity ─────────────────────────────────────────────

server.tool(
  'search_entity',
  `模糊搜索实体（项目、人、群组等）。当不确定实体精确名称时使用，返回匹配的实体列表。` +
  `与 get_entity 的区别：get_entity 精确匹配 name/aliases，search_entity 模糊搜索 name/aliases/category/attributes。`,
  {
    query: z.string().describe('搜索关键词'),
    category: z.string().optional().describe('过滤类型：project / person / group / wiki_space / document / team'),
    limit: z.number().optional().describe('返回条数，默认 10，最大 20'),
  },
  async (args) => {
    try {
      const results = await store.searchEntity({
        query: args.query,
        category: args.category,
        limit: args.limit,
      });

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `未找到匹配「${args.query}」的实体。` }],
        };
      }

      const formatted = results.map((r, i) => {
        const aliasStr = r.aliases.length > 0 ? `\n    aliases: ${r.aliases.join(', ')}` : '';
        const relStr = r.relations.length > 0
          ? `\n    relations: ${r.relations.map(rel => `${rel.type} → ${rel.target}`).join(', ')}`
          : '';

        return (
          `[${i + 1}] #${r.id} | ${r.name} [${r.category}]${aliasStr}\n` +
          `    attributes: ${JSON.stringify(r.attributes)}${relStr}\n` +
          `    source: ${r.source} | created: ${r.created_at} | updated: ${r.updated_at}`
        );
      }).join('\n\n');

      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── store_entity ──────────────────────────────────────────────

server.tool(
  'store_entity',
  `创建或更新实体。已存在同名实体时自动合并（aliases 追加去重，attributes 覆盖合并）。` +
  `用于记录项目、人、群组、知识库等持久身份信息。` +
  `生命周期用 status 参数（不要写进 attributes）：归档/退役项目传 status='archived'/'retired'，会从注入中隐藏但仍可 get_entity 查到。`,
  {
    name: z.string().describe('实体名称'),
    category: z.string().describe('类型：project / person / group / wiki_space / document / team'),
    attributes: z.string().optional().describe('结构化属性 JSON 对象（如 {"path":"projects/xxx","owner":"张三"}）。勿在此写 status——生命周期用 status 参数'),
    aliases: z.string().optional().describe('别名 JSON 数组（如 ["别名1","alias2"]）。仅用户确认后添加'),
    relations: z.string().optional().describe('关系 JSON 数组（如 [{"type":"belongs_to","target":"团队名"}]）'),
    status: z.enum(['active', 'archived', 'retired']).optional().describe('生命周期（列权威字段，注入仅含 active）：active=活跃 / archived=归档 / retired=退役。不传则新建默认 active、已存在保持原状态。删除请用 delete_entity'),
  },
  async (args) => {
    try {
      const attributes = args.attributes ? JSON.parse(args.attributes) : undefined;
      const aliases = args.aliases ? JSON.parse(args.aliases) : undefined;
      const relations = args.relations ? JSON.parse(args.relations) : undefined;

      const result = await store.storeEntity({
        name: args.name,
        category: args.category,
        attributes,
        aliases,
        relations,
        status: args.status,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── delete_entity ─────────────────────────────────────────────

server.tool(
  'delete_entity',
  `软删除实体（项目、人、群组等）。需 confirm=true 确认。删除后可通过 store_entity 同名重建。`,
  {
    id: z.number().describe('要删除的实体 id'),
    confirm: z.boolean().optional().describe('必须为 true 才会执行删除'),
  },
  async (args) => {
    try {
      const result = store.deleteEntity({ id: args.id, confirm: args.confirm });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ── 启动 ──────────────────────────────────────────────────────

async function main() {
  try {
    store = new MemoryStore();
    const stats = store.getStats();
    console.error(`[memory-server] Started. DB stats: ${stats.active} active, ${stats.nullEmbedding} missing embeddings`);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (err) {
    console.error('[memory-server] Fatal:', err);
    process.exit(1);
  }
}

main();
