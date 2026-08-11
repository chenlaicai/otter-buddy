---
id: F20260811mrop
title: memory-recall-optimization
doc_type: feature
summary: |
  对记忆召回链路做三项核心优化，合起来构成"记忆模型 v2"升级：
  Part 1 搜索可观测性（路径标记扩展 + vecCoverage 默认返回 + 暗化条目扫描），让召回问题从"猜"变成"看"；
  Part 2 Snippet 质量 + 下钻路径（应用层后处理高亮 + drillDown hint），让 agent 看到匹配证据且知道如何拿全文；
  Part 3 Embedding 版本锚（meta 表 + bootstrap 校验 + 协议扩展 + 降级告警），消除模型切换的静默失败风险。
  根因：召回链路缺诊断手段、snippet 不含匹配词、embedding 切换会静默变差。三者共同构成召回层"可观测+精确+安全"基础。
  完整四轮对抗审视见 R20260811rclo。

causal_links:
  from:
    - R20260811rclo

status: draft
change_type: feature
tags: [memory, retrieval, observability, snippet, embedding, safety]
modules:
  - src/usecases/memory/search-memory.ts
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/memory-repository.ts
  - src/usecases/memory/scan-dark-entries.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/usecases/memory/embedding-gateway.ts
  - src/frameworks/embedding/embedding-service.ts
  - src/frameworks/embedding/bge-m3-worker.ts
  - src/frameworks/db/schema.ts
  - src/bootstrap/memory.ts
  - src/interface-adapters/http/controllers/memory-controller.ts
  - src/entities/memory/memory-entry.ts
  - api-contract/api/memory.ts
capability_test: "n/a: 纯契约/数据/启动校验层改动（A 类），无 LLM 参与行为。drillDown hint 是字段提示，agent 是否调用工具不强制——属于信息驱动而非 prompt 驱动"
---

# F20260811mrop: 记忆召回链路三项核心优化

## 背景

### 起因

调研 clowder-ai 项目的记忆召回机制后（完整对比与四轮对抗审视见 R20260811rclo），识别出 otter 召回链路相对薄弱的三个方向：**可观测性、精确度、安全降级**。本 F 把这三件事合并为一次"记忆模型升级"——它们之间不是独立的特性，而是支撑召回层稳定可用的三块基石。

### 为什么合并为一个 F

| Part | 单独做的后果 |
|------|-------------|
| Part 1（可观测性） | 没 Part 3 的暗化条目检测，可观测性看不到 vec 索引缺失这个最大盲点 |
| Part 2（Snippet+下钻） | 没 Part 1 的路径标记，agent 拿到 snippet 后不知道走了什么召回路径 |
| Part 3（版本锚） | 没 Part 1 的 vecCoverage 默认返回，降级状态无法被 agent 在召回响应中直接感知 |

三者构成"诊断→展示→安全"的完整链路。分三个 F 等于把一次升级拆成三个互不完整的碎片。

### 共识前提

- otter 现有的精致设计（时间衰减/频率加权/用户标记/加权 RRF）**不动**，本 F 只补短板
- 不做 re-embed 基础设施（worker 单线程串行，留 P2-3 专项）
- 不做 P1 的 Anchor Lookup / Passage Context Window / Edges 1-hop 图（留后续 PR）

---

## Part 1: 搜索召回可观测性

### 1.1 痛点

1. **路径不透明**：`RetrievalSource`（`search-engine.ts:21`）只有 `fts/vec/both` 三态，无法体现"这条结果走了什么路径"。未来加 anchor lookup、context expand 等新路径后三态不够用。
2. **暗化条目静默累积**：`store-memory.ts:60-69` 的 embedding 存储是 fire-and-forget，失败后无补偿。失败条目永久"FTS 可搜 / Vec 不可搜"，随时间累积。同一查询有时 `source: both`、有时 `source: fts`，agent 以为搜全了实际没搜全。
3. **诊断信息零暴露**：`ScoredHit`（`search-engine.ts:24-32`）的中间计算结果（`rrfScore/timeDecay/frequencyBoost/multiHitCount`）在 `rerankAndReturn`（`search-memory.ts:313-333`）组装返回值时被丢弃。

### 1.2 方案

#### A. 扩展 RetrievalSource 路径标记

`search-engine.ts:21` 类型扩展（本 F 只打开契约，anchor/context-expand 等值留给后续 P1 PR 用）：

```typescript
export type RetrievalSource =
  | "fts" | "vec" | "both"           // 现有三态
  | "anchor"                          // 留 P1-1 Anchor Lookup 用
  | "keyword-fallback"               // 留 P2-5 候选
  | "context-expand"                 // 留 P1-2 Passage Context Window
  | "related-expand";                // 留 P1-3 Edges 1-hop
```

#### B. vecCoverage 默认返回

`RetrievalResult`（`search-memory.ts:49-52`）扩展：

```typescript
export interface RetrievalResult {
  entries: RetrievalResultEntry[];
  total: number;
  vecCoverage: { total: number; withVec: number; ratio: number };
}
```

**默认返回**（不加任何 debug 参数）。值很小但让 agent 能自动感知"这次召回可能不完整"——`ratio < 1.0` 说明有暗化条目。

#### C. debug 中间分值（按需开启）

`SearchQuery` 加 `debug?: boolean`（默认 false）。开启时 `RetrievalResultEntry.debug` 注入 `{ rrfScore, timeDecay, frequencyBoost, multiHitCount? }`。默认关闭避免 token 膨胀。

#### D. scanDarkEntries 用例（暗化条目扫描）

新增独立用例，不进 `manage-memory.ts`：

```typescript
// src/usecases/memory/scan-dark-entries.ts
export class ScanDarkEntries {
  constructor(private readonly repo: MemoryRepository) {}
  async execute(): Promise<{ entries: DarkEntry[]; total: number }> {
    return this.repo.scanDarkEntries();
  }
}
```

**vec0 anti-join 限制规避**（第四轮审视补充）：用 `NOT EXISTS` 子查询而非 `LEFT JOIN ... WHERE IS NULL`：

```sql
SELECT me.id, me.content_type, me.source_id, me.created_at
FROM memory_entries me
WHERE NOT EXISTS (
  SELECT 1 FROM memory_vec mv WHERE mv.memory_entry_id = me.id
)
ORDER BY me.created_at DESC
LIMIT 1000;
```

**下游链路**：本 F 只做扫描（检测）。补 embed 的修复链路（自动重试或运维触发）留 P2-3。

### 1.3 验收

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| P1-AT-1 | 路径标记 | 跑现有召回测试 | source 仍为 `fts/vec/both`，无回归 |
| P1-AT-2 | 覆盖率默认返回 | 不传 debug 跑召回 | 响应体含 `vecCoverage` |
| P1-AT-3 | 暗化比例准确 | 制造 5 条记忆删 2 条 vec | `vecCoverage.ratio = 0.6`（3/5） |
| P1-AT-4 | debug 模式 | 传 `debug=true` | entries 含 `debug: { rrfScore, timeDecay, ... }` |
| P1-AT-5 | 暗化扫描 | 制造 3 条暗化条目调端点 | 返回 3 条 entryId |
| P1-AT-6 | vec0 兼容 | 真实 memory_vec 跑 SQL | NOT EXISTS 不报错 |

### 1.4 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/usecases/memory/search-engine.ts` | 修改 | 扩展 `RetrievalSource` 类型 |
| `src/usecases/memory/search-memory.ts` | 修改 | `RetrievalResult` 加 `vecCoverage`；`SearchQuery` 加 `debug?`；`rerankAndReturn` 计算覆盖率 + 注入 debug |
| `src/usecases/memory/memory-repository.ts` | 修改 | 新增 `scanDarkEntries()` 接口 |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现 `scanDarkEntries()`（NOT EXISTS 子查询） |
| `src/usecases/memory/scan-dark-entries.ts` | 新增 | 独立用例 |
| `src/bootstrap/memory.ts` + `src/bootstrap/usecases.ts` | 修改 | DI 装配 |
| `src/interface-adapters/http/controllers/memory-controller.ts` | 修改 | 透传 `debug`/`vecCoverage`；新增 `getDarkEntries` handler |
| `src/interface-adapters/http/routes/memory-routes.ts` | 修改 | 新增 `GET /api/memory/dark-entries` |
| `api-contract/api/memory.ts` | 修改 | 扩展契约类型 |
| `tests/usecases/memory/scan-dark-entries.test.ts` | 新增 | 用例测试 |
| `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` | 修改 | scanDarkEntries SQL 测试 |

### 1.5 设计决策

- **vecCoverage 默认返回**（vs 仅 debug）：让 agent 自动感知召回完整性。3 个数字 token 成本可忽略。
- **scanDarkEntries 独立用例**（vs 并入 manage-memory）：避免 manage-memory 职责膨胀。
- **契约先打开**：本 F 一次性扩展 RetrievalSource 到 7 种值，避免后续 P1 每个都改契约。
- **debug 按需开启**：中间分值数量多，token 成本不可忽略。

---

## Part 2: Snippet 质量 + 下钻路径

### 2.1 痛点

1. **snippet 不含匹配词**：`searchFTSWithHighlight`（`sqlite-memory-repository.ts:366-407`）实际返回 `row.content` 全文（`:399`）。注释（`:367`）说明有意设计"避免分词碎片化"，但代价是 agent 在 snippet 模式下看不到匹配证据。
2. **无下钻 hint**：`RetrievalResultEntry`（`search-memory.ts:40-47`）没有"提示调用方下一步该用什么工具"的字段。agent 看到有用 snippet 后不知道用什么工具拿全文。

### 2.2 方案

#### A. 应用层后处理高亮

`tokenizeQuery(query)` 已返回 jieba 分词后的 token 数组。在 `searchFTSWithHighlight` 拿到 FTS 命中后，**用 token 数组在 content 里 indexOf 定位匹配位置，截取窗口（前后各 100 字符）作为 snippet**：

```typescript
private extractSnippet(content: string, tokens: string[], windowSize = 100): string {
  if (!content) return '';
  let firstMatchPos = -1;
  for (const token of tokens.slice(0, 10)) {  // 限制扫描 token 数防 O(n²)
    const idx = content.indexOf(token);
    if (idx >= 0) { firstMatchPos = idx; break; }
  }
  if (firstMatchPos < 0) return content.slice(0, 200);  // fallback
  const start = Math.max(0, firstMatchPos - windowSize);
  const end = Math.min(content.length, firstMatchPos + windowSize);
  return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
}
```

**性能保护**：`tokens.slice(0, 10)` 限制扫描 token 数。`indexOf` 不需正则转义（token 是 jieba 分词结果，本质是子串匹配）。

**替代方案对比**（不采纳）：
- 走 trigram 表的 FTS5 `highlight()`：双表 join 复杂度高，trigram 分词粒度与 jieba 不一致导致 highlight 错位
- 改 jieba 表为 trigram：丢失中文分词能力

#### B. Drill-Down Hint

`RetrievalResultEntry` 新增 `drillDown?: { tool: string; params: Record<string, unknown> }`。

填充策略（在 `search-memory.ts:rerankAndReturn`）：

```typescript
const drillDown = detailLevel !== "full" ? {
  tool: "get_memory_detail",
  params: { id: h.entryId },
} : undefined;
```

**MCP 工具描述更新**（`search_memory`）：

> 返回结果含 `drillDown` 字段时，表示当前 snippet/summary 不完整。如果想看完整内容，调用 `drillDown.tool` 工具，传入 `drillDown.params`。

### 2.3 验收

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| P2-AT-1 | snippet 含匹配 | 索引文本搜其中一个词 | snippet 包含该词，~200 字符，前后有 `...` |
| P2-AT-2 | fallback 行为 | 搜 jieba 分不出的词 | 返回前 200 字符，不报错 |
| P2-AT-3 | 性能保护 | 100 个 token 的查询 | 只扫前 10 个，响应 < 100ms |
| P2-AT-4 | drillDown 填充 | detail_level=snippet 调 search | 每个 entry 含 `drillDown: { tool, params }` |
| P2-AT-5 | full 模式不填 | detail_level=full | entries 不含 drillDown |
| P2-AT-6 | 向后兼容 | 用旧客户端调 search | 旧客户端正常忽略 drillDown |

### 2.4 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 重写 `searchFTSWithHighlight`（`:366-407`），新增 `extractSnippet` |
| `src/usecases/memory/search-memory.ts` | 修改 | `RetrievalResultEntry` 加 `drillDown?`；`rerankAndReturn` 按 detail_level 填充 |
| `src/entities/memory/memory-entry.ts` | 修改 | 加 `DrillDownHint` 类型 |
| `api-contract/api/memory.ts` | 修改 | 扩展 `MemoryEntryDTO` 加 `drillDown?`（通过 `@contract/api/memory` alias 引用） |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` 或对应工具定义 | 修改 | 更新 `search_memory` 工具描述 |
| `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` | 修改 | extractSnippet 测试 |
| `tests/usecases/memory/search-memory.test.ts` | 修改 | drillDown 填充测试 |

### 2.5 设计决策

- **应用层后处理高亮**（vs FTS5 highlight 函数）：jieba 表不支持 FTS5 内置 highlight，唯一可行路径。
- **indexOf 而非正则**：不需转义特殊字符，更快更安全。
- **drillDown.tool 统一为 get_memory_detail**（vs 按 library 区分）：P0 阶段先简单，避免过度设计。
- **full 模式不填 drillDown**：full 已是完整内容，下钻没意义。

---

## Part 3: Embedding 版本锚

### 3.1 痛点

otter 当前 embedding 配置硬编码（`embedding-service.ts:178-182` 的 `Xenova/bge-m3` + `schema.ts:188-191` 的 `FLOAT[1024]`）。**未来切换模型时，旧向量与新查询混跑，召回质量静默变差**——这是定时炸弹。

### 3.2 方案

采用 R 文档方案 A（推荐）+ 协议扩展（第四轮审视补充）。

#### A. 新增 embedding_meta 表

`schema.ts` 的 `createMemoryTables` 内新增（key-value 结构，参照 clowder `schema.ts:72-77`）：

```sql
CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

key-value 而非独立列——otter schema 禁止 ALTER TABLE，key-value 更灵活。

#### B. 扩展 EmbeddingGateway 接口

```typescript
export interface EmbedModelMeta {
  modelId: string;
  modelRev: string;
  dim: number;
}

export interface EmbeddingGateway {
  readonly available: boolean;
  embed(text: string): Promise<Float32Array>;
  /** 新增：worker ready 后才可用 */
  getMeta?(): Promise<EmbedModelMeta>;
}
```

`getMeta?` 设为可选——避免破坏现有 mock 实现。

#### C. 扩展 worker 协议（关键改动）

当前 `EmbedResponse.ready`（`embedding-service.ts:36-39`）不携带 meta。**必须扩展**：

```typescript
type EmbedResponse =
  | { type: "ready"; meta: EmbedModelMeta }   // 附带 meta
  | { type: "result"; embedding: Float32Array; id: number }
  | { type: "error"; error: string; id: number };
```

`setupHandlers` 的 ready handler（`:71-77`）改造：缓存 `msg.meta` 到 `this.cachedMeta`。

新增 `getMeta()` 实现：

```typescript
async getMeta(): Promise<EmbedModelMeta> {
  if (!this.readyState.ready) await this.waitForReady();
  if (!this.cachedMeta) throw new Error("Worker ready but meta missing");
  return this.cachedMeta;
}
```

#### D. worker 端发送 meta

`bge-m3-worker.ts` 加载完模型后 postMessage 时附带 meta。**dim 必须从实际加载的 ONNX session 读取**（不能从配置硬编码），否则校验没意义：

```javascript
parentPort.postMessage({
  type: "ready",
  meta: {
    modelId: ...,           // 从 workerData 或 model.config
    modelRev: ...,          // revision
    dim: model.config.dim,  // 从实际加载的模型读取
  },
});
```

#### E. bootstrap 校验

`bootstrap/memory.ts` 新增 `verifyEmbeddingVersion`：

```typescript
async function verifyEmbeddingVersion(...): Promise<boolean> {
  if (!embeddingGateway.available) return true;
  const meta = await embeddingGateway.getMeta();
  const stored = await repo.getEmbeddingMeta();
  if (!stored.modelId) {
    await repo.setEmbeddingMeta(meta);  // 初次基线
    return true;
  }
  if (stored.modelId !== meta.modelId ||
      stored.modelRev !== meta.modelRev ||
      stored.dim !== meta.dim) {
    logger.error("Embedding version mismatch, degrading", { stored, current: meta });
    await otterContextRepo.set("embedding_degraded", JSON.stringify({
      reason: "version_mismatch", stored, current: meta,
      detectedAt: new Date().toISOString(),
    }));
    return false;  // 禁用 vec
  }
  return true;
}
```

#### F. re-embed 范围控制（不做）

本 F 不做 re-embed。理由：worker 单线程串行（500 条几分钟），批量 embed 接口/任务调度器/进度跟踪都不存在。本 F 只做**检测 + 降级 + 告警**。降级后用户可手动重建库。

### 3.3 验收

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| P3-AT-1 | 表存在 | 启动后查 sqlite_master | `embedding_meta` 表存在 |
| P3-AT-2 | getMeta 可用 | worker ready 后调 getMeta | 返回 `{ modelId, modelRev, dim }`，dim=1024 |
| P3-AT-3 | worker 协议 | 看 worker postMessage | ready 消息附带 meta |
| P3-AT-4 | 初次基线 | 全新 DB 启动 | embedding_meta 写入 3 个 key |
| P3-AT-5 | 不一致降级 | 改 schema 维度重启 | 日志 error；`otter_context.embedding_degraded` 写入；召回变 FTS-only |
| P3-AT-6 | 降级召回可用 | 降级状态调 search | 正常（FTS-only），`vecCoverage.withVec: 0` |
| P3-AT-7 | 一致不降级 | 不改配置重启 | 正常启动 |

### 3.4 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/schema.ts` | 修改 | `createMemoryTables` 加 `embedding_meta` 表 |
| `src/usecases/memory/memory-repository.ts` | 修改 | 新增 `getEmbeddingMeta()` / `setEmbeddingMeta()` |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现 getEmbeddingMeta/setEmbeddingMeta |
| `src/usecases/memory/embedding-gateway.ts` | 修改 | 加 `EmbedModelMeta` 类型；接口加可选 `getMeta?()` |
| `src/frameworks/embedding/embedding-service.ts` | 修改 | `EmbedResponse.ready` 携带 meta；`setupHandlers` 缓存；新增 `getMeta()` |
| `src/frameworks/embedding/bge-m3-worker.ts` | 修改 | postMessage 附带 meta（dim 从实际加载模型读取） |
| `src/bootstrap/memory.ts` | 修改 | 新增 `verifyEmbeddingVersion`；主流程加校验 |
| `src/interface-adapters/http/controllers/memory-controller.ts` | 修改 | 透传 `embedding_degraded` 状态（参照 `:95` degraded 先例） |
| `src/frameworks/db/otter-context-repository.ts` | 修改 | 加 `set(key, value)` / `get(key)`（若不存在） |
| `tests/frameworks/embedding/embedding-service.test.ts` | 修改 | ready 携带 meta、getMeta 测试 |
| `tests/bootstrap/memory.test.ts` | 新增/修改 | verifyEmbeddingVersion 三分支测试 |
| `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` | 修改 | embedding_meta CRUD 测试 |

### 3.5 设计决策

- **key-value 表结构**（vs 独立列）：otter schema 禁止 ALTER TABLE，key-value 更灵活，参照 clowder `schema.ts:72-77`。
- **getMeta? 可选**（vs 强制）：避免破坏现有 EmbeddingGateway 实现（测试 mock 等）。
- **不做 re-embed**：基础设施完全不存在，留 P2-3 专项。
- **otter_context 写入降级**（vs 仅 logger.error）：让 agent 能通过结构化渠道感知降级，不只是埋日志。
- **dim 从 ONNX session 读取**：校验"实际"而非"声明"，否则没意义。

---

## 整体改动范围与依赖关系

### 三 Part 的协作

```
Part 3 (Embedding 版本锚)        → bootstrap 校验决定 hasVec
                                       ↓
Part 1 (可观测性)                 → 召回时返回 vecCoverage（依赖 hasVec 状态）
                                  → scanDarkEntries 扫描暗化条目（含 Part 3 降级后的全表）
                                       ↓
Part 2 (Snippet+下钻)             → 召回响应里 snippet 含匹配词 + drillDown hint
                                  → 让 agent 能基于 vecCoverage + drillDown 做决策
```

**实施顺序**：Part 3 → Part 1 → Part 2（依赖关系最自然）。但三者必须一起进，否则会出现"诊断打开了但没有可诊断的内容"或"vecCoverage 返回了但 agent 不知道怎么用"的中间态。

### 不在本 F 范围

- **P1 三项**（Anchor Lookup / Passage Context Window / Edges 1-hop 图）：留后续 PR
- **P2 候选**（LSM 摘要 / Durable Candidate Extraction / Re-embed / Tool-Based Recall / Keyword 字段 / Signal Trigger / Shadow Mode / SemanticReranker）：评估或后续
- **re-embed 基础设施**：留 P2-3 专项
- **暗化条目自动补 embed 链路**：本 F 只做扫描，修复留 P2-3

### 契约变更总览

| 契约 | 变更 | 向后兼容 |
|------|------|---------|
| `RetrievalSource` | 7 种值 | ✅ 现有 fts/vec/both 不变 |
| `RetrievalResult` | 加 `vecCoverage` | ✅ 新增字段 |
| `RetrievalResultEntry` | 加 `debug?` `drillDown?` | ✅ 可选字段 |
| `SearchQuery` | 加 `debug?` | ✅ 可选字段 |
| `EmbeddingGateway` | 加 `getMeta?()` | ✅ 可选方法 |
| `EmbedResponse` (worker 协议) | ready 加 meta | ⚠️ 破坏性（仅 worker ↔ 主线程，无外部消费方） |
| 数据库 schema | 加 `embedding_meta` 表 | ✅ 幂等 CREATE |
| HTTP API | 加 `GET /api/memory/dark-entries`；search 响应加字段 | ✅ 新增/扩展 |

---

## 验收结果

### 测试结果

[实现阶段填写]

### 证据判定

| Part | 需求 | 证据状态 | 判定 |
|------|------|---------|------|
| Part 1 | 路径标记 | 待验证 | ❓ |
| Part 1 | 覆盖率默认返回 | 待验证 | ❓ |
| Part 1 | 暗化比例准确 | 待验证 | ❓ |
| Part 1 | debug 中间分值 | 待验证 | ❓ |
| Part 1 | 暗化扫描可用 | 待验证 | ❓ |
| Part 1 | vec0 anti-join 兼容 | 待验证 | ❓ |
| Part 2 | snippet 含匹配 | 待验证 | ❓ |
| Part 2 | fallback 正常 | 待验证 | ❓ |
| Part 2 | 性能可控 | 待验证 | ❓ |
| Part 2 | drillDown 填充 | 待验证 | ❓ |
| Part 2 | 向后兼容 | 待验证 | ❓ |
| Part 3 | 表存在 | 待验证 | ❓ |
| Part 3 | getMeta 可用 | 待验证 | ❓ |
| Part 3 | worker 协议 | 待验证 | ❓ |
| Part 3 | 初次基线 | 待验证 | ❓ |
| Part 3 | 不一致降级 | 待验证 | ❓ |
| Part 3 | 降级召回可用 | 待验证 | ❓ |

---

## 对抗审视记录

本 F 的方案设计经过四轮独立对抗审视，完整记录见 R20260811rclo "对抗审视记录"章节。关键决策链：

| 轮次 | 关键发现 | 对本 F 的影响 |
|------|---------|---------------|
| 第一轮 | unicode61→trigram/jieba 误判；supersedes 字段位置；re-embed 基础设施不存在 | Part 3 范围收敛到"检测+降级"，re-embed 留 P2-3 |
| 第二轮 | 零捏造；行号偏差修正 | 各 Part 行号引用精确化 |
| 第三轮 | 暗化条目问题；P0-2+P0-3 强耦合 | Part 1 扩展含暗化扫描；Part 2 合并 highlight + drillDown |
| 第四轮 | SemanticReranker 是死代码；方案 A 协议扩展；vec0 anti-join | Part 3 明确 ready 消息必须扩展携带 meta；Part 1 用 NOT EXISTS 子查询 |

## 实施顺序

按依赖关系：

1. **Part 3 (Embedding 版本锚)** —— bootstrap 校验决定 hasVec，影响 Part 1 的 vecCoverage 计算
2. **Part 1 (可观测性)** ——契约先打开,scanDarkEntries 检测暗化条目（含 Part 3 降级场景）
3. **Part 2 (Snippet+下钻)** —— 在 Part 1 的契约基础上加 drillDown,snippet 改造独立可并行

但三个 Part **必须一起进同一 PR**——分开会出现中间态(诊断打开但无内容可诊断、vecCoverage 返回但 agent 不知道用)。
