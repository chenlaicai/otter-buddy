---
id: F20260813mren
title: memory-relation-layer
summary: |
  记忆关系层：把 flat 的 memory_entries 升级为可声明、可遍历的有向关系图。
  memory_edges 表（4 种边类型，ON CONFLICT 幂等，只禁 chunk 建边，re-sync 边重定向）+ 文档 provenance（frontmatter created_in_conversation 入列）+ 4 个 agent 工具（link_memory/get_related/unlink_memory/sync_docs）。
  根因：文档入库 conversationId=undefined 致 doc↔message 断链，跨会话同主题无关联，证据链/因果链拼不出。
  主机制：建关系表 → frontmatter 记事实级 provenance → 工具让 LLM 自主声明遍历 → sync_docs 即时入库。

causal_links:
  from:
    - F20260811mrpy   # 记忆召回链路三项核心优化（检索基础设施）
    - F20260812mrcq   # 召回质量与稳定性（RetrievalSource 契约收敛后的基线）

status: development
change_type: feature
tags: [memory, relations, graph, provenance]
modules:
  - src/entities/memory/memory-edge.ts
  - src/usecases/memory/memory-repository.ts
  - src/usecases/memory/create-edge.ts
  - src/usecases/memory/get-related.ts
  - src/usecases/memory/delete-edge.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - src/bootstrap/memory.ts
  - src/bootstrap/usecases.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/session-helpers.ts
capability_test: tests/capability/memory-relations.capability.test.ts
---

# F20260813mren: 记忆关系层

## 背景

### 起因

用户期待：每次提问时，海獭应主动做背景探索——查历史对话中是否处理过此问题，找相关历史痕迹，形成一条**证据链/因果链/发展链**。实际看不到这种效果。

排查结论分两条线：

1. **数据侧无关系层（本 F）**：`memory_entries` 是扁平表，entries 之间没有可声明、可遍历的语义关系。即使 LLM 调了 `search_memory`，拿到的也是散点，拼不出链。
2. **prompt 侧无引导（issue #264）**：检索 100% 依赖 LLM 自觉调 `search_memory`，且 tool description 写"不要每次回复前都搜索"，方向与期待相反。归 issue #264 单独处理。

### 数据层断链（实锤）

当前 memory_entries 的三种"隐式关联"都太弱：

| 关联 | 机制 | 缺陷 |
|------|------|------|
| 同 conversation_id | FK 字段 | 只覆盖同会话内消息；跨会话同主题无关联 |
| 同 (sourceTable, sourceId) | 主键聚合 | 只覆盖同一文档的 chunks；不跨内容类型 |
| 文档 supersedes/from | metadata JSON | 不可遍历——search-engine.ts 不读这个字段；只对文档生效，消息层无 |

**最关键的断链**：`bootstrap/memory.ts:41,54,72,99` 显示 feature/research 文档入库时 `conversationId: undefined`。`features` / `research` 表也没有 `conversation_id` 列——**一份由某段对话产出的特性文档，在记忆层与那段对话完全断开**。

### 共识前提

- 检索引擎（FTS+vec+RRF、时间衰减、anchor 短路、context-expand）**不动**（F20260812mrcq 基线）
- RetrievalSource 契约**不动**——不在 search_memory 里自动展开关系（反强编排，见决策 D3）
- 不引入自动语义推断（LLM 自主通过工具声明关系；工程只记录事实级 provenance）
- 按 `feedback_no_strong_orchestration`：提供"手脚"工具，不替 LLM 做判断

---

## 对抗审视决策（三轮独立审视后用户拍板）

本设计经三位独立 agent 对抗审视（架构 / 反强编排审计 / MVP 完整性），用户逐题拍板。关键决策：

### D1: 砍掉原 Part 3（supersedes/from 反规范化）和原 Part 4（检索集成 expandRelations）

**原方案**：sync 时自动把 frontmatter 的 supersedes/causal_links 复制成 edges 表的边；search_memory 加 expandRelations 参数自动沿边扩展。

**审视抓到的两个致命问题**：

1. **反规范化是双写悖论**：`supersedes`/`causal_links` 是 LLM/人写的**判断**（不是事实）。sync 自动建边 = 把 metadata 层的判断提升为图结构硬连接。更致命的是——LLM 用 `unlink_memory` 删了边后，下次 sync 会重建，工程逻辑直接覆盖 LLM 判断。
2. **expandRelations 是已删 feature 换名复活**：F20260812mrcq 明确删除了 `related-expand`（原因"重工程收益不明"）。本 F 原 Part 4 换名 `expandRelations` 重新引入同一种冲动。search_memory 自动展开 = 在检索内部做编排，替代了 LLM 本应自主做的多步检索（search → 判断 → get_related）。

**决策**：两 Part 全砍。关系遍历只通过 `get_related` 工具，LLM 在 search_memory 命中后自主决定是否调。

### D2: 边类型 4 种（原 6 种）

`produced` / `references` / `supersedes` / `relates-to`。砍 `evolves-from`/`caused-by`（用 `references` + metadata.note 表达）。

命名上用 `produced` 替代原 `derived-into`——后者英语语义歧义（"A derived-into B" 到底是 A 产出 B 还是 A 被产进 B），`produced` 无歧义（A produced B）。

### D3: 限制 LLM 只能对 coarse entry 建边

**审视抓到的隐蔽 bug**：文档 sync 时 `replaceEntriesBySource` 会删旧 chunk entries 建新 chunk entries。如果 LLM 在 chunk entry（fine 粒度）上建了边，CASCADE/手动删都会让边在每次文档更新后静默丢失。

**决策（PR 审视二轮修正）**：`link_memory` 校验目标 entry 的 contentType——拒绝 `feature_chunk`/`research_chunk`（chunk 被 sync replaceEntriesBySource N:M 删旧建新，边无法重定向）；message/fact/文档 summary 均可建边（message 是 fine 粒度但不会被 sync 替换）。

**审视二轮 P1-12 修正**：初版 D3 论断"summary entry 的 source_id 不变所以边安全"是错误前提——`replaceEntryBySource` 是 DELETE 旧行 + INSERT 新 UUID 行，文档改一个错别字就触发，LLM 声明的 `produced` 边会静默消失。修复：1:1 summary entry 的 replace 改为**边重定向**（同事务内 UPDATE 边端点到新 id），不再删边；chunk 的 N:M replace 无法重定向，维持禁边。

### D4: 砍 direction 字段

原方案有 `direction: directed | symmetric` 字段。审视指出只有 `relates-to` 用 symmetric，不值得为单一类型加全表字段。

**决策**：砍字段。所有边物理上是 directed。`GetRelated` 查询时对 `relates-to` 类型自动双向查（`WHERE from_entry_id = ? OR to_entry_id = ?`），其他类型单向。

### D5: frontmatter 记录 provenance（用户拍板，撤销原"不污染"决策）

原审视方案：不把 `conversationId` 写进文档 frontmatter（怕污染文档库），改走工具上下文直接写 DB。

**用户拍板撤销**：frontmatter 本就是 provenance 载体（`causal_links_from`/`supersedes` 同模式），加一个字段是自然的。且文档就是本地文件，海獭用 bash/workspace_write 或任何方式都能写，绑特定工具反而脆弱。

**最终实现**：
1. 身份注入加「当前对话 ID」——海獭写文档时知道自己的 `conversationId`
2. frontmatter 加 `created_in_conversation: <conv-id>`（海獭用任何方式写文件时填入）
3. `SyncDocuments` 读 `fm.created_in_conversation` → `createdInConversationId`
4. fingerprint 加入此字段——provenance 变更触发 sync update
5. mapper 双向映射 + INSERT/UPDATE SQL 包含 `created_in_conversation_id` 列

### D6: get_related 返回结构化 path 而非平铺列表

原方案返回 entry 列表 + edgeType 标注。审视指出 LLM 拿到平铺列表无法判断"A 指向 B，B 指向 C"的链式关系。

**决策**：返回 `[{ entry, edgeType, edgeFromEntryId, depth }]` 的结构化路径。

### D7: 加 UNIQUE 约束 + 去 CASCADE 改手动删

- `UNIQUE INDEX(from_entry_id, to_entry_id, edge_type)` + `ON CONFLICT DO NOTHING` —— 防并发 TOCTOU 竞态
- 不依赖 FK CASCADE（与 F20260812mrcq 审视 M5 项目模式一致），在 `deleteBySource` 等清理路径手动 `DELETE FROM memory_edges WHERE from_entry_id IN (...) OR to_entry_id IN (...)`

### D8: get_related 不做"关键消息"预筛选

原方案 get_related 对文档 provenance 返回"turn 边界消息、用户消息"。审视指出这是隐式编排（工程替 LLM 判断哪些消息"关键"）。

**决策**：返回同会话全部消息（按条数限制），附带 role/turn 元数据，让 LLM 自主筛。

### D9: 加 B 类端到端能力测试

审视指出原验收全是 A 类单元测试，缺"用户提问→海獭调 get_related→拼出链"的端到端验证。**决策**：加 B 类能力测试（真系统+真 LLM）。

---

## Part 1: memory_edges 表 + 基础 use case

### 1.1 表设计

```sql
CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  from_entry_id TEXT NOT NULL,
  to_entry_id TEXT NOT NULL,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('produced','references','supersedes','relates-to')),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  CHECK (from_entry_id != to_entry_id),
  FOREIGN KEY (from_entry_id) REFERENCES memory_entries(id),
  FOREIGN KEY (to_entry_id) REFERENCES memory_entries(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_unique
  ON memory_edges(from_entry_id, to_entry_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_entry_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_entry_id, edge_type);
```

不使用 FK CASCADE（见 D7）。清理走应用层 `deleteEdgesByEntry(entryIds)` 在 deleteBySource 等路径手动调。

### 1.2 边类型语义

| edge_type | 语义 | 方向 | 典型场景 |
|-----------|------|------|---------|
| `produced` | A 产出/推导出 B | message → doc / message → decision | 一段讨论催生了一份 F 文档 |
| `references` | A 引用/参考了 B | entry → doc | 消息提到某个 F 文档；文档交叉引用 |
| `supersedes` | A 取代 B | entry → entry | 文档新版替换旧版；决策推翻旧决策 |
| `relates-to` | A 与 B 相关（兜底） | 查询层 symmetric | 无更精确类型时的通用关联 |

查询语义：
- `produced`/`references`/`supersedes`：单向。`get_related(A)` 默认查 `from_entry_id = A`（出边）。传 `direction="in"` 查 `to_entry_id = A`（入边）。
- `relates-to`：查询层自动双向（`from_entry_id = A OR to_entry_id = A`）。

### 1.3 use cases

- `CreateEdge.execute({ fromEntryId, toEntryId, edgeType, metadata?, createdBy? })`
  - **校验类型**（D3，审视二轮修正）：拒绝 `feature_chunk`/`research_chunk`（chunk 被 N:M replace 删旧建新，边无法重定向）；message/fact/文档 summary 均可
  - **幂等**：同 (from, to, type) 已存在则返回已存在的 edge id（`INSERT ... ON CONFLICT DO NOTHING` + 重 SELECT，原子防 TOCTOU）
  - **自环拒绝**：CHECK 约束
- `GetRelated.execute({ entryId, depth?, edgeTypes?, direction?, limit? })`
  - BFS 遍历，默认 `depth=1`
  - **visited set** 防环
  - **返回结构化 path**（D6）：`[{ entry: MemoryEntry, edgeType, edgeFromEntryId, depth }]`
  - `relates-to` 自动双向（D4）
- `DeleteEdge.execute({ edgeId })` — 显式删除（LLM 纠错用）

### 1.4 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/schema.ts` | 修改 | `createMemoryTables` 加 `memory_edges` 表 + 3 个索引 |
| `src/frameworks/db/migration.ts` | 修改 | 幂等迁移（CREATE IF NOT EXISTS）|
| `src/entities/memory/memory-edge.ts` | 新增 | MemoryEdge 实体 + EdgeType 枚举 + 校验 |
| `src/usecases/memory/memory-repository.ts` | 修改 | 接口加 createEdge / getRelated / deleteEdge / getEdgesByEntry / deleteEdgesByEntryIds |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现 + deleteBySource 等路径加边清理 |
| `src/usecases/memory/create-edge.ts` | 新增 | use case（含 coarse 校验）|
| `src/usecases/memory/get-related.ts` | 新增 | use case（BFS + path 返回）|
| `src/usecases/memory/delete-edge.ts` | 新增 | use case |
| `src/bootstrap/usecases.ts` | 修改 | DI 装配 |

---

## Part 2: 文档 provenance

### 2.1 加列

```sql
ALTER TABLE features ADD COLUMN created_in_conversation_id TEXT;
ALTER TABLE research ADD COLUMN created_in_conversation_id TEXT;
```

通过 `migration.ts` 加（项目已有大量 ALTER 先例，PRAGMA table_info 幂等检测）。

### 2.2 写入路径（frontmatter，用户拍板）

海獭创建文档时在 frontmatter 写 `created_in_conversation: <conv-id>`（当前对话 ID 从身份注入获知，任何写文件方式均可——bash/workspace_write 等）。`SyncDocuments` 读 `fm.created_in_conversation` → entity.createdInConversationId → 写入 `features.created_in_conversation_id` 列。fingerprint 含此字段，provenance 变更触发 update。

**即时性**：写完文档调 `sync_docs` 工具立即入库（审视二轮新增——否则要等系统重启才可检索）。

人工/外部创建的文档无此字段（null），表示"外部引入"。

### 2.3 get_related 如何用 provenance

`get_related(featureDocEntryId)` 工具实现里，若 entry 是 feature/research 且 `created_in_conversation_id` 非空：
- JOIN 该 conversation 的消息，**返回全部**（按条数限制，如 top 50）+ 每条带 role/turn 元数据
- **不做"关键消息"预筛选**（D8）——选择权归 LLM

这是工具内部的 JOIN 查询，不是 edges 表的行。哪些消息"催生"了文档是判断，交给 LLM 用 `link_memory` 显式声明；provenance 只提供候选池。

### 2.4 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/schema.ts` | 修改 | features/research 表定义加列 |
| `src/frameworks/db/migration.ts` | 修改 | ALTER 迁移 |
| `src/usecases/document/sync-documents.ts` | 修改 | 读 `fm.created_in_conversation` + fingerprint 含此字段 |
| `src/frameworks/db/document/*-mapper.ts` | 修改 | 双向映射新列 |
| `src/frameworks/db/document/sqlite-*-repository.ts` | 修改 | INSERT/UPDATE 含新列 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | 身份注入加「当前对话 ID」 |
| `src/usecases/memory/get-doc-provenance.ts` | 新增 | provenance 读路径 use case |

---

## Part 3: agent 工具

### 3.1 工具集

| 工具 | 入参 | 作用 |
|------|------|------|
| `link_memory` | from_id, to_id, type, note? | LLM 声明两个记忆条目之间的关系 |
| `get_related` | entry_id, depth?, types?, direction?, limit? | 从某条目出发遍历关系图，返回 `{related: [{entry, edgeType, edgeFromEntryId, depth}], provenance?}` |
| `unlink_memory` | edge_id | 删除一条关系边（幂等，纠错用） |
| `sync_docs` | 无 | 写完/改完文档后立即同步入库（审视二轮新增——否则要等重启才可检索） |

### 3.2 工具描述与交叉引用（审视二轮拍板）

审视发现 search_memory 与关系工具零交叉引用，海獭搜到条目后不知道下一步——不加这行本 PR 合并后用户 100% 看不到效果。最小交叉引用（工具契约文档，非行为引导）：

- `search_memory` 加："命中条目后可调 get_related 沿关系图遍历，发现条目间关联可用 link_memory 声明"
- `get_related` 加：典型前置是 search_memory 命中后深挖；发现未声明的关联可用 link_memory 补上
- `link_memory` 加：典型时机——文档创建完成后（当前讨论 produced 本文档）、回答引用历史决策时、发现跨会话同主题时

更系统的 prompt 引导（SYSTEM.md 强化等）仍归 issue #264。

### 3.3 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | 加 4 个工具 + 交叉引用描述 |
| `src/frameworks/agent/session-helpers.ts` | 修改 | `getOtterToolNamesForType` 加新工具名 |
| `src/bootstrap/clients.ts` | 修改 | docs.sync 接线 |
| `src/app.ts` | 修改 | syncDocs 注入 |
| `.pi/skills/_shared/SKILL-TEMPLATE.md` | 修改 | 特性文档全局约定：字段清单加 created_in_conversation + sync_docs/link_memory 引导 |

---

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 边可声明与查询 | link_memory(A, B, "produced") 后 get_related(A) | 返回 B，edgeType=produced，depth=1 |
| AT-2 | 幂等（UNIQUE）| 同一 (A, B, "produced") 并发调两次 | 返回同一 edge id，表里 1 行 |
| AT-3 | 自环拒绝 | link_memory(A, A, ...) | 抛错（CHECK 约束）|
| AT-4 | 双向查询 | produced(A, B)，get_related(B, direction="in") | 返回 A |
| AT-5 | relates-to 自动双向 | relates-to(A, B)，get_related(B) 不传 direction | 返回 A |
| AT-6 | chunk 类型限制 | link_memory 到 feature_chunk entry | 抛 DomainError |
| AT-7 | entry 删边清 | 删 entry A，查 memory_edges | from/to 为 A 的边都被清理 |
| AT-8 | 文档 provenance | frontmatter 写 created_in_conversation: C，sync 后查 features.created_in_conversation_id | = C 的 id |
| AT-9 | provenance JOIN 返回全部消息 | get_related(D)，D 是 feature 且有 provenance | 返回 C 的消息，不做预筛选 |
| AT-10 | 环安全 | A→B→A 成环，get_related(A, depth=5) | visited 守门，不无限循环 |
| AT-11 | path 结构 | get_related 返回值 | `{related: [{entry, edgeType, edgeFromEntryId, depth}], provenance?}` |
| AT-12 | re-sync 边重定向 | 建边 message→doc 后，replaceEntryBySource 换 doc 新 id | 边端点重定向到新 id，不丢失（审视二轮 P1-12） |
| AT-13 | sync_docs 即时入库 | 写新文档后调 sync_docs | 不等重启，search_memory 立即可检索 |

### 能力测试

实际交付：`tests/capability/memory-relations.capability.test.ts` —— 真 app + 真 DB + 真 bge-m3 的基础设施层验证（edge CRUD/BFS/边重定向/provenance/即时入库 6 用例全过）。

**真 LLM 在环的行为验证（"海獭收到提问后主动调 get_related 拼链"）归 issue #264**——该层效果依赖 prompt 引导就绪后验证才有意义（审视三轮确认：infra 层扎实但"LLM 真的会走这条路"需 #264 落地后用真 LLM 用例验证）。

测试文件：`tests/capability/memory-relations.capability.test.ts`

---

## 不在本 F 范围

- prompt 层系统引导（SYSTEM.md 强化 + 真 LLM 行为验证）→ issue #264
- search_memory 自动关系扩展（expandRelations）→ 砍（D1），永久不做（反强编排）
- 文档 supersedes/from 反规范化到 edges → 砍（D1），LLM 用 link_memory 显式声明即可
- 自动语义推断（NLP 提取消息间因果）→ 反强编排原则不做
- 关系图 UI 可视化 → 后续 F
- 跨记忆库（terminology）的关系遍历 → 先不做
- 关系边自身的 embedding → YAGNI
- 边的软删/归档 → 先硬删，按需加
- **存量文档 provenance 暗区**：本 F 上线前入库的文档 created_in_conversation_id 全为 NULL——历史事实（文档由哪段对话产出）入库时已丢失，不可考据，任何 backfill 都是推断而非事实，违背"只记事实级 provenance"原则。愈合方式：新文档自然带字段；存量文档在被再次讨论时由海獭用 link_memory 有机补边（审视三轮显式声明为已知 gap）
- sync_docs 返回新建/更新文档的 entry ID 列表 / link_memory 支持按 (source_table, source_id) 建边（降 ID 获取摩擦）→ follow-up
- user_flagged/retrieval_count 在 replaceEntryBySource 时重置（pre-existing 语义缺陷，与本 F 无关，另开 F 时可顺手修）
- "参见全局约定「特性文档」"引用悬空（pre-existing：各 SKILL.md 的引用无解析机制；本 F 把 sync_docs/link_memory 引导直接写进了 3 个 SKILL.md 的工作流步骤规避此问题，引用机制本身的治理另开 issue）

---

## 对抗审视记录

### 审视者

- 审视 A（架构）：存储模型、分类法、方向语义、provenance 耦合、检索集成复杂度
- 审视 B（反强编排审计）：逐 Part 判定合规/边界/违规
- 审视 C（MVP 完整性）：范围、YAGNI、缺失能力、依赖关系、实战验收

### 关键质疑与决策

| 质疑 | 来源 | 决策 |
|------|------|------|
| derived-into 命名歧义 | A-P0 | 改 produced（D2）|
| references 命名歧义 | A-P0 | 保留 references（在 tool description 里明确方向）|
| 6 种边类型 MVP 过多 | A-P1, C | 砍到 4 种（D2）|
| frontmatter 污染 | A-P1, B | 走工具上下文写 DB（D5）|
| expandRelations 默认 0 = 死代码 | A-P1, B, C | 砍整个 Part 4（D1）|
| 缺 UNIQUE 约束 | A-P1 | 加（D7）|
| CASCADE 删 chunk 边静默丢失 | A-P1, C | 限制 coarse entry 建边（D3）+ 手动删边（D7）|
| direction 字段多余 | A-P2, C | 砍（D4）|
| causal_links.from 应映射 evolves-from | A-P2 | 砍反规范化（D1），问题消失 |
| Part 3 双写悖论 | B | 砍 Part 3（D1）|
| Part 4.2 与已删 related-expand 同类 | B | 砍 Part 4（D1）|
| get_related "关键消息"预筛选 | B | 删，返回全部带元数据（D8）|
| get_related 返回平铺列表 | C | 改结构化 path（D6）|
| 缺端到端能力测试 | C | 加能力测试（D9；真 LLM 行为验证归 #264，审视三轮对齐）|
| tool description 太简略 | C | 归 issue #264（用户决策：不拉入本 F）|
| unlink_memory 过早 | C | 保留（反强编排原则是给工具，删工具违背原则）|

### 第二轮审视（PR #269 代码级，2 位独立 agent）

| 质疑 | 决策 |
|------|------|
| createEdge SELECT+INSERT 有 TOCTOU 竞态 | 改 ON CONFLICT DO NOTHING + 重 SELECT |
| message 是 fine 粒度被 D3 误拒（produced 头号用例建不了边） | 校验从 granularity 改为 contentType（只排两类 chunk） |
| RelatedEntryItem.entry 内联类型退化 | 复用 MemoryEntry |
| DeleteEdge 描述幂等但实现抛错 | 改真幂等 |
| D5 frontmatter 决策 | 用户拍板撤销——frontmatter 本就是 provenance 载体 |
| search_memory 零交叉引用 get_related | 用户拍板：加最小交叉引用（破"合并后 100% 看不到效果"） |
| sync 仅启动时，写完即问必败 | 用户拍板：加 sync_docs 工具 |
| 冷启动无边 + 无触发场景 | 用户拍板：skill 工作流加"声明关系"引导 |
| 端到端评分 | 10-20%（数据层对但行为层抓手全缺） |

### 第三轮审视（delta + 端到端重走，2 位独立 agent）

| 质疑 | 决策 |
|------|------|
| **P1-12 re-sync 静默丢边**：replaceEntryBySource 是 DELETE+INSERT 新 UUID，D3 前提错误 | 边重定向（插新→UPDATE 端点→按 id 删旧），补"建边后 re-sync"测试 |
| sync_docs rootDir 与 worktree 流程脱节（R1 红线文档写 worktree，sync 扫主仓） | 工具加 root_dir 参数 |
| 引导加错文件（SKILL-TEMPLATE 运行时不被读） | 引导移到 3 个 SKILL.md 工作流步骤（code-implementation/requirement-analysis/troubleshooting） |
| 多旧行 UNIQUE 冲突（脏数据从自愈退化为永久失败） | 只重定向 oldRows[0]，其余删边 |
| get_related 描述裸数组 vs 实现对象包装 | 描述更新为 `{related, provenance?}` |
| sync_docs 接线无测试 | 补 clients.test.ts（透传/未接线/并发互斥 3 用例） |
| sync_docs 并发伪错误 | in-flight 互斥标志 |
| docs/README 模板缺 created_in_conversation | 加字段 + 注释 |
| isSymmetricEdgeType 死代码 | 删 |
| 存量文档 provenance 暗区 | 显式声明为已知 gap（历史事实不可考，有机愈合），见"不在范围" |
| 端到端评分 | 约 40%（读路径机制完备；写路径触发率 30-50%，剩余归 #264） |

---

## 设计决策

### 反强编排合规性

本 F 的所有设计决策都在 `feedback_no_strong_orchestration` 框架内：

- **数据层**：edges 表 + provenance 列是纯数据基础设施，LLM 通过工具自主用
- **写入路径**：语义关系（produced/references/supersedes/relates-to）由 LLM 用 `link_memory` 显式声明；工程只记录事实级 provenance（conversationId 是系统注入的 ID，非推断）
- **读取路径**：`get_related` 是纯查询工具，LLM 自主调用、指定参数、解释结果；**不在 search_memory 里自动展开**（避免编排）
- **校验**：chunk 类型禁边 + re-sync 边重定向是数据完整性约束（防 sync 丢边），非行为编排；自环 CHECK 是安全约束

### 为什么不做 expandRelations（反编排审计 D1）

F20260812mrcq 已删除 `related-expand`。本 F 原 Part 4 的 `expandRelations` 是同一种冲动的换名复活——"在搜索时自动扩展关系邻居"。正确做法是让 LLM 在 search_memory 命中后，自主判断"这个条目可能有关系链"，再调 `get_related`。两步而非一步，把判断权留给 LLM。

可选的折中（未来评估）：search_memory 返回结果加 `hasRelations: boolean` 提示，但不自动展开。LLM 看到 hasRelations=true 后自主决定是否调 get_related。本 F 不实现，留 follow-up。
