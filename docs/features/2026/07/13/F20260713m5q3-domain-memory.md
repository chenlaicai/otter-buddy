---
id: F20260713m5q3
title: domain-memory
from_ids: [F20260709p4q7, F20260709m2n8, F20260710b3m9, F20260713i5k2]
tags: [implementation, s4, domain, memory, search, fts5, vec0, rrf]
modules: [domain/memory]
doc_kind: spec
status: locked
created_at: 2026-07-13
---

# F20260713m5q3 [domain/memory] 记忆领域模块

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。
>
> 本文档设计 domain/memory 模块。这是 S3-A8 步骤 ⑤ 的实现，也是系统核心模块 -- 混合检索引擎（FTS5 + vec0 + RRF + 权重重排）。依赖 infra/db + infra/embedding。模块自包含，FTS5 立即可用，vec0 在 sqlite-vec 可用时启用。

## 背景 [required]

S3-A8 定义 domain/memory 为"记忆索引 + 检索（自包含，FTS5 立即可用，vec0 待⑨）"。经 D-S3-2 调整后，infra/embedding 已在 infra 层完成（F20260713i5k2），domain/memory 可直接依赖 infra/embedding 的 EmbeddingService，无需等待后续步骤。

S3 数据模型已定义全部表结构（memory_entries, memory_weights, memory_fts, memory_vec），infra/db/schema.ts 已实现 DDL 初始化。本模块实现 MemoryPort 公开接口 + Repository 持久化 + 混合检索引擎。

### 约束输入

- S3-A1 DDL -- memory_entries + memory_weights + memory_fts + memory_vec 表结构
- S3-A2 MemoryRepository 接口 -- store, getById, getBySource, searchFTS, searchVec, rrfFusion, getWeight, updateWeight, incrementRetrievalCount, flagMemory, storeEmbedding, getEmbedding
- S3-A3 三层记忆存储映射 -- 工作记忆(layer='working') / 历史对话记忆(layer='historical') / 对话关键信息(layer='key_info')
- S3-A5 检索索引策略 -- FTS5(BM25) + vec0(KNN) + RRF(k=60) + 权重重排
- S3-A6 权重系统 -- 存储部分(retrieval_count, user_flagged) + 计算部分(time_decay, frequency, task_relevance)
- S3-A8 代码目录结构 -- model.ts + port.ts + _internal/{repository, mapper, adapter, initor}
- D27: FTS5 同步写入，embedding 异步写入
- D24: 统一索引表 memory_entries
- D22: 降级策略 -- embedding 失败时降级为纯 FTS5
- D29: 全局 4 层 + Provider Port + _internal/ 封装 + memory 内部保留拆分 + search-engine 协调器
- F20260710b3m9: infra/base 已完成（db, config, logger）
- F20260713i5k2: infra/embedding 已完成（EmbeddingService）

### 已确认决策

| 项目 | 决策 | 来源 |
|------|------|------|
| 模块结构 | model.ts + port.ts + _internal/{repository, mapper, search-engine, adapter, initor} | S3-A8 D29 + 本文档新增 search-engine.ts |
| MemoryPort 范围 | 11 方法（store, getById, getBySource, search, searchSimilar, updateLayerByConversation, getWeight, incrementRetrievalCount, flagMemory, storeEmbedding, getEmbedding） | 本文档分析 |
| refine() 不在 MemoryPort | app/agent-runtime 组合调用 search() 实现迭代检索 | S3-A2 委托路径 + 本文档分析 |
| expand() 不在 MemoryPort | 需要 ConversationRepository，属 app/orchestration 跨模块 | S3-A2 委托路径 |
| addKeyInfo/linkResource 不在 MemoryPort | 跨模块写操作，属 app/orchestration | S3-A8 跨模块事务编排 |
| updateWeightsByTreePath 不在 MemoryPort | 查询时计算 task_relevance，不更新数据库 | S3-A6 |
| embedding 依赖 | domain/memory 依赖 infra/embedding（domain 依赖 infra 正确） | S3-A7 部署图 + D-S3-2 |
| store() 触发异步 embedding | domain/memory 内部调用 EmbeddingService | D27 + 本文档分析 |
| search-engine.ts 独立文件 | 混合检索算法复杂度高，独立文件分离关注点 | D29 "memory 内部保留拆分 + search-engine 协调器" |
| 权重参数从 config 读取 | rrfK, halfLifeDays, samePathBoost 等从 infra/config 读取 | S3-A6 + config.ts 已定义 |

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | 当前讨论 msg#4676 | 你继续来实现，最新pr完成了infra和otter domain的实现，你继续S3-A8的后续模块实现 | 动作：继续实现；范围：S3-A8 后续模块 | 按依赖顺序继续实现，domain/memory 是下一个 |
| UA-2 | F20260710b3m9 UA-S4-2（引用） | 应该是一个一个模块完整实现，不需要一次性将所有模块都实现 | 粒度：一个一个模块；要求：完整实现 | domain/memory 需完整实现含混合检索 + 权重系统 + 测试 |
| UA-3 | S1 讨论（引用） | 记忆系统仍然是非常核心的一环，要做大做强 | 程度：非常核心；动作：做大做强 | 记忆系统是核心差异化，检索质量必须高 |
| UA-4 | S1 讨论（引用） | 除了自身当前session这部分是各个ai专有的，其余的 所有信息，可能都是通用的、大家都可触及到的 | 专有：当前 session；通用：其余所有 | memory_entries 共享存储，无 Otter 隔离（layer 区分工作/历史） |
| UA-5 | S2 讨论（引用） | 首先，肯定会有sqlite fts5 | 肯定：有 FTS5 | FTS5 是基线检索，必须实现 |
| UA-6 | S2 讨论（引用） | 其次，这还远远不够 | 程度：远远不够 | 必须超越 FTS5，添加向量检索 + RRF + 权重重排 |
| UA-7 | S2 讨论（引用） | 我要的是一个强大的记忆系统 | 程度：强大；对象：记忆系统 | 混合检索 + 权重系统是核心要求 |
| UA-8 | S1 讨论（引用） | 这种结构 要在记忆中也要有所侧重，ai知道当前本对话在某一个节点 | 影响：记忆侧重；感知：知道位置 | S3 必须存储 tree_path 并支持基于路径的权重计算（task_relevance） |

## 目标 [required]

### P1 - domain/memory 模块完整实现

实现 domain/memory 模块，包含：
- 领域模型定义（MemoryEntry, MemoryWeight, SearchQuery, RetrievalResult 及相关值对象）
- MemoryPort 公开接口（11 方法）
- SQLite 持久化（Repository：CRUD + FTS5 查询 + vec0 查询）
- 混合检索引擎（SearchEngine：RRF 融合 + 权重重排）
- 业务逻辑适配器（Adapter：store 触发异步 embedding，search 编排检索流水线）
- 工厂函数（Initor：注入 db + embedding，返回 port）

### P2 - 检索降级容错

- sqlite-vec 不可用时，search() 降级为纯 FTS5 检索（D22）
- embedding 生成失败时，store() 仅写入 FTS5 索引，search() 降级为纯 FTS5
- 检索结果质量不因降级而崩溃（FTS5 是有效基线）

### P3 - 可独立验证

通过集成测试验证：
- store + getById 全流程
- FTS5 关键词检索（中文 trigram 分词）
- vec0 语义检索（需 sqlite-vec 可用）
- RRF 融合正确性
- 权重重排（time_decay, frequency, user_flag, task_relevance）
- searchSimilar 全流程（getEmbedding -> searchVec）
- 权重管理（incrementRetrievalCount, flagMemory）
- layer 变更（updateLayerByConversation）

## 非目标 [required]

- 不实现 refine()（迭代检索由 app/agent-runtime 组合 search() 实现）
- 不实现 expand()（需 ConversationRepository，属 app/orchestration 跨模块）
- 不实现 addKeyInfo() / linkResource()（跨模块写操作，属 app/orchestration）
- 不实现 conversation 模块（步骤 ⑥）
- 不实现 app/orchestration 跨模块事务编排（步骤 ⑨）
- 不实现 app/agent-runtime Agent 工具注册（步骤 ⑩）
- 不修改 infra 已有代码（db, config, logger, embedding, llm-gateway, agent-core）
- 不修改 S3 已锁定的 DDL
- 不实现前端 UI

## 设计 [required]

### 模块范围

```
src/domain/memory/
├── model.ts                 # 公开类型（Entity, Value Object, Input types）
├── port.ts                  # 公开接口（MemoryPort）
└── _internal/               # 私有实现（ESLint 禁止跨模块 import）
    ├── repository.ts        # SQLite 持久化（CRUD + FTS5 + vec0 查询）
    ├── mapper.ts            # 领域对象 <-> DB 行映射
    ├── search-engine.ts     # 混合检索引擎（RRF + 权重重排）
    ├── adapter.ts           # 业务逻辑（实现 MemoryPort）
    └── initor.ts            # 工厂函数

tests/domain/memory/
├── repository.test.ts       # 集成测试（real SQLite :memory:）
├── search-engine.test.ts    # 单元测试（纯算法验证）
└── adapter.test.ts          # 单元测试（mock repository + mock EmbeddingService）
```

---

### 1. model.ts -- 领域模型

```typescript
// ===== 值对象 =====

type MemoryLayer = 'working' | 'historical' | 'key_info';
type MemoryContentType = 'message' | 'conversation_summary' | 'key_fact' | 'linked_resource';
type RetrievalGranularity = 'coarse' | 'fine';
type RetrievalSource = 'fts' | 'vec' | 'both';

// ===== 实体 =====

interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId: string | null;
  treePath: string | null;
  granularity: RetrievalGranularity;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface MemoryWeight {
  memoryEntryId: string;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  userFlagged: boolean;
}

// ===== 输入类型 =====

interface MemoryEntryInput {
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId?: string;
  treePath?: string;
  granularity: RetrievalGranularity;
  content: string;
  metadata?: Record<string, unknown>;
}

interface SearchQuery {
  query: string;
  layer?: MemoryLayer;
  granularity?: RetrievalGranularity;
  conversationId?: string;
  treePath?: string;          // 当前对话树路径，用于 task_relevance 计算
  limit?: number;
}

// ===== 检索结果 =====

interface RetrievalResult {
  entries: MemoryEntry[];
  scores: number[];
  sources: RetrievalSource[];  // 每条结果的检索来源
}

// ===== 内部类型（repository 使用，不暴露到 Port） =====

interface FTSHit {
  memoryEntryId: string;
  bm25Score: number;
  entry: MemoryEntry;
}

interface VecHit {
  memoryEntryId: string;
  distance: number;
  entry: MemoryEntry;
}

interface RrfHit {
  memoryEntryId: string;
  rrfScore: number;
  entry: MemoryEntry;
  source: RetrievalSource;
}

interface ScoredHit {
  memoryEntryId: string;
  finalScore: number;
  entry: MemoryEntry;
  source: RetrievalSource;
}
```

---

### 2. port.ts -- MemoryPort 接口

```typescript
interface MemoryPort {
  // --- Memory Entry CRUD ---

  /** 存储记忆条目。同步写入 memory_entries + memory_fts + memory_weights，异步写入 memory_vec */
  store(entry: MemoryEntryInput): Promise<string>;

  /** 按 ID 查询记忆条目 */
  getById(id: string): Promise<MemoryEntry | null>;

  /** 按来源查询记忆条目 */
  getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null>;

  // --- 混合检索 ---

  /** 混合检索（FTS5 + vec0 + RRF + 权重重排） */
  search(query: SearchQuery): Promise<RetrievalResult>;

  /** 查找相似条目（getEmbedding -> searchVec -> 权重重排） */
  searchSimilar(id: string, limit: number): Promise<RetrievalResult>;

  // --- Layer 管理 ---

  /** 批量更新 layer（Session 归档时 working -> historical） */
  updateLayerByConversation(
    conversationId: string,
    fromLayer: MemoryLayer,
    toLayer: MemoryLayer,
  ): Promise<void>;

  // --- 权重管理 ---

  /** 获取记忆条目权重 */
  getWeight(memoryEntryId: string): Promise<MemoryWeight>;

  /** 递增检索计数 + 更新最后检索时间 */
  incrementRetrievalCount(memoryEntryId: string): Promise<void>;

  /** 用户标记/取消标记记忆 */
  flagMemory(memoryEntryId: string, flagged: boolean): Promise<void>;

  // --- Embedding ---

  /** 存储 embedding 向量到 memory_vec */
  storeEmbedding(memoryEntryId: string, embedding: number[]): Promise<void>;

  /** 获取 embedding 向量 */
  getEmbedding(memoryEntryId: string): Promise<number[] | null>;
}
```

**方法行为说明**：

| 方法 | 同步/异步 | 数据库操作 | Embedding 操作 | 说明 |
|------|----------|-----------|---------------|------|
| store() | 同步 DB + 异步 embedding | INSERT memory_entries + memory_fts + memory_weights（单事务） | 异步 embed(content) -> INSERT memory_vec | D27: FTS5 同步，embedding 异步 |
| getById() | 同步 | SELECT memory_entries | 无 | 纯数据查询 |
| getBySource() | 同步 | SELECT memory_entries WHERE source_table=? AND source_id=? | 无 | 纯数据查询 |
| search() | 异步 | FTS5 MATCH + vec0 KNN（如有） | 异步 embed(query) | D22: embedding 失败降级为纯 FTS5 |
| searchSimilar() | 异步 | SELECT memory_vec -> vec0 KNN | 无（使用已存储的 embedding） | 先 getEmbedding，再 searchVec |
| updateLayerByConversation() | 同步 | UPDATE memory_entries SET layer=? WHERE conversation_id=? AND layer=? | 无 | Session 归档时调用 |
| getWeight() | 同步 | SELECT memory_weights | 无 | 纯数据查询 |
| incrementRetrievalCount() | 同步 | UPDATE memory_weights SET retrieval_count+=1, last_retrieved_at=now | 无 | 检索后调用 |
| flagMemory() | 同步 | UPDATE memory_weights SET user_flagged=? | 无 | 用户标记 |
| storeEmbedding() | 同步 | INSERT OR REPLACE memory_vec | 无 | 由 store() 异步回调调用 |
| getEmbedding() | 同步 | SELECT memory_vec | 无 | searchSimilar 使用 |

**不在 MemoryPort 中的方法及原因**：

| S2 方法 | 不纳入原因 | 实现位置 |
|--------|----------|---------|
| refine(prevSearchId, adjustedQuery) | 需维护搜索状态缓存，是服务层组合 | app/agent-runtime（调用 search() + 自维护状态） |
| expand(id, direction, count) | 需 ConversationRepository.expandMessage()，跨模块 | app/orchestration（MemoryPort.getBySource + ConversationPort.expandMessage） |
| addKeyInfo(conversationId, keyInfo) | 写 key_facts + memory_entries，跨模块 | app/orchestration |
| linkResource(conversationId, resource) | 写 linked_resources + external_resources + memory_entries，跨模块 | app/orchestration |
| updateWeights(treePath) | S3-A6 明确不更新数据库，查询时计算 | SearchQuery.treePath 参数 |

---

### 3. _internal/repository.ts -- SQLite 持久化

```typescript
class MemoryRepository {
  constructor(private db: Database.Database) {}

  // --- Entry CRUD ---
  storeEntry(id: string, entry: MemoryEntryInput): void;  // 单事务: memory_entries + memory_fts + memory_weights
  getById(id: string): MemoryEntry | null;
  getBySource(sourceTable: string, sourceId: string): MemoryEntry | null;
  updateLayerByConversation(conversationId: string, fromLayer: string, toLayer: string): void;

  // --- FTS5 搜索 ---
  searchFTS(query: string, opts: { layer?: string; granularity?: string; conversationId?: string; limit: number }): FTSHit[];

  // --- vec0 搜索 ---
  searchVec(embedding: number[], opts: { layer?: string; granularity?: string; conversationId?: string; limit: number }): VecHit[];
  storeEmbedding(memoryEntryId: string, embedding: number[]): void;
  getEmbedding(memoryEntryId: string): number[] | null;
  hasVecTable(): boolean;  // 检查 memory_vec 是否可用（构造时缓存）

  // --- 权重 ---
  getWeight(memoryEntryId: string): MemoryWeight;
  getWeights(memoryEntryIds: string[]): Map<string, MemoryWeight>;  // 批量查询，避免 N 次 SELECT
  incrementRetrievalCount(memoryEntryId: string): void;
  flagMemory(memoryEntryId: string, flagged: boolean): void;
}
```

**storeEntry 事务边界**：

```typescript
storeEntry(id: string, entry: MemoryEntryInput): void {
  this.db.exec("BEGIN");
  try {
    // 1. INSERT memory_entries
    this.db.prepare(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
        conversation_id, tree_path, granularity, content, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, entry.layer, entry.contentType, entry.sourceId, entry.sourceTable,
      entry.conversationId ?? null, entry.treePath ?? null,
      entry.granularity, entry.content, entry.metadata ? JSON.stringify(entry.metadata) : null);

    // 2. INSERT memory_fts
    this.db.prepare(`
      INSERT INTO memory_fts (memory_entry_id, content)
      VALUES (?, ?)
    `).run(id, entry.content);

    // 3. INSERT memory_weights (默认值)
    this.db.prepare(`
      INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged)
      VALUES (?, 0, NULL, 0)
    `).run(id);

    this.db.exec("COMMIT");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

**FTS5 查询**：

```sql
-- searchFTS: 关键词检索（BM25）
SELECT me.*, fts.rank AS bm25_score
FROM memory_fts fts
JOIN memory_entries me ON fts.memory_entry_id = me.id
WHERE memory_fts MATCH ?
  AND (? IS NULL OR me.layer = ?)
  AND (? IS NULL OR me.granularity = ?)
  AND (? IS NULL OR me.conversation_id = ?)
ORDER BY fts.rank
LIMIT ?;
```

**vec0 查询**：

```sql
-- searchVec: 语义检索（KNN）
SELECT mv.memory_entry_id, mv.distance, me.*
FROM memory_vec mv
JOIN memory_entries me ON mv.memory_entry_id = me.id
WHERE mv.embedding MATCH ?
  AND k = ?
  AND (? IS NULL OR me.layer = ?)
  AND (? IS NULL OR me.granularity = ?)
  AND (? IS NULL OR me.conversation_id = ?)
ORDER BY mv.distance;
```

**hasVecTable 实现**：

```typescript
// 构造时缓存，运行期不变（S10）
private readonly hasVec: boolean;

constructor(db: Database.Database) {
  this.db = db;
  this.hasVec = this.checkVecTable();
}

private checkVecTable(): boolean {
  try {
    this.db.prepare("SELECT 1 FROM memory_vec LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

hasVecTable(): boolean {
  return this.hasVec;
}
```

**getWeights 批量查询**：

```sql
-- getWeights: 批量获取权重
SELECT * FROM memory_weights WHERE memory_entry_id IN (?, ?, ...);
```

```typescript
getWeights(memoryEntryIds: string[]): Map<string, MemoryWeight> {
  if (memoryEntryIds.length === 0) return new Map();
  const placeholders = memoryEntryIds.map(() => '?').join(',');
  const rows = this.db.prepare(
    `SELECT * FROM memory_weights WHERE memory_entry_id IN (${placeholders})`
  ).all(...memoryEntryIds);
  const result = new Map<string, MemoryWeight>();
  for (const row of rows) {
    result.set(row.memory_entry_id, mapRowToWeight(row));
  }
  return result;
}
```

---

### 4. _internal/search-engine.ts -- 混合检索引擎

**职责**：RRF 融合 + 权重重排。纯算法模块，无数据库依赖。

```typescript
class SearchEngine {
  constructor(private config: SearchEngineConfig) {}

  /** RRF 融合（k 值从 config 读取，不由调用方传入） */
  rrfFusion(ftsHits: FTSHit[], vecHits: VecHit[]): Map<string, RrfHit>;

  /** 计算最终权重 */
  computeFinalScore(
    rrfScore: number,
    weight: MemoryWeight,
    entryCreatedAt: string,
    currentTreePath: string | null,
    entryTreePath: string | null,
  ): number;

  /** 重排 */
  rerank(hits: RrfHit[], weights: Map<string, MemoryWeight>, currentTreePath: string | null): ScoredHit[];
}

interface SearchEngineConfig {
  rrfK: number;              // default: 60
  weightHalfLifeDays: number; // default: 7
  samePathBoost: number;      // default: 1.5
  crossPathDecay: number;     // default: 0.8
  userFlagMultiplier: number; // default: 2.0
  frequencyBoostFactor: number; // default: 0.1
}
```

**权重计算公式（S3-A6）**：

```
final_score = rrf_score
  × time_decay_weight          // exp(-ln(2) * age_days / half_life_days)
  × frequency_boost            // log(1 + retrieval_count) * factor + 1
  × task_relevance_weight      // same_path ? samePathBoost : crossPathDecay
  × user_flag_multiplier       // user_flagged ? userFlagMultiplier : 1.0
```

**RRF 融合算法（S3-A5）**：

```typescript
rrfFusion(ftsHits: FTSHit[], vecHits: VecHit[]): Map<string, RrfHit> {
  const k = this.config.rrfK;
  const scores = new Map<string, { score: number; entry: MemoryEntry; source: RetrievalSource }>();

  for (const [rank, hit] of ftsHits.entries()) {
    const existing = scores.get(hit.memoryEntryId);
    const rrfScore = 1 / (k + rank + 1);
    if (existing) {
      existing.score += rrfScore;
      existing.source = 'both';
    } else {
      scores.set(hit.memoryEntryId, { score: rrfScore, entry: hit.entry, source: 'fts' });
    }
  }

  for (const [rank, hit] of vecHits.entries()) {
    const existing = scores.get(hit.memoryEntryId);
    const rrfScore = 1 / (k + rank + 1);
    if (existing) {
      existing.score += rrfScore;
      existing.source = 'both';
    } else {
      scores.set(hit.memoryEntryId, { score: rrfScore, entry: hit.entry, source: 'vec' });
    }
  }

  return scores;
}
```

**task_relevance 计算（S3-A6）**：

```typescript
private computeTaskRelevance(
  entryTreePath: string | null,
  currentTreePath: string | null,
): number {
  if (!entryTreePath || !currentTreePath) return 1.0;  // 无路径上下文时不加成也不衰减
  if (entryTreePath.startsWith(currentTreePath) || currentTreePath.startsWith(entryTreePath)) {
    return this.config.samePathBoost;  // 1.5
  }
  return this.config.crossPathDecay;  // 0.8
}
```

---

### 5. _internal/adapter.ts -- 业务逻辑

```typescript
class MemoryAdapter implements MemoryPort {
  constructor(
    private repo: MemoryRepository,
    private embedding: EmbeddingService,
    private searchEngine: SearchEngine,
  ) {}

  async store(entry: MemoryEntryInput): Promise<string> {
    const id = crypto.randomUUID();

    // 同步: memory_entries + memory_fts + memory_weights（单事务）
    this.repo.storeEntry(id, entry);

    // 异步: embedding -> memory_vec（D27: 不阻塞返回）
    this.embedding.embed(entry.content)
      .then(emb => {
        try {
          this.repo.storeEmbedding(id, Array.from(emb));
        } catch (err) {
          logger.warn(`Failed to store embedding for ${id}: ${err}`);
        }
      })
      .catch(err => {
        // D22 写入侧降级: 该条目仅可通过 FTS5 检索
        logger.warn(`Embedding generation failed for ${id}: ${err}`);
      });

    return id;
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    return this.repo.getById(id);
  }

  async getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null> {
    return this.repo.getBySource(sourceTable, sourceId);
  }

  async search(query: SearchQuery): Promise<RetrievalResult> {
    const limit = query.limit ?? 20;

    // 1. FTS5 搜索（始终可用）
    const ftsHits = this.repo.searchFTS(query.query, {
      layer: query.layer,
      granularity: query.granularity,
      conversationId: query.conversationId,
      limit,
    });

    // 2. vec0 搜索（可能降级）
    let vecHits: VecHit[] = [];
    if (this.repo.hasVecTable()) {
      try {
        const queryEmbedding = await this.embedding.embed(query.query);
        vecHits = this.repo.searchVec(Array.from(queryEmbedding), {
          layer: query.layer,
          granularity: query.granularity,
          conversationId: query.conversationId,
          limit,
        });
      } catch (err) {
        // D22 检索侧降级: 纯 FTS5
        logger.warn(`Embedding search failed, falling back to FTS5 only: ${err}`);
      }
    }

    // 3. RRF 融合（k 值由 SearchEngine 内部 config 提供）
    const rrfHits = this.searchEngine.rrfFusion(ftsHits, vecHits);

    // 4. 批量获取命中条目的权重（避免 N 次 SELECT）
    const hitIds = Array.from(rrfHits.keys());
    const weights = this.repo.getWeights(hitIds);

    // 5. 权重重排
    const scored = this.searchEngine.rerank(rrfHits, weights, query.treePath);

    // 6. 排序 + 截取
    scored.sort((a, b) => b.finalScore - a.finalScore);
    const top = scored.slice(0, limit);

    // 7. 同步递增检索计数（better-sqlite3 同步调用，保证计数一致性）
    for (const hit of top) {
      this.repo.incrementRetrievalCount(hit.memoryEntryId);
    }

    return {
      entries: top.map(h => h.entry),
      scores: top.map(h => h.finalScore),
      sources: top.map(h => h.source),
    };
  }

  async searchSimilar(id: string, limit: number): Promise<RetrievalResult> {
    const embedding = this.repo.getEmbedding(id);
    if (!embedding) {
      return { entries: [], scores: [], sources: [] };
    }

    const vecHits = this.repo.searchVec(embedding, { limit });

    // searchSimilar 仅有 vec 单源，跳过 RRF 直接做权重重排
    // 构造 RrfHit（source='vec'）传入 rerank
    const rrfHits = new Map<string, RrfHit>();
    for (const hit of vecHits) {
      rrfHits.set(hit.memoryEntryId, {
        memoryEntryId: hit.memoryEntryId,
        rrfScore: 1 / (1 + 1),  // 单源时 RRF 退化为 1/(k+rank+1)，但无意义，直接赋常量
        entry: hit.entry,
        source: 'vec',
      });
    }

    const hitIds = Array.from(rrfHits.keys());
    const weights = this.repo.getWeights(hitIds);
    const scored = this.searchEngine.rerank(rrfHits, weights, null);  // searchSimilar 不传 treePath

    scored.sort((a, b) => b.finalScore - a.finalScore);
    const top = scored.slice(0, limit);

    for (const hit of top) {
      this.repo.incrementRetrievalCount(hit.memoryEntryId);
    }

    return {
      entries: top.map(h => h.entry),
      scores: top.map(h => h.finalScore),
      sources: top.map(h => h.source),
    };
  }

  async updateLayerByConversation(
    conversationId: string,
    fromLayer: MemoryLayer,
    toLayer: MemoryLayer,
  ): Promise<void> {
    this.repo.updateLayerByConversation(conversationId, fromLayer, toLayer);
  }

  async getWeight(memoryEntryId: string): Promise<MemoryWeight> {
    return this.repo.getWeight(memoryEntryId);
  }

  async incrementRetrievalCount(memoryEntryId: string): Promise<void> {
    this.repo.incrementRetrievalCount(memoryEntryId);
  }

  async flagMemory(memoryEntryId: string, flagged: boolean): Promise<void> {
    this.repo.flagMemory(memoryEntryId, flagged);
  }

  async storeEmbedding(memoryEntryId: string, embedding: number[]): Promise<void> {
    this.repo.storeEmbedding(memoryEntryId, embedding);
  }

  async getEmbedding(memoryEntryId: string): Promise<number[] | null> {
    return this.repo.getEmbedding(memoryEntryId);
  }
}
```

---

### 6. _internal/mapper.ts -- 映射规则

| DB 列 | 领域字段 | 转换 |
|-------|---------|------|
| id | MemoryEntry.id | 直接映射 |
| layer | MemoryEntry.layer | 直接映射（TEXT -> union type） |
| content_type | MemoryEntry.contentType | snake_case -> camelCase |
| source_id | MemoryEntry.sourceId | snake_case -> camelCase |
| source_table | MemoryEntry.sourceTable | snake_case -> camelCase |
| conversation_id | MemoryEntry.conversationId | 直接映射（NULL -> null） |
| tree_path | MemoryEntry.treePath | 直接映射（NULL -> null） |
| granularity | MemoryEntry.granularity | 直接映射 |
| content | MemoryEntry.content | 直接映射 |
| metadata | MemoryEntry.metadata | JSON.parse / JSON.stringify（TEXT <-> Record） |
| created_at | MemoryEntry.createdAt | snake_case -> camelCase |
| retrieval_count | MemoryWeight.retrievalCount | INTEGER -> number |
| last_retrieved_at | MemoryWeight.lastRetrievedAt | 直接映射（NULL -> null） |
| user_flagged | MemoryWeight.userFlagged | INTEGER 0/1 <-> boolean |

---

### 7. _internal/initor.ts -- 工厂函数

```typescript
function initMemory({
  db,
  embedding,
}: {
  db: Database.Database;
  embedding: EmbeddingService;
}): MemoryPort {
  const repository = new MemoryRepository(db);
  const searchEngine = new SearchEngine({
    rrfK: config.memory.rrfK,
    weightHalfLifeDays: config.memory.weightHalfLifeDays,
    samePathBoost: config.memory.samePathBoost,
    crossPathDecay: config.memory.crossPathDecay,
    userFlagMultiplier: config.memory.userFlagMultiplier,
    frequencyBoostFactor: config.memory.frequencyBoostFactor,
  });
  const adapter = new MemoryAdapter(repository, embedding, searchEngine);
  return adapter;
}
```

---

### 8. main.ts 装配（更新后）

```typescript
// main.ts 伪代码（更新后）
const db = initDatabase();                          // infra/db ✅
const llm = initLLMGateway();                       // infra/llm-gateway ✅
const { agentRegistry } = initAgentCore({ llm });   // infra/agent-core ✅
const embedding = initEmbedding();                  // infra/embedding ✅

const otterPort = initOtter({ db, agentRegistry }); // domain/otter ✅
const memoryPort = initMemory({ db, embedding });   // domain/memory (NEW)

// 待实现
// const conversationPort = initConversation({ db });
// const capabilityPort = initCapability({ db });
// const externalPort = initExternal({ db });
```

## 偏差记录 [required]

### D-Mem-1: MemoryPort 不包含 refine/expand/addKeyInfo/linkResource

**偏差对象**：S2-A8 MemoryService 接口定义（10 方法）

| 项目 | S2 设计 | 本文档设计 |
|------|---------|-----------|
| refine() | MemoryService.refine(prevSearchId, adjustedQuery) | 不在 MemoryPort，app/agent-runtime 组合 |
| expand() | MemoryService.expand(id, direction, count) | 不在 MemoryPort，app/orchestration 跨模块 |
| addKeyInfo() | MemoryService.addKeyInfo(conversationId, keyInfo) | 不在 MemoryPort，app/orchestration 跨模块 |
| linkResource() | MemoryService.linkResource(conversationId, resource) | 不在 MemoryPort，app/orchestration 跨模块 |
| updateWeights() | MemoryService.updateWeights(treePath) | 不在 MemoryPort，查询时计算（S3-A6） |

**依据**：
1. S3-A2 委托路径已明确这些方法需要跨模块协作
2. D29 原则：domain 模块间不互相依赖，跨模块操作在 app/orchestration 编排
3. S3-A6 明确 updateWeights 不更新数据库，查询时计算
4. refine 是服务层组合（缓存上次搜索 + 调整参数 + 重新 search），不是原子操作

**影响**：S2 MemoryService 定义 10 方法，其中 4 个（store, getById, search, searchSimilar）保留在 MemoryPort，6 个移至 app 层。同时从 Repository 层提升 7 个方法到 MemoryPort（getBySource, updateLayerByConversation, getWeight, incrementRetrievalCount, flagMemory, storeEmbedding, getEmbedding）。总计 4 + 7 = 11 方法。跨模块方法推迟到 app/orchestration 和 app/agent-runtime。

### D-Mem-2: search-engine.ts 独立文件

**偏差对象**：S3-A8 模块结构（model.ts + port.ts + _internal/{repository, mapper, adapter, initor}）

| 项目 | S3-A8 设计 | 本文档设计 |
|------|-----------|-----------|
| _internal/ 文件数 | 4（repository, mapper, adapter, initor） | 5（+search-engine.ts） |

**依据**：D29 讨论记录"memory 内部保留拆分 + search-engine 协调器"。混合检索算法（RRF + 权重重排）复杂度高，独立文件分离关注点，使 adapter 聚焦业务编排。

## 硬约束 [required]

- 所有表使用 `CREATE TABLE IF NOT EXISTS`，禁止 ALTER TABLE
- memory_entries + memory_fts + memory_weights 写入必须在单事务内（D27）
- embedding 异步写入，不阻塞 store() 返回（D27）
- embedding 失败时降级为纯 FTS5，不抛出异常（D22）
- 消息存储为 append-only（memory_entries 不 UPDATE content 字段，只 UPDATE layer 字段）
- domain 模块间不互相依赖，跨模块操作在 app/orchestration 编排（D29）
- MemoryPort 是 domain/memory 唯一的公开接口
- ESLint 禁止跨模块 import `_internal/`（main.ts 豁免）
- 权重参数从 config 读取，不硬编码
- search() 必须在 rerank 前批量获取命中条目的 MemoryWeight，权重重排才能生效

## 实现指引

> 以下来自交叉审视 S9-S13，供 development 阶段参考。

### S9: searchSimilar 跳过 RRF

searchSimilar 仅有 vec 单源命中，RRF 融合在单源场景下是无意义的 pass-through。实现时 searchSimilar 应跳过 RRF，直接对 vecHits 做 rerank（权重重排）。但为保持 rerank 接口一致，需将 vecHits 转换为 RrfHit 格式（source='vec'，rrfScore 赋常量）。

**注意**：rrfScore 不应赋相同常量（如 0.5），否则 vec0 距离排序信息完全丢失。应使用 `1 / (this.config.rrfK + rank + 1)` 保留距离排序，使距离更近的条目在 rerank 后仍获得更高 base score。

### S10: hasVecTable 构造时缓存

vec0 表的存在性在运行期不会变化。Repository 构造函数中检测一次并缓存为 `private readonly hasVec: boolean`，避免每次 search() 调用时重复检测。

### S11: store() fire-and-forget embedding 丢失风险

store() 使用 `.then().catch()` 模式异步写入 embedding。如果进程在 promise resolve 前退出，embedding 丢失，该条目仅可通过 FTS5 检索。在桌面单用户场景下风险可控。验收标准中已明确记录此行为。

### S12: hasVecTable 实现方式

使用 `SELECT 1 FROM memory_vec LIMIT 1` 检测表是否可用（而非查询 sqlite_master），因为同时验证了表存在和 sqlite-vec 扩展可用。

### S13: Float32Array vs number[]

EmbeddingService.embed() 返回 `Promise<Float32Array>`。better-sqlite3 + sqlite-vec 直接支持 Float32Array，`Array.from(emb)` 转换为 `number[]` 是不必要的内存拷贝。建议 repository 的 `storeEmbedding` 和 `searchVec` 参数类型使用 `Float32Array`，避免转换开销。MemoryPort 的 `storeEmbedding` 参数类型也相应调整为 `Float32Array`。

**Port 类型统一**：port.ts 中 `storeEmbedding(embedding: number[])` 和 `getEmbedding(): Promise<number[] | null>` 当前使用 `number[]`。如果采用 S13 建议，需将 Port 接口也改为 `Float32Array`，保持 Port 与 Repository 类型一致。

### S14: FTS5 查询安全

searchFTS 使用 `WHERE memory_fts MATCH ?` 传入原始查询字符串。FTS5 支持 AND/OR/NOT/前缀(*)等特殊语法，如果用户搜索内容含这些字符可能产生意外行为。trigram 分词器对中文有所缓解，但混合语言内容仍有风险。建议实现时对查询字符串做转义或使用 phrase query（双引号包装）。

### S15: search 中 incrementRetrievalCount 事务包裹

search() 中 N 条 incrementRetrievalCount 逐条执行，进程崩溃可能导致部分计数更新。建议用 `BEGIN/COMMIT` 包裹 N 条 UPDATE 语句，提升一致性。约束：不改变检索结果的语义，仅保证计数更新的原子性。

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| embedding 依赖注入 | domain/memory 依赖 infra/embedding | app 层注入 embedding | S3-A7 部署图：MemSys 直接调用 Embed；domain 依赖 infra 是正确方向 |
| store() 内部触发异步 embedding | adapter 内部调用 embedding.embed() | 调用方负责生成 embedding | 消费方只需调 store()，不需要关心 embedding 逻辑 |
| refine 不在 MemoryPort | app/agent-runtime 组合 | domain/memory 维护搜索状态 | refine 是服务层组合，不是原子操作；避免在 domain 层维护状态 |
| search-engine.ts 独立 | 5 文件结构 | 4 文件（算法放 adapter） | D29 明确"search-engine 协调器"，算法复杂度独立 |
| 权重查询时计算 | time_decay/frequency/task_relevance 不持久化 | 预计算并存储 | S3-A6 D26：避免定时任务，单用户场景计算开销可忽略 |
| incrementRetrievalCount 同步执行 | search() 内同步更新 | 异步更新 | better-sqlite3 同步调用，无性能影响；保证计数一致性 |
| hasVecTable() 运行时检测 | 查询 memory_vec 表是否可用 | 启动时标记 | 简单直接，构造时缓存一次，运行期不变 |
| memory 归属 domain 而非 infra | domain/memory | 抽取 FTS5+vec0+RRF 到 infra/search-engine | 换域测试：三层记忆模型、权重公式、task_relevance 依赖对话树路径，均为 otter-buddy 特有业务语义；权重重排在检索流水线内部，不可分离（用户确认 msg#4710） |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/domain/memory/model.ts` | 新增 | 领域模型类型定义 |
| `src/domain/memory/port.ts` | 新增 | MemoryPort 接口 |
| `src/domain/memory/_internal/repository.ts` | 新增 | SQLite 持久化 |
| `src/domain/memory/_internal/mapper.ts` | 新增 | 领域对象映射 |
| `src/domain/memory/_internal/search-engine.ts` | 新增 | 混合检索引擎 |
| `src/domain/memory/_internal/adapter.ts` | 新增 | 业务逻辑 |
| `src/domain/memory/_internal/initor.ts` | 新增 | 工厂函数 |
| `tests/domain/memory/repository.test.ts` | 新增 | 集成测试 |
| `tests/domain/memory/search-engine.test.ts` | 新增 | 单元测试（纯算法） |
| `tests/domain/memory/adapter.test.ts` | 新增 | 单元测试（mock） |

## 验证 [required]

### 验收标准

- [ ] `npm run check` 通过（lint + build）
- [ ] `npm run test` 通过
- [ ] store: 同步写入 memory_entries + memory_fts + memory_weights（单事务验证）
- [ ] store: 异步写入 memory_vec（不阻塞返回）
- [ ] store: embedding 失败时不抛出异常（D22 降级）
- [ ] store: 进程退出前未完成异步 embedding 的条目，降级为纯 FTS5 检索（S11）
- [ ] getById: 返回 MemoryEntry 或 null
- [ ] getBySource: 按来源表 + ID 查询
- [ ] search: FTS5 关键词检索可用（中文 trigram）
- [ ] search: vec0 语义检索可用（需 sqlite-vec）
- [ ] search: RRF 融合正确（FTS5+vec0 共同命中时 score 更高）
- [ ] search: 权重重排生效（time_decay, frequency, user_flag, task_relevance）
- [ ] search: embedding 失败时降级为纯 FTS5（D22）
- [ ] search: sqlite-vec 不可用时降级为纯 FTS5
- [ ] searchSimilar: getEmbedding -> searchVec 全流程
- [ ] searchSimilar: 无 embedding 时返回空结果
- [ ] updateLayerByConversation: 批量更新 layer
- [ ] getWeight: 返回默认权重（新条目）
- [ ] incrementRetrievalCount: 计数递增 + 时间更新
- [ ] flagMemory: 标记/取消标记
- [ ] storeEmbedding + getEmbedding: 向量存储和读取
- [ ] 所有 domain/memory 代码不 import domain/conversation/otter/capability/external

### 测试设计

#### tests/domain/memory/repository.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| storeEntry + getById | 创建后可按 ID 查询 |
| storeEntry 事务原子性 | memory_fts 写入失败时 memory_entries 也回滚 |
| storeEntry + getBySource | 按来源表 + ID 查询 |
| storeEntry + searchFTS | FTS5 可检索到刚写入的条目 |
| searchFTS 中文 | trigram 分词对中文有效 |
| searchFTS layer 过滤 | 只返回指定 layer 的结果 |
| searchFTS granularity 过滤 | 只返回指定 granularity 的结果 |
| searchFTS conversationId 过滤 | 只返回指定对话的结果 |
| storeEmbedding + getEmbedding | 向量存储和读取 |
| searchVec KNN | 返回最近邻结果（需 sqlite-vec） |
| searchVec granularity 过滤 | 只返回指定 granularity 的结果（需 sqlite-vec） |
| searchVec conversationId 过滤 | 只返回指定对话的结果（需 sqlite-vec） |
| getWeights 批量查询 | 批量获取多个条目权重，返回 Map |
| getWeight 默认值 | retrieval_count=0, user_flagged=false |
| incrementRetrievalCount | 计数递增 + last_retrieved_at 更新 |
| flagMemory | user_flagged 0->1, 1->0 |
| updateLayerByConversation | 批量 layer 变更 |
| metadata JSON 序列化 | Record <-> JSON TEXT |

#### tests/domain/memory/search-engine.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| rrfFusion 仅 FTS 命中 | source='fts' |
| rrfFusion 仅 vec 命中 | source='vec' |
| rrfFusion 双源命中 | source='both', score 更高 |
| rrfFusion k 参数 | k=60 默认值验证 |
| time_decay 计算 | 7 天半衰期，新条目权重高于旧条目 |
| frequency_boost 计算 | retrieval_count 高的条目权重高 |
| task_relevance 同路径 | samePathBoost=1.5 |
| task_relevance 跨路径 | crossPathDecay=0.8 |
| task_relevance 无路径 | 1.0（不加成不衰减） |
| user_flag_multiplier | flagged=true 时 ×2.0 |
| rerank 综合排序 | 多因子组合后排序正确 |

#### tests/domain/memory/adapter.test.ts

| 测试用例 | 验证点 |
|---------|--------|
| store 调用 repo.storeEntry | mock repo，验证事务写入 |
| store 触发 embedding.embed | mock embedding，验证 embed 被调用 |
| store embedding 失败不抛出 | mock embedding.reject，store 正常返回 |
| store embedding 成功后调 storeEmbedding | mock repo，验证异步写入 |
| search FTS5+vec0 全流程 | mock repo + embedding，验证流水线 |
| search 降级为纯 FTS5 | mock embedding.reject，仅 FTS5 结果 |
| searchSimilar 无 embedding | 返回空结果 |
| searchSimilar 有 embedding | 调用 searchVec + getWeights + rerank |
| search treePath 影响排序 | 同路径条目排在前面 |
| search 获取权重后重排 | mock repo.getWeights 被调用，权重影响排序 |
| search conversationId 过滤 | 只返回指定对话的记忆 |
| incrementRetrievalCount 被调用 | search 后计数递增 |

## 关联 [required]

- **S3 数据模型设计**：[F20260709p4q7](../09/F20260709p4q7-data-model-design.md)
- **S2 能力模块架构设计**：[F20260709m2n8](../09/F20260709m2n8-capability-module-architecture.md)
- **infra/base 基础设施基础层**：[F20260710b3m9](../10/F20260710b3m9-infra-base-foundation.md)
- **infra 层 LLM+Agent+Embedding**：[F20260713i5k2](./F20260713i5k2-infra-llm-agent-embedding.md)
- **domain/otter 设计**：[F20260713o4t8](./F20260713o4t8-domain-otter.md)
- **项目实施计划**：[otter-buddy#5](https://github.com/chenlaicai/otter-buddy/issues/5)

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-Mem-1 | 当存储记忆条目时 | 同步写入 memory_entries + memory_fts + memory_weights，异步生成 embedding 写入 memory_vec | ← UA-2, UA-3 |
| B-Mem-2 | 当 embedding 生成失败时（写入侧） | 记忆条目仅可通过 FTS5 检索，不抛出异常 | ← UA-3（降级不崩溃） |
| B-Mem-3 | 当执行混合检索时 | FTS5(BM25) + vec0(KNN) + RRF 融合 + 权重重排 | ← UA-5, UA-6, UA-7 |
| B-Mem-4 | 当 embedding 生成失败时（检索侧） | 降级为纯 FTS5 检索，返回 FTS5 排序结果 | ← UA-3（降级不崩溃） |
| B-Mem-5 | 当 sqlite-vec 不可用时 | search() 跳过 vec0 搜索，仅返回 FTS5 结果 | ← UA-5（FTS5 基线始终可用） |
| B-Mem-6 | 当记忆被检索时 | retrieval_count 递增，last_retrieved_at 更新 | ← UA-3（做大做强：频率加成） |
| B-Mem-7 | 当用户标记记忆时 | user_flagged=true，后续检索中该条目权重 ×2.0 | 不适用（架构师决策） |
| B-Mem-8 | 当切换对话树节点时 | 检索结果按 tree_path 计算 task_relevance（同路径 ×1.5, 跨路径 ×0.8） | ← UA-8 |
| B-Mem-9 | 当 Session 归档时 | memory_entries.layer 从 'working' 变为 'historical' | ← UA-4（工作记忆转历史） |
| B-Mem-10 | 当查询相似条目时 | 先获取条目 embedding，再执行 vec0 KNN 搜索 | ← UA-6（超越 FTS5） |
| B-Mem-11 | 当新记忆条目创建时 | 权重默认值：retrieval_count=0, user_flagged=false | 不适用（架构师决策） |
| B-Mem-12 | 当记忆条目存在时间越久时 | time_decay 权重指数衰减（7 天半衰期） | ← UA-3 |
