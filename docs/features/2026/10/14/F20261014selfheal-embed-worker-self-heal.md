---
id: F20261014selfheal
title: embedding worker 超时自愈——onnxruntime 竞态假死的 terminate+重建+熔断
summary: onnxruntime 1.23.2 在 Intel x86 mac 上存在偶发 ThreadPool lost-wakeup 竞态（worker 推理卡死永不返回，主线程超时只清 pending，已 postMessage 的消息堆积在假死 worker 队列造成 ~1GB/h 泄漏）。应用层无法修复原生竞态，修复为超时自愈：embed 超时 → terminate 假死 worker（销毁 ThreadPool + 清空消息队列，堵漏的唯一手段）→ workerFactory 重建；熔断防风暴（5min 窗口重启 >3 次 → 降级 FTS5-only）；每次重启落结构化日志让偶发卡死从隐形变显性。
change_type: fix
capability_test: "tests/frameworks/embedding/embedding-service.test.ts（+2 用例：超时自愈重建、窗口熔断；存量 7 条全过 9/9）"
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

**超时自愈（terminate+重建+熔断）**——应用层无法修复 onnxruntime 原生竞态，唯一可行的恢复手段：

1. **embed 超时触发自愈**：`embed()` 超时回调 → `restartWorker()` → terminate 旧 worker（销毁 ThreadPool 上下文 + 清空 MessagePort 队列，堵漏的唯一手段）→ 用注入的 `workerFactory` 重建新 worker
2. **熔断防风暴**：5min 窗口内重启 >3 次 → `circuitBroken=true`，`available=false`，embedding 降级 FTS5-only 直至进程重启（防无限重建消耗资源）
3. **可观测**：每次重启落 warn 日志（含窗口内计数），熔断落 error 日志——让"偶发卡死"从隐形变显性

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
