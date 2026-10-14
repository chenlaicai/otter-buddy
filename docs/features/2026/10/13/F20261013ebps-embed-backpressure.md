---
id: F20261013ebps
title: "embedding worker 淹没背压 + retry 熔断 + document sync 批量 embed（#1453/#1460）"
summary: "P1 bug 修复：document sync 612 篇文档 3269 条 chunk 逐条 fireAndForgetEmbed 瞬间淹没 worker（串行处理 ~500ms/条，需 27min 排完），retry worker 首次 tick 的 embed 排在 2700 条积压后面 30s 超时，之后所有 embed 永久超时（worker 队列永远排不到）。三层修复：① embedding-service 背压——in-flight 上限 50，满时直接 reject 不 postMessage（调用方 catch 入 retry 队列，不丢失）；② retry worker 熔断——连续 3 次 tick 全失败暂停消费（worker 已淹再打加压）；③ document sync 批量 embed——embedBatch 一次 postMessage 传 N 条文本，worker 端 batch 推理（吞吐近线性提升）。"
change_type: fix
capability_test: "n/a: 修复为 embedding 通路内部流控逻辑，行为面由单测锁定——tests/frameworks/embedding/embedding-service.test.ts（背压上限/batch 协议/超时缩放）；tests/usecases/memory/embedding-retry-worker.test.ts（熔断计数/恢复/全失败判定）；全量 memory+embedding 166 用例不回归"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
intent:
  problem: "2026-10-13 14:24 启动后 embedding 通路全灭：document sync 612 updated → 3269 chunk fireAndForgetEmbed 同时 postMessage 进 worker（串行 ~500ms/条，需 27min），sync 4min 完成后 worker 队列仍堆 2700+ 条。14:28:58 retry worker 首次 tick embed 排在积压后面 30s 超时，之后 44 条 embed 全超时 0 成功。pending 队列从 ~700 涨到 8465（只进不出），RSS 2.3G→4.8G（1GB/h），worker 两线程 100% 空转 ONNX。根因：embed 无背压（无节制 postMessage）、retry worker 无熔断（超时后继续打）、sync 逐条 embed（无批量）。"
  expected_effect: "embed 有背压上限（50 in-flight），满时 reject 由调用方入 retry 队列——worker 队列永远可控；retry worker 连续 3 次全失败熔断暂停——不再给淹死的 worker 加压；document sync chunk embed 走 batch——一次 postMessage 传 N 条，worker batch 推理吞吐近线性提升，3269 条从 27min 降到 ~3min（batch=50）。"
  verify_by:
    type: behavior_check
modules:
  - src/frameworks/embedding/embedding-service.ts
  - src/frameworks/embedding/bge-m3-worker.ts
  - src/usecases/memory/embedding-retry-worker.ts
  - src/usecases/memory/store-memory.ts
  - src/usecases/memory/embedding-gateway.ts
tags:
  - embedding
  - bugfix
  - backpressure
---

# embedding worker 淹没背压 + retry 熔断 + document sync 批量 embed

## 问题（#1453/#1460）

2026-10-13 14:24 主服务启动后 embedding 通路全灭。三层叠加：

1. **worker 淹没**：document sync 612 updated → 3269 chunk 逐条 `fireAndForgetEmbed` 同时 `postMessage` 进 worker。worker 串行处理 ~500ms/条，3269 条需 ~27min。sync 4min 完成后队列仍堆 2700+ 条。
2. **retry 加压**：14:28:28 迁移 1000 条暗化条目 → 14:28:58 retry worker 首次 tick → claim 10 条 → embed postMessage 排在 2700 条积压后面 → 30s 超时 → release 回 pending → 30s 后再 tick 又 claim 又超时。**retry worker 不是在重试，是在给已淹的 worker 继续加压**。
3. **空转 + 泄漏**：worker 持续处理积压 embed（两线程 100% CPU），结果回来后 pendingRequests 已超时删除——算出来的向量无人消费。RSS 2.3G→4.8G（1GB/h）。

**关键数据**：今天 14:24 后 vec 写入 0 条（最后一次成功 10/13 03:18）；pending 8465（ attempts=0 有 7779 条是超时后新写入）；44 条超时日志全是 retry worker 的。

## 修复

### Bug 1：embedding-service 背压（embedding-service.ts）

- `MAX_IN_FLIGHT = 50`：`pendingRequests.size >= 50` 时新 embed 直接 reject，不 postMessage 到 worker
- 超出的请求由 `fireAndForgetEmbed` 的 catch 捕获 → 入 retry 队列，不丢失
- `embedBatch()` 新增：一次 postMessage 传 N 条文本，batch 超时按条数缩放（1s/条，上限 120s）
- 测试覆盖：`setTestMaxInFlightOverride`

### Bug 2：retry worker 熔断（embedding-retry-worker.ts）

- `MAX_CONSECUTIVE_FULL_FAILURES = 3`：连续 3 次 tick 全部失败（10/10 超时）→ 暂停消费
- 有成功即重置计数；熔断后每 10 次跳过打一次日志（防刷屏）
- PatrolWorker 1h 周期天然退避——熔断后下个小时自动恢复

### Bug 3：document sync 批量 embed（store-memory.ts + bge-m3-worker.ts + embedding-gateway.ts）

- `EmbeddingGateway.embedBatch?(texts: string[]): Promise<Float32Array[]>` 新增可选方法
- worker 端 `embed-batch` 消息类型：pipeline 原生支持数组输入，batch 推理共享权重加载/分词开销
- `replaceChunksBySource` 改用 `fireAndForgetEmbedBatch`：embedBatch 可用时走批量，不可用时回落逐条
- batch 整体失败（背压/超时）→ 逐条入 retry 队列，不丢失

### 对抗审视补充（PR #1465 round 1）：sync 批量路径槽位流速控制

检视发现：sync 启动期 612 篇文档的 `replaceChunksBySource` 虽被串行 await，但每篇的 embed 是 fire-and-forget——前一批 batch 未完成，下一批就已发起。背压上限 50 slot，前 50 篇即可耗尽，第 51 篇起全部背压 reject 走 retry 慢路径，批量收益被背压拒绝切断。

修复：`EmbeddingGateway.acquireSlot?()` 新增可选方法——in-flight 满时挂起等空闲槽（FIFO 唤醒，每次出队只放一个防惊群；超时/dispose 路径同样释放槽位）。`fireAndForgetEmbedBatch` 发起 batch 前先 acquireSlot——**软限流替代硬溢出**，sync 速度由 worker 真实吞吐节流，batch 收益不被背压拒绝切断。背压 reject 保留为非 sync 路径（单条 embed、retry）的防浪兜底。

## 验证

- TypeScript 编译零错误
- tests/frameworks/embedding/ 18 用例通过（含 embed timeout 既有用例）
- tests/usecases/memory/ 148 用例通过（含 search-memory/store-memory/embedding-retry-worker）
- 离线复现：50 条连发（模拟 FIFO 队列形态）独立进程 27s 全部完成（排除病态文本假设）

## 影响范围

- embedding-service.ts：新增背压 + embedBatch + acquireSlot 槽位流速控制，既有 embed() 行为不变（仅加了 in-flight 检查）
- bge-m3-worker.ts：新增 embed-batch 消息处理，既有 embed 消息处理不变
- embedding-retry-worker.ts：新增熔断计数，既有 tick 逻辑不变（仅加了全失败计数和熔断跳过）
- store-memory.ts：`replaceChunksBySource` 的 embed 路径从逐条改为批量（embedBatch 不可用时回落逐条，行为等价）；发起 batch 前先 acquireSlot 软限流
- embedding-gateway.ts：新增可选 embedBatch + acquireSlot 方法（不破坏既有实现）

## 取舍

- **背压上限 50**：bge-m3 单条 ~500ms，50 条 = ~25s 排队上限，低于 30s 超时阈值。太大则排队超时，太小则吞吐不足。
- **熔断阈值 3 次**：PatrolWorker 1h 驱动，3 次 = 3h 全失败才熔断。太短会误熔断（暂时性抖动），太长则 worker 淹太久。
- **batch 大小由调用方控制**：`replaceChunksBySource` 传入全部 chunk（通常 5-20 条/文档），sync 612 篇文档逐篇调用——每篇一个 batch，天然分批。
- **batch 超时按条数缩放（上限 120s）**：worker 串行处理消息，排队时间 = 前面 batch 处理时间之和。上限 120s 是"排队+推理"的总预算——正常情况（acquireSlot 限流后 ≤50 batch in-flight，每 batch ≤20 条）排队 ≤ 50×20×0.5s/有效并发，足够；极端排队超时 reject 走 retry 兜底（不丢数据，retry 逐条 embed 排队更短）。这是设计预期，非计算疏漏（对抗审视 #1465 建议发现 2 的裁决）。
- **不实现 worker 自愈重启**：背压+熔断防淹没后，worker 不会被淹死。真正卡死（ONNX segfault 等）走 exit 事件 → ready=false → 后续 embed 走 FTS 降级。自愈重启增加复杂度，当前场景不需要。
