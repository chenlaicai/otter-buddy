---
id: F20260821evaf
title: embedding-version-anchor-deadcode-fix
doc_type: feature

summary: |
  修复 embedding 版本锚机制（F20260811mrpy Part 3）在存量库上完全死代码的缺陷。
  根因四层叠加：meta 上报取 dims[0] 恒为 batch=1；embedding_meta 表只在新库 initSchema 建、老库无补建；
  verifyEmbeddingVersion 用 worker ready 时序快照 available 做守卫、bootstrap 时恒 false 直接跳过；
  降级告警写 otter_context('system') 被 FK 挡住且无消费方。经两轮独立 agent 对抗审视定稿。
  修法：取形状末维、migration 幂等补表、守卫只看 getMeta（30s 超时兜底）、删除双重死代码的告警写入。

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

### 根因分析（四层叠加，前三层任一层都足以让校验失效）

**层 1 — meta 上报取错维度**（`bge-m3-worker.ts`）：
dummy embed 后 `dim: dummy.dims[0]`。transformers.js 的 `dims` 是形状数组 `[batch, dim]`，`[0]` 恒为 batch=1。即使锚启用，dim=1 与任何存量基线都不一致，会误触发降级。

**层 2 — 老库无表**（`migration.ts`）：
`embedding_meta` 的 CREATE TABLE 只在 `initSchema` 里，而 `initSchema` 仅新库执行（`bootstrap/database.ts` 的 `isNewDb` 分支）。migration.ts 补建了同期的 `embedding_tasks` 却漏了 `embedding_meta`——存量库该表永远不存在。

**层 3 — 守卫时序错误**（`bootstrap/database.ts` verifyEmbeddingVersion）：
```ts
if (!embeddingGateway.available || typeof embeddingGateway.getMeta !== "function") return { vecEnabled: true };
```
`available` 是 worker ready 的时序快照。app.ts:130 调用时 worker 尚在加载模型（本地 bge-m3 约 4s），`available` 恒为 false → 走"兼容老接口"跳过分支。讽刺的是接口文档自己写着 getMeta "worker ready 后才可用，**内部会 waitForReady**"——守卫根本不需要也不应该看 available。

**层 4 — 降级告警写入双重死代码**（T3 补验实锤，对抗审视阶段发现）：
mismatch 时写 `otter_context('system', 'embedding_degraded')` 实测被 `FOREIGN KEY constraint failed` 挡住（otter_id → otters.id，'system' 是幽灵 id）；且 agent 的 get_context 工具按系统注入的 otterId 读，全仓库无任何路径读 'system' 行——即使写成功也无消费方。agent 感知实际由 search_memory 结果的 vecCoverage 字段（ratio/vecDisabled）承担，该通道一直是工作的。

### 数据实锤

- 生产库 `memory_vec` 4245/4245 全覆盖、向量数据 24MB——embedding 本身工作正常，问题仅限防线机制；
- 7/27–8/3 曾有 20 次 `fetch failed` 降级（worker 远程拉模型被阻断），此后零降级；
- 40 次+ 启动日志中 `dim=1`、零次 baseline recorded。

## 方案设计

### 技术方案

1. **dim 取值**：`dummy.dims[dummy.dims.length - 1]`（最后一维才是向量维度，batch 维被自然跳过）。
2. **migration 补建**：`ensureEmbeddingMetaTable`，CREATE TABLE IF NOT EXISTS 与 schema.ts 同构，注册进 migrateDatabase（幂等，新库老库都安全）。日志只在真正补建时打（sqlite_master 先行探测），使日志可作为升级证据。
3. **守卫修正**：去掉 `!embeddingGateway.available` 条件，只保留 `typeof getMeta !== "function"`（老接口兼容）。getMeta 内部 waitForReady，worker 加载失败时 reject → 走 catch 分支跳过校验（模型不可用时本来也无法 embed，语义不变）。
4. **getMeta 30s 超时**（对抗审视项）：截断"worker 永不 ready 也永不报错"的挂起态（onnxruntime 原生死锁、远程 fetch 挂起）。超时只 skip 校验、不掩盖 mismatch（mismatch 在 meta 拿到后才判定）。
5. **DB 读写容错**（对抗审视项）：getEmbeddingMeta 读失败 / setEmbeddingMeta 写失败 → warn + 跳过校验，不崩 boot（IO 错误 ≠ schema 缺失，防御深度与 getMeta 一致）。
6. **移除 otter_context 告警写入**（T3 补验发现的层 4）：双重死代码，agent 感知由 vecCoverage 承担。

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
| AT-3 | 基线写入 + 一致性分支 | 首次启动 → 查表；二次启动 → 看日志 | 首启 `baseline recorded`；二启无 mismatch/降级日志 |
| AT-4 | 降级路径可达 + 恢复闭环（T3 补验） | 副本库 `UPDATE embedding_meta SET value='999' WHERE key='dim'` → 重启；还原后三启 | mismatch 日志 + vec 禁用 + retry worker 停；三启恢复 vec 且 retry worker 回灌暗化条目 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| 全部 | n/a（A 类纯代码逻辑，单测 + 隔离实例实证） |

## 实现细节

### 代码修改

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/embedding/bge-m3-worker.ts | 修改 | dim 取 dims 最后一维 |
| src/usecases/memory/embedding-gateway.ts | 修改 | modelRev 注释如实记录"恒 unknown + 固化代价"；dim 注释更正 |
| src/frameworks/db/migration.ts | 修改 | 新增 ensureEmbeddingMetaTable（条件打日志）并注册 |
| src/bootstrap/database.ts | 修改 | 守卫去掉 available 快照；getMeta 30s 超时；DB 读写容错；移除 otter_context 告警写入 |
| src/app.ts | 修改 | 注释同步（降级状态经 vecCoverage 暴露） |
| tests/bootstrap/verify-embedding-version.test.ts | 修改 | 反转 available 用例；新增超时/IO 错误用例；降级用例改为断言不写 otter_context |
| tests/frameworks/db/migration.test.ts | 修改 | 新增老库补建 + 幂等两个用例 |

### 逻辑变更

版本锚从"永远走不到的代码"变为"每次 boot 真实校验"。语义不变项：模型加载失败仍跳过校验（vecEnabled=true）、不一致仍 disableVec。行为变化项：boot 现在会等模型加载完成（本地约 4s，30s 超时上限）才继续 memory index 写入——这本来就是注释声明的顺序要求（"在 memory index 写入前完成"）。

## 验收结果

### 测试结果

- 单测：`npm test` 1355/1355 通过、lint 0 error（verify-embedding-version 10 例含超时/IO 容错、migration 新增 2 例）
- 隔离实例实证（worktree + 独立端口 3901 + 生产库一致性副本，三轮启动）：
  - 首启：`Ensured embedding_meta table exists` → `Embedding model loaded: bge-m3 rev=unknown dim=1024` → `Embedding meta baseline recorded: bge-m3 rev=unknown dim=1024`；表内容 model_id=bge-m3 / dim=1024
  - mismatch 轮（dim 改 999）：`Embedding version mismatch, degrading to FTS-only` → `Embedding vec path disabled` → `EmbeddingRetryWorker not started`，memory_vec 被 disableVec 清空；无 FK 报错（告警写入已移除）
  - 恢复轮（dim 还原 1024）：无 mismatch、vec 恢复可用、`EmbeddingRetryWorker started, migratedExisting=1000`——暗化条目自愈回灌闭环
  - （副本库同步报 1 个 F20260731 文档 UNIQUE 冲突，为副本与 worktree 文档差异的既有现象，与本修复无关）

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 老库补表 + 基线 | 证明完成（日志 + 表内容） | ✅ |
| T2 dim=1024 | 证明完成（三轮启动日志） | ✅ |
| T3 降级路径可达 + 恢复闭环 | 证明完成（真库构造 mismatch：日志 + vec 清空 + retry worker 停启 + 回灌） | ✅ |

## 对抗审视记录

两轮独立 agent 并行审视（代码正确性 / 集成面与升级路径），交叉确认了根因诊断、dims 修复（实读 transformers.js 源码验证 `[batch, dim]` 形状）、migration 同构性、无其他 available 消费方。发现的问题与用户逐题拍板：

| 审视项 | 决策 | 处置 |
|--------|------|------|
| getMeta 无超时，worker 挂死 → 全进程起不来且无日志 | 加超时 | 30s，超时走 skip（不掩盖 mismatch） |
| embedding_degraded 只写不清（恢复后永久脏状态） | — | 被 T3 实锤的层 4 取代：连写入本身都是死代码，整体移除 |
| modelRev 恒 unknown，基线固化后未来实现真实 rev 需人工重写 | 仅修注释+文档 | gateway 注释如实记录；不实现 mtime 上报（换模型是低频运维事件，与"不做 re-embed 基础设施"决策一致） |
| T3 降级路径未真实验证（❓） | 补验 | dim=999 实验，✅（且发现层 4） |
| verify 内 DB 读写无容错（IO 错误崩 boot） | 修 | 读/写失败 warn + skip |
| 补建日志无条件打削弱 AT-1 证据 | 修 | sqlite_master 先行探测，只在真补建时打 |
| 基线语义：写的是"当前 worker meta"，未验证存量向量来源 | 记录已知限制 | 存量向量 1024 维由 vec0 表写入约束背书（维度错写入必报错）；跨模型历史混合的可能性无法事后追溯，接受 |
| 启动 time-to-listen 净增约 4s | 接受 | 端口在 verify 前未开，外部表现为 connection refused 而非挂起连接 |

## 设计决策

- **不防御性兜底 getEmbeddingMeta 的 no-such-table**：migration 补建已修根因，对 schema 缺失加 fallback 只会重新掩盖问题（原 bug 正是被静默跳过藏了 10 天）。IO 错误另论——已包 try/catch。
- **移除而非修复 otter_context 告警**：修复需要造 system 海獭实体 + 新增读取通道，而降级状态已有工作中的暴露通道（vecCoverage），再建一条是重复机制。
- **modelRev 固化为 unknown 的代价**：本地 models/ 目录整目录替换（同 modelId 同 dim）时锚检测不到；将来实现真实 rev 时需一次性重写基线。接受理由：换模型属低频运维事件，届时全库线下 re-embed 顺带重写锚即可。
- **顺带发现未修**：memory_fts（trigram 表）只写不查，每条 entry 白写一份索引——独立问题，另行处理。
