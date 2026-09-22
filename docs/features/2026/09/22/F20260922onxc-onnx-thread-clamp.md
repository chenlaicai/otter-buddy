---
id: F20260922onxc
title: 钳制 onnxruntime intra-op 线程数：治理 embedding 检索高峰 CPU 打满
summary: issue #1107 排查修正——推理已在 worker 线程（非主进程同步执行），真实问题是 onnxruntime 线程池默认核数 + SpinPause 忙等自旋把进程 CPU 打到 ~9 核；修复为 session_options.intraOpNumThreads 钳制为 2（env 可覆盖）
change_type: fix
capability_test: "n/a: 线程池钳制行为用最小复现脚本 scripts/verify-onnx-threads.mjs 固化（修复前后线程数对照），embedding 单测回归（tests/frameworks/embedding/ 18 通过）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [embedding, onnxruntime, performance, worker-threads]
modules: [src/frameworks/embedding/bge-m3-worker.ts, scripts/verify-onnx-threads.mjs]
---

# 钳制 onnxruntime intra-op 线程数（issue #1107）

## 预注册（troubleshooting 步骤 1）

- **X（预期根因方向）**：embedding 推理已在 worker 线程，891% CPU 是 onnxruntime 内部线程池自旋等待烧 CPU，非主进程同步推理
- **Y（验证标准）**：采样文件中 onnxruntime 栈挂在线程池 worker 线程而非 main-thread，且存在大量 SpinPause
- **Z（反例方向）**：若采样显示 onnxruntime 栈在 main-thread（uv_run 下），则 issue 描述成立

**预期 vs 实际对照**：预期命中。采样证据精确命中 Y——onnxruntime 推理栈挂在 `Thread_29419242: WorkerThread`，main-thread 热点是 SQLite FTS5。

## 排查结论

### 现象（issue #1107 报告）

主进程（PID 99858）CPU 891%，3 秒采样热点栈几乎全是 onnxruntime 推理算子。issue 假设「bge-m3 推理在主进程内同步执行」。

### 证据链

1. **推理已在 worker 线程**（置信度：高）
   - 代码：`src/frameworks/embedding/embedding-service.ts:218` 创建 `Worker` 跑 `bge-m3-worker.js`，主线程只 postMessage
   - 采样：`/tmp/99858-sample.txt:1428` `Thread_29419242: WorkerThread` → `node::worker::Worker::Run()` → 1450 行 `InferenceSession::Run`（692 样本）
   - 反例排除：main-thread（`Thread_29418060`）热点是 `sqlite3_step` / `fts5NextMethod`（FTS5 检索），无 onnxruntime

2. **CPU 打满的真实机制**（置信度：高）
   - onnxruntime 默认 `intraOpNumThreads = 物理核数`（M 系 ~8-10）：采样文件 2386 行起多个匿名线程 `PosixThread::ThreadMain → WorkerLoop`
   - 线程池任务间隙**忙等自旋不放核**：采样 288+121 次 `SpinPause`（1467/1470 行），WorkerLoop 553 样本/676 占线程大头
   - 效果：单条 embed 期间 ~9 线程打满 → 进程级 891%，与主事件循环/SSE/HTTP 抢核

3. **修复可行性**
   - `@huggingface/transformers` 4.2.0 `pipeline()` 支持 `session_options` 透传（`node_modules/@huggingface/transformers/types/pipelines.d.ts:42`）

### 根因

onnxruntime 线程池未钳制：默认核数线程 + 自旋等待策略，在「串行队列处理 embed」的 worker 场景下纯浪费——embedding 请求本就逐条串行处理（`store-memory.ts:163` M16），intra-op 并行收益远不抵自旋烧核成本。

## 修复方案

**修法排序①（既有机制内补缺）**：`bge-m3-worker.ts` 的 `pipeline()` 调用加 `session_options: { intraOpNumThreads: 2 }`，`OTTER_EMBED_INTRA_OP_THREADS` env 可覆盖（紧急调参逃生口）。

**机制识别检查点**：逐项未命中——env 读取是进程启动时一次性临时分支（结果被遗忘、不持久化），非新增配置字段/状态/线程/存储/分支/调用路径。不涉净新增机制。

**Modification-Class**: `narrow-fix`

### 为什么默认 2

- embedding 在 worker 内串行队列处理，无跨请求并行需求
- 单次推理 intra-op 2 线程已能吃满大部分 GEMM 并行收益，继续加线程边际收益递减而自旋成本线性增长
- 预期进程 CPU 从 ~900% 降到 ~200% 量级

## 失败证据固化（步骤 5a）

最小复现脚本 `scripts/verify-onnx-threads.mjs`：创建 onnxruntime session 后用 `ps -M` 数进程线程。

**修复前（默认，不钳制）**：
```
baseline (before onnx load): 7 threads
after session create (intraOpNumThreads=default): 14 threads
delta: 7 threads   ← 默认建 7 个推理线程（= 物理核数行为）
```

**修复后（intraOpNumThreads=2）**：
```
baseline (before onnx load): 7 threads
after session create (intraOpNumThreads=2): 8 threads
delta: 1 threads   ← 线程池被钳制
```

回归：`tests/frameworks/embedding/` 3 文件 18 用例全过；`tsc --noEmit` 干净。

## 影响范围

- 仅 `bge-m3-worker.ts` 的 pipeline 构造参数 + 新增验证脚本；无接口/协议变更
- embed 单条延迟预期微增（intra-op 并行度下降），检索非延迟敏感路径，可接受
- 风险：若未来 embedding 改为批量并发模式，2 线程可能不足——届时用 `OTTER_EMBED_INTRA_OP_THREADS` 调大或重评默认值

## 关联

- issue #1107（Closes）
- 历史旁证：F20260803mval（worker 崩溃治理）、F20260811mrpy（worker ready 协议）——本修复是 embedding worker 化之后的第三次治理
