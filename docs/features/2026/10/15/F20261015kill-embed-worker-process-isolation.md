---
id: F20261015kill
title: embedding worker 进程隔离——terminate 拆 isolate 抛 Napi::Error 打死主进程，改 child_process SIGKILL
summary: F20261015selfheal 的 oldWorker.terminate() 在 onnxruntime InferenceSession 方法回调路径抛 Napi::Error，C++ 未捕获异常 abort 整个主进程（21:22:13 实锤，.ips 栈 InferenceSessionWrap::InstanceMethodCallbackWrapper）。改 child_process.fork + SIGKILL 进程隔离：原生死只带走子进程；并补 worker 代际隔离，防旧 worker 滞后 exit 打回新 worker readyState。
change_type: fix
capability_test: "tests/frameworks/embedding/embedding-service.test.ts（+1 用例：重建后旧 worker 滞后 exit 不得把新 worker 打回未就绪；存量 11 条全过 12/12）"
modules: [embedding, memory]
created_in_conversation: a817159e-ad26-4ede-844a-8a70889f4f98
causal_links:
  - F20261015selfheal（#1493 自愈兜底用 worker.terminate()——治了假死，但 terminate 拆 isolate 时 onnxruntime N-API 回调抛 Napi::Error 打死主进程；本特性改 SIGKILL 进程隔离，自愈语义不变、宿主不再陪葬）
  - F20261013ebps（#1465 淹没背压——同属 #1453/#1460 泄漏家族，本特性闭合「自愈动作本身致死」的最后一环）
related_issues: [1453, 1460]
---

# embedding worker 进程隔离（terminate→SIGKILL）

## 问题

F20261015selfheal 上线后，2026-10-15 21:21:32 启动、21:22:13 主进程 abort，存活仅 39 秒。日志最后一行：

```
libc++abi: terminating due to uncaught exception of type Napi::Error:
```

macOS 崩溃报告 `node-2026-10-15-212216.ips` 栈帧坐实：

```
Napi::Error::ThrowAsJavaScriptException()
Napi::InstanceWrap<InferenceSessionWrap>::InstanceMethodCallbackWrapper   ← onnxruntime-node
...
node::worker::Worker::Run()   ← embedding worker 线程
```

`termination: { byProc: "node", byPid: 3322 }`——**不是被谁 kill 的，是自己 abort 的**。

## 根因

### 直接原因：`worker.terminate()` 拆 isolate 与 onnxruntime N-API 回调竞态

F20261015selfheal 的自愈路径 `restartWorker()`（embedding-service.ts）在 embed 超时后调用 `oldWorker.terminate()`。terminate 会拆掉 worker 的 V8 isolate；而 onnxruntime `InferenceSession` 的实例方法回调（`InstanceMethodCallbackWrapper`）此刻可能仍在途——`ThrowAsJavaScriptException` 在 teardown 路径无法把错误转成 JS 异常，退化成 C++ `Napi::Error` 异常逃逸 → `std::terminate` → `abort()`。

**abort 杀的是整个进程**（worker 线程里 `std::terminate` 同样带走主进程），所以「兜底自愈」变成了「自愈即自杀」。

### 触发时序（21:22 实锤）

| 时间 | 事件 |
|---|---|
| 21:22:01 | `embedding_worker_restart`：batch 超时 9000ms（9 texts），窗口内第 2 次 |
| 21:22:05 | 新 worker 加载 bge-m3 ready |
| 21:22:11 | 最后一条 HTTP |
| 21:22:13 | 主进程 abort（Napi::Error） |

崩溃前 `host.rssMb: 6389`——terminate 只停 JS 侧，onnxruntime ThreadPool 原生线程仍在算，与新建 worker 的模型加载叠加把 RSS 顶到 6.4GB。今天下午 14:34/14:35/15:17/15:18 还有 4 次 V8 OOM 报告，同一压力面。

### 伴生 bug：旧 worker 滞后 exit 污染新 worker 状态

`setupHandlers()` 把 `handleWorkerExit` 绑在 worker 实例上。`restartWorker()` 换新 worker 后，**旧 worker 的监听器还在**——`oldWorker.terminate()` 完成后触发 `exit`，`handleWorkerExit` 执行：

```ts
this.readyState.ready = false;   // 把刚 ready 的新 worker 打回未就绪
this.rejectAllPending(err);      // 拒掉新 worker 的在途请求
```

这是自愈路径的状态污染 bug，与 abort 无关但同属 selfheal 引入的缺陷。

## 修复

### 1. worker_threads → child_process 进程隔离（主修）

- `bge-m3-worker.ts`：`parentPort`/`workerData` → `process.send`/`process.on('message')` + env `OTTER_EMBED_WORKER_CONFIG`
- `embedding-service.ts`：`new Worker()` → `fork(..., { serialization: 'advanced' })`（structured clone 保 Float32Array）；超时自愈 `oldWorker.terminate()` → `oldWorker.kill('SIGKILL')`
- **SIGKILL 不跑析构 / N-API teardown**——onnxruntime 原生死只带走子进程，主进程无感；假死 worker 的 ThreadPool + IPC 队列随进程一并销毁（#1460 泄漏堵漏语义不变）

### 2. worker 代际隔离（伴生 bug）

- 新增 `workerGeneration` 代际号，重建时 `++`
- `setupHandlers()` 捕获当前代际，旧 worker 滞后 `message`/`error`/`exit` 因代际不匹配直接丢弃
- `restartWorker()`/`dispose()` 先 `removeAllListeners()` 再 kill，双保险

## 设计取舍

- **为什么用 child_process 而不是修 terminate 时序**：`Napi::Error` 是 C++ 异常，JS 层 `uncaughtException` 捕不到；terminate 路径的原生回调竞态应用层无法消除（F20261015selfheal 已论证「应用层无法修复原生竞态」）。进程隔离是唯一能把原生死限制在子进程内的边界。
- **为什么 SIGKILL 而不是 SIGTERM**：假死 worker 收不到任何信号处理（卡在 SpinPause），SIGTERM 无意义；SIGKILL 立即销毁，不留半死孤儿。
- **不改超时/熔断/串行化参数**：MAX_IN_FLIGHT=1、RESTART_MAX_IN_WINDOW=3、超时画像快照全部保持——本特性只换「杀进程的刀」，不动自愈策略。
- **serialization: 'advanced'**：默认 JSON 会把 Float32Array 退化成对象，必须走 structured clone。

## 不做的事

- **不降级 onnxruntime**（1.23.2→1.22.x）：竞态在 ThreadPool 代码十年未大改，降级无证据收益，挂起为预案
- **不动 MAX_IN_FLIGHT 串行化治本层**：那是 F20261015selfheal 的根因修复，本特性只修「兜底动作致死」
- **不引入 worker 进程池**：单 worker 串行已够用，池化是过度设计

## 测试

- 存量 11 条 embedding 测试全过（12/12）：超时自愈重建、窗口熔断、batch 超时自愈、结构化快照、背压、槽位 FIFO
- **+1 新用例**：重建后旧 worker 滞后 exit 不得把新 worker 打回未就绪（代际隔离断言 ready 仍为 true、loadError 仍为 null、embed 仍可用）
- build-app 2 个测试文件 11 条全过（stub worker 同步改 process.send）

## 影响范围

- `src/frameworks/embedding/bge-m3-worker.ts`：worker_threads → child_process IPC
- `src/frameworks/embedding/embedding-service.ts`：fork + SIGKILL + workerGeneration 代际隔离
- `tests/frameworks/embedding/embedding-service.test.ts`：mock worker 改 process.send，+1 代际隔离用例
- `tests/app/build-app.test.ts` / `tests/app/build-app-existing-db.test.ts`：stub worker 同步
- 无配置项变更、无 DB schema 变更、无 API 变更、自愈语义不变

## 关联

- 上游：F20261015selfheal / PR #1493（自愈兜底引入 terminate 致死路径）
- 同家族：F20261013ebps / #1465（淹没背压）、#1453（假死首发）、#1460（RSS 泄漏）
- 事故证据：`node-2026-10-15-212216.ips`、`.otter-buddy.log` 21:22:01–21:22:13 时序
