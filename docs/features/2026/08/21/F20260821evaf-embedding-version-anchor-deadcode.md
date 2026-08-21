---
id: F20260821evaf
title: embedding-version-anchor-deadcode-fix
doc_type: feature

summary: |
  修复 embedding 版本锚机制（F20260811mrpy Part 3）在存量库上完全死代码的缺陷。
  根因是三层叠加：meta 上报取 dims[0] 恒为 batch=1；embedding_meta 表只在新库 initSchema 建、老库无 migration 补建；
  verifyEmbeddingVersion 用 worker ready 时序快照 available 做守卫、bootstrap 时恒 false 直接跳过。
  修法：取形状数组最后一维、migration 幂等补建表、守卫只看 getMeta 是否存在（其内部 waitForReady）。

causal_links:
  from:
    - F20260811mrpy

status: final
change_type: fix
tags: [embedding, memory, migration, bootstrap]
modules:
  - src/frameworks/embedding/bge-m3-worker.ts
  - src/frameworks/db/migration.ts
  - src/bootstrap/database.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: fix-embedding-version-anchor
---

# F20260821evaf: embedding 版本锚死代码修复

## 背景与需求

### 问题描述

对生产库（data/otter-buddy.db）的实证排查发现，F20260811mrpy Part 3 引入的 embedding 版本锚机制**从未实际运行过**：

1. 日志中 `Embedding model loaded: bge-m3 rev=unknown dim=1`——维度恒报 1；
2. 日志中从未出现 `Embedding meta baseline recorded`（初次启动写基线的必经路径）；
3. 直接查 sqlite_master：`embedding_meta` 表不存在；
4. 若校验真跑到 `getEmbeddingMeta()`，`SELECT ... FROM embedding_meta` 会直接抛 no such table。

### 根因分析（三层叠加，任一层都足以让机制失效）

**层 1 — meta 上报取错维度**（`bge-m3-worker.ts`）：
dummy embed 后 `dim: dummy.dims[0]`。transformers.js 的 `dims` 是形状数组 `[batch, dim]`，`[0]` 恒为 batch=1。即使锚启用，dim=1 与任何存量基线都不一致，会误触发降级。

**层 2 — 老库无表**（`migration.ts`）：
`embedding_meta` 的 CREATE TABLE 只在 `initSchema` 里，而 `initSchema` 仅新库执行（`bootstrap/database.ts` 的 `isNewDb` 分支）。migration.ts 补建了同期的 `embedding_tasks` 却漏了 `embedding_meta`——存量库该表永远不存在。

**层 3 — 守卫时序错误**（`bootstrap/database.ts` verifyEmbeddingVersion）：
```ts
if (!embeddingGateway.available || typeof embeddingGateway.getMeta !== "function") return { vecEnabled: true };
```
`available` 是 worker ready 的时序快照。app.ts:130 调用时 worker 尚在加载模型（本地 bge-m3 约 4s），`available` 恒为 false → 走"兼容老接口"跳过分支。讽刺的是接口文档自己写着 getMeta "worker ready 后才可用，**内部会 waitForReady**"——守卫根本不需要也不应该看 available。

### 数据实锤

- 生产库 `memory_vec` 4245/4245 全覆盖、向量数据 24MB——embedding 本身工作正常，问题仅限防线机制；
- 7/27–8/3 曾有 20 次 `fetch failed` 降级（worker 远程拉模型被阻断），此后零降级；
- 40 次+ 启动日志中 `dim=1`、零次 baseline recorded。

## 方案设计

### 技术方案

1. **dim 取值**：`dummy.dims[dummy.dims.length - 1]`（最后一维才是向量维度，batch 维被自然跳过）。
2. **migration 补建**：`ensureEmbeddingMetaTable`，CREATE TABLE IF NOT EXISTS 与 schema.ts 同构，注册进 migrateDatabase（幂等，新库老库都安全）。
3. **守卫修正**：去掉 `!embeddingGateway.available` 条件，只保留 `typeof getMeta !== "function"`（老接口兼容）。getMeta 内部 waitForReady，worker 加载失败时 reject → 走既有 catch 分支跳过校验（模型不可用时本来也无法 embed，语义不变）。

### 目标

- T1: 存量库启动后 embedding_meta 表存在且记录正确基线（dim=1024）
- T2: meta 上报维度为真实向量维度
- T3: 版本不一致时降级路径真正可达

### 成功标准

boot 日志出现 `Embedding model loaded: ... dim=1024` + `Embedding meta baseline recorded: ... dim=1024`；二次启动无 mismatch 降级。

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 老库补建 embedding_meta | VACUUM INTO 复制生产库（无该表）→ 启动 | 日志 `Ensured embedding_meta table exists`；表可读写 |
| AT-2 | dim 上报正确 | 启动后看日志 | `Embedding model loaded: bge-m3 rev=unknown dim=1024` |
| AT-3 | 基线写入 + 一致性分支 | 首次启动 → 查表；二次启动 → 看日志 | 首启 `baseline recorded`；二启无 mismatch/降级日志，otter_context 无 embedding_degraded |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| 全部 | n/a（A 类纯代码逻辑，单测 + 隔离实例实证） |

## 实现细节

### 代码修改

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/embedding/bge-m3-worker.ts | 修改 | dim 取 dims 最后一维 |
| src/usecases/memory/embedding-gateway.ts | 修改 | 接口注释更正（dims[0] → 最后一维） |
| src/frameworks/db/migration.ts | 修改 | 新增 ensureEmbeddingMetaTable 并注册 |
| src/bootstrap/database.ts | 修改 | verifyEmbeddingVersion 守卫去掉 available 快照判断 |
| tests/bootstrap/verify-embedding-version.test.ts | 修改 | "不 available → 跳过"用例反转为"不 available 仍校验" |
| tests/frameworks/db/migration.test.ts | 修改 | 新增老库补建 + 幂等两个用例 |

### 逻辑变更

版本锚从"永远走不到的代码"变为"每次 boot 真实校验"。语义不变项：模型加载失败仍跳过校验（vecEnabled=true）、不一致仍 disableVec + otter_context 告警。行为变化项：boot 现在会等模型加载完成（本地约 4s）才继续 memory index 写入——这本来就是注释声明的顺序要求（"在 memory index 写入前完成"）。

## 验收结果

### 测试结果

- 单测：`npm test` 1353/1353 通过（含更新后的 verify-embedding-version 8 例、migration 新增 2 例）
- 隔离实例实证（worktree + 独立端口 3901 + 生产库一致性副本）：
  - 首启：`Ensured embedding_meta table exists` → `Embedding model loaded: bge-m3 rev=unknown dim=1024` → `Embedding meta baseline recorded: bge-m3 rev=unknown dim=1024`；表内容 model_id=bge-m3 / dim=1024
  - 二启：无 baseline 重写、无 mismatch、无 embedding_degraded，vec 全程可用
  - （副本库同步报 1 个 F20260731 文档 UNIQUE 冲突，为副本与 worktree 文档差异的既有现象，与本修复无关）

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 老库补表 + 基线 | 证明完成（日志 + 表内容） | ✅ |
| T2 dim=1024 | 证明完成（两轮启动日志） | ✅ |
| T3 降级路径可达 | 证据不足（单测 mock 覆盖，未在真库构造模型不一致场景——需换模型才能触发，属低频运维事件） | ❓ |

## 设计决策

- **不防御性兜底 getEmbeddingMeta 的 no-such-table**：migration 补建已修根因，加 try/catch 只会重新掩盖问题（原 bug 正是被静默跳过藏了 10 天）。
- **不做启动超时**：waitForReady 无限等待与 embed() 行为一致；worker preload 必然 postMessage ready 或 error，崩溃场景由 exit/error 事件兜底。
- **顺带发现未修**：memory_fts（trigram 表）只写不查，每条 entry 白写一份索引——独立问题，另行处理。
