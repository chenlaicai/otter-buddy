---
id: F20260811eanc
title: embedding-version-anchor
doc_type: feature
summary: |
  给 embedding 模型/维度切换加版本锚检测：①新增 embedding_meta 表记录当前 model_id/model_rev/dim；②扩展 EmbeddingGateway 接口暴露 getMeta()；③bootstrap 时校验，不一致则降级为纯 FTS + otter_context 告警。
  根因：当前 embedding 配置硬编码（bge-m3, 1024 维），切换模型时旧向量与新查询混跑，召回质量静默变差。re-embed 基础设施不存在（worker 单线程串行，500 条要几分钟），无法主动修复，只能降级。
  主机制：bootstrap 时通过 worker ready 消息（需扩展协议附带 meta）校验一致性，不一致则降级并暴露状态给 agent。

causal_links:
  from:
    - R20260811rclo

status: draft
change_type: feature
tags: [memory, embedding, safety, bootstrap]
modules:
  - src/frameworks/db/schema.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/usecases/memory/embedding-gateway.ts
  - src/frameworks/embedding/embedding-service.ts
  - src/frameworks/embedding/bge-m3-worker.ts
  - src/bootstrap/memory.ts
  - src/interface-adapters/http/controllers/memory-controller.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为。仅扩展接口、加启动校验，不涉及 prompt/skill/工具选择"
---

# F20260811eanc: Embedding 版本锚

## 背景与需求

### 问题描述

otter 当前 embedding 配置在 `embedding-service.ts:178-182` 硬编码：

```typescript
workerData: {
  modelPath: embedConfig?.modelPath ?? "Xenova/bge-m3",
  localModelPath: embedConfig?.localModelPath,
},
```

`memory_vec` 表维度也在 `schema.ts:188-191` 硬编码为 `FLOAT[1024]`。

**问题**：未来如果切换 embedding 模型（如 bge-m3 → bge-small 384 维，或换 multilingual-e5），**旧向量与新查询混跑，召回质量静默变差**。这是个定时炸弹。

### 根因分析

| # | 根因 | 代码证据 |
|---|------|---------|
| R1 | 无模型版本元数据持久化 | 当前 otter 不存储"现有向量是用哪个模型/维度生成的" |
| R2 | EmbeddingGateway 接口窄 | `embedding-gateway.ts:2-6` 只有 `available: boolean + embed(text)`，拿不到 model_id/rev/dim |
| R3 | 模型元信息封在 worker 内部 | `bge-m3-worker.js` 加载模型后不 postMessage 回模型信息，主线程拿不到 |
| R4 | 无启动校验 | `bootstrap/memory.ts` 启动时不检查现有向量与新配置是否一致 |
| R5 | re-embed 基础设施不存在 | `store-memory.ts:113` 注释明示 "~546 embedding 约 27s"，worker 单线程串行；无批量 embed 接口、无任务调度器、无进度跟踪 |

### 数据实锤

- `embedding-service.ts:36-39` 的 `EmbedResponse` 类型只有 `{ type: "ready" } | { type: "result"; ... } | { type: "error"; ... }`——ready 消息不携带模型元信息
- `embedding-service.ts:128-134` 的 `waitForReady()` 等待 ready 消息，但 resolve 不带参数
- `schema.ts:8` 注释明确"禁止 ALTER TABLE"——加列要么新增表，要么重建库
- `memory-controller.ts:95` 已有 `degraded` 字段先例（`result.total === 0 && !embeddingGateway.available`），可参照扩展

---

## 方案设计

### 技术方案

**采用 R 文档方案 A（推荐）+ 协议扩展（第四轮审视补充）**

#### 一、新增 embedding_meta 表

`schema.ts` 的 `createMemoryTables` 内新增（幂等模式，无需迁移）：

```sql
CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

采用 key-value 结构（参照 clowder `schema.ts:72-77`），而非独立列——更灵活，未来加新元字段不用改表。

存储内容：
- `model_id`：模型标识（如 `Xenova/bge-m3`）
- `model_rev`：模型版本/revision（如 git commit hash 或 HF revision）
- `dim`：向量维度（如 `1024`）

#### 二、扩展 EmbeddingGateway 接口

`embedding-gateway.ts`：

```typescript
export interface EmbedModelMeta {
  modelId: string;
  modelRev: string;
  dim: number;
}

export interface EmbeddingGateway {
  readonly available: boolean;
  embed(text: string): Promise<Float32Array>;
  /** 新增：返回当前 worker 加载的模型元信息（worker ready 后才可用） */
  getMeta?(): Promise<EmbedModelMeta>;
}
```

`getMeta?` 设为可选——避免破坏现有 EmbeddingGateway 实现（如测试 mock）。

#### 三、扩展 worker 协议（关键改动）

`embedding-service.ts:36-39` 的 `EmbedResponse` 类型扩展：

```typescript
type EmbedResponse =
  | { type: "ready"; meta: EmbedModelMeta }   // 附带 meta
  | { type: "result"; embedding: Float32Array; id: number }
  | { type: "error"; error: string; id: number };
```

`setupHandlers()` 的 ready handler（`:71-77`）改造：

```typescript
if (msg.type === "ready") {
  this.readyState.ready = true;
  this.cachedMeta = msg.meta;  // 新增：缓存 meta
  this.readyState.waiters.forEach(w => w.resolve());
  this.readyState.waiters.length = 0;
  this.logger.info("Embedding model loaded successfully", msg.meta);
  return;
}
```

新增 `getMeta()` 实现：

```typescript
async getMeta(): Promise<EmbedModelMeta> {
  if (!this.readyState.ready) await this.waitForReady();
  if (!this.cachedMeta) throw new Error("Worker ready but meta missing");
  return this.cachedMeta;
}
```

#### 四、worker 端发送 meta

`bge-m3-worker.js` 在加载完模型后 postMessage 时附带 meta：

```javascript
// 加载完模型后
parentPort.postMessage({
  type: "ready",
  meta: {
    modelId: modelConfig.modelId,      // 从 workerData 或 model.config 拿
    modelRev: modelConfig.revision ?? "unknown",
    dim: model.config?.dim ?? 1024,    // 从加载后的模型拿实际维度
  },
});
```

**worker 端的 meta 来源**（三种可能，按可靠性排序）：
1. 加载完模型后从 ONNX session 的 `model.metadata` 读取（最可靠）
2. 从 workerData 接收的 `modelPath`/`localModelPath` 推断（次之）
3. 硬编码（最后兜底）

#### 五、bootstrap 校验

`bootstrap/memory.ts` 新增校验逻辑：

```typescript
async function verifyEmbeddingVersion(
  embeddingGateway: EmbeddingGateway,
  repo: MemoryRepository,
  otterContextRepo: OtterContextRepository,
  logger: Logger,
): Promise<boolean> {
  if (!embeddingGateway.available) return true;  // 没启用 vec，无需校验

  const meta = await embeddingGateway.getMeta();
  const stored = await repo.getEmbeddingMeta();  // { modelId?, modelRev?, dim? }

  if (!stored.modelId) {
    // 初次启动，写入基线
    await repo.setEmbeddingMeta(meta);
    logger.info("Embedding meta baseline recorded", meta);
    return true;
  }

  if (stored.modelId !== meta.modelId ||
      stored.modelRev !== meta.modelRev ||
      stored.dim !== meta.dim) {
    // 不一致 → 降级
    logger.error("Embedding version mismatch, degrading", { stored, current: meta });
    await otterContextRepo.set("embedding_degraded", JSON.stringify({
      reason: "version_mismatch",
      stored, current: meta,
      detectedAt: new Date().toISOString(),
    }));
    return false;  // 返回 false 表示应禁用 vec
  }

  return true;
}
```

`bootstrap/memory.ts` 主流程：

```typescript
const embeddingAvailable = embeddingGateway.available &&
  (embeddingGateway.getMeta ? await verifyEmbeddingVersion(...) : true);

// embeddingAvailable=false 时，注入 SQLiteMemoryRepository 时 hasVec=false
```

#### 六、re-embed 范围控制（不做）

**本 F 不做 re-embed**。理由：
- worker 单线程串行，500 条要几分钟
- 批量 embed 接口、任务调度器、进度跟踪都不存在
- 这些基础设施留 P2-3 Embedding Re-embed 基础设施专项做

本 F 只做：**检测 + 降级 + 告警**。降级后用户可以手动重建库（`npm run rebuild-memory-db` 或类似命令）。

### 目标

- T1: `embedding_meta` 表存在（key-value 结构）
- T2: `EmbeddingGateway.getMeta()` 可用，返回 modelId/modelRev/dim
- T3: worker ready 消息附带 meta
- T4: bootstrap 时校验，不一致则降级为纯 FTS + otter_context 写入 `embedding_degraded`
- T5: 初次启动写入基线 meta

### 成功标准

- 启动日志显示 `Embedding meta baseline recorded` 或 `Embedding version mismatch, degrading`
- 故意改 dim（如把 schema 改 FLOAT[512]）触发降级，召回仍能跑（FTS-only）
- agent 能通过 `otter_context` 感知到 `embedding_degraded` 状态

---

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1 表存在 | 启动后查 `sqlite_master` | `embedding_meta` 表存在，结构是 key-value |
| AT-2 | T2 getMeta 可用 | worker ready 后调 `embeddingGateway.getMeta()` | 返回 `{ modelId, modelRev, dim }`，dim=1024 |
| AT-3 | T3 worker 协议 | 看 worker 端 postMessage | ready 消息附带 meta 字段 |
| AT-4 | T4 初次启动基线 | 全新 DB 启动 | `embedding_meta` 表写入 3 个 key（model_id/model_rev/dim），日志显示 baseline |
| AT-5 | T4 不一致降级 | 改 schema 维度，重启 | 日志 error "version mismatch"；`otter_context` 表 `embedding_degraded` key 写入；召回变 FTS-only |
| AT-6 | T4 降级召回仍可用 | 降级状态下调 search | 召回结果正常（FTS-only），`vecCoverage.withVec: 0` |
| AT-7 | T5 一致时不降级 | 不改任何配置重启 | 正常启动，无降级告警 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 ~ AT-7 | n/a（A 类纯代码逻辑改动，单元测试 + 集成测试覆盖） |

单测覆盖：
- `tests/frameworks/embedding/embedding-service.test.ts` — getMeta/waitForReady/ready 消息携带 meta
- `tests/bootstrap/memory.test.ts` — verifyEmbeddingVersion 三个分支（基线/一致/不一致）
- `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` — embedding_meta CRUD

---

## 实现细节

### 代码修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/frameworks/db/schema.ts` | 修改 | `createMemoryTables` 内加 `embedding_meta` 表（key-value 结构） |
| `src/usecases/memory/memory-repository.ts` | 修改 | 新增 `getEmbeddingMeta()` / `setEmbeddingMeta(meta)` 接口 |
| `src/frameworks/db/memory/sqlite-memory-repository.ts` | 修改 | 实现 getEmbeddingMeta/setEmbeddingMeta |
| `src/usecases/memory/embedding-gateway.ts` | 修改 | 加 `EmbedModelMeta` 类型；接口加可选 `getMeta?()` |
| `src/frameworks/embedding/embedding-service.ts` | 修改 | `EmbedResponse.ready` 携带 meta；`setupHandlers` 缓存 meta；新增 `getMeta()` 实现 |
| `src/frameworks/embedding/bge-m3-worker.ts` | 修改 | 加载完模型后 postMessage 时附带 meta（从 model.config 读取） |
| `src/bootstrap/memory.ts` | 修改 | 新增 `verifyEmbeddingVersion`；主流程加校验 |
| `src/interface-adapters/http/controllers/memory-controller.ts` | 修改 | 透传 `embedding_degraded` 状态到响应（参照 `:95` degraded 先例） |
| `src/frameworks/db/otter-context-repository.ts`（或对应文件） | 修改 | 加 `set(key, value)` / `get(key)` 接口（若不存在） |
| `tests/frameworks/embedding/embedding-service.test.ts` | 修改 | 加 ready 消息携带 meta、getMeta 测试 |
| `tests/bootstrap/memory.test.ts` | 新增/修改 | verifyEmbeddingVersion 三个分支测试 |
| `tests/frameworks/db/memory/sqlite-memory-repository.test.ts` | 修改 | embedding_meta CRUD 测试 |

### 逻辑变更

1. **启动时序**：
   ```
   bootstrap/memory.ts
     → initEmbeddingService() 创建 worker
     → embeddingGateway.getMeta() 内部调 waitForReady()
     → worker 加载模型完成后 postMessage({ type: "ready", meta })
     → getMeta() resolve 返回 meta
     → verifyEmbeddingVersion(meta) 校验
     → 一致：继续；不一致：降级（hasVec=false）+ otter_context 告警
   ```

2. **降级传播**：
   - bootstrap 决定 `embeddingAvailable` 布尔值
   - 注入 `SQLiteMemoryRepository` 时设 `hasVec=false`
   - `search-memory.ts:searchVec` 已有 `if (!this.repo.hasVecTable()) return []` 守卫（`:277`），自动跳过 vec 路径
   - `memory-controller.ts:95` 的 `degraded` 字段会在 `total === 0 && !embeddingGateway.available` 时为 true，但本 F 的降级场景 embeddingGateway.available 仍是 true（worker 正常加载，只是版本不匹配）——需要新增 `embeddingVersionDegraded` 字段或扩展 degraded 触发条件

3. **meta 来源可靠性**：
   - 优先从 ONNX session 的 `model.metadata` 读取
   - 兜底从 `workerData.modelPath` 推断 modelId
   - dim 必须从实际加载的模型读取（不能从配置硬编码），否则校验没意义

### 改动范围

| 范围 | 影响 |
|------|------|
| 数据库 schema | 新增 `embedding_meta` 表（幂等，无需迁移） |
| Worker 协议 | `EmbedResponse.ready` 加 `meta` 字段——破坏性改动（仅限 worker 与主线程通信，无外部消费方） |
| EmbeddingGateway 接口 | 加可选 `getMeta?()` 方法——向后兼容，现有 mock 不强制实现 |
| bootstrap 启动时序 | 多一步 `verifyEmbeddingVersion`，启动时间增加可忽略（worker 加载后立即可读 meta） |
| 运行时行为 | 检测到不一致时降级，召回变 FTS-only。用户感知到召回质量下降，可通过 `otter_context` 看到降级原因 |

---

## 验收结果

### 测试结果

[实现阶段填写]

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 表存在 | 待验证 | ❓ |
| T2 getMeta 可用 | 待验证 | ❓ |
| T3 worker 协议 | 待验证 | ❓ |
| T4 初次基线 | 待验证 | ❓ |
| T4 不一致降级 | 待验证 | ❓ |
| T4 降级召回可用 | 待验证 | ❓ |
| T5 一致不降级 | 待验证 | ❓ |

---

## 对抗审视记录

完整审视见 R20260811rclo。本 F 的关键决策：

- **第一轮拆分**：原方案包含"全量 re-embed"，第一轮审视指出严重低估复杂度（worker 单线程串行，re-embed 基础设施不存在）。本 F 拆为只做"检测+降级+告警"，re-embed 留 P2-3。
- **第四轮审视补充协议扩展**：原方案 A 说"复用 waitForReady"，第四轮审视指出当前 `ready` 消息不含模型元信息，必须扩展 `EmbedResponse` 类型。本 F 在方案中明确这点。
- **第四轮审视 dim 来源**：dim 必须从实际加载的模型读取，不能从配置硬编码——否则校验没意义。

## 设计决策

- **key-value 表结构**（vs 独立列）：参照 clowder `schema.ts:72-77`，未来加新元字段不用改表。otter schema 禁止 ALTER TABLE，key-value 更灵活。
- **getMeta? 可选**（vs 强制）：避免破坏现有 EmbeddingGateway 实现（测试 mock 等）。bootstrap 校验时通过 `embeddingGateway.getMeta ?` 守卫。
- **不做 re-embed**（vs 全套检测+修复）：第一轮审视指出 re-embed 基础设施完全不存在。本 F 聚焦"检测+降级"，修复留 P2-3。
- **otter_context 写入降级状态**（vs 仅 logger.error）：参照 memory-controller.ts:95 degraded 先例，让 agent 能通过结构化渠道感知降级，不只是埋在日志里。
- **dim 从 ONNX session 读取**（vs 从 workerData 推断）：workerData 是配置声明，session 是实际加载——校验的意义在比对"实际"而非"声明"。
