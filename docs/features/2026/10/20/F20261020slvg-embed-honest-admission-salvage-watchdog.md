---
id: F20261020slvg
title: embedding 诚实准入 + 结果 salvage + 无进展看门狗——根治「超时≠取消」缺位导致的写 lane 活锁
summary: '#1521 双 lane 上线当天写 lane 活锁 4h40m（200% CPU、RSS 10.9G、重试 100% 超时、2905 backlog 零收敛）。真根因是 12 次提交从未建立的「超时≠取消」不变量：超时只删主进程 promise 并提前释放槽位，worker 照算、结果静默丢弃、任务回队列无限重算。修复：超时只标记 abandoned，条目保留到 worker 响应（准入量测 worker 真实占用）；晚到结果经 salvage 回调落库去重；「死」的判定从墙钟超预算改为「lane 占用且无任何响应 5 分钟」看门狗。'
change_type: fix
capability_test: "n/a: 纯软件边界内的代码逻辑改动（A 类，IPC 协议/背压/持久化语义），无 LLM 参与行为"
modules: [embedding, memory]
created_in_conversation: 9de64f08-cee0-46a3-93bb-745069205182
causal_links:
  - F20261016ebrt（#1521 双 lane + 慢≠死 + 泄洪——本特性修其上线当天暴露的活锁；「慢≠死」由看门狗承载更彻底的语义）
  - F20261015kill（#1520 进程隔离——SIGKILL/代际隔离基础设施本特性全量复用）
  - F20261015selfheal（#1493 超时自杀——第一代「死」判定，误杀慢 worker；本特性是第三代判定）
  - F20261013ebps（#1465 淹没背压——「结果丢弃」唯一一次被文字承认（「算出来的向量无人消费」）但从未修；本特性补上 salvage）
  - F20260819x222（#306 embed 加 30s 超时——「超时≠取消」模式的起点）
related_issues: [1453, 1460, 1521]
---

# embedding 诚实准入 + 结果 salvage + 无进展看门狗

## 事故（2026-10-16 09:34–14:15，本特性根因分析并入）

#1521（F20261016ebrt，读写双 lane + 慢≠死 + 回填泄洪）09:32 合入，服务 09:34 带新代码重启。当天写 lane worker 即陷入活锁 4h40m：

| 现场证据 | 数值 |
|---|---|
| 写 lane worker CPU | 持续 ~200%（采样确认满负荷 GEMM，非死锁空转） |
| worker RSS | 9.4G → 10.9G（8 分钟内），物理占用 23.5G，全机 swap 抖动 |
| 重试 embed | 09-12 时每小时 ≤1 条超时，13:00 起 100% 超时（35 条/h） |
| backlog | 2905 条 pending 全部 due，**零收敛**（commit 预估 1000，实际 3 倍） |
| worker 重启次数 | 0（「慢≠死」闭锁了唯一逃生通道） |

### 机制链（每一步都有代码/日志实证）

1. 超时后只删客户端 pendingRequests 条目 + `releaseSlot()`，但消息已 send 进 worker——**worker 照算**（不可取消、不可抢占）
2. worker 算完回结果，`handleResponseMessage` 找不到 pending → **静默丢弃**（不计任何观测指标）
3. 任务没完成 → 保持 pending → 下个整点 tick 重新 claim → 重新 send → **无限重算**
4. 槽位提前释放 → 新请求立即准入排在没算完的旧消息后 → 队列雪崩 → 内存暴涨 → swap 抖动 → 推理更慢 → 全超时
5. `restartWorkerIfHung` 只在「本代零成功」才杀——worker 早上成功过几条 → 永不重启

这是活锁的精确定义：worker 100% 忙、有效吞吐趋零、自愈机制被语义合法闭锁。

## 历史时间线：为什么修了 12 次还在修

| 时间 | 事件 | 修了什么 | 埋了什么 |
|---|---|---|---|
| 07-13 | F20260713i5k2 | bge-m3 worker_threads 跑推理 | 埋下「推理不可取消、队列深度不可见」全部结构前提 |
| 08-19 | F20260819x222（#306） | embed 加 30s 超时 | **「超时≠取消」模式定型**——超时只删 promise，worker 侧照算 |
| 08-24 | R20260821tutv | onnxruntime 升 1.23.2 | lost-wakeup 竞态入场（原罪层） |
| 09-15 | F20260915qvrc（#948） | retry tick 30s→1h | 吞吐掉 120 倍，积压 4 天 |
| 09-22 | F20260922onxc（#1107） | intra-op 线程钳制 | SpinPause 死锁信号被误诊为负载浪费，掩盖 3 周 |
| 10-13 | F20261013ebps（#1465） | 背压 + 熔断 + embedBatch | **「结果丢弃」被文字承认一次，未修**；槽位释放路径被验证「无泄漏」——但问的问题是错的方向（没问「释放后 worker 还在算」） |
| 10-15 | F20261015selfheal（#1493） | 超时自杀 + MAX_IN_FLIGHT=1 | 误杀慢 worker；terminate 打死主进程 |
| 10-15 | F20261015kill（#1520） | child_process + SIGKILL | 读写仍共管道 |
| 10-16 | F20261016ebrt（#1521） | 双 lane + 慢≠死 + 泄洪 | **当天活锁**（本特性） |

**贯穿 12 次提交从未出现的原语**：worker 侧背压/取消/结果复用协议。所有修复（背压 50、串行 1、双 lane、泄洪）都假设「发出去了就当它在算」，准入门控量的是主进程 promise map 大小，而真实瓶颈在 worker 消息队列深度——**口径错配**。

## 三个缺陷与修复设计

核心原则：**准入门控量测 worker 真实占用，不是调用方耐心；超时只是「调用者不再等」，不是「工作取消」；晚到结果必须被 salvage 而非丢弃；「死」= 无响应，不是墙钟超预算。**

### D1 槽位语义修正（超时≠取消的不变量）

`embed()`/`embedBatch()` 超时 handler：只标记 `abandoned=true` + reject 调用方，**条目保留、槽位不释放**，直到 worker 响应（成功/错误）才删条目 + 释放槽位。准入从此与 worker 占用严格一致：每 lane 最多 1 条 outstanding，队列不可能在 worker 侧积压。

### D2 结果 salvage 协议

`embed(text, opts?)` 接口加可选 `{ salvage }` 回调（`EmbeddingGateway` 接口扩展，单参调用完全向后兼容）。晚到的成功结果交 salvage 持久化：

- retry worker：`salvage = storeEmbedding + markTaskDone`（任务行删除即去重）
- store-memory 单条/batch 路径：同构
- service 侧包裹 `Promise.resolve().then().catch()` 吞错——防 salvage 同步 throw 沿 EventEmitter 冒泡成 uncaughtException 打死主进程
- 晚到 error 响应：清理条目 + warn 日志，任务留 pending（retry 队列兜底）

**双轨语义**：超时 catch 仍走 enqueueRetry 兜底（salvage 是机会主义的——worker 被看门狗杀掉时无 salvage，任务必须在队列里）；salvage 成功 markTaskDone 删行去重。窗口内（timeout → salvage 完成）任务可能被下个 tick 重复 claim 重算一次——`storeEmbedding` 是 DELETE+INSERT 幂等覆盖写，收敛不发散，接受。

### D3 无进展看门狗（「死」的判定第三代）

前两代都失败：#1493「超时自杀」误杀慢 worker；#1521「慢≠死」（零成功才杀）闭锁活锁逃生通道。本代判定与墙钟完全解耦：

- `lastWorkerActivityAt` 在每次 send、每个响应（result/error/batch-result）、ready、重建时刷新
- 60s interval tick（unref）：lane 有 outstanding 且 `now - lastActivity > 300s` → restartWorker
- **慢而健康（响应持续到达）永不触发**；**真死锁（SpinPause 永不返回）必触发**
- 删除 `restartWorkerIfHung` 超时触发路径；保留 restartWorker/killAndResetOldWorker/3 次每 5min 熔断/结构化快照观测

### D4 背压语义修正

- 新增 `EmbedBackpressureError` 专门类型（原背压 reject 是普通 Error，retry worker 会计入 maxAttempts → 3 次埋掉可恢复任务——又一个潜伏坑）
- retry worker 见背压：不计 attempts、终止本轮 drain（lane 满了继续 claim 只会堆积）
- `waitSlot: true` 选项：写路径槽满挂起排队（软限流）而非弹回 retry 队列等 1h tick——回填泄洪期间活消息也能及时 embedding。查询路径保持默认 fail-fast 走 FTS5（不排队）
- **修存量 bug A**：embed 背压检查原来只查 `pendingRequests.size`（batch 占槽期间单条可钻入，破坏 MAX_IN_FLIGHT=1 串行前提），统一为两 map 总和
- **修存量 bug B（TOCTOU）**：原 acquireSlot→embed 两步配对在「唤醒→准入」之间有 microtask 竞态窗口；waitSlot 循环内嵌进 embed/embedBatch，「唤醒重查→准入→set+send」在同一同步段原子完成
- retry worker `tickNow` 重入守卫（原 `inflightTick` 是从未赋值的死字段）：waitSlot 节流后单个 tick 可能跑几十分钟，防 PatrolWorker 并发 tick

### D5 worker 显式串行

bge-m3-worker `process.on("message")` 套 promise chain。现状 onnxruntime-node 的 session.run 原生同步阻塞，「串行」是事件循环停摆的偶然结果；显式化防未来换异步 backend/IOBinding/worker_threads 时依赖偶然性。chain 停摆（原生挂死）由主进程看门狗兜底，语义不变。

## 耦合旋钮警示（#948 教训：调一个旋钮必须核对相邻旋钮）

| 旋钮 | 值 | 耦合约束 |
|---|---|---|
| `WATCHDOG_NO_PROGRESS_MS` | 300s | 必须 > batch 超时预算上限（120s）× 安全余量。**放宽 BATCH_TIMEOUT 或 BATCH_LIMIT 时必须同步调整** |
| batch 超时预算 | `min(max(N×5s, 30s), 120s)` | 决定健康最坏 batch 时长，是看门狗阈值的下界依据 |
| `EMBED_TIMEOUT_MS` | 30s | 调用方耐心，与正确性解耦（salvage 兜底）——但影响 FTS5 降级时机与 warn 噪音 |

## 明示接受的残余风险

1. **重复计算窗口**：timeout → salvage 完成之间任务仍 pending，下个 tick 可能重算一次（幂等，收敛不发散）
2. **孤儿 vec 行**：晚到 salvage 可能给已被 replaceEntriesBySource 删除重建的 entry 写 vec（窗口比原 30s 宽到分钟级）。searchVec 有 `JOIN memory_entries` 守卫，孤儿永不浮现搜索结果，惰性垃圾接受（~4KB/条）
3. **极端健康长 batch（~4min+）可能被看门狗误杀一次**：熔断内自愈；按 `embedding_worker_restart` 快照的 workerAgeMs/超时画像校准阈值
4. **双 lane 常驻 ~4.5G 内存**：ebrt 已接受的代价，不变

## 观测增强

- 重启快照新增 `outstandingRequests`（重启时在途数）与 `workerSalvagedResults`（本代 salvage 命中数——原先是不可观测的静默丢弃）
- `lastTimeoutContext.inflight` 语义变化：超时后条目不再自删，inflight 含自身（测试断言同步更新）

## 测试

- `tests/frameworks/embedding/embedding-service.test.ts`：重写 5 个「超时→重启」为看门狗驱动（`setTestWatchdogOverride` + 直接调 `watchdogTick()` 模拟心跳，确定性）；新增：超时槽位保留+背压拒绝、晚到 result 触发 salvage 并释放槽位、晚到 error 清理、salvage throw 不 crash、waitSlot 排队、持续有响应不被看门狗杀、dispose 后看门狗不触发、worker 崩溃唤醒 parked waiter fail-fast
- `tests/usecases/memory/embedding-retry-worker.test.ts`：新增 EmbedBackpressureError/EmbedTransientError 不计 attempts、纯超时轮不进熔断（吸收态修正）、超时后 salvage 落库+markTaskDone 去重、tickNow 重入守卫、resetPendingAttempts 赦免
- `tests/usecases/memory/store-memory.test.ts`：acquireSlot 配对用例改写为 waitSlot+salvage 传递断言
- 全量 `npm test` 5750 passed；`tsc --noEmit` 干净

## 对抗审视（两轮独立 agent + 用户拍板）

初版实现跑了两轮独立对抗审视（并发不变量攻击 + 端到端语义攻击），发现 5 个叠加洞，用户裁决全修 + 存量 attempts 上线前重置：

| # | 洞 | 严重度 | 处置 |
|---|---|---|---|
| 1 | **waiter 悬挂**：error/exit/熔断三条路径清 pending 但不唤醒 slotWaiters；parked waiter 无超时兜底，挂死经 tickNow 堵死整个 PatrolWorker（对账/信号扫描全停） | P1 | 三路径补 `drainSlotWaiters()`；waitSlot 循环醒来后检查 `loadError` fail-fast（重建路径 loadError=null 走新 worker，死亡路径 fail-fast 不 send 死 worker） |
| 2 | **埋单链**：claim 即 attempts+1，超时循环把 attempts 撑到 ≥3；worker 重启/崩溃的 reject 走普通 Error → `markTaskAttemptFailed` → 成批 dead-letter（判死看被撑大的 attempts）。2905 存量积压大量 attempts>3，上线即批量暗化 | P0 | 新增 `EmbedTransientError`：重启/崩溃/熔断/send 失败/dispose 全部改用它 reject；retry worker 见它不计 attempts。**用户拍板：启动迁移 `resetPendingAttempts()` 赦免存量 pending 的 attempts（每次启动执行，与 M8 迁移 includeDead=true 复活 dead 自洽）** |
| 3 | **熔断吸收态**：纯超时轮计入「全失败」，3 轮后 retry worker 自我砖化且无重置路径（salvage 成功不回哺）——推翻「首个 tick 吃 1000 条」的收敛承诺 | P1 | 「全失败」收窄为「零成功且有硬失败（markTaskAttemptFailed 路径）」；纯超时轮是 lane 慢的正常路径，不计入 |
| 4 | **PatrolWorker 阻塞**：tickNow waitSlot 节流后可跑几十小时，串行 duty 全饿死 | P1 | `MAX_TICK_MS = 10min` 时间预算，任务边界检查，到点即收下个 tick 续 |
| 5 | send 同步 throw（channel closed）时条目泄漏 map → lane 永久堵死；salvage 命中无日志、观测指标与代码不对齐 | P2 | send try/catch；`Embedding salvage landed` info 打点 + tick 收尾 `embedding_retry_tick_summary`（claimed/succeeded/timedOut/hardFailed） |

**审视中确认通过的部分**：waitSlot 原子性论证、salvage 闭包捕获、worker promise chain 可 GC、abandoned+rejectAllPending 无 unhandledRejection、双轨时序（enqueueRetry 必先于 salvage）、enqueueRetry 与 markTaskDone 去重闭环、全部写路径调用方已覆盖（signal-pipeline/RHI/sync 经 StoreMemory 收口）。

**明示接受的审视发现**：
- 看门狗 kill 路径无 salvage（SIGKILL 蒸发在途计算）——任务留 pending 重来，一次白算可接受
- killAndReset 一次放行全部 waiter 的瞬时并发突破——worker 串行链兜住，有界
- searchVec 查询不截断 + waitForReady 无超时（存量问题，查询 lane，另立 issue）
- 复审残留 P2（后续小 PR）：claim 即 attempts+1 的膨胀机制未根除（启动赦免+M8 复活兜底，后果有界）；retry worker 自身熔断触发后进程内无归零路径（存量单向门，本次已把触发面收窄到连续 3 轮全硬失败）；熔断 loadError 用 EmbedTransientError 承载永久状态（命名失真，无实害）

## 不做的事

- **取消协议（向 worker 发 cancel 消息）**：诚实准入下每 lane 最多 1 条 outstanding，被浪费的计算至多 1 条在途请求，取消协议的复杂度不成比例
- **降级 onnxruntime / 换量化模型**：延续 selfheal/kill/ebrt 三连裁决（无证据 1.22 无此竞态、与根因无关）
- **worker pool / 优先级队列**：延续 mrcq/ebrt 裁决（串行是原生约束，双 lane 已物理隔离读写）
- **storeEmbedding 加 entry 存在守卫**：searchVec 的 JOIN 已挡住孤儿浮现，守卫属过度设计

## 上线观察指标

- 写 lane worker RSS 稳定在模型量级（~2.3G），不再单调增长
- `embedding_tasks` pending 数逐 tick 单调下降（当前积压 2905）
- 无 `embedding_worker_restart` 风暴；快照中 `workerSalvagedResults` > 0 即 salvage 在救命
- 日志无「Embedding retry timeout」持续刷屏（超时应回归零星）
