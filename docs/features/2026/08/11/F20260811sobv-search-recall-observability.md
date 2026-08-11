---
id: F20260811sobv
title: search-recall-observability
doc_type: feature
summary: |
  给记忆召回链路加可观测性：①扩展 RetrievalSource 路径标记(anchor/keyword-fallback/context-expand)；②默认返回 vecCoverage 覆盖率指标；③新增 scanDarkEntries 用例扫描 embedding fire-and-forget 失败导致的暗化条目。
  根因：otter 当前 source 字段仅 fts/vec/both 三态，召回质量出问题时无法诊断"为什么这条排第一"；且 store-memory.ts:60-69 fire-and-forget 无补偿，失败条目永久无 vec 索引，随时间累积导致召回一致性静默下降。
  主机制：路径标记 + 覆盖率 + 暗化扫描三件套，让召回问题从"猜"变成"看"。

causal_links:
  from:
    - R20260811rclo

status: draft
change_type: feature
tags: [memory, retrieval, observability]
modules:
  - src/usecases/memory/search-memory.ts
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/memory-repository.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/interface-adapters/http/controllers/memory-controller.ts
  - api-contract/api/memory.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为。仅扩展 DTO 字段、增加诊断接口，不涉及 prompt/skill/工具选择"
---

# F20260811sobv: 搜索召回可观测性

## 背景与需求

### 问题描述

召回质量出问题时（"为什么这条无关结果排第一"、"为什么这条该出现却没出现"），otter 当前没有任何诊断手段。具体表现：

1. **路径不透明**：`RetrievalResultEntry.source` 字段只标记 `fts/vec/both` 三态（`search-engine.ts:21` 的 `RetrievalSource` 类型）。当未来加入 anchor lookup、keyword fallback、context expand 等新召回路径后，三态不够用，且现有 source 值无法体现"这条结果走了什么路径"。
2. **暗化条目静默累积**：`store-memory.ts:60-69` 的 embedding 存储是 fire-and-forget——`embed().then().catch()` 失败后只 log debug/warn，无重试无补偿。失败条目永久"FTS 可搜 / Vec 不可搜"。同一查询有时返回 `source: both`、有时 `source: fts`，agent 以为搜全了实际没搜全。
3. **诊断信息零暴露**：`ScoredHit`（`search-engine.ts:24-32`）的中间计算结果（`rrfScore`/`timeDecay`/`frequencyBoost`/`multiHitCount`）在 `rerankAndReturn`（`search-memory.ts:313-333`）组装返回值时被丢弃。出问题时无法看到"这条结果是 rrfScore 高还是 timeDecay 拉高了"。

### 根因分析

| # | 根因 | 代码证据 |
|---|------|---------|
| R1 | `RetrievalSource` 类型窄 | `search-engine.ts:21` 只有 `"fts" \| "vec" \| "both"` 三态，没有为未来路径扩展预留 |
| R2 | fire-and-forget 无补偿 | `store-memory.ts:60-69/96-105/135-146` 三处 embed catch 后只 log，没有重试队列或后续扫描 |
| R3 | 中间分值未暴露 | `search-memory.ts:313-333` 的 `rerankAndReturn` 只取 `h.finalScore` 和 `h.source`，丢弃 `rrfScore`/`timeDecay` 等 |
| R4 | 无覆盖率指标 | 当前返回结构只有 `entries`/`total`（`search-memory.ts:49-52`），不告诉调用方"vec 路径有多少条命中" |

### 数据实锤

- `store-memory.ts:60-69` 三个 fire-and-forget 入口都验证过：失败时仅 `logger.debug`（embed 阶段）或 `logger.warn`（storeEmbedding 阶段）
- `memory_vec` 表是 vec0 虚拟表（`schema.ts:188-191`），不会自动同步 `memory_entries` 的删除/插入，事务中途失败会产生孤儿/暗化
- `memory-controller.ts:95` 已有 `degraded` 字段先例（`result.total === 0 && !embeddingGateway.available`），可参照扩展

---

## 方案设计

### 技术方案

**三件套：路径标记 + 覆盖率 + 暗化扫描**

#### 一、扩展 RetrievalSource 路径标记

`search-engine.ts:21` 类型扩展：

```typescript
export type RetrievalSource =
  | "fts" | "vec" | "both"           // 现有三态
  | "anchor"                          // P1-1 Anchor Lookup 短路注入
  | "keyword-fallback"               // 未来 P2-5 候选
  | "context-expand"                 // P1-2 Passage Context Window 邻域补充
  | "related-expand";                // P1-3 Edges 1-hop 图扩展
```

本 F 只新增类型定义，不实际产生 `anchor`/`context-expand` 等值——这些值留给后续 P1 优化点使用。本 F 的目的是把契约先打开，避免后续 P1 PR 时再次改契约。

#### 二、vecCoverage 默认返回

`RetrievalResult` 接口扩展（`search-memory.ts:49-52`）：

```typescript
export interface RetrievalResult {
  entries: RetrievalResultEntry[];
  total: number;
  /** 新增：vec 路径覆盖率（默认返回） */
  vecCoverage: {
    total: number;       // 本次召回结果总数
    withVec: number;     // 其中有 vec 索引的数量
    ratio: number;       // withVec / total，0-1
  };
}
```

`vecCoverage` **默认返回**（不加任何 debug 参数）。理由：值很小（3 个数字），但让 agent 能自动感知"这次召回可能不完整"。如果 `ratio < 1.0`，说明本次结果中有暗化条目——agent 可以主动决策"是否补一次搜索或调用 scanDarkEntries"。

#### 三、debug 中间分值（按需开启）

`SearchQuery` 新增 `debug?: boolean`（默认 false）。开启时 `RetrievalResultEntry` 注入中间分值：

```typescript
export interface RetrievalResultEntry extends MemoryEntry {
  score: number;
  source: RetrievalSource;
  snippet?: string;
  userFlagged?: boolean;
  /** debug=true 时注入 */
  debug?: {
    rrfScore: number;
    timeDecay: number;
    frequencyBoost: number;
    multiHitCount?: number;
  };
}
```

理由：默认关闭避免 token 膨胀。出问题时手动开启用于诊断。

#### 四、scanDarkEntries 用例

新增独立用例，不进 `manage-memory.ts`（参照 R 文档第三轮审视决策）：

```typescript
// src/usecases/memory/scan-dark-entries.ts
export interface DarkEntry {
  entryId: string;
  contentType: string;
  sourceId: string;
  createdAt: string;
}

export class ScanDarkEntries {
  constructor(private readonly repo: MemoryRepository) {}
  async execute(): Promise<{ entries: DarkEntry[]; total: number }> {
    return this.repo.scanDarkEntries();
  }
}
```

`MemoryRepository` 新增接口：

```typescript
scanDarkEntries(): Promise<{ entries: DarkEntry[]; total: number }>;
```

**SQL 实现（vec0 anti-join 限制规避）**：

```sql
-- 不用 LEFT JOIN ... WHERE IS NULL（vec0 虚拟表可能行为异常）
-- 用 NOT EXISTS 子查询
SELECT me.id, me.content_type, me.source_id, me.created_at
FROM memory_entries me
WHERE NOT EXISTS (
  SELECT 1 FROM memory_vec mv WHERE mv.memory_entry_id = me.id
)
ORDER BY me.created_at DESC
LIMIT 1000;
```

**下游链路（明确不在本 F 范围）**：本 F 只做扫描（检测）。补 embed 的修复链路（自动重试队列或运维触发）留 P2-3 Embedding Re-embed 基础设施一起做。本 F 通过 `scanDarkEntries` HTTP 端点暴露清单，供运维或后续修复链路消费。

### 目标

- T1: `RetrievalSource` 类型预留 7 种路径值，契约一次打开
- T2: 每次召回默认返回 `vecCoverage`，让 agent 能感知暗化比例
- T3: `debug=true` 时返回中间分值（rrfScore/timeDecay/frequencyBoost/multiHitCount）
- T4: 新增 `scanDarkEntries` 用例 + HTTP 端点，能列出无 vec 索引的暗化条目

### 成功标准

- 召回结果含 `vecCoverage` 字段，所有现有调用方不破坏
- 暗化条目能被扫描接口返回（用故意造的暗化条目验证）
- debug 模式下中间分值可见

---

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1 路径标记 | 跑现有召回测试，检查返回 entries 的 source 字段 | 仍然是 `fts/vec/both`，无回归 |
| AT-2 | T2 覆盖率 | 制造 5 条记忆，删 2 条 vec 索引模拟暗化，跑召回 | `vecCoverage.ratio = 0.6`（3/5），`withVec: 3, total: 5` |
| AT-3 | T2 默认返回 | 不传 debug 参数，跑召回 | 响应体里默认有 `vecCoverage` 字段 |
| AT-4 | T3 debug 模式 | 传 `debug=true` 跑召回 | entries 含 `debug: { rrfScore, timeDecay, frequencyBoost, multiHitCount? }` |
| AT-5 | T4 暗化扫描 | 制造 3 条暗化条目，调 `GET /api/memory/dark-entries` | 返回 3 条 entryId 列表 |
| AT-6 | T4 vec0 兼容 | 在真实 memory_vec 表上跑 scanDarkEntries SQL | NOT EXISTS 子查询能正确返回结果，不报 vec0 错误 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 ~ AT-6 | n/a（A 类纯代码改动，由单元测试覆盖） |

单测覆盖：
- `tests/usecases/memory/search-memory.test.ts` — vecCoverage 计算逻辑
- `tests/usecases/memory/scan-dark-entries.test.ts` — 暗化扫描用例
- `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` — vec0 anti-join SQL

---

## 实现细节

### 代码修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/usecases/memory/search-engine.ts` | 修改 | 扩展 `RetrievalSource` 类型；`ScoredHit` 已有 `multiHitCount`，无改 |
| `src/usecases/memory/search-memory.ts` | 修改 | `RetrievalResult` 加 `vecCoverage`；`SearchQuery` 加 `debug?`；`rerankAndReturn` 计算覆盖率 + 注入 debug |
| `src/usecases/memory/memory-repository.ts` | 修改 | 新增 `scanDarkEntries()` 接口 |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现 `scanDarkEntries()`，用 NOT EXISTS 子查询 |
| `src/usecases/memory/scan-dark-entries.ts` | 新增 | 独立用例类 |
| `src/bootstrap/memory.ts` | 修改 | 注入 `ScanDarkEntries` 到 DI 容器 |
| `src/bootstrap/usecases.ts` | 修改 | 装配新用例 |
| `src/interface-adapters/http/controllers/memory-controller.ts` | 修改 | 透传 `debug` 参数；透传 `vecCoverage` 到响应；新增 `getDarkEntries` handler |
| `src/interface-adapters/http/routes/memory-routes.ts` | 修改 | 新增 `GET /api/memory/dark-entries` 路由 |
| `api-contract/api/memory.ts` | 修改 | 扩展契约类型：`RetrievalSource` / `RetrievalResult` / `SearchResultDTO` |
| `tests/usecases/memory/scan-dark-entries.test.ts` | 新增 | 用例测试 |
| `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` | 修改 | 加 scanDarkEntries SQL 测试 |

### 逻辑变更

1. **覆盖率计算**（在 `rerankAndReturn` 内）：
   - 遍历 top 结果，查 weightMap 或直接查 repo 拿每条 entry 的 vec 是否存在
   - 优化：批量查 `repo.hasEmbeddings(entryIds)` 一次性获取（避免 N 次查询）
   - 若 `hasVecTable=false`，直接返回 `{ total: N, withVec: 0, ratio: 0 }`

2. **暗化扫描 SQL**：
   - 用 `NOT EXISTS` 子查询而非 `LEFT JOIN ... WHERE IS NULL`，规避 vec0 虚拟表 JOIN 限制
   - LIMIT 1000，防止全表扫描大批数据

### 改动范围

| 范围 | 影响 |
|------|------|
| 契约（api-contract） | 新增可选字段，向后兼容。前端/MCP 客户端不需要立即升级 |
| 数据库 | 不动 schema，纯查询层改动 |
| HTTP API | 新增 `GET /api/memory/dark-entries` 端点；现有 search 端点响应加字段 |
| MCP 工具 | search_memory 工具响应自动透传新字段（无需改工具描述） |

---

## 验收结果

### 测试结果

[实现阶段填写]

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 路径标记 | 待验证 | ❓ |
| T2 覆盖率默认返回 | 待验证 | ❓ |
| T2 暗化比例准确 | 待验证 | ❓ |
| T3 debug 中间分值 | 待验证 | ❓ |
| T4 暗化扫描可用 | 待验证 | ❓ |
| vec0 anti-join 兼容 | 待验证 | ❓ |

---

## 对抗审视记录

完整三轮+第四轮对抗审视见因果上游 R20260811rclo 的"对抗审视记录"章节。本 F 关注的是落地层面：

- **第一轮**：可观测性作为"诊断能力先于优化能力"被识别为 P0（架构师建议）
- **第三轮**：扩展范围含暗化条目扫描 + vecCoverage 默认返回（避免"做完体感没差别"风险）
- **第四轮**：vec0 anti-join 限制补到风险章节，scanDarkEntries 用 NOT EXISTS 子查询实现

## 设计决策

- **vecCoverage 默认返回**（vs 仅 debug 模式）：默认返回让 agent 能自动感知召回完整性。值很小（3 个数字），token 成本可接受。
- **scanDarkEntries 独立用例**（vs 并入 manage-memory）：避免 manage-memory 职责膨胀（参照 R 文档第三轮审视决策）。
- **debug 模式按需开启**（vs 默认开启）：中间分值数量多，token 成本不可忽略，按需开启更稳妥。
- **契约先打开**（vs 用到再改）：本 F 一次性扩展 RetrievalSource 到 7 种值，避免后续 P1 优化点每个都改契约。
