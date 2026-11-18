---
id: F20261118stale
title: 记忆检索端 stale 感知：被 supersede 条目的降权与标注（P0）
doc_type: feature
summary: |
  记忆系统「主动记忆层」方案的 P0 检索端改造：被 supersedes 边（from=取代者/新条目, to=被取代/旧条目）
  的 to 端指向的旧记忆条目，在 search_memory 重排时乘以降权因子（默认 0.3），并在结果条目透出
  supersededBy（取代它的新条目 ID），供 agent 感知「此条已过期」。动机：supersede 边
  自 F20260813mren 起就是记忆图一等公民，但 search-engine 从不读它——旧认识被 link_memory
  声明取代后仍会按历史分数排在前面，新旧并列比「不记录取代」更糟。本改动只动检索端
  rerank，不动存储、不改 supersede 边语义；无 supersede 关系的检索路径行为零变化。
  查重：2026-11-18 实查 docs/features|research 无「stale 感知 / 被取代降权」同主题文档，
  F20260813mren（关系层）与 F20261112rnkph（排序 Phase 1）均不重复本主题，新建文档。
change_type: feature
intent:
  problem: "supersedes 边建了（F20260813mren 一等公民 edge_type），但检索重排从不读它——被 link_memory 声明取代的旧记忆条目继续按历史 retrievalCount/timeDecay 得分排在前面，检索结果新旧版本并列，agent 引用到过期认识反而比不建边更糟。主动记忆层（P1 belief 状态机）落地的前提，是检索端必须先能感知 stale。"
  expected_effect: "被 supersedes 边的 to 端（旧条目）在 rerank 时 finalScore×0.3 明显下沉，结果条目透出 supersededBy 供 agent 标注；未声明 supersede 的条目检索行为与现在完全一致（零变化）；金标评测三项地板不劣化。"
  verify_by:
    type: behavior_check
    note: "单测覆盖 rerank/rerankAdditive 降权与透出、bulk 边查询正确性；npm run check 全绿；golden-eval 三项地板不变（评测数据无 supersedes 边）；检视獭核对命中边方向（to 端=被取代条目）与声明 Modification-Class=mechanism-addition 一致性。"
capability_test: "n/a: 改动是检索排名的机制增强（降权因子为确定性数学变换，不新增 prompt/工具/协议指令）；supersededBy 是结果条目的附加元数据字段，不改变任何 LLM 行为指令；行为门禁为 tests/usecases/memory/golden-eval.test.ts 三项地板与新增单测。"
created_at: 2026-11-18
created_in_conversation: 82f71e1a-a8b0-4e0f-916e-5e219624483c
causal_links:
  from: [F20260813mren, F20261112rnkph]
tags: [memory, retrieval, rerank, supersede, stale]
modules:
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - src/usecases/memory/memory-reader.ts
  - src/usecases/memory/memory-repository.ts
  - src/frameworks/db/memory/memory-edge-queries.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - tests/usecases/memory/search-engine.test.ts
  - tests/frameworks/db/memory/memory-edges.test.ts
---

# 记忆检索端 stale 感知：被 supersede 条目的降权与标注（F20261118stale）

> **定位与查重**：本改动是「主动记忆层」方案（v4 设计定稿，见对话工作区
> `otter-memory-design-v2.md`）的 **P0 检索端改造**——单独拆出、先落地。
> 2026-11-18 建档前实查：`grep -rl 'stale 感知|被取代降权|supersede 降权'` 在
> `docs/features/` + `docs/research/` 无同主题命中；F20260813mren（记忆关系层，定义
> supersedes 边）与 F20261112rnkph（排序 Phase 1 加法融合）均不重复本主题，新建文档，
> 以 `causal_links.from` 关联两者，不复用两者 ID。

## 背景与动机（为什么 P0 先做）

主动记忆层（P1）要为「搭档喜好 / 当前认识」引入 belief 状态机（recorded → verified →
disputed → superseded），而 supersede 是其中「旧认识让位新认识」的关键迁移。但现状是：

| 项 | 事实 | 锚点 |
|---|---|---|
| supersedes 边是一等公民 | `edge_type` 四值之一，`supersedes` 语义 = A 取代 B（from=新, to=旧） | `F20260813mren`；`memory_edges` 表 DDL |
| 检索不读边 | `search-engine.ts` 的 rerank 只算 rrf×timeDecay×frequency×flag×conv，从不查 edges | `src/usecases/memory/search-engine.ts`（本 PR 前） |
| 旧认识仍排前 | 被取代条目 retention 无衰减，history score 继续增长，新旧并列 top-k | 设计审查 k3 共识：「检索端 stale 感知必须先做，否则新旧并列比现在更糟」 |
| 被砍的旧 Part 4 不再现 | F20260813mren D1 砍掉的是「expandRelations 沿边扩展召回」——本 P0 不扩召回，只对**已命中**的旧条目降权+标注，不把边当召回源 | `F20260813mren` 文档 D1 节 |

一句话：**supersede 边建了却不参与排序，等于声明了「旧的认识对」还让它继续赢。** P0 补上
检索端这一环，P1 的 belief 状态机才有可依赖的展示基底。

## 设计

### 命中边方向（关键语义）

- `supersedes` 边（F20260813mren + link_memory 工具描述 = A 取代 B）：`from_entry_id` = 取代者
  （新条目），`to_entry_id` = 被取代的旧条目。检索对 **to 端（旧条目）**降权，对 from 端不处理。
- bulk 查询只查 `edge_type='supersedes' AND to_entry_id IN (候选)`，返回
  `Map<旧条目(被取代) ID, 新条目(取代者) ID>`；候选里没边的条目不在 Map 里，行为与无
  supersede 时一致。同一旧条目被多条 supersedes 边指向时取 `created_at` 最新的一条。

### 改动面（只动检索，不动存储/边语义）

| 文件 | 改动 |
|---|---|
| `search-engine.ts` | `SearchEngineConfig.supersededPenalty?: number`（构造回填默认 0.3）；`ScoredHit.supersededBy?: string`；`rerank`/`rerankAdditive` 加 `supersededById?: ReadonlyMap<string,string>`，命中即 finalScore × supersededPenalty 并透出 `supersededBy` |
| `search-memory.ts` | `RetrievalResultEntry.supersededBy?: string`；`rerankAndReturn` 在 rerank 前 `reader.getSupersededBy(hitIds)`，传入 rerank，结果透出 |
| `memory-reader.ts` / `memory-repository.ts` | port 加 `getSupersededBy(entryIds): Promise<Map<string,string>>`（读接口，兼容完整接口） |
| `memory-edge-queries.ts` + `sqlite-memory-repository.ts` | bulk 查询实现（见上） |

### 降权因子的选择

默认 `0.3`：明显下沉（旧条目 top-k 内会掉到非 supersede 的新条目之后），但不归零——保留
被取代内容可见（agent 仍能看到「它存在、且被 X 取代」），符合 v4 设计「禁止删除，只能
supersede」的回滚可见性要求。因子收在配置口，后续网格标定可调，不改公式。

**顺序说明（标定勿误判）**：降权发生在 rerank 内，`dedupAndBoostBySource` 的 multiHit
聚合加分（chunk 多命中）在降权**之后**运行，可部分抵消 ×0.3——这是可接受的取舍，但网格
标定超参时须知道降权与聚合加分的先后顺序，不能把「旧条目 chunk 多命中仍上前排」误判为
因子失效。

## 验证

### 单元测试（新增，随 PR 提交）

- `search-engine.test.ts`：multiply 与 additive 两条路径下，被 supersede 条目 finalScore
  ×0.3 且透出 `supersededBy`；未传 `supersededById` 时行为与旧一致（无字段、排序不变）。
- `memory-edges.test.ts`：`getSupersededBy` 只返回 supersedes 边的旧→新映射、过滤
  references 边、空集合返回空 Map。

### 回归门禁

- `npm run check`（build + lint + schema + smoke + 脚本测试）全绿。
- `npm run eval:golden`：三项地板不劣化——评测数据不含 supersedes 边，本改动对无 supersede
  路径零影响。

### 对抗审视

按 code-implementation 全流程，PR 提交后由检视獭核对：①声明 `mechanism-addition` 与
diff 实际新增机制一致；②命中边方向正确（to 端=被取代旧条目）；③无 supersede 路径零行为变更。