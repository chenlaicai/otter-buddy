---
id: F20260813mrel
title: memory-relation-layer
summary: |
  记忆关系层：把 flat 的 memory_entries 升级为可声明、可遍历的有向关系图。
  Part 1 memory_edges 表 + CreateEdge/GetRelated/DeleteEdge use case（4 种边类型：produced/references/supersedes/relates-to；无 direction 字段，relates-to 查询层双向；UNIQUE 约束保幂等；限制 LLM 只能对 coarse entry 建边防 chunk sync 丢边）；
  Part 2 文档 provenance（features/research 加 created_in_conversation_id 列，工具上下文直接写 DB 不污染 frontmatter；get_related 返回同会话消息时不预筛选，带 role/turn 元数据）；
  Part 3 agent 工具（link_memory/get_related/unlink_memory，get_related 返回结构化 path 而非平铺列表）。
  根因：memory_entries 扁平，文档入库 conversationId=undefined 导致 doc↔message 完全断链，跨会话同主题无关联，用户期待的"证据链/因果链/发展链"拼不出来。
  主机制：建独立关系表 → 记录事实级 provenance → 暴露工具让 LLM 自主声明和遍历。

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

# F20260813mrel: 记忆关系层

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

**决策**：`link_memory` 校验目标 entry 的粒度——只允许 `granularity = "coarse"` 的 entry（文档 summary、message、fact、linked_resource）建边，拒绝 `feature_chunk`/`research_chunk`（fine 粒度 chunk）。文档 summary entry 的 `source_id` = 文档 ID，sync 时不删，边安全。

### D4: 砍 direction 字段

原方案有 `direction: directed | symmetric` 字段。审视指出只有 `relates-to` 用 symmetric，不值得为单一类型加全表字段。

**决策**：砍字段。所有边物理上是 directed。`GetRelated` 查询时对 `relates-to` 类型自动双向查（`WHERE from_entry_id = ? OR to_entry_id = ?`），其他类型单向。

### D5: 不污染 frontmatter，provenance 走工具上下文

原方案把 `conversationId` 写进文档 frontmatter。审视指出 `docs/` 是人类阅读、git 版本控制的设计制品，加运行时 conversationId 是耦合。

**决策**：文档创建工具（writing-skills 等）的 execute 上下文已有 conversationId，直接写 DB 的 `features.created_in_conversation_id` 列，不经过 frontmatter。

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
  - **校验粒度**（D3）：from 和 to 的 entry 必须 `granularity = "coarse"`，否则抛 `DomainError("edges only allowed on coarse entries")`
  - **幂等**：同 (from, to, type) 已存在则返回已存在的 edge id（`ON CONFLICT DO NOTHING RETURNING id`）
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

### 2.2 写入路径（不经过 frontmatter）

文档创建/更新工具（如 writing-skills 的相关工具）的 execute 上下文已有 `conversationId`（`ToolContext.conversationId`）。工具调用 `createFeatureDoc` / `updateFeatureDoc` 等 use case 时，把 conversationId 一并传入，写入 `features.created_in_conversation_id`。**不污染 frontmatter**。

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
| 文档创建 use cases（`src/usecases/document/` 或相关） | 修改 | 接受并写入 conversationId |
| `src/usecases/memory/get-related.ts` | 修改 | feature/research entry 的 provenance JOIN |

---

## Part 3: agent 工具

### 3.1 工具集

| 工具 | 入参 | 作用 |
|------|------|------|
| `link_memory` | from_id, to_id, type, note?, created_by? | LLM 声明两个记忆条目之间的关系 |
| `get_related` | entry_id, depth?, types?, direction?, limit? | 从某条目出发遍历关系图，返回结构化 path |
| `unlink_memory` | edge_id | 删除一条关系边（纠正错误声明） |

### 3.2 工具描述骨架

```
link_memory: 声明两个记忆条目之间的关系。入参：from_id, to_id, type(produced/references/supersedes/relates-to), note?
get_related: 从一个记忆条目出发，沿关系边遍历邻居。入参：entry_id, depth?(默认1), types?, direction?(out/in)
unlink_memory: 删除一条关系边。入参：edge_id
```

详细引导语（什么时候用、怎么用好）归 issue #264，配合 prompt 层优化。

### 3.3 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | 加 3 个工具 |
| `src/frameworks/agent/session-helpers.ts` | 修改 | `getOtterToolNamesForType` 加新工具名 |

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
| AT-6 | 粗粒度限制 | link_memory 到 feature_chunk entry（fine）| 抛 DomainError |
| AT-7 | entry 删边清 | 删 entry A，查 memory_edges | from/to 为 A 的边都被 deleteEdgesByEntry 清理 |
| AT-8 | 文档 provenance | 在对话 C 中用工具创建 F 文档 D，查 features.created_in_conversation_id | = C 的 id |
| AT-9 | provenance JOIN 返回全部消息 | get_related(D)，D 是 feature 且有 provenance | 返回 C 的消息（带 role/turn），不做预筛选 |
| AT-10 | 环安全 | A→B→A 成环，get_related(A, depth=5) | visited 守门，不无限循环 |
| AT-11 | path 结构 | get_related 返回值 | 每项含 {entry, edgeType, edgeFromEntryId, depth} |

### 能力测试（B 类，真系统+真 LLM）

| 编号 | 场景 | 验证 |
|------|------|------|
| CT-1 | 预置 fixture（消息 M produced 文档 D），用户提问"D 是怎么来的？" | 海獭调用 get_related(D)，回复包含 M 的内容 |
| CT-2 | 预置 fixture（D1 references D2），用户问"D1 引用了什么" | 海獭调用 get_related(D1, types=["references"])，回复含 D2 |

测试文件：`tests/capability/memory-relations.capability.test.ts`

---

## 不在本 F 范围

- prompt 层引导（tool description 详细优化 + SYSTEM.md 强化）→ issue #264
- search_memory 自动关系扩展（expandRelations）→ 砍（D1），永久不做（反强编排）
- 文档 supersedes/from 反规范化到 edges → 砍（D1），LLM 用 link_memory 显式声明即可
- 自动语义推断（NLP 提取消息间因果）→ 反强编排原则不做
- 关系图 UI 可视化 → 后续 F
- 跨记忆库（terminology）的关系遍历 → 先不做
- 关系边自身的 embedding → YAGNI
- 边的软删/归档 → 先硬删，按需加

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
| 缺端到端能力测试 | C | 加 B 类测试（D9）|
| tool description 太简略 | C | 归 issue #264（用户决策：不拉入本 F）|
| unlink_memory 过早 | C | 保留（反强编排原则是给工具，删工具违背原则）|

---

## 设计决策

### 反强编排合规性

本 F 的所有设计决策都在 `feedback_no_strong_orchestration` 框架内：

- **数据层**：edges 表 + provenance 列是纯数据基础设施，LLM 通过工具自主用
- **写入路径**：语义关系（produced/references/supersedes/relates-to）由 LLM 用 `link_memory` 显式声明；工程只记录事实级 provenance（conversationId 是系统注入的 ID，非推断）
- **读取路径**：`get_related` 是纯查询工具，LLM 自主调用、指定参数、解释结果；**不在 search_memory 里自动展开**（避免编排）
- **校验**：coarse 粒度限制是数据完整性约束（防 chunk sync 丢边），非行为编排；自环 CHECK 是安全约束

### 为什么不做 expandRelations（反编排审计 D1）

F20260812mrcq 已删除 `related-expand`。本 F 原 Part 4 的 `expandRelations` 是同一种冲动的换名复活——"在搜索时自动扩展关系邻居"。正确做法是让 LLM 在 search_memory 命中后，自主判断"这个条目可能有关系链"，再调 `get_related`。两步而非一步，把判断权留给 LLM。

可选的折中（未来评估）：search_memory 返回结果加 `hasRelations: boolean` 提示，但不自动展开。LLM 看到 hasRelations=true 后自主决定是否调 get_related。本 F 不实现，留 follow-up。
