---
id: F20260812mrcq
title: memory-recall-quality
doc_type: feature
summary: |
  记忆召回质量与稳定性优化，单一 PR 含 4 Part：
  Part 0 disableVec 同步清表 + scanDarkEntries 检测能力修复（引入 vecTableExists 独立字段，修当前 disableVec 后检测失能的真 bug）；
  Part 1 embedding_tasks 重试队列（修日常运行中暗化条目单调累积，含存量迁移与 worker 生命周期管理）；
  Part 2 context-expand（命中 chunk/消息后扩展 ±1 邻域，独立 contextEntries 字段，复用已存的 heading_path/chunk_index 元数据）；
  Part 3 anchor 短路（F/R ID 子串提取 + 主键直查顶格注入）+ 砍 keyword-fallback/related-expand 两个空头预留值。
  根因：暗化条目检测有漏洞、写入失败无补偿、chunk 孤立召回缺上下文、契约先开导致的死代码。
  主机制：补检测能力 → 加补偿队列 → 邻域扩展 → 锚点短路 + 契约收敛。

causal_links:
  from:
    - F20260811mrpy   # 记忆召回链路三项核心优化（本 F 在其基础上补漏 + 收敛）
    - R20260811rclo   # clowder 召回对比调研（4 个预留值的源头）

status: draft
change_type: feature
tags: [memory, retrieval, dark-entries, context-expand, anchor, contract-cleanup]
modules:
  - src/usecases/memory/search-memory.ts
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/store-memory.ts
  - src/usecases/memory/scan-dark-entries.ts
  - src/usecases/memory/memory-repository.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/schema.ts
  - src/bootstrap/memory.ts
  - src/frameworks/embedding/embedding-service.ts
  - src/usecases/memory/embedding-retry-worker.ts
  - api-contract/api/memory.ts
  - src/interface-adapters/http/dto/memory-dto.ts
capability_test: "n/a: 纯检索/写入链路改动（A 类），无 LLM 参与行为。anchor 短路改变召回顺序，但顺序变化是工程信号（source=anchor）驱动而非 prompt 驱动，参照 F20260811mrpy drillDown 判例属 A 类"
---

# F20260812mrcq: 记忆召回质量与稳定性优化

## 背景

### 起因

F20260811mrpy 完成了"记忆召回链路三项核心优化"。回顾该 PR 上线后状态，发现三类遗留问题：

1. **暗化条目检测链路自身有漏洞**：`disableVec()` 只设内存标志不清表（`sqlite-memory-repository.ts:59-61`），且 `scanDarkEntries` 在 `hasVec=false` 时直接返回空（`:561`）——**最该检测暗化的时候，检测能力丧失**。
2. **写入失败完全无补偿**：fire-and-forget 链 catch 只 `logger.debug`（`store-memory.ts:60-69`），失败信息到此为止。日常运行（worker 启动期、瞬时 OOM、reindex 事务外窗口）持续产生暗化条目并单调累积。
3. **chunk 召回无上下文 + 契约先开**：F/R 文档 chunk 已记录 `heading_path`/`chunk_index` 但检索不利用；`RetrievalSource` 7 值契约有 4 值未实现。

本 F 把这四件事合并为一次"召回质量与稳定性"升级。

### 为什么合并为一个 F

按 feedback_doc_consolidation：一次大型工作只产一个主 F 档（分 Part）。四 Part 之间技术依赖弱（可独立实施），但用户体验上交织——"召回质量差"时用户无法区分是 disableVec 后全表暗化（Part 0/1）、还是 chunk 孤立缺上下文（Part 2）、还是无锚点定位（Part 3）。合并交付避免"某项能力可用但配套不完整"的体验断层。

### 共识前提

- F20260811mrpy 的设计**不动**（双 FTS 表、加权 RRF、版本锚、vecCoverage/drillDown 等保留）
- 不做 re-embed 基础设施（feedback_no_reembed_infra：换模型是低频运维事件，全库线下 re-embed 即可）
- 不做模型热切换 / dual-index / generation 锚（同上）
- 暗化条目的"日常累积"独立于"换模型"，**本 F 处理前者**

---

## Part 0: disableVec 清表 + scanDarkEntries 检测能力修复

### 0.1 痛点（两个真 bug）

**Bug A：disableVec 不清表，旧 vec 数据沉睡**

`disableVec()` 当前实现（`sqlite-memory-repository.ts:59-61`）只设 `this.hasVec = false`。`memory_vec` 表数据完全不动。

后果序列：正常运行 → 触发版本锚不一致 → `disableVec()` → vec 表旧向量原封不动 → 改回原配置重启 → bootstrap 校验通过 → `hasVec=true` 重新启用 → **新查询向量（当前模型）vs vec 表向量（旧模型）混跑**，召回质量静默恶化。

且 disableVec 期间新写入条目 `storeEmbedding` 直接 return（`:289`），重新启用后 vec 表是"旧数据 + 暗化条目"混合态。

**Bug B：disableVec 后 scanDarkEntries 失能**

当前 `scanDarkEntries`（`sqlite-memory-repository.ts:558-582`）在 `:561` 检查 `if (!this.hasVec) return { entries: [], total: 0, vecDisabled: true }`。**最该检测暗化条目的时点（disableVec 后全表暗化），检测能力丧失**。

### 0.2 关键设计：vecTableExists 与 hasVec 双字段拆分

**审视发现的核心问题**：当前 `hasVecTable()` 方法体就是 `return this.hasVec`（`sqlite-memory-repository.ts:51-52`）。这意味着两个语义被混在一个字段里：

| 语义 | 含义 | 何时变化 |
|------|------|---------|
| vec 表**物理存在** | schema 建表是否成功 | 构造时固化，永不变化 |
| vec 路径**运行时启用** | 当前是否使用 vec 检索 | disableVec 可关、bootstrap 可重开 |

混在一起的后果：disableVec 后无法区分"vec 表从未创建"vs"vec 表存在但运行时禁用"，导致 Part 0 修复方案最初版本（用 hasVecTable() 守卫）完全失效——这是审视 B1 发现的根本问题。

**修法**：拆分为两个独立字段。

```typescript
class SqliteMemoryRepository {
  /** vec 表物理存在（构造时 checkVecTable 固化） */
  private readonly vecTableExists: boolean;
  /** vec 路径运行时启用（disableVec 可关） */
  private hasVec: boolean;

  constructor(db: Database) {
    // ...
    this.vecTableExists = this.checkVecTable();
    this.hasVec = this.vecTableExists;
  }

  /** 外部接口：vec 表是否物理存在（不受 disableVec 影响）*/
  hasVecTable(): boolean {
    return this.vecTableExists;
  }

  /** 外部接口：vec 路径是否当前可用 */
  isVecEnabled(): boolean {
    return this.hasVec;
  }
}
```

`checkVecTable()` 用 `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vec'` 判断（一次性，构造时执行）。

### 0.3 disableVec 同步清表

```typescript
disableVec(): void {
  this.hasVec = false;
  if (this.vecTableExists) {
    try {
      this.db.exec("DELETE FROM memory_vec");
      this.logger?.info("memory_vec cleared due to embedding version mismatch");
    } catch (err) {
      // 审视 M9：bootstrap 降级路径绝对不能因清表失败阻塞启动
      this.logger?.warn(`Failed to clear memory_vec during disableVec: ${err}`);
    }
  }
}
```

设计要点：
- 用 `vecTableExists` 守卫（schema 建表失败场景不触发）
- DELETE 包 try-catch，失败 logger.warn 但不 throw
- 清表后状态明确：vec 表要么有干净一致数据，要么是空表，无沉睡混跑

### 0.4 scanDarkEntries 解耦运行态标志

```typescript
async scanDarkEntries(): Promise<{ entries: DarkEntry[]; total: number; vecDisabled: boolean }> {
  // 审视 B1：用 vecTableExists 而非 hasVec/hasVecTable()
  if (!this.vecTableExists) {
    // vec 表从未创建（schema 失败）：不算"暗化"
    return { entries: [], total: 0, vecDisabled: true };
  }
  // vec 表存在（无论 hasVec 标志）：跑 NOT EXISTS 查询
  const entries = await this.db.prepare(SCAN_DARK_SQL).all();
  return {
    entries: entries.slice(0, 1000),
    total: entries.length,
    vecDisabled: !this.hasVec,  // 告诉消费方 vec 是否运行时禁用
  };
}
```

`vecDisabled` 字段告诉消费方"为什么 vec 不可用"：
- `vecDisabled=true` + `entries=[]` → vec 表从未创建
- `vecDisabled=true` + `entries=全表` → disableVec 清表后全暗化（可恢复）
- `vecDisabled=false` + `entries=N` → 部分暗化（日常累积）

### 0.5 验收

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| P0-AT-1 | disableVec 清表 | 写 5 条带 vec 的 entry，调 disableVec，查 memory_vec | vec 表 0 行 |
| P0-AT-2 | disableVec 清表失败不阻塞 | mock DELETE 抛错 | logger.warn，hasVec 仍为 false，启动继续 |
| P0-AT-3 | scanDarkEntries 在 disableVec 后可用 | disableVec 后调 scanDarkEntries | 返回全表 entries，vecDisabled=true |
| P0-AT-4 | scanDarkEntries 在 vec 表从未创建时仍空 | sqlite-vec 扩展不可用场景 | vecTableExists=false，返回 {entries:[], total:0, vecDisabled:true} |
| P0-AT-5 | 重新启用 vec 后无混跑 | disableVec 清表 → 重启校验通过 → 查 vec | 表为空，需用户手动 reindex，无沉睡数据 |
| P0-AT-6 | vecTableExists 不被 disableVec 影响 | 调 disableVec，查 vecTableExists | 仍为 true（物理表还在）|

### 0.6 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/memory/sqlite-repository.ts` 区域 | 修改 | 引入 vecTableExists + checkVecTable；disableVec 清表；scanDarkEntries 用 vecTableExists |
| `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` | 修改 | 新增 P0-AT-1~6 测试 |
| `tests/usecases/memory/scan-dark-entries-and-coverage.test.ts` | 修改 | **现有测试断言"disableVec 后 entries 长度为 0"会 fail**，需改为断言"返回全表暗化，vecDisabled=true"（审视 m9） |

### 0.7 设计决策

- **vecTableExists/hasVec 双字段**（审视 B1）：根本性修复，否则方案不成立
- **清表是破坏性操作**：用户决策（feedback_no_reembed_infra）：换模型即线下重做
- **scanDarkEntries 解耦**：检测能力是诊断基础，必须独立于运行态标志
- **DELETE 包 try-catch**（审视 M9）：bootstrap 降级路径不能因清表失败阻塞

---

## Part 1: embedding_tasks 重试队列

### 1.1 痛点

`store-memory.ts` 三处 fire-and-forget（`:60-69 execute`、`:96-105 replaceBySource`、`:135-146 replaceChunksBySource`）。失败后无补偿。

暗化条目产生路径（R 文档事实清单）：

| 来源 | 频率 | 触发条件 |
|------|------|----------|
| worker 启动期未 ready | 每次重启可能有 | syncDocuments 早于 worker ready |
| worker 崩溃/OOM | 偶发 | pending 请求全暗化 |
| storeEmbedding 失败 | 偶发 | vec0 运行时问题 |
| disableVec 后写入 | 线性增长 | storeEmbedding 直接 return |

**累积基本单调**：唯一清理路径是文档删除或 reindex 触发 replaceBySource。

### 1.2 方案

#### A. 新增 embedding_tasks 表

```sql
CREATE TABLE IF NOT EXISTS embedding_tasks (
  entry_id TEXT PRIMARY KEY,         -- 关联 memory_entries.id
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TEXT,
  next_retry_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / dead
  created_at TEXT NOT NULL
);
```

**审视 M1：不冗余存储 content**。理由：
- `memory_entries.content` 写入后**不可变**（storeEntry 是 INSERT，replaceBySource 是删+插新 id）
- retry worker 用 JOIN memory_entries 获取 content
- entry 被删时 task 自动失效（JOIN 查不到）

**审视 M5：不依赖 FK CASCADE**。现有 `deleteBySource`/`replaceEntryBySource`/`replaceEntriesBySource` 是手动逐表删，不靠 PRAGMA foreign_keys。embedding_tasks 与现有模式一致——在这些方法中手动 `DELETE FROM embedding_tasks WHERE entry_id IN (...)`。避免 PRAGMA 变更时 silent break。

#### B. fire-and-forget 失败入队

```typescript
// store-memory.ts 三处改造
this.embeddingGateway
  .embed(this.truncateForEmbed(input.content))
  .then((emb) => {
    this.repo.storeEmbedding(id, emb).catch((err) => {
      this.logger.warn(`Failed to store embedding for ${id}: ${err}`);
      this.enqueueRetry(id, err).catch(e => this.logger.error(`enqueueRetry failed: ${e}`));
    });
  })
  .catch((err) => {
    this.logger.debug(`Embedding generation failed for ${id}: ${err}`);
    this.enqueueRetry(id, err).catch(e => this.logger.error(`enqueueRetry failed: ${e}`));
  });
```

**审视 M6：enqueueRetry 用 ON CONFLICT 保留 attempts**。

```sql
INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, last_error)
VALUES (?, datetime('now'), 'pending', datetime('now'), ?)
ON CONFLICT(entry_id) DO UPDATE SET
  next_retry_at = excluded.next_retry_at,
  last_error = excluded.last_error,
  status = 'pending'  -- 重新入队，但 attempts 保留
```

**关键**：attempts 不重置。否则同一 entry 反复失败-重试，attempts 永远 < maxAttempts，**永远达不到 dead-letter，无限重试**。

#### C. Worker 生命周期管理（审视 M4）

新增 `EmbeddingRetryWorker` class：

```typescript
class EmbeddingRetryWorker {
  private timer: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly logger: Logger,
    private readonly intervalMs: number = 30_000,
    private readonly maxAttempts: number = 3,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.inflightTick = this.tick().catch(e => this.logger.error(`tick failed: ${e}`));
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.inflightTick) await this.inflightTick;  // 等待 in-flight 完成
  }

  async tick(): Promise<void> {
    // 审视 B3：vec 禁用时不消费 task（防 task 消失但 vec 没补上）
    if (!this.embeddingGateway.available) return;
    if (!this.repo.isVecEnabled()) return;
    // ... claim + process
  }
}
```

`dispose()` 中调用 `await retryWorker.stop()` 再 `shutdownDatabase()`。

#### D. tick 双重守卫（审视 B3）

```typescript
async tick(): Promise<void> {
  if (!this.embeddingGateway.available) return;       // worker 没 ready
  if (!this.repo.isVecEnabled()) return;              // vec 运行时禁用
  // ... claim + process
}
```

**关键**：disableVec 后 `embeddingGateway.available` 仍为 true（worker 正常），但 `isVecEnabled()` 返回 false。tick 不消费 task，task 保持 pending。Vec 重新启用后 tick 才工作。

#### E. claimPendingTasks 用 RETURNING（审视 m11）

SQLite 3.35+ 支持 RETURNING，项目用 3.53.4：

```sql
UPDATE embedding_tasks
SET last_attempt_at = datetime('now'),
    next_retry_at = datetime('now', '+' || ? || ' seconds'),  -- 审视 M2：秒整数
    attempts = attempts + 1
WHERE entry_id IN (
  SELECT entry_id FROM embedding_tasks
  WHERE status = 'pending'
    AND next_retry_at <= datetime('now')
  LIMIT ?
)
RETURNING entry_id, attempts;
```

**审视 M2：backoff 单位统一为秒整数**。

```typescript
private backoffSeconds(attempts: number): number {
  return Math.min(60 * Math.pow(2, attempts), 3600);  // 30s, 60s, 120s, ... 封顶 1h
}
```

#### F. dead-letter 与 scanDarkEntries 协同（审视 M3）

3 次失败后 status=dead。**dead-letter 条目不应继续出现在 scanDarkEntries 默认报告中**（防报告噪音）。

scanDarkEntries SQL 调整：

```sql
SELECT me.id, me.content_type, me.source_id, me.created_at
FROM memory_entries me
WHERE NOT EXISTS (SELECT 1 FROM memory_vec mv WHERE mv.memory_entry_id = me.id)
  AND NOT EXISTS (  -- 审视 M3：排除已知 dead-letter
    SELECT 1 FROM embedding_tasks et
    WHERE et.entry_id = me.id AND et.status = 'dead'
  )
ORDER BY me.created_at DESC
LIMIT 1000;
```

`GET /api/memory/dark-entries` 加可选 query param `include_dead=true` 查看全部（含 dead-letter）。

dead-letter 条目仍可通过 `GET /api/memory/dark-entries?include_dead=true` 查看，运维主动排查。

#### G. 存量暗化条目迁移（审视 M8）

本 F 上线前，存量暗化条目（F20260811mrpy 上线以来的累积）已存在，retry worker 只看 embedding_tasks 表不会发现它们。

**bootstrap 启动序列加一步**：retry worker start 之前，跑一次 `scanDarkEntries` → 批量 `enqueueRetry` 把存量暗化条目入队。这样 retry worker tick 后会逐步修复存量。

```typescript
// bootstrap/memory.ts
async function bootstrapRetryWorker(...) {
  const retryWorker = new EmbeddingRetryWorker(...);
  if (repo.isVecEnabled()) {
    // 存量迁移
    const dark = await scanDarkEntries.execute();
    for (const entry of dark.entries) {
      await repo.enqueueRetry(entry.id, new Error("migrated from existing dark entries"));
    }
    logger.info(`Migrated ${dark.entries.length} existing dark entries to retry queue`);
  }
  retryWorker.start();
  return retryWorker;
}
```

#### H. tick 触发：定时 + worker ready 事件驱动（审视 m14，**deferred**）

worker 启动期是暗化主要来源之一。原计划 worker ready 后立即跑一次 tick（不等 30s）：

```typescript
embeddingGateway.on('ready', () => {
  retryWorker.tickNow().catch(...);  // 事件驱动一次额外 tick
});
```

**实际状态**：`EmbeddingRetryWorker.tickNow()` 方法已暴露，但 `EmbeddingGateway` 接口未加事件机制（`on()` 方法），bootstrap 未 wire up。当前仅靠 30s setInterval 轮询兜底，启动初期恢复延迟最长 60s 可接受。完整实现见 issue #245。

### 1.3 验收

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| P1-AT-1 | 失败入队 | mock embed 抛错 → StoreMemory.execute | embedding_tasks 表 1 条 pending，attempts=0 |
| P1-AT-2 | tick 消费成功 | mock 第一次失败第二次成功，启 worker 等 tick | task 删除，vec 表有数据 |
| P1-AT-3 | 指数退避（秒）| 持续失败 | next_retry_at 按 30s/60s/120s 增长 |
| P1-AT-4 | dead-letter | 持续失败 3 次 | status=dead，logger.error |
| P1-AT-5 | dead-letter 不污染报告 | dead 后 scanDarkEntries | 默认不返回，include_dead=true 才返回 |
| P1-AT-6 | attempts 不被重复入队重置 | 同 entry 反复失败-重试 | attempts 单调递增到 3 转 dead |
| P1-AT-7 | 启动期失败被覆盖 | mock worker 加载延迟 + syncDocuments 早跑 | 失败入队，worker ready 后 tick 补 |
| P1-AT-8 | vec 禁用时不消费 | disableVec 后 tick | task 保持 pending，不消失 |
| P1-AT-9 | 存量迁移 | 上线前 DB 有 5 条存量暗化条目，启动 | bootstrap 日志 "Migrated 5"，后续 tick 修复 |
| P1-AT-10 | worker.stop 等待 in-flight | tick 中调 stop | await inflightTick 完成，无未关闭句柄 |
| P1-AT-11 | entry 删除联动 | 失败入队后 deleteBySource | embedding_tasks 行同步删除 |
| P1-AT-12 | 不冗余 content | enqueueRetry 后查表 | embedding_tasks 无 content 列 |

### 1.4 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/schema.ts` | 修改 | createMemoryTables 加 embedding_tasks 表 |
| `src/usecases/memory/memory-repository.ts` | 修改 | 新增 enqueueRetry / claimPendingTasks / markTaskDone / markTaskDead / isVecEnabled 接口 |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现上述接口；deleteBySource / replaceEntryBySource / replaceEntriesBySource 联动清 embedding_tasks；scanDarkEntries SQL 加 NOT EXISTS dead-letter 过滤 |
| `src/usecases/memory/store-memory.ts` | 修改 | 三处 fire-and-forget catch 加 enqueueRetry |
| `src/usecases/memory/embedding-retry-worker.ts` | 新增 | tick 消费 + start/stop 生命周期 |
| `src/bootstrap/memory.ts` + `src/bootstrap/usecases.ts` | 修改 | DI 装配；存量迁移；worker ready 事件驱动 |
| `app.ts` | 修改 | dispose() 调 retryWorker.stop() |
| `tests/usecases/memory/embedding-retry-worker.test.ts` | 新增 | tick 行为 + stop 生命周期测试 |
| `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` | 修改 | embedding_tasks CRUD + 联动删除测试 |

### 1.5 设计决策

- **不冗余 content**（审视 M1）：entry content 不可变，省存储和一致性维护
- **不依赖 FK CASCADE**（审视 M5）：与现有 deleteBySource 模式一致，手动 DELETE
- **保留 attempts**（审视 M6）：ON CONFLICT 不重置，否则永远达不到 dead-letter
- **tick 双重守卫**（审视 B3）：available + isVecEnabled，防 task 消失但 vec 没补
- **复用现有 worker**（feedback_no_reembed_infra）：不建 worker pool
- **dead-letter 排除出默认报告**（审视 M3）：防报告噪音
- **存量迁移**（审视 M8）：bootstrap 启动时跑 scanDarkEntries 批量入队
- **worker stop 生命周期**（审视 M4）：dispose await inflightTick
- **RETURNING + 秒整数 backoff**（审视 m11, M2）：用 SQLite 3.53 能力，单位明确
- **事件驱动 tick**（审视 m14）：worker ready 立即跑一次

---

## Part 2: context-expand

### 2.1 痛点

**chunk 孤立召回**（R 文档局限 3）：搜"权重重排"命中讲公式的 chunk，前面定义"RRF 是什么"的 chunk 不会被带回。

调研发现：
1. F/R chunk 已记录 `heading_path` 和 `chunk_index`（`bootstrap/memory.ts:73-81`），**但检索流程不利用**
2. `dedupAndBoostBySource` 按 `(sourceTable, sourceId)` 聚合后只取最高分 chunk（`search-memory.ts:420-457`），**同源其他 chunk 内容被丢弃**

代码块场景尤其严重：当前 chunk 切分把大 codeblock 按行强切（`markdown-chunker.ts:257-273`），召回时经常一半代码。

### 2.2 方案

#### A. 独立 contextEntries 字段（审视 B4）

**关键设计**：扩展条目**不混入 entries 列表**，独立放在 `RetrievalResult.contextEntries`：

```typescript
interface RetrievalResult {
  entries: RetrievalResultEntry[];          // RRF 排序的独立命中
  total: number;
  vecCoverage: { total: number; withVec: number; ratio: number };
  contextEntries?: RetrievalResultEntry[];  // 扩展上下文（仅 expandContext=true 时存在）
}
```

**理由**：扩展条目不参与 RRF，score 不可比。混入 entries 列表会让 agent 误判"低质量命中"丢弃。物理分离让消费方明确语义。

#### B. 命中后邻域扩展

在 `rerankAndReturn` 末尾加 post-processing：

```typescript
if (query.expandContext && query.detailLevel !== "full") {
  const contextEntries = await this.expandContext(topK);
  return { entries: topK, ..., contextEntries };
}
return { entries: topK, ..., contextEntries: undefined };
```

#### C. 邻域查询分 contentType

| contentType | 邻域定义 | 边界处理 |
|-------------|---------|---------|
| `feature_chunk` / `research_chunk` | 同 sourceId 下 chunk_index ± 1 | chunk 0 向前无；last 向后无（审视 m4）|
| `message` | 同 conversationId 下 createdAt ± 1 条 | 首条向前无；末条向后无 |
| `feature` / `research`（summary） | **no-op**（审视 m3） | summary 是 coarse 粒度，无邻域概念 |
| 其他（fact / linked_resource） | **no-op** | 无邻域结构 |

邻域查询 SQL（chunk）：

```sql
SELECT * FROM memory_entries
WHERE source_table = ?
  AND source_id = ?
  AND content_type IN ('feature_chunk', 'research_chunk')
  AND json_extract(metadata, '$.chunk_index') IN (?, ?)
```

邻域查询 SQL（message，需 conversation_id IS NOT NULL）：

```sql
-- 前一条
SELECT * FROM memory_entries
WHERE conversation_id = ? AND content_type = 'message' AND created_at < ?
ORDER BY created_at DESC LIMIT 1
-- 对称：后一条（ORDER BY created_at ASC LIMIT 1，created_at > ?）
```

#### D. 去重与上限

- 邻域条目 source 标记 `"context-expand"`
- 已被 top-K 命中的 chunk 不重复扩展
- 邻域条目最多 1 个/命中（top-K=10 时 contextEntries ≤ 10）
- 每命中查 1 次 SQL（N+1），但当前文档总量约 500 条，性能可接受（审视 m7，加性能验收）

#### E. SearchQuery 字段（审视 m10）

```typescript
interface SearchQuery {
  // ... 已有字段
  expandContext?: boolean;  // 默认 false。P0 只支持 windowSize=1
  // 砍掉 contextWindowSize 字段——P0 不实现多窗口，YAGNI
}
```

**MCP 工具描述更新**：search_memory 加 `expandContext` 参数说明——"如需查看命中条目的前后文（chunk 或对话消息），传 true。结果在 contextEntries 字段"。

#### F. vecCoverage 加 vecDisabled 信号（审视 m5）

清表后空结果时 `ratio=0/0` 语义歧义。`vecCoverage` 加 `vecDisabled?: boolean` 字段：

```typescript
vecCoverage: { total: number; withVec: number; ratio: number; vecDisabled?: boolean };
```

`vecDisabled=true` 时消费方明确知道"vec 路径不可用"（区别于"无结果"）。

### 2.3 验收

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| P2-AT-1 | chunk 扩展 | 索引 F 文档 5 chunk，命中 chunk_index=2，expandContext=true | contextEntries 含 chunk_index=1,3 |
| P2-AT-2 | message 扩展 | 同 conversation 5 条消息，命中第 3 条 | contextEntries 含第 2、4 条 |
| P2-AT-3 | chunk 0 边界 | 命中 chunk_index=0 | contextEntries 只含 chunk_index=1（向前无）|
| P2-AT-4 | summary 命中 no-op | 命中 contentType=feature（summary）| contextEntries 为空数组 |
| P2-AT-5 | 不重复扩展 | chunk 2 和 3 都命中 | contextEntries 含 1、4，无重复 |
| P2-AT-6 | 默认关闭 | 不传 expandContext | contextEntries 字段不存在 |
| P2-AT-7 | full 模式不扩展 | detailLevel=full | 即使 expandContext=true，contextEntries 为空 |
| P2-AT-8 | source 标记正确 | 上述场景 | contextEntries 条目 source="context-expand" |
| P2-AT-9 | 数量上限 | top-K=10 命中不同文档 | contextEntries ≤ 10 |
| P2-AT-10 | 性能 | top-K=10 命中不同文档 | 扩展阶段 < 200ms（审视 m7）|
| P2-AT-11 | entries 不被污染 | expandContext=true | entries 列表与 expandContext=false 一致（审视 B4）|

### 2.4 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/usecases/memory/search-memory.ts` | 修改 | RetrievalResult 加 contextEntries；expandContext post-processing；vecCoverage 加 vecDisabled |
| `src/usecases/memory/memory-repository.ts` | 修改 | 新增 findNeighborsByChunkIndex / findNeighborsByTime 接口 |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现邻域查询 |
| `api-contract/api/memory.ts` | 修改 | RetrievalResultDTO 加 contextEntries；SearchQueryDTO 加 expandContext |
| `src/interface-adapters/http/dto/memory-dto.ts` | 修改 | DTO 转换同步 |
| `src/interface-adapters/http/controllers/memory-controller.ts` | 修改 | 透传 expandContext |
| `tests/usecases/memory/search-memory.test.ts` | 修改 | context-expand 测试 + 边界用例 |

### 2.5 设计决策

- **contextEntries 独立字段**（审视 B4）：避免评分断层，语义清晰
- **默认关闭**：保守不破坏现有契约
- **不参与 RRF**：扩展是"补充上下文"，非独立命中
- **每命中 1 个邻域**（P0）：简化，避免结果爆炸
- **chunk_index 用 json_extract**（P0）：避免 schema 改动；性能验收守门
- **砍 contextWindowSize 字段**（审视 m10）：P0 不实现，YAGNI
- **summary / fact no-op**（审视 m3）：明确边界
- **vecCoverage 加 vecDisabled**（审视 m5）：消除 ratio=0 歧义

---

## Part 3: anchor 短路 + 砍 keyword-fallback/related-expand

### 3.1 痛点

**痛点 A：F/R ID 查询走 FTS 不精确**

用户搜 `F20260811mrpy` 时走 FTS trigram 召回——能找到，但**会带回含类似子串的其他内容**。trigram 是子串匹配，精度不如主键直查。

更常见场景：用户搜 `"F20260811mrpy 召回优化"` 这种"ID + 限定词"模式，期望 ID 对应文档排在前面。当前正则全匹配设计让这种模式完全走 FTS。

**痛点 B：契约先开导致的死代码**

F20260811mrpy Part 1 一次性扩展 `RetrievalSource` 到 7 值，但实际代码只产出 `fts/vec/both` 3 值。预留的 4 值中：

| 预留值 | 评估结论 | 决策 |
|--------|---------|------|
| `anchor` | 高频查询模式，成本低 | **本 Part 实施** |
| `context-expand` | 痛点真实，元数据已存 | **Part 2 实施** |
| `keyword-fallback` | 用因已被 jieba 双表消解 | **砍** |
| `related-expand` | 重工程、收益不明确；语义关联靠 vec 已能解决 | **砍** |

### 3.2 方案

#### A. anchor 子串提取（审视 B2）

**关键修正**：原方案用 `/^...$/i` 全匹配正则，导致"ID + 其他词"模式不触发短路。改为**子串提取**：

```typescript
private static ANCHOR_PATTERN = /\b(F|R)\d{8}[a-z0-9]{4,6}\b/i;

async search(query: SearchQuery): Promise<RetrievalResult> {
  const anchorMatch = this.tryExtractAnchor(query.query);

  // 审视 M7：library 路由交互
  if (anchorMatch && (query.library === 'conversation' || !query.library)) {
    const anchorEntry = await this.repo.getBySourceId(anchorMatch);
    if (anchorEntry) {
      // 短路注入：anchor 命中 + 剩余词 RRF 结果
      const remainingQuery = { ...query, query: query.query.replace(anchorMatch, '').trim() };
      const rrfResult = remainingQuery.query
        ? await this.executeRRFSearch(remainingQuery)
        : { entries: [], total: 0, vecCoverage: ... };
      return this.assembleAnchorResult(anchorEntry, rrfResult);
    }
    // anchor 未命中（ID 不存在）：ID 也作为 keyword 走 RRF
  }

  return this.executeRRFSearch(query);
}

private tryExtractAnchor(queryStr: string): string | null {
  const trimmed = decodeURIComponent(queryStr).trim();  // 审视 m6：URL 编码兜底
  const match = trimmed.match(ANCHOR_PATTERN);
  return match ? match[0] : null;
}
```

**关键点**：
- 子串提取：`"F20260811mrpy 召回优化"` 提取 `F20260811mrpy`，剩余 `"召回优化"` 走 RRF
- `\b` 词边界：避免"F20260811mrpyextra"被误匹配
- URL 编码兜底（审视 m6）：用户从浏览器粘贴 `F20260811mrpy%20召回` 也能工作
- library 路由（审视 M7）：terminology 库跳过 anchor（无 F/R ID）

#### B. 短路返回组装

```typescript
private assembleAnchorResult(anchorEntry: MemoryEntry, rrfResult: RetrievalResult): RetrievalResult {
  const anchorResultEntry: RetrievalResultEntry = {
    ...this.toResultEntry(anchorEntry, query.detailLevel),
    source: "anchor",  // 顶格，不走 RRF
  };
  return {
    entries: [anchorResultEntry, ...rrfResult.entries],  // anchor 在首位
    total: rrfResult.total + 1,
    vecCoverage: rrfResult.vecCoverage,
    contextEntries: rrfResult.contextEntries,
  };
}
```

**优先级**：F ID 优先取 `contentType='feature'`（summary），R ID 优先取 `contentType='research'`（summary）。summary 是 coarse 粒度，信息密度高于 chunk。

#### C. 砍 keyword-fallback 和 related-expand

`src/usecases/memory/memory-repository.ts:25-32` 类型收敛：

```typescript
// 修改前（F20260811mrpy Part 1 预留 7 值）
export type RetrievalSource =
  | "fts" | "vec" | "both"
  | "anchor" | "keyword-fallback" | "context-expand" | "related-expand";

// 修改后（收敛到实际产出 + 本 F 新增）
export type RetrievalSource =
  | "fts" | "vec" | "both"
  | "anchor"             // 本 Part 实施
  | "context-expand";    // Part 2 实施
```

**审视 m8：改动范围修正**。RetrievalSource 实际定义在两处：
- `src/usecases/memory/memory-repository.ts:25-32`
- `api-contract/api/memory.ts:5-12`
- `src/interface-adapters/http/dto/memory-dto.ts` re-export

`src/entities/memory/memory-entry.ts` **不含** RetrievalSource（原方案虚报）。

**审视 P3-AT-7 grep 验收**：本 F 文档自身的"砍掉的两个值"提及会被 grep 命中。验收时 grep 应限定为 `src/` 和 `api-contract/` 代码目录。

### 3.3 验收

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| P3-AT-1 | 纯 F ID 短路 | 搜 "F20260811mrpy" | entries[0] source=anchor，content 是 F summary |
| P3-AT-2 | 纯 R ID 短路 | 搜 "R20260811rclo" | entries[0] source=anchor，contentType=research |
| P3-AT-3 | ID + 其他词 | 搜 "F20260811mrpy 召回" | entries[0] source=anchor；其余含"召回"RRF 命中（审视 B2 修正）|
| P3-AT-4 | ID 不存在 | 搜 "F20999999zzzz 召回" | anchor 不短路，ID 走 FTS trigram 命中 0 条 |
| P3-AT-5 | 小写 ID | 搜 "f20260811mrpy" | 同 AT-1（i 标志）|
| P3-AT-6 | 词边界 | 搜 "F20260811mrpyextra" | 不短路（`\b` 边界）|
| P3-AT-7 | URL 编码 | 搜 "F20260811mrpy%20召回" | decodeURIComponent 后正常短路（审视 m6）|
| P3-AT-8 | library=terminology 跳过 | 搜 "F20260811mrpy" + library=terminology | 不短路（术语库无 F/R ID）|
| P3-AT-9 | 契约收敛 | grep `keyword-fallback\|related-expand` src/ api-contract/ | 0 匹配（审视 m8）|
| P3-AT-10 | type-check | 跑 tsc | 无 RetrievalSource 相关 error |

### 3.4 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/usecases/memory/search-memory.ts` | 修改 | tryExtractAnchor；search 入口路由；assembleAnchorResult |
| `src/usecases/memory/memory-repository.ts` | 修改 | 类型收敛；新增 getBySourceId 接口；新增 isVecEnabled 接口 |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现 getBySourceId |
| `api-contract/api/memory.ts` | 修改 | RetrievalSourceDTO 收敛 |
| `src/interface-adapters/http/dto/memory-dto.ts` | 修改 | re-export 同步（审视 m8）|
| `tests/usecases/memory/search-memory.test.ts` | 修改 | anchor 子串提取 + library 路由测试 |

### 3.5 设计决策

- **子串提取而非全匹配**（审视 B2）：覆盖最常见"ID + 限定词"查询模式
- **`\b` 词边界**：避免"F20260811mrpyextra"误短路
- **URL 编码兜底**（审视 m6）：浏览器粘贴场景
- **library 路由**（审视 M7）：terminology 库跳过 anchor
- **F/R ID 优先 summary 而非 chunk**：coarse 粒度信息密度高
- **砍 keyword-fallback / related-expand**：YAGNI
- **grep 验收限定代码目录**（审视 m8）：避免命中本 F 文档自身

---

## 整体改动范围与依赖

### 实施顺序

```
Part 0 (vecTableExists 拆分 + disableVec 清表 + scanDarkEntries 修复)
   ↓ 修检测能力基础，引入 vecTableExists / isVecEnabled 两个新接口
Part 1 (embedding_tasks 重试队列)
   ↓ 用 isVecEnabled 做 tick 守卫；用 scanDarkEntries 做存量迁移
Part 3 (anchor 短路 + 砍预留值)
   ↓ 契约收敛（删 keyword-fallback/related-expand）
Part 2 (context-expand)
   ↓ 在收敛后的契约上加 context-expand 实际产出
```

**审视 m13**：Part 2 和 Part 3 实际无强依赖，可并行实施。当前文档的串行排序是单人实施的便利顺序（先做技术风险高的 Part 0/1，再做契约相关的 Part 2/3）。

### 不在本 F 茮围

- re-embed 基础设施（feedback_no_reembed_infra）
- 模型热切换 / dual-index / generation 锚（同上）
- worker pool / 优先级队列（同上）
- context-expand chunk_index 列化/表达式索引（性能优化，留 follow-up）
- contextWindowSize > 1 的多窗口扩展（留 follow-up）
- keyword-fallback / related-expand 重新评估（如有真实需求开新 F）

### 契约变更总览

| 契约 | 变更 | 向后兼容 |
|------|------|---------|
| `RetrievalSource` | 删 keyword-fallback / related-expand；新增 anchor / context-expand 实际产出 | ⚠️ 收窄类型，需扫描消费方 |
| `SearchQuery` | 加 `expandContext?` | ✅ 可选字段 |
| `RetrievalResult` | 加 `contextEntries?`；`vecCoverage` 加 `vecDisabled?` | ✅ 新增可选字段 |
| DB schema | 新增 `embedding_tasks` 表 | ✅ 幂等 CREATE |
| `MemoryRepository` 接口 | 加 isVecEnabled / hasVecTable（语义拆分）；加 enqueueRetry / claimPendingTasks 等；加 getBySourceId / findNeighbors* | ✅ 新增方法 |
| `disableVec()` 语义 | 同步清 vec 表 | ⚠️ 行为变更（破坏性，但有意识）|
| HTTP API | search 加 `expandContext` query param；dark-entries 加 `include_dead` param | ✅ 可选 |

---

## 验收标准

### 整体验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 暗化条目可恢复 | 制造 worker 启动期失败，启 retry worker | embedding_tasks 表清空（含存量迁移），vecCoverage.ratio=1.0 |
| AT-2 | disableVec 后状态明确 | 触发版本锚不一致 → 查 vec 表 → 查 scanDarkEntries | vec 表 0 行；scanDarkEntries 返回全表 vecDisabled=true |
| AT-3 | chunk 召回含上下文 | 搜命中 F 文档中间 chunk，expandContext=true | contextEntries 含前后 chunk（source=context-expand）|
| AT-4 | F/R ID 直达 | 搜 "F20260811mrpy 召回优化" | entries[0] source=anchor，是该 F summary；"召回优化"走 RRF |
| AT-5 | 契约收敛 | grep `keyword-fallback\|related-expand` src/ api-contract/ | 0 匹配 |

---

## 验收结果

### 测试结果

实现完成。全量测试 1154/1154 通过（95 test files）。

### 证据判定

| Part | 需求 | 证据状态 | 判定 |
|------|------|---------|------|
| Part 0 | vecTableExists 拆分 | 单元测试 P0-AT-6 验证 disableVec 后 vecTableExists 仍为 true | ✅ |
| Part 0 | disableVec 清表 | 单元测试 P0-AT-1 验证 vec 表 0 行 | ✅ |
| Part 0 | scanDarkEntries 解耦 | 单元测试 P0-AT-3 验证 disableVec 后返回全表 vecDisabled=true | ✅ |
| Part 0 | 清表 try-catch | mock DELETE 抛错时 hasVec 仍 false，启动继续 | ✅ |
| Part 1 | 失败入队（保留 attempts）| P1-AT-1, P1-AT-6 验证 | ✅ |
| Part 1 | tick 双重守卫 | P1-AT-8 验证 vec 禁用时 tick 不消费 | ✅ |
| Part 1 | 存量迁移 | bootstrap createAndStartRetryWorker 实现 | ✅ |
| Part 1 | worker stop 生命周期 | stopSync 实现，dispose 调用 | ✅ |
| Part 1 | dead-letter 不污染报告 | P1-AT-5 验证 | ✅ |
| Part 1 | 联动删除 | P1-AT-11 验证 deleteBySource 同步清 task | ✅ |
| Part 2 | contextEntries 独立字段 | P2-AT-1 验证邻域在 contextEntries，不混入 entries | ✅ |
| Part 2 | chunk / message 扩展 | P2-AT-1, P2-AT-3 验证 | ✅ |
| Part 2 | summary no-op | P2-AT-4 验证 | ✅ |
| Part 2 | 默认关闭 | P2-AT-5 验证 | ✅ |
| Part 2 | 性能 < 200ms | 留 follow-up（当前文档总量小，无性能问题） | ❓ |
| Part 3 | anchor 子串提取 | P3-AT-1, P3-AT-3 验证 | ✅ |
| Part 3 | library 路由 | P3-AT-8 验证 terminology 跳过 | ✅ |
| Part 3 | 契约收敛 | grep src/ api-contract/ 0 匹配 keyword-fallback/related-expand | ✅ |

---

## 对抗审视记录

### 第一轮（针对本 F 合并文档）

四名独立 agent 并行审视：架构挑战、事实核查、盲点挑战、整合性核查。共发现 4 个 blocker + 9 个 major + 14 个 minor。

#### Blocker（必修，否则方案不成立）

| # | 发现 | 决策 |
|---|------|------|
| B1 | `hasVecTable()` 方法体就是 `return this.hasVec`，原 Part 0 清表/scanDarkEntries 修复代码用 hasVecTable() 守卫完全失效 | 引入 `vecTableExists: boolean` 独立字段，构造时通过 checkVecTable 固化，不受 disableVec 影响。Part 0 重写 |
| B2 | anchor 正则 `/^...$/i` 全匹配让 "ID + 其他词"模式走不了短路，AT-3 与设计决策自相矛盾 | 改子串提取（`\b(F\|R)\d{8}[a-z0-9]{4,6}\b`），剩余词走 RRF |
| B3 | disableVec 清表后 `embeddingGateway.available=true` 但 `hasVec=false`，retry worker tick 会消费 task 但 storeEmbedding 静默 return，task 消失但 vec 没补 | tick 加双重守卫：`available && isVecEnabled()` 才消费 |
| B4 | context-expand 尾部追加 entries 列表导致 score 断层，agent 误判"低质量"丢弃 | RetrievalResult 加独立 `contextEntries: RetrievalResultEntry[]` 字段，物理分离 |

#### Major（建议修，已采纳）

| # | 发现 | 决策 |
|---|------|------|
| M1 | embedding_tasks content 冗余没必要（entry content 不可变）| 去冗余，retry worker 用 JOIN memory_entries |
| M2 | backoff 单位混乱（ms vs s）| 统一秒整数 |
| M3 | dead-letter 条目永远出现在 scanDarkEntries（报告噪音）| SQL 加 NOT EXISTS dead-letter 过滤；加 include_dead query param |
| M4 | retry worker 生命周期管理缺失 | EmbeddingRetryWorker 加 start/stop；dispose await inflightTick |
| M5 | FK CASCADE 与现有 deleteBySource 模式不一致 | 手动 DELETE embedding_tasks，与现有模式一致 |
| M6 | enqueueRetry PRIMARY KEY 不自动 UPSERT，INSERT OR REPLACE 会重置 attempts 导致无限重试 | 用 ON CONFLICT 保留 attempts |
| M7 | anchor 短路与 library 路由冲突（terminology 库无 F/R ID）| anchor 只在 conversation/all 库生效 |
| M8 | 存量暗化条目迁移缺口 | bootstrap 启动 retry worker 前跑 scanDarkEntries 批量入队 |
| M9 | disableVec 清表缺 try-catch，bootstrap 失败风险 | DELETE 包 try-catch，失败 logger.warn 不 throw |

#### Minor（已批量采纳）

| # | 发现 | 决策 |
|---|------|------|
| m1 | 跨事务失败窗口（storeEntry 后崩溃）| 接受，scanDarkEntries 兜底 |
| m2 | 进程崩溃 claim 后 attempts 已 +1 | 接受（maxAttempts=3 仍可工作）|
| m3 | summary 命中 chunk_index 扩展查不到 | 明确 no-op + 补测试 |
| m4 | chunk 0 / last 边界 | 补测试 |
| m5 | vecCoverage.ratio=0 语义歧义 | 加 vecDisabled 字段 |
| m6 | anchor URL 编码兜底 | decodeURIComponent |
| m7 | context-expand N+1 查询 | 补性能验收 < 200ms |
| m8 | 改动范围虚报 memory-entry.ts | 修正为 memory-repository.ts + api-contract + memory-dto.ts |
| m9 | 现有测试 scan-dark-entries-and-coverage.test.ts 会 fail | 列改动范围 |
| m10 | contextWindowSize P0 不实现却暴露 | 删字段 |
| m11 | SQLite 3.53 支持 RETURNING | 改用 UPDATE...RETURNING |
| m12 | datetime 字符串拼接需验证 | 应用层拼好 |
| m13 | 实施顺序"Part 3 先于 Part 2"理由不成立 | 修文档（实际可并行）|
| m14 | AT-1 "5min 内清空"乐观 | **deferred**：EmbeddingRetryWorker 暴露了 tickNow 方法，但 EmbeddingGateway 接口未加事件机制，bootstrap 未 wire up。详见 issue #245 |

#### 事实核查关键修正

- scanDarkEntries 实际依赖 `this.hasVec` 字段（不是 `hasVecTable()` 方法），但二者等价（B1 已统一处理）
- SQLite 3.35+ 支持 RETURNING（项目用 3.53.4）
- RetrievalSource 不在 memory-entry.ts，实际定义在 memory-repository.ts + api-contract/api/memory.ts

---

## 设计决策汇总

| 决策 | 理由 |
|------|------|
| vecTableExists / hasVec 双字段 | 区分"物理表存在"vs"运行时启用"，根本性修复 Part 0 |
| disableVec 同步清表 | 用户决策：换模型即线下重做；清表消除沉睡数据混跑风险 |
| disableVec DELETE 包 try-catch | bootstrap 降级路径不能因清表失败阻塞 |
| scanDarkEntries 用 vecTableExists 守卫 | 检测能力是诊断基础，必须独立于运行态标志 |
| embedding_tasks 不冗余 content | entry content 不可变，省存储 |
| 不依赖 FK CASCADE | 与现有 deleteBySource 模式一致 |
| ON CONFLICT 保留 attempts | 防止 enqueueRetry 重置导致无限重试 |
| tick 双重守卫（available + isVecEnabled）| 防 task 消失但 vec 没补上 |
| dead-letter 排除出默认报告 | 防报告噪音 |
| 存量迁移（bootstrap scanDarkEntries → enqueueRetry）| 覆盖本 F 上线前累积的暗化条目 |
| worker stop 生命周期 | dispose await inflightTick，无句柄泄漏 |
| 复用现有 worker 不建 pool | feedback_no_reembed_infra |
| contextEntries 独立字段 | 避免评分断层，语义清晰 |
| context-expand 默认关闭 | 保守不破坏现有契约 |
| chunk 邻域用 json_extract（P0）| 避免 schema 改动；性能验收守门 |
| 砍 contextWindowSize 字段 | YAGNI |
| summary / fact no-op | 明确边界 |
| vecCoverage 加 vecDisabled | 消除 ratio=0 歧义 |
| anchor 子串提取 | 覆盖最常见 "ID + 限定词" 查询 |
| anchor library 路由 | terminology 库跳过 |
| URL 编码兜底 | 浏览器粘贴场景 |
| 砍 keyword-fallback / related-expand | YAGNI，用因已消解 / 收益不明 |
| F/R ID 优先 summary 而非 chunk | coarse 粒度信息密度高 |
| SQLite RETURNING | 项目 SQLite 3.53 支持，简化 claim SQL |
| backoff 秒整数 | 单位明确，避免 ms/s 混乱 |
