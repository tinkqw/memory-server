# memory-server

给 Claude Code（以及其他支持 MCP 的 agent）用的本地长期记忆服务。所有数据存在本机一个 SQLite 文件里，不依赖任何云服务。

- **混合检索**：FTS5 全文（jieba 中文分词）+ 向量语义（本地 BGE-M3 模型，1024 维，经 sqlite-vec），两路结果融合排序
- **两类记忆**：`work`（做过的事、决策、结论）和 `observation`（对用户偏好、协作方式的观察）
- **实体**：项目、人、群组等实体带别名，记忆写入时自动关联，可按实体反查
- **去重与取代**：写入时语义判重，返回 `similar_found` 让调用方选 skip / update / extend / store；`supersede_memory` 可事后标记某条已被取代
- **时间衰减**：检索分数按事件日期衰减，`is_static` 的永久知识不衰减；`forget_after` 到期自动软删除
- **会话注入 CLI**：`memory-core-block` 等命令输出 markdown，可挂在 Claude Code 的 SessionStart / UserPromptSubmit hook 上，把相关记忆自动注入对话

技术栈：TypeScript、Node.js 22、better-sqlite3、sqlite-vec、@huggingface/transformers、nodejieba、MCP SDK。

## 安装

```bash
git clone https://github.com/tinkqw/memory-server.git
cd memory-server
npm ci
npm run build
```

首次写入或检索时会下载向量模型 `Xenova/bge-m3`（q8 量化），默认缓存到 `~/.cache/memory-server/models`。

## 接入 Claude Code

```bash
claude mcp add memory -s user -- node /绝对路径/memory-server/dist/index.js
```

提供的工具：

| 工具 | 作用 |
|---|---|
| `store_memory` | 写入一条记忆 |
| `search_memory` | 混合检索 |
| `list_recent` / `list_all` | 按时间列出 |
| `delete_memory` / `restore_memory` | 软删除 / 恢复 |
| `supersede_memory` | 标记某条已被取代或失效 |
| `store_entity` / `get_entity` / `search_entity` / `delete_entity` | 实体管理 |

## 配置

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `MEMORY_DB_PATH` | 数据库文件路径 | `~/Data/memory/memory.db` |
| `HF_CACHE_DIR` | 向量模型缓存目录 | `~/.cache/memory-server/models` |
| `MEMORY_SOURCE` | 写入来源标记 | — |
| `MEMORY_RESIDENT_PATH` | `memory-consolidate` 对照的常驻规则文件 | `~/.claude/rules/memory-resident.md` |

**两台机器（可选）**：在 `~/.claude-host` 写一行 `main` 或 `air`，两台各用一个库（`~/Data/memory` / `~/Data/memory-air`），id 分段（main < 1,000,000，air ≥ 1,000,000），合并时不撞号。单机不需要这个文件。

## 命令行工具

| 命令 | 作用 |
|---|---|
| `memory-core-block --cwd <目录>` | 按当前目录识别项目，输出项目状态 + 近期相关记忆（markdown），适合 SessionStart hook |
| `memory-detect-project --text <文本> --workspace <根目录>` | 从一段话里识别提到的项目 |
| `memory-observation-block` | 按语义取相关的 observation，适合 UserPromptSubmit hook |
| `memory-store` | 从命令行写入一条记忆（给定时脚本用，向量由常驻服务后补） |
| `memory-consolidate` | 只读扫描重复与同主题簇，输出待人工审阅的报告 |

项目识别依赖目录里的 `PROJECT.md` / `HANDOFF.md`，以及实体的 `attributes.path`。

## 网关（实验）

`dist/gateway-server.js` 是一个面向多 agent 的写入网关（`memory_write` / `memory_update` / `memory_search` / `memory_list_recent`），每次写入要求带 `request_id`、`evidence_ref`、`idempotency_key` 等上下文并做审计。通过 `MEMORY_GATEWAY_*` 环境变量配置允许的客户端。

## 维护

```bash
npm run health:readonly   # 只读体检
npm run repair:vec        # 检查向量索引与主表是否一致（加 -- --apply 实际修复）
npm run test:p2-integrity && npm run test:p2-gateway && npm run test:supersede
```

已知问题：`tests/gateway.test.ts` 有 1 例失败（`similar_found is audited without reserving its key`）。

## 许可证

MIT，见 `LICENSE`。
