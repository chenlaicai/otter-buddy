---
id: F20261015selfheal
title: embedding worker 假死治本——严格串行化消除 onnxruntime 并发竞态 + 超时自愈兜底 + 观测增强
summary: 根因定论（实验矩阵闭合）：onnxruntime 1.23.2 ThreadPool 嵌套 parallel section 在长文本（>1500 token）× 并发 >1 时必然 lost-wakeup 死锁（并发=1 全过、并发=2 第 8 条卡死、并发=16 第 4 条）。治本：MAX_IN_FLIGHT 50→1 严格串行消除触发条件；兜底：超时 terminate+重建+熔断；观测：重启落结构化快照（三组画像），e2e 现场数据已验证有效。
change_type: fix
capability_test: "tests/frameworks/embedding/embedding-service.test.ts（+3 用例：超时自愈重建、窗口熔断、batch 超时自愈、超时重启结构化快照；存量 7 条全过 11/11）"
modules: [embedding, memory]
created_in_conversation: f7e5e4eb-1c44-4cb2-b5fb-4d10f6f57c6c
causal_links:
  - F20261013ebps（#1465 修淹没背压+retry 熔断——修"淹没"场景，未修"卡死本体"；本特性补上卡死自愈，两者合案 #1453/#1460 才真正结案）
related_issues: [1453, 1460]
---

# embedding worker 超时自愈

## 问题

#1453/#1460 实证：onnxruntime 1.23.2 在 Intel x86 mac（i9-9880H, macOS 26）上跑 bge-m3 fp32 推理时存在**偶发 ThreadPool lost-wakeup 竞态**——`InferenceSession.Run` 内算子执行完毕后，parallel section 退出时唤醒信号丢失，`SpinPause` 死等一个已完成任务的 PosixThread，导致 worker 永久假死。

假死后果链：
1. 主线程 `embed()` 超时只清 `pendingRequests.delete(id)`（embedding-service.ts:259）
2. 已 `postMessage` 的消息永远堆积在假死 worker 的 MessagePort 输入队列（只进不出）
3. retry worker 每 30s 打一条 + 查询路径持续超时 → 队列无限增长 → **RSS ~1GB/h 单调泄漏**（#1460 实证 2.3G→4.8G/2h）
4. worker 卡死后无任何恢复机制——`embedding-service.ts` 只在 `!available` 时懒启动，卡死后不 terminate 不重建 → 永久假死直至进程重启

## 根因定位（2026-10-14 取证）

| 证据 | 内容 | 锚点 |
|---|---|---|
| 卡死精确位置 | `InferenceSession.Run → ExecuteKernel → Add/MatMul/BiasGelu`（正常算子）→ `ThreadPoolParallelSection::~` → `EndParallelSectionInternal` → `SpinPause` | /tmp/emb-sample.txt:660-760 |
| 死锁画面 | onnx PosixThread `2430/2430` 样本在 `WorkerLoop → ulfions_wait`（醒着等活），主 WorkerThread 在 `SpinPause` 等它退出 section | /tmp/emb-sample.txt Thread_21931694 |
| 时间线 | 10/14 PID 43823：08:17:01 模型 loaded → 08:18:18 第一条超时（77 秒），59 条超时 0 成功 | data/logs/otter-buddy.log |
| 版本史 | onnxruntime 1.23.2 于 2026-08-24 升级（R20260821tutv #375），之前版本无此问题；#1107（9/22）已拍到同一 SpinPause 症状（当时误判为负载高） | package.json overrides |
| 复现实验 | 干净 worker 串行 300 次 / 并发 16×400 次均不卡——触发依赖生产宿主环境（V8 isolate 负载 + libuv 竞争），低成本不可复现 | /tmp/repro-worker*.mjs |
| 误诊纠正 | fp32 模型本身正常（50312 条存量向量 + 取证脚本均正常），换 q8 与根因无关（同一 ThreadPool） | 本对话 17:06 搭档质疑后修正 |

## 修复方案

**治本：worker 内严格串行化（MAX_IN_FLIGHT 50→1）+ 超时自愈兜底 + 观测增强**

### 根因定论（10/15 实验矩阵完整闭合）

观测增强在 e2e 环境抓到决定性病发现场（3 次重启快照）：卡死时 inflight=75~100、重建后 0 成功立即再卡、超时请求为 2411 字符长文本（estTokens 1607）。据此设计对照实验（/tmp/repro-long-text.mjs）：

| 配置 | 长文本×并发 | 结果 |
|---|---|---|
| 短文本 × 并发 16 | ~300 字符 | ✅ 400 次全过 |
| 长文本 × 并发 1（串行）| ~2400 字符 | ✅ 30 次全过 |
| 长文本 × 并发 2 | 同上 | ❌ 第 8 条卡死 |
| 长文本 × 并发 4 | 同上 | ❌ 第 6 条卡死 |
| 长文本 × 并发 16 | 同上 | ❌ 第 4 条卡死 |
| executionMode=sequential | 长文本 × 并发 16 | ❌ 卡死（排除）|
| interOpNumThreads=1 | 长文本 × 并发 16 | ❌ 卡死（排除）|

**触发条件确定：长文本（>1500 token）× 并发 >1**——onnxruntime 1.23.2 ThreadPool 嵌套 parallel section 在跨 Run 并发竞争时必然 lost-wakeup。之前「生产环境不可复现」声明作废——是实验设计错误（只用了短文本）。卡死机制与生产栈完全一致（EndParallelSectionInternal → SpinPause，/tmp/repro-sample.txt 与 /tmp/emb-sample.txt 逐帧一致）。

### 三层修复

1. **治本：MAX_IN_FLIGHT 50→1（worker 内严格串行）**——消除触发条件。并发=1 时嵌套 parallel 不跨 Run 竞争，实验证实不卡。吞吐不受损：sync 路径本来就是 acquireSlot 挂起等空闲 → embedBatch 一次一批（一批占一槽，串行节奏不变）；查询路径并发 embed 排队，单次 ~230ms 可接受。
2. **兜底：超时自愈（terminate+重建+熔断）**——任何原生层 hang 都不应永久假死（保留，防未来 onnxruntime 升级引入新竞态）。
3. **观测增强**：重启时落结构化日志 `embedding_worker_restart`（worker 画像/超时请求画像含 inflight/宿主环境快照）——本次根因能钉死靠的就是它抓到的 e2e 现场数据。

## 设计取舍（机制判定前置）

- 命中项：**修法决策树④ 新增机制**
- 为什么必须有：onnxruntime 竞态不可控（实验证实干净进程不复现），无恢复机制 = 一次卡死永久假死+泄漏，无替代路径
- 最小实现：~80 行（restartWorker + 熔断计数 + 测试），不引入新依赖/新进程/新配置项（阈值用常量）
- 后续机制：不生长——onnxruntime 若修复，本机制退化为纯兜底（保留，成本为零）
- 退役条件：onnxruntime 官方确认修复该竞态且升级后观察 30 天无重启日志 → 可移除熔断告警（保留 terminate+重建作为通用兜底）

## 不做的事

- **不换模型/量化**（fp32→q8）：与根因无关（同一 onnxruntime ThreadPool），50312 条向量证明 fp32 正常
- **不立即降级 onnxruntime**（1.23.2→1.22.x）：无证据 1.22 无此竞态（ThreadPool 代码十年未大改），且降级引入回归风险；挂起为预案——若自愈上线后重启频率 >5 次/天再评估

## 测试

- 单测 2 条（`embedding-service.test.ts`「worker 超时自愈」describe）：
  - embed 超时后 terminate+重建，`restartTimestamps` 记录
  - 窗口内重启超限熔断：`available=false`，embed 直接 reject
- 存量 7 条 embedding 测试全过（9/9）

## 影响范围

- `src/frameworks/embedding/embedding-service.ts`：+restartWorker/circuitBroken/workerFactory，embed 超时回调加自愈调用
- `tests/frameworks/embedding/embedding-service.test.ts`：+2 测试
- 无配置项变更、无 DB schema 变更、无 API 变更

## 关联

- 上游：#1453（worker 假死首发）、#1460（RSS 泄漏）、#1107（9/22 同一 SpinPause 症状误诊为负载）
- 前序修复：F20261013ebps / PR #1465（淹没背压+retry 熔断+batch embed——修"淹没"场景，未修"卡死本体"）
- 本特性：修"卡死本体不自愈"——与 #1465 互补，两者合案 #1453/#1460 家族才真正结案
