---
id: R20260811rclo
title: clowder-recall-lessons
doc_type: research
summary: |
  对比 otter-buddy 与 clowder-ai 的记忆召回机制，识别可采纳的优化点。
  调研结论：clowder 并非"十几路并行召回"，而是 mode×scope×dimension×depth 的正交组合搜索空间。
  otter 在重排质量（时间衰减/频率/用户标记/加权 RRF）上更精致，clowder 在召回广度、自动沉淀、可观测性上更强。
  经三轮对抗审视（架构挑战 6.5/10 → 事实核查 95%+ → 盲点挑战），修正多处事实错误与决策错误，
  最终采纳 P0 三项（搜索可观测性含暗化条目检测、Snippet质量+下钻路径合并、Embedding 版本锚-仅检测降级）、
  P1 三项（Anchor Lookup、Passage Context Window、Edges 1-hop 图），P2 八项候选。
  砍掉的项含明确理由与状态变更记录（Signal-Driven Trigger 第三轮恢复为 P2 候选）。

status: draft
exploration_type: technical
tags: [memory, retrieval, recall, rrf, embedding, architecture]
modules:
  - src/usecases/memory/search-memory.ts
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/memory-repository.ts
  - src/usecases/memory/store-memory.ts
  - src/entities/memory/memory-entry.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/embedding/embedding-service.ts
  - src/bootstrap/memory.ts
---

# R20260811rclo: Clowder-AI 召回机制对比与采纳评估

## 背景

### 起因

用户问"clowder-ai 据说有十几路召回，有哪些 otter 可以学习"。本研究的目的是回答这个问题，并把答案转化为可执行的优化清单。

### 调研范围

- **clowder-ai 仓库**：`/Users/orca/ai/others/clowder-ai`，重点看 `packages/api/src/domains/memory/`、`packages/api/src/domains/cats/services/`、`docs/features/F102-memory-adapter-refactor.md`
- **otter-buddy 现状**：`src/usecases/memory/`、`src/frameworks/db/memory/`、`src/entities/memory/`

### 一个认知纠偏

"十几路召回"的说法不准确。clowder 真正的设计是**少量检索原语 × 多维过滤参数的正交组合**，等效 ~90 种组合的搜索空间，看起来像十几路。这与 otter 现有的"对话库/术语库 + FTS/Vec 双路"是同一个思路，只是维度更多。

```
mode       (lexical | semantic | hybrid)               ×3
scope      (docs | memory | threads | sessions | all)  ×5
dimension  (project | global | all)                    ×3
depth      (summary | raw)                             ×2
```

---

## Otter 现状梳理

### 已有的精致设计（不能丢）

| 维度 | 实现 | 优势 |
|------|------|------|
| 时间衰减 | `exp(-ln2 · age / half_life)` (`search-engine.ts:184`) | 旧记忆自然沉淀 |
| 频率加权 | `log(1+count) · factor + 1` (`search-engine.ts:189`) | 被反复检索的记忆放大 |
| 用户标记乘子 | `userFlagMultiplier` (`search-engine.ts:163`) | 用户 pin 的内容强提权 |
| 加权 RRF (alpha) | FTS/Vec 权重可调（`alpha=0.4` 偏 FTS，`search-engine.ts:56-57`） | 比朴素 RRF 更可控 |
| Vec 质量门控 | `vecSimilarityThreshold=0.3` 过滤 (`search-engine.ts:70-73`) | 拒垃圾语义命中 |
| 长文档防霸占 | FTS/Vec 双路预聚合 top-3（`preAggregateFtsBySource` `search-memory.ts:387-398`、`preAggregateVecBySource` `:404-415`） | 解决长 chunk 挤占 limit |
| 多 chunk 加分 | `0.01/hit` 封顶 5 hits (`search-memory.ts:344-345`) | 同源多命中视为正信号 |
| 多语言句末 | `\p{Sentence_Terminal}` Unicode property (`search-memory.ts:445`) | 覆盖中英日韩泰阿拉伯 |
| 多库路由 | 对话库/术语库归一化混排，路由入口 `search-memory.ts:63`、混排实现 `:128` | 跨库不互相碾压 |
| 渐进式披露 | summary/snippet/full 三档 (`memory-entry.ts:60`) | 省 token |
| **FTS 双表** | `memory_fts` (trigram) + `memory_fts_jieba` (jieba 分词在应用层 `jieba-tokenizer.ts` 完成，表本身不声明 tokenizer) 双写 (`schema.ts:170, 179`) | 中文短查询能力远超 clowder 的 unicode61 |

### 当前局限

1. **搜索可观测性不足**：`source` 字段只标记 `fts/vec/both`，没有 `anchor`/`keyword-fallback`/`semantic-only` 等路径标记。召回质量出问题时无法诊断"为什么这条结果排第一"。
2. **jieba 表 highlight 实为全文返回**：`searchFTSWithHighlight` 名字暗示返回匹配片段，实际返回 `row.content` 全文（`sqlite-memory-repository.ts:399`），snippet 可能完全不含搜索词。这是有意设计（注释"避免分词碎片化"），但代价是 agent 在 snippet 模式下看不到匹配证据。
3. **chunk 孤立，无上下文窗口**：搜到一条消息片段后看不到前后文，对对话场景理解不友好。
4. **版本演进字段未被搜索利用**：`features.supersedes`/`research.supersedes` 是 `features`/`research` 表的**独立列**（非 `memory_entries.metadata` 字段），可 SQL 查询但搜索流程不感知，无法"查最新版决策"。
5. **Embedding 模型/维度切换无防护**：换模型或升维度时旧向量与新查询混跑，召回质量静默变差。
6. **agent 不知道如何下钻**：summary/snippet 看完觉得有用，但用什么工具拿全文不明确。
7. **结构化 ID 精确匹配弱**：用户搜 `F20260811rclo` 时，trigram + jieba 能召回（不是"找不到"），但可能带出含类似子串的其他内容，精确度不如主键直查。
8. **working/historical 沉淀是手工的**：长对话靠人决定何时压缩。
9. **暗化条目累积（embedding fire-and-forget 无补偿）**：`store-memory.ts:60-69` 的 embedding 存储是 fire-and-forget（`.embed().then().catch()`），失败后无重试无补偿。失败条目永久"FTS 可搜 / Vec 不可搜"。随时间累积，会出现同一查询有时 `source: both`、有时 `source: fts` 的不一致——agent 以为搜全了实际没搜全。**第三轮审视发现，前两轮漏掉**。
10. **搜索查询被批量 reindex 阻塞**：`store-memory.ts:113` 的 "~546 embedding 约 27s" 不只是"批量 re-embed 阻塞"，运行时影响是——文档同步后 27 秒内，搜索查询的 embedding 请求排在 N 个 chunk embedding 后面，实时搜索延迟堆积。需要优先级队列方案。
11. **FTS 一致性对账缺失**：`sync-documents.ts:reconcileSync` 只对账磁盘 vs features/research 表，不检查 `memory_entries` vs `memory_fts`/`memory_fts_jieba` 行数一致。事务中途失败会产生孤儿行。
12. **双 FTS 表写入一致性风险**：`storeEntry` 在单事务内写 `memory_fts` + `memory_fts_jieba`，jieba 分词库的稳定性直接影响记忆存储可用性——`tokenizeWithJieba` 抛异常会回滚整个事务。FTS 双表是优势，但风险未识别。

### 关键架构约束（审视发现的硬约束）

- **schema 禁止 ALTER TABLE**：`initSchema` 使用 `CREATE TABLE IF NOT EXISTS` 幂等模式（`schema.ts:8`），加新列不能 ALTER，要么新增表，要么重建库。
- **bge-m3 worker 单线程串行**：`embedding-service.ts` 通过 Worker Thread 跑，每次 `embed()` postMessage 排队处理。`store-memory.ts:113` 注释 "~546 embedding 约 27s" 量化了批量 re-embed 的阻塞成本。
- **EmbeddingGateway 接口窄**：当前只有 `available: boolean` + `embed()`（`embedding-gateway.ts`），拿不到模型 id/rev/dim。模型元信息封在 worker 内部。
- **memory_entries 表无 `position`/`keywords` 列**：邻域查询需 join `messages` 表（按 `sequence_num`），keyword 字段需新增独立列。

---

## Clowder 调研要点

### 检索原语

| 原语 | 文件:行号 | 说明 |
|------|-----------|------|
| Exact Anchor Lookup | `SqliteEvidenceStore.ts:83-117` | query 是 anchor 形状时主键直查（`COLLATE NOCASE`），用 `seenAnchors` 去重后顶格插入结果列表 |
| FTS5 BM25 | `SqliteEvidenceStore.ts:119-182` | title 权重 5.0、summary 权重 1.0；superseded/archive 降权 |
| Keyword JSON Fallback | `SqliteEvidenceStore.ts:184-227` | FTS 命中 ≤1 时回退到 keywords 字段 LIKE（**用因：clowder FTS 用 unicode61，对中文无能，故需 keyword 补**） |
| Passage-level FTS | `SqliteEvidenceStore.ts:229-280, 599-693` | 独立 `passage_fts` 表，消息段落粒度，支持 contextWindow（grep -C 风格） |
| Vector NN | `SqliteEvidenceStore.ts:357-408` | sqlite-vec vec0 表，768 维 |
| Hybrid BM25+Vec RRF | `SqliteEvidenceStore.ts:414-494` | 候选池 `min(max(limit*4, 20), 100)`，朴素 RRF k=60（**无 alpha 加权，无质量门控**） |
| Federated project+global | `KnowledgeResolver.ts:1-104` | 第二层 RRF 融合两个 SQLite 库 |

### 索引/数据模型亮点

- **Edges 表**（1-hop 关系图，`schema.ts:33-38`）：关系类型 `evolved_from | blocked_by | related | supersedes | invalidates`，从 frontmatter 自动提取，可查询但不可图遍历。
- **Embedding version anchor**（`schema.ts:72-77`）：`embedding_meta` 表用 key-value 结构存储（key=`embedding_model_id`/`embedding_model_rev`/`embedding_dim`），`VectorStore.checkMetaConsistency` 启动校验，不一致触发 `clearAll`。
- **Embedding Shadow Mode**（`interfaces.ts:200`，第三轮审视补充）：三态 `'off' | 'shadow' | 'on'`。`shadow` 模式下向量照常生成存储，但搜索仍走 lexical 路径（`SqliteEvidenceStore.ts:295` 检查 `mode === 'on'`）。这是"灰度上线"能力——降级时仍可用旧向量，不是二元全清。与 otter P0-3 形成互补。
- **双 FTS 表**：`evidence_fts`（文档级 title+summary）+ `passage_fts`（段落级 content）。
- **SemanticReranker**（`SemanticReranker.ts`，第三轮审视补充）：对 FTS 候选，用预计算的 vec distance 做二次排序。和 RRF 不同——RRF 是"两路独立打分再合并"，SemanticReranker 是"FTS 召回为主，vec 距离做 fine-grain 重排"。**注意：该组件在 clowder 仓库内已定义但未被 factory 实际 wire 到搜索路径，属于设计意图而非已落地能力**（第四轮审视核查确认）。otter 仍可作为 P2 候选评估这个思路。
- **FTS 一致性对账**（`IndexBuilder.ts:385`，第三轮审视补充）：`checkConsistency()` 对账 `evidence_docs` 和 `evidence_fts` 行数，检测索引不一致。otter 完全没有这个能力。
- **切块策略**：文档级（每 .md 一条）+ 段落级（每消息一条 passage）+ lessons-learned 按 `### LL-NNN:` 标题拆分。

### 渐进式披露

- **depth 参数**：`summary`（title+summary snippet）/ `raw`（passage + contextWindow）
- **Drill-Down Hint**（`SqliteEvidenceStore.ts:331-350`）：`enrichWithDrillDown()` 对每类结果附加 `{ tool, params }`，告诉 agent 用哪个 MCP 工具继续下钻（thread → `cat_cafe_get_thread_context`，session → `cat_cafe_read_session_digest`）。
- **scope 路由策略**：docs → memory → threads → sessions → raw transcript，逐层下钻。

### 自动沉淀（otter 完全没有的能力）

- **LSM-style 摘要压缩**（`SummaryCompactionTask.ts`）：L0 实时拼接 / L1 定时 Opus 摘要（`schedulerIntervalMs: 30 * 60 * 1000`，即 30 分钟检查；`quietWindowMinutes: 10` 静默窗口门控）/ L2 deferred，双写读模型 + append-only ledger。
- **Durable Candidate Extraction**（`AbstractiveSummaryClient.ts:49-104`）：摘要时提取 `[decision]/[lesson]/[method]` 标记的候选知识，带 Implementation Noise 拒绝门（正则拒绝实现细节噪音，`196-213`）+ 3 个月新人准入标准（`"Would a new team member benefit from knowing this 3 months from now?"`，第 79 行）。
- **Materialization Pipeline**（`MaterializationService.ts`）：approved marker → 写 .md → git commit → trigger reindex。SQLite 是编译产物，文件系统是真相源。
- **Signal-Driven Trigger**（`summary-config.ts:31-40`）：`SIGNAL_FLAGS` 位标记（DECISION=1, CODE=2, ERROR_FIX=4），消息写入时设 flag，高价值信号 bypass volume gate（**不是摘要时正则扫描对话**——架构师纠错）。
- **Tool-Based Recall**（`SystemPromptBuilder.ts:203-230`）：召回不自动注入，而是教 agent 用 MCP 工具主动搜索。

---

## 候选优化点（按价值密度分组）

> 优先级判断维度：① otter 是否存在该痛点；② 改动是否局部（不牵动架构）；③ 与现有体系是否契合；④ 失败模式是否可控。

### P0 — 防雷性质 / 高频痛点

#### P0-1：搜索可观测性（source 路径标记 + embedding 覆盖率 + 暗化条目检测）

**现状**：otter 的 `source` 字段只标记 `fts/vec/both`。召回质量出问题时（"为什么这条无关结果排第一"），没有工具诊断召回路径。比很多 P1 优化点更紧急——**诊断能力先于优化能力**。

**第三轮审视扩展范围**：原方案只做"路径标记"，但更大的可观测性盲点是**暗化条目**（局限 9）——embedding fire-and-forget 失败的条目永久无 vec 索引。同一查询有时返回 `source: both`、有时 `source: fts`，agent 以为搜全了实际没搜全。**只标路径不标覆盖率,等于只诊断了一半**。

**方案**：
- **路径标记**（原方案）：扩展 `RetrievalSource` 类型：`"anchor" | "fts" | "vec" | "both" | "keyword-fallback" | "context-expand"`。
- **中间分值**（原方案）：`debug=true` 时返回 `{ rrfScore, finalScore, timeDecay, frequencyBoost, multiHitCount }`。
- **embedding 覆盖率（新增，默认返回）**：返回 `vecCoverage: { total: N, withVec: M, ratio: M/N }`。不加 debug 参数也返回——让小獭能自动感知"这次召回可能不完整"。
- **暗化条目扫描接口（新增）**：新增 `scanDarkEntries(): Promise<{ entryId, createdAt }[]>` 用例,返回无 vec 索引的条目清单,供后续手动补 embed 或自动重试。

**改动位置**：`search-engine.ts:24-32`（ScoredHit 接口）、`search-memory.ts:313-333`（rerankAndReturn）、`search-memory.ts`（vecCoverage 计算）、`memory-repository.ts`（scanDarkEntries 接口）、`memory-controller.ts`（debug 参数 + vecCoverage 透传）。

**风险**：① vecCoverage 默认返回会占用少量 token,但值很小（3 个数字）值得；② scanDarkEntries 是新接口,需要约定调用频率（避免高频扫描加压 DB）；③ **vec0 虚拟表 anti-join 限制**(第四轮审视补充):`memory_vec` 是 vec0 虚拟表不是普通表,LEFT JOIN ... WHERE IS NULL 可能行为异常,建议用 `NOT EXISTS (SELECT 1 FROM memory_vec WHERE memory_entry_id = me.id)` 替代。

**收益**：召回质量出问题时能立即定位"哪条路径出了问题" + 暗化条目不再静默累积。

#### P0-2：Snippet 质量 + 下钻路径（jieba highlight 修复 + Drill-Down Hint 合并）

**第三轮审视合并**：原 P0-2(jieba highlight 修复)和原 P0-3(Drill-Down Hint)强耦合,拆成两个 F 会出现"先做的那个独立价值打折"——P0-2 先做没 P0-3,agent 拿到好 snippet 但不知怎么拿全文;P0-3 先做没 P0-2,drillDown 指向全文,但全文和 snippet 差不多。合并为一个 F 文档,作为"Snippet 系统整体升级"。

**现状**（两个痛点合并）：
- `searchFTSWithHighlight` 返回 `row.content` 全文（`sqlite-memory-repository.ts:399`），snippet 可能完全不含搜索词。注释说明这是有意设计（"避免分词碎片化"），但代价是 agent 在 snippet 模式下看不到匹配证据。
- agent 在 snippet 看到有用内容后，不知道用什么工具拿全文。

**方案**：
- **Snippet 质量修复**（原 P0-2）：应用层后处理高亮——拿到查询的 jieba 分词结果（`tokenizeQuery`），在 content 里正则定位匹配 token 位置，截取窗口（前后各 100 字符）作为 snippet。绕开 jieba 表不支持 FTS5 内置 `highlight()` 的限制。
- **第三种替代方案对比**（审视补充）：也可以"搜索走 jieba 表,但 highlight 走 trigram 表"——`memory_fts`(trigram) 表支持 `highlight()` 函数,可双表联查。评估:① 复杂度高(双表 join);② trigram 分词粒度与 jieba 不一致,highlight 可能错位。**仍推荐应用层方案**。
- **Drill-Down Hint**（原 P0-3）：`RetrievalResultEntry` 新增 `drillDown?: { tool: string; params: Record<string, unknown> }` 字段。`detail_level != "full"` 时填充 `{ tool: "get_memory_detail", params: { id: entry.id } }`。MCP 工具描述中写明"如果想看 snippet 对应的全文，调用 get_memory_detail"。

**改动位置**：`sqlite-memory-repository.ts:366-407`（snippet 重写）、`search-memory.ts:buildSnippet`（消费新 snippet + 注入 drillDown）、`src/entities/memory/memory-entry.ts`（drillDown 字段）、`api-contract/api/memory.ts`（**契约类型定义源,通过 `@contract/api/memory` alias 引用,必须改**）。

**风险**：① 应用层高亮的性能（O(token_count × content_length)），需限制扫描 token 数;② 正则特殊字符转义;③ drillDown 字段对契约的向后兼容性。

#### P0-3：Embedding Version Anchor（仅检测 + 降级 + 告警）

**现状**：otter 当前 embedding 模型与维度固定，但未来可能切换。切换时旧向量与新查询混跑，召回质量静默变差。这是个定时炸弹。

**架构师纠错**：原方案包含"触发全量 re-embed"严重低估复杂度——bge-m3 worker 单线程串行（`embedding-service.ts`），500 条要几分钟；且 re-embed 基础设施完全不存在（没有批量 embed 接口）。**本批只做检测+降级+告警，re-embed 留 P2。**

**方案**：
- 新增 `embedding_meta` 表：`{ model_id TEXT, model_rev TEXT, dim INTEGER, recorded_at TEXT }`。
- 扩展 `EmbeddingGateway` 接口暴露 `getMeta(): { modelId, modelRev, dim }`。
- `bootstrap/memory.ts` 启动时校验：当前配置与表内记录一致才允许 vec 搜索；不一致时：
  - **降级为纯 FTS**（vec 搜索跳过）
  - 在 `otter_context` 表写入 `embedding_degraded: true`（参照 `memory-controller.ts:95` 已有的 `degraded` 字段先例，让 agent 能感知）
  - `logger.error` 记录（不只是 warn）
- 初次启动时若表为空，写入当前模型元信息（基线）。

**worker postMessage 时序方案**（第三轮审视补充）：bootstrap 时 worker 还没 ready,主线程拿不到 meta。三种方案:
- **方案 A**:`bootstrap/memory.ts` 同步等待 worker ready 信号——`embedding-service.ts:128-134` 已有 `waitForReady` 机制可复用。**推荐**。但需注意:当前 `ready` 消息(`embedding-service.ts:36-39` 的 `{ type: "ready" }`)**不包含模型元信息**,所以"复用 waitForReady"实际还要扩展 `EmbedResponse` 类型让 `ready` 消息附带 `{ modelId, modelRev, dim }`,或新增一条 `getMeta` postMessage 在 ready 之后再请求 meta。改动不算大,但不是 trivial 复用。
- 方案 B:worker 在 `workerData` 接收配置参数,主线程直接读配置文件作为 meta(不依赖 worker)。绕开了 worker 通信但耦合了配置文件位置。
- 方案 C:延迟校验——不在 bootstrap 时校验,在第一次搜索时校验。会让首次搜索变慢,且失败信号延迟暴露。

**改动位置**：`src/frameworks/db/schema.ts:170-200` 区间加新表（在 `createMemoryTables` 里，幂等模式）、`src/bootstrap/memory.ts`（启动校验 + 方案 A 的 waitForReady）、`src/usecases/memory/embedding-gateway.ts` + `src/frameworks/embedding/embedding-service.ts`（worker postMessage 回模型元信息 + waitForReady 复用）、`src/interface-adapters/http/controllers/memory-controller.ts`（透传 degraded 状态）。

**风险**：① 第一次上线时若发现现有向量与配置不一致（比如本来就有维度问题），会立刻降级——这其实是好事（暴露存量问题）；② 方案 A 复用 waitForReady 时,要确认当前 `waitForReady` 行为是否等待 worker 完成初始化信号(而不只是 worker 加载)。

**收益**：消除 embedding 切换的静默失败风险。

---

### P1 — 中期价值高

#### P1-1：Exact Anchor Lookup（从 P0 降级，因痛点被高估）

**架构师纠错**：原文档说 otter 用 `unicode61` tokenizer 是**事实错误**。otter 实际用 `memory_fts`（trigram）+ `memory_fts_jieba`（jieba）双表。trigram 能匹配任意 3 字符以上子串，对 `F20260811rclo` 这类长 ID 已经能召回。**痛点不是"找不到"，而是"找得不够精确"——可能带出含类似子串的其他内容。**

**现状**：用户搜 `F20260811rclo` 时，trigram + jieba 能召回，但精确度不如主键直查。

**方案**：
- 在 `search-memory.ts:searchConversation` / `searchAllLibraries` 入口加 anchor 形状检测。
- 正则（大小写不敏感）：`/^(F|R)\d{8}[a-z0-9]{4}$/i`——仅 otter 实际存在的 F/R 命名空间（架构师确认 otter 无 ADR/LL 命名空间）。
- 命中时调用现有 `repo.getBySourceId(anchor)`——**注意 `getById(id)` 按 `memory_entries.id` 查（`crypto.randomUUID()`），不适用，需新增 `getBySourceId(sourceId)` 按 F/R 文档 ID 查**。
- anchor 命中结果短路注入结果列表顶部（参照 clowder 的 `seenAnchors` + 顶格插入模式），不走 RRF（anchor 没有 rank 概念）。

**改动位置**：`search-memory.ts:63`（`search` 方法入口）、`memory-repository.ts`（新增 `getBySourceId`）、`sqlite-memory-repository.ts`（实现）。

**路由边界**：
- `searchAllLibraries` 和 `searchConversation` 路径都注入 anchor lookup。
- `searchTerminologyLibrary` 路径不注入（术语用 term 名直接搜，不需要 anchor）。

**风险**：① 近似 anchor（"F2026081rclo" 缺一位）不匹配正则时降级到 FTS，不硬失败；② 与现有去重逻辑的协作——anchor 命中结果应排除在 RRF 去重之外（避免被误并入 fts/vec 候选）。

#### P1-2：Passage Context Window（grep -C 风格）

**现状**：otter 的 chunk 孤立。对话场景下"前后文"对理解极其关键，但搜到的 chunk 看不到上下文。

**架构师纠错**：原方案"按 `(conversationId, position)` 邻域补齐"与 otter 数据模型不兼容。`memory_entries` 表没有 `position` 列。`position` 在 `messages` 表的 `sequence_num` 列。需要跨表 join：
1. 从 `memory_entries.sourceId`（即 messageId）反查 `messages.sequence_num`。
2. 按 `(conversation_id, sequence_num ± N)` 查邻域消息。
3. 把邻域消息作为 context entries 返回（标记 `source: "context-expand"`，排除去重）。

**方案**：
- `SearchQuery` 新增 `contextWindow?: number`（1-5，默认 0）。
- 在 `sqlite-memory-repository.ts` 新增 `getNeighborMessages(messageId, windowSize): Promise<Message[]>`。
- 在 `search-memory.ts` 的 `rerankAndReturn` 后注入 context entries（不参与打分，只作为附加上下文）。
- 返回结构区分 `matchedEntries`（打分结果）与 `contextEntries`（邻域补充）。

**改动位置**：`memory-repository.ts`（新接口）、`sqlite-memory-repository.ts`（跨表 join 实现）、`search-memory.ts`（注入逻辑）、`RetrievalResult` 接口（新增 contextEntries 字段）。

**风险**：① 多次邻域查询的 IO 成本，需要批量查询接口；② 与 `dedupAndBoostBySource` 的协作——context entries 必须打 `source: "context-expand"` 标记排除去重；③ schema 约束：邻域消息可能本身不在 `memory_entries` 表里（不是所有消息都被索引为 memory entry），需要直接查 `messages` 表。

#### P1-3：Edges 1-hop 关系图

**架构师纠错**：原方案"解析 `metadata.supersedes`"是数据源错误。`supersedes` 和 `causal_links_from` 是 `features`/`research` 表的**独立列**，不是 metadata 字段。自动建边应在 `sync-documents.ts` 层做（文档入库时从 `features.supersedes` 解析），不在 `store-memory.ts` 层。

**方案**：
- 新表 `memory_edges(source_id TEXT, relation TEXT, target_id TEXT, created_at TEXT)`（在 `createMemoryTables` 里加，幂等）。
- `sync-documents.ts` 解析 `features.supersedes`/`research.supersedes` 时同步建边（**仅 supersedes，不含 causal_links_from**——架构师建议）。
- `search-memory.ts` 新增 `expandRelated?: boolean` 参数，对 top-K 结果做 1-hop 扩展：
  - `supersedes` 关系：返回最新版本（链式追溯）。
  - 其他关系暂不扩展。
- 扩展结果标记 `source: "related-expand"`，独立于 RRF 候选。

**改动位置**：`src/frameworks/db/schema.ts`（新表）、`src/frameworks/document/sync-documents.ts`（建边逻辑）、`src/usecases/memory/memory-repository.ts`（edges 查询接口）、`src/usecases/memory/search-memory.ts`（expandRelated 参数）。

**风险**：① 历史数据的 edges 需要回填脚本（一次性 `rebuild-edges` 任务）；② 1-hop 扩展可能放大召回噪声，限制扩展结果数量（如每条命中最多扩展 1 条）。

**收益**：解决"查最新版决策"这个高频痛点，避免 agent 引用过时决策。

---

### P2 — 架构级，需专项讨论

#### P2-1：Durable Candidate Extraction（先做，独立于 LSM 摘要）

**现状**：otter 完全没有从对话中自动识别"该沉淀的决策/教训"的能力。

**方案（Step A，先做）**：
- 从对话消息中识别 `[decision]/[lesson]/[method]` 标记（或用 LLM 抽取）。
- 配套必备：Implementation Noise 拒绝门（拒绝"改了 JSON parser"等实现细节）+ 3 个月新人准入标准。
- 产出到独立的 `candidates` 表（参照 clowder 的 `markers` 表），**不进 `manage-memory` 的待审队列**（架构师建议：避免职责膨胀）。
- 审批通过后转 F 文档，走正常特性流程。

**改动位置**：新表 `candidates`、新用例 `ReviewCandidates`、抽取逻辑（LLM 调用）。

**风险**：① 抽取质量依赖 prompt + 拒绝门，需要迭代调优；② 与 mimo 模型复读倾向（记忆 `project_mimo_degenerate_tendency`）的协作——抽取时若输入已被污染，candidate 质量不可控。

#### P2-2：LSM 摘要压缩（评估后再决定）

**现状**：otter 的 working/historical 转换是手工的。

**建议**：先做 P2-1 Step A，观察 candidate 抽取效果后再决定是否上完整 LSM 摘要。如果对话长度还没到必须自动压缩的程度，Step A 已足够。

#### P2-3：Embedding Re-embed 基础设施（P0-3 的后续）

**现状**：检测到 embedding 模型/维度不一致时（P0-3），只能降级为纯 FTS，无法主动修复。

**方案**：批量 re-embed 任务（离线运行，避免阻塞实时搜索）。但这需要：
- 批量 embed 接口（绕过 worker 单线程串行瓶颈）。
- 任务调度器（参照 clowder 的 `task_run_ledger`）。
- 进度跟踪 + 中断恢复。

**建议**：等 P0-3 实际触发降级后再评估必要性。如果模型切换频率低，"降级 + 手动重建库"也可接受。

#### P2-4：Tool-Based Recall（评估，不急于采用）

**现状**：otter 是系统自动注入上下文。

**建议**：评估，不急于采用。先做 P0/P1，观察 agent 在新能力下的行为再决定。可以考虑"关键事实自动注入 + 深度检索工具化"的混合策略。

#### P2-5：Keyword 字段（用户手动标的精准价值，非补中文）

**回应 P1-3 砍掉后的遗留**：clowder 的 keyword fallback 有两个用途——① 补 unicode61 对中文的无能（otter 用 jieba 已覆盖，**砍掉**）；② 用户手动声明的关键词比自动分词更精准（otter 暂无，**保留 P2 候选**）。

otter 有 `tags` 字段（F 文档 frontmatter）但未被 FTS 索引。如果未来发现 jieba 漏召场景，可以把 tags 索引化（加 `tags_fts` 表或扩展 jieba 表 content）。

#### P2-6：Signal-Driven Trigger（第三轮审视恢复）

**第三轮审视纠错**：第一轮砍掉 Signal-Driven Trigger 的理由"mimo 复读风险,正则信号不可靠"是**机制理解错误**。clowder 的 signal 是**消息写入时设位**(检测原文里的"决定/agreed/decided/.ts/.js/fix/bug"等),不是摘要时正则扫描对话。复读问题出在摘要阶段,与信号设位无关。

**价值**:在 otter 上 LSM 摘要压缩(P2-2)之前,signal trigger 可以作为"摘要触发条件"的输入——含高价值信号的消息(决定/代码变更/错误修复)bypass volume gate,优先沉淀。比纯时间窗口触发更精准。

**保留为 P2 候选**:依赖 LSM 摘要基础设施。若 P2-1 Step A(candidate extraction)能落地,signal trigger 可以与 candidate 抽取的"何时触发"逻辑结合。

#### P2-7：Embedding Shadow Mode（第三轮审视新增）

**遗漏识别**:clowder 三态 `off | shadow | on`(`interfaces.ts:200`)。shadow 模式下向量照常生成存储,但搜索仍走 lexical 路径。这是"灰度上线"能力——降级时仍可用旧向量,不是二元全清。

**与 P0-3 的互补关系**:P0-3(Embedding Anchor)是"模型切换时检测+降级"。Shadow Mode 是更软的中间态——可以让新模型 shadow 运行一段时间,对比召回质量后再切换到 on。比 P0-3 的二元降级更平滑。

**保留为 P2 候选**:otter 当前 embedding 模型稳定,shadow mode 的价值在未来切换模型时才显现。

#### P2-8：SemanticReranker（第三轮审视新增）

**遗漏识别**:clowder 的 `SemanticReranker.ts` 对 FTS 候选用预计算的 vec distance 做二次排序。和 otter 的 RRF 是不同策略——RRF 是"两路独立打分再合并",SemanticReranker 是"FTS 召回为主,vec 距离做 fine-grain 重排"。

**结构性差异**:RRF 用 `1/(k+rank)` 消除了量纲问题,但也丢失了"这条 FTS 命中非常好但 vec 完全不相关"的信号。SemanticReranker 保留这个信号。

**保留为 P2 候选**:otter 的 RRF + 重排已经精致,是否换 SemanticReranker 需要实测对比召回质量。可以作为 P0-1(可观测性)落地后的下一个调优方向。

---

## 对比矩阵总览

| 能力 | otter | clowder | 差距方向 | 建议采纳 |
|------|-------|---------|----------|----------|
| 时间衰减 | ✅ exp half-life | ❌ 仅硬过滤 | otter 强 | — |
| 频率加权 | ✅ log | ❌ | otter 强 | — |
| 用户标记乘子 | ✅ | ❌（marker 是另一回事） | otter 强 | — |
| 加权 RRF (alpha) | ✅ | ❌ 朴素 RRF | otter 强 | — |
| Vec 质量门控 | ✅ threshold=0.3 | ❌ | otter 强 | — |
| 长文档防霸占 | ✅ 预聚合 top-3 | ⚠️ pool cap 100 | otter 精致 | — |
| FTS 双表（trigram+jieba） | ✅ | ❌ unicode61 单表 | otter 强 | — |
| 搜索可观测性 | ⚠️ 仅 fts/vec/both,无覆盖率 | ✅ 多路径标记 | clowder 强 | **P0-1**（含暗化条目检测） |
| Snippet 质量 + 下钻路径 | ❌ 返回全文 + 无 drillDown | ✅ highlight + drillDown hint | clowder 强 | **P0-2**（合并 F） |
| Embedding Version Anchor | ❌ | ✅ | clowder 强 | **P0-3**（仅检测+降级） |
| Exact Anchor Lookup | ❌ | ✅ | clowder 强 | **P1-1** |
| Passage Context Window | ❌ | ✅ | clowder 强 | **P1-2** |
| Edges 1-hop 图 | ❌（字段未利用） | ✅ | clowder 强 | **P1-3** |
| LSM 摘要压缩 | ❌（手工） | ✅ | clowder 强 | **P2-2**（评估） |
| Durable Candidate Extraction | ❌ | ✅ | clowder 强 | **P2-1 Step A** |
| Embedding Re-embed | ❌ | ✅ | clowder 强 | **P2-3**（评估） |
| Tool-Based Recall | ❌（自动注入） | ✅ | 设计哲学差异 | **P2-4**（评估） |
| Keyword 字段（手动精准） | ❌ | ✅ | clowder 强 | **P2-5**（候选） |
| Signal-Driven Trigger | ❌ | ✅（消息写入时设位） | clowder 强 | **P2-6**（恢复候选） |
| Embedding Shadow Mode | ❌（二元降级） | ✅ 三态 off/shadow/on | clowder 强 | **P2-7**（候选） |
| SemanticReranker | ❌ | ✅ FTS+vec distance 重排 | clowder 强 | **P2-8**（候选） |
| Federated Retrieval | ❌ | ✅ | clowder 强 | **暂不**（理由修正:worktree DB 生命周期短） |
| Keyword Fallback（补中文） | — | ✅ | clowder 强（因 FTS 弱） | **砍掉**（otter jieba 已覆盖） |
| 多语言句末切分 | ✅ Unicode property | ⚠️ unicode61 | otter 强 | — |
| 多库归一化混排 | ✅（对话/术语） | ✅（project/global） | 各有所长 | — |
| 暗化条目补偿（vec 一致性） | ❌（fire-and-forget 无重试） | ⚠️（部分覆盖） | 都不足 | **P0-1 内** |
| FTS 一致性对账 | ❌ | ✅（`checkConsistency`） | clowder 强 | **暂不**（运维层面） |

---

## 推荐采纳范围（第三轮审视后修订）

**第一批（P0）**：
1. **P0-1**：搜索可观测性（source 路径标记 + embedding 覆盖率 + 暗化条目扫描）
2. **P0-2**：Snippet 质量 + 下钻路径（jieba highlight 修复 + Drill-Down Hint 合并 F）
3. **P0-3**：Embedding Version Anchor（仅检测 + 降级 + 告警，不做 re-embed）

**第二批（P1）**：
1. **P1-1**：Exact Anchor Lookup（短路注入，需新增 `getBySourceId`）
2. **P1-2**：Passage Context Window（跨表 join `messages` 表）
3. **P1-3**：Edges 1-hop 图（仅 `supersedes` 关系，在 `sync-documents.ts` 建边）

**第三批（P2）**：
1. **P2-1 Step A**：Durable Candidate Extraction（先做，独立于 LSM 摘要）
2. **P2-2**：LSM 摘要压缩（P2-1 后评估）
3. **P2-3**：Embedding Re-embed 基础设施（P0-3 触发降级后评估）
4. **P2-4**：Tool-Based Recall（P0/P1 落地后观察 agent 行为再决定）
5. **P2-5**：Keyword 字段（候选，等 jieba 漏召场景出现）
6. **P2-6**：Signal-Driven Trigger（恢复候选,依赖 LSM 摘要基础设施）
7. **P2-7**：Embedding Shadow Mode（候选,模型切换时显现价值）
8. **P2-8**：SemanticReranker（候选,P0-1 可观测性落地后实测对比）

**砍掉**：
- Keyword Fallback（补中文部分，已被 jieba 覆盖）
- Federated Retrieval（**理由修正**:不是"无多项目场景",而是 worktree DB 生命周期短,不适合联邦检索）

---

## F 文档拆分策略

**采纳第三轮审视建议**：P0-2(jieba highlight)和 P0-3(Drill-Down Hint)强耦合,合并为一个 F。其余优化点保持独立 F。

**理由**：otter 的 F 文档规范是 per-feature 粒度。强耦合的优化点拆成两个 F 会出现"先做的那个独立价值打折"——P0-2 先做没下钻提示,agent 拿到好 snippet 但不知怎么拿全文;P0-3 先做没 snippet 修复,drillDown 指向全文但全文和 snippet 差不多。

**F 文档清单**（待用户拍板后逐项创建，共 6 个）：

| 优先级 | F 文档 | 主题 | 涉及模块 |
|---|---|---|---|
| P0-1 | F20260811xxxx | 搜索可观测性（路径标记 + 覆盖率 + 暗化条目扫描） | search-engine/search-memory/memory-repository/controller |
| P0-2 | F20260811xxxx | Snippet 质量 + 下钻路径（highlight 修复 + drillDown hint） | sqlite-memory-repository/search-memory/entities/memory/contract |
| P0-3 | F20260811xxxx | Embedding 版本锚（检测 + 降级 + worker 时序方案 A） | schema/bootstrap/embedding-service/embedding-gateway/controller |
| P1-1 | F20260811xxxx | Anchor Lookup（短路注入 + getBySourceId） | search-memory/memory-repository |
| P1-2 | F20260811xxxx | Passage Context Window（跨表 join messages） | sqlite-memory-repository/search-memory |
| P1-3 | F20260811xxxx | Edges 1-hop 图（supersedes 关系） | schema/sync-documents/memory-repository/search-memory |

---

## 对抗审视记录

### 第一轮审视（架构师 agent，2026-08-11）

**评分**：6.5/10，需要返工但不需要推翻。

**主要发现**：

#### 事实错误（已修正）
1. **原 P0-1 立论错误**：文档说 otter 用 `unicode61` tokenizer 拆碎 ID。实际 otter 用 `memory_fts`（trigram，`schema.ts:170-173`）+ `memory_fts_jieba`（jieba，`schema.ts:179`）双表。trigram 对长 ID 能匹配，痛点被夸大。**修正**：原 P0-1 降为 P1-1，调整立论为"精确度优化"而非"防雷"。
2. **原 P1-2 数据源错误**：文档说 `supersedes` 在 `metadata`。实际 `features.supersedes`/`research.supersedes` 是独立列。**修正**：建边位置改为 `sync-documents.ts`。
3. **原 P0-3 范围含糊**：方案包含"全量 re-embed"，但 bge-m3 worker 单线程串行，re-embed 基础设施不存在。**修正**：拆为 P0-4（检测+降级）和 P2-3（re-embed 评估）。**注:P0-4 在第三轮审视后因 P0-2+P0-3 合并而重编为 P0-3**。

#### 遗漏的关键事实（已补充）
- `getById(id)` 接口已存在（`memory-repository.ts:58`），但按 `memory_entries.id`（UUID）查，**不适用 anchor lookup**，需新增 `getBySourceId(sourceId)` 按 F/R 文档 ID 查。
- `searchFTSWithHighlight` 返回 `row.content` 全文不是 `highlight()` 片段（`sqlite-memory-repository.ts:399`），有意设计但影响 snippet 价值。**新增 P0-2 修复**。
- schema 用 `CREATE TABLE IF NOT EXISTS` 幂等模式，**禁止 ALTER TABLE**（`schema.ts:8`）。加新列要新增表或重建库。
- EmbeddingGateway 接口窄，拿不到模型元信息，需 worker postMessage 回传（跨线程改动）。

#### 优先级调整（已采纳）
- 原 P0-1 Anchor Lookup → **降 P1-1**（痛点被高估）
- 新增 P0-1 搜索可观测性（架构师建议，诊断能力先于优化能力）
- 新增 P0-2 jieba highlight 修复（架构师建议，影响 P0-3 下钻提示价值）
- 原 P1-3 Keyword Fallback（补中文部分）→ **砍掉**（otter jieba 已覆盖 clowder unicode61 的痛点）
- 原 P2-1 Signal-Driven Trigger → **砍掉**（mimo 复读风险，信号不可靠；架构师补充：clowder 的 signal flag 是消息写入时设位，不是摘要时正则扫描，文档对机制理解有误）

#### 用户拍板记录（2026-08-11）
- **搜索可观测性**：纳入 P0 ✅
- **jieba highlight 修复**：独立成 P0 ✅
- **Anchor Lookup**：用户"看不懂，对抗评估下吧"——架构师建议降 P1，主理采纳
- **Keyword Fallback**：用户问"为什么 clowder 两者皆有？"——主理回答：clowder 的 keyword 有两个用途（补中文 + 手动精准标），otter 的 jieba 已覆盖补中文部分，手动精准标保留为 P2-5 候选

### 第二轮审视（事实核查 agent，2026-08-11）

**评分**：A- (89%) → 修正后 ≈ A (95%+)。

**主要发现**：零捏造。所有字段名/函数名/表名/公式均真实存在。4 处 ⚠️ 行号偏差（指向函数定义行而非实现行，技术文档惯例可接受），1 处 clowder embedding_meta 表结构描述易误解。

**已修正**：
1. 多库路由 `:128` → `:63`（路由入口）+ `:128`（混排实现）
2. FTS 双表描述补充"分词在应用层 `jieba-tokenizer.ts` 完成"
3. "~546 embedding 约 27s" 注释引用补到 `store-memory.ts:113`
4. clowder embedding_meta 改为"key-value 结构存储"
5. 预聚合行号 `:387, 404` → `:387-398, :404-415`

### 第三轮审视（盲点+决策挑战 agent，2026-08-11）

**视角**：前两轮检视"已写的对不对"，第三轮换视角找盲点 + 挑战决策。

#### 找到的盲点（已回写）

**clowder 调研遗漏 3 项**：
1. **Embedding Shadow Mode**（`interfaces.ts:200`）：三态 off/shadow/on，灰度上线能力。新增为 P2-7 候选。
2. **SemanticReranker**：FTS 为主 + vec distance 二次重排，与 RRF 是不同策略。新增为 P2-8 候选。
3. **FTS 一致性对账**（`IndexBuilder.ts:385`）：`checkConsistency()` 检测索引不一致。列入"暂不"（运维层面）。

**otter 自身局限 4 项（前两轮都漏了）**：
1. **暗化条目累积**（`store-memory.ts:60-69` fire-and-forget 失败无补偿）：失败条目永久无 vec 索引，召回一致性静默下降。**已并入 P0-1 范围**。
2. **搜索查询被批量 reindex 阻塞**：`store-memory.ts:113` 的 "~546 embedding 约 27s" 运行时影响是实时搜索延迟堆积。
3. **FTS 一致性对账缺失**：`sync-documents.ts:reconcileSync` 不检查 `memory_entries` vs `memory_fts` 行数一致。
4. **双 FTS 表写入一致性风险**：jieba 抛异常回滚整个事务。

#### 决策错误修正

1. **Signal-Driven Trigger 砍错了**：原理由"mimo 复读"与机制无关（signal 是写入时设位，不是摘要时正则扫描）。**已恢复为 P2-6 候选**。
2. **Federated Retrieval 砍的理由修正**：从"无多项目场景"改为"worktree DB 生命周期短"。
3. **F 文档 P0-2 + P0-3 强耦合**：拆成两个 F 会让"先做的那个独立价值打折"。**已合并为一个 F**（Snippet 质量 + 下钻路径）。
4. **P0-4 worker postMessage 时序方案缺失**：补充三种方案对比，推荐方案 A（复用 `waitForReady`）。

#### P0-1 范围扩展

原 P0-1 只做"路径标记"，第三轮扩展范围：
- 增加 embedding 覆盖率 `vecCoverage` 默认返回（不加 debug 参数也能看到）
- 增加暗化条目扫描接口 `scanDarkEntries()`（让 fire-and-forget 失败可见、可补偿）

避免 P0-1 出现"做完体感没差别"的风险——vecCoverage 默认返回让小獭能自动感知召回完整性。

#### 用户拍板记录（2026-08-11，第三轮）
- **Signal-Driven Trigger**：恢复为 P2 候选 ✅（采纳审视员建议）
- **P0-2 + P0-3 合并**：合并为一个 F ✅（采纳审视员建议）
- **暗化条目**：并入 P0-1 ✅（采纳审视员建议）

### 第四轮审视（大改后整合性核查 agent，2026-08-11）

**视角**：前三轮分段检视(方案/事实/盲点),第四轮换整合视角——大改之后内部是否还自洽?第三轮新增内容是否经得起核查?

#### 内部一致性 — 通过

通读全文,大改后的编号、决策、范围、审视记录四处交叉验证全部对得上,无残留矛盾。

#### 找到的两个必修问题(已修)

1. **SemanticReranker 死代码说成活代码**:第三轮新增 P2-8 时把 SemanticReranker 描述为 clowder 的能力,但**第一轮 agent 早就识别了它是死代码**(`index.ts:52` export 了但全仓库无 import)。第三轮覆盖时没核实。**已修**:第 117 行加注"该组件在 clowder 仓库内已定义但未被 factory 实际 wire 到搜索路径,属于设计意图而非已落地能力"。

2. **方案 A "复用 waitForReady" 不够**:`embedding-service.ts:128-134` 确实有 `waitForReady` 机制,但它等待的 `{ type: "ready" }` 消息(`:36-39`)**不包含模型元信息**。"复用 waitForReady" 实际还要扩展 `EmbedResponse` 类型让 `ready` 附带 meta,或新增 `getMeta` 消息。**已修**:第 194 行方案 A 描述补充协议扩展说明。

#### 验证为正确的关键事实

- ✅ Embedding Shadow Mode `interfaces.ts:200` 三态 + `SqliteEvidenceStore.ts:295` `mode === 'on'` 检查——行号精确
- ✅ `store-memory.ts:60-69` fire-and-forget 无补偿——暗化条目问题真实存在
- ✅ `memory-controller.ts:95` 的 `degraded` 字段先例——行号精确
- ✅ `embedding-service.ts:128-134` `waitForReady` 机制存在——行号精确

#### 三个建议(已采纳)

1. **vec0 anti-join 限制**:P0-1 风险补充,`memory_vec` 是 vec0 虚拟表,LEFT JOIN ... WHERE IS NULL 可能行为异常,建议用 NOT EXISTS 子查询替代。
2. **契约路径**:`src/contract/api/memory.ts` → `api-contract/api/memory.ts`(`@contract/api/memory` alias),避免 F 文档作者按字面路径找不到文件。
3. **P0-4 历史引用括注**:第一轮审视记录的"P0-4"加括注说明第三轮重编为 P0-3。

#### 最终判断

**R 文档作为源头已准备好进入 F 文档阶段。** 两个必修项都是局部文字修正(改 2-3 行),不涉及方案重新设计。三个建议也已采纳。三轮加第四轮的对抗审视构成了完整的决策史,所有事实错误、决策错误、内部不一致都已识别并修正。

---

## 不采纳清单（避免后续反复讨论）

| 项 | 拒绝理由 |
|---|---------|
| 朴素 RRF 替换加权 RRF | otter 的 alpha 加权 + bothBoost 是优势（`search-engine.ts:56-57`） |
| 无时间衰减设计 | otter 的时间衰减对长生命周期记忆有价值（`search-engine.ts:184`） |
| SQLite 是编译产物哲学 | otter 的 F/R 文档本来就是 .md，已在用；对话记忆是真实数据不是文件 |
| Keyword Fallback（补中文） | otter jieba + trigram 双表已覆盖 clowder unicode61 的痛点 |
| Federated Retrieval | **理由修正(第三轮)**:不是"无多项目场景",而是 worktree DB 生命周期短(用完即删),不适合联邦检索 |

> **Signal-Driven Trigger 状态变更**:第一轮以"mimo 复读"为由砍掉,**第三轮审视纠错**:机制理解错误(signal 是消息写入时设位,与 mimo 复读无关)。已恢复为 P2-6 候选。

---

## 下一步

1. **本 R 文档**进入用户最终拍板环节。
2. 拍板后按 F 文档清单逐项创建（共 6 个 F，本次 R+F 一个 PR）。
3. F 文档进入特性流程：方案设计 → 实现 → 验收。

---

## 参考文件

### Otter 仓库
- `src/usecases/memory/search-memory.ts` — 召回主逻辑
- `src/usecases/memory/search-engine.ts` — RRF + 重排
- `src/usecases/memory/memory-repository.ts` — 数据访问接口
- `src/frameworks/db/memory/sqlite-memory-repository.ts` — SQLite 实现
- `src/frameworks/db/schema.ts` — 表结构（幂等初始化，禁止 ALTER）
- `src/entities/memory/memory-entry.ts` — 实体定义
- `docs/README.md` — F/R 文档规范

### Clowder 仓库
- `packages/api/src/domains/memory/SqliteEvidenceStore.ts` — 召回主实现
- `packages/api/src/domains/memory/KnowledgeResolver.ts` — 联邦检索
- `packages/api/src/domains/memory/SummaryCompactionTask.ts` — LSM 摘要
- `packages/api/src/domains/memory/AbstractiveSummaryClient.ts` — Candidate 抽取
- `packages/api/src/domains/memory/IndexBuilder.ts` — 索引构建
- `packages/api/src/domains/memory/schema.ts` — 表结构
- `docs/features/F102-memory-adapter-refactor.md` — 主架构文档
