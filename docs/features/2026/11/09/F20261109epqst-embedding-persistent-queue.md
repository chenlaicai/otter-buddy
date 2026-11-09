---
id: F20261109epqst
title: embedding 后台统一持久化队列根治——删除 RAM 长队双账本
summary: 根治 2026-11-09 生产旧任务饿死（1000 条 1h+ 0 出队）：后台任务统一先落 embedding_tasks（单一账本），retry worker 批量消费；删除 store-memory RAM 长队（fireAndForgetEmbedBatch/bulkInFlight/acquireSlot）；waitSlot 全部有界（超时摘除 waiter）；启动即消费存量。
change_type: fix
capability_test: 'n/a: 后台行为修复，无用户可感界面；验证走行为测试（12 用例）+ 真实 bge-m3 ONNX 吞吐 + alpha 隔离实例端到端'
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  from:
    - F20261105embqg
    - F20260812mrcq
    - F20261013ebps
    - F20261020slvg
  supersedes: []
tags: [embedding, memory, queue, persistence, liveness]
modules:
  - src/usecases/memory/store-memory.ts
  - src/usecases/memory/embedding-retry-worker.ts
  - src/usecases/memory/embedding-gateway.ts
  - src/usecases/memory/memory-queue.ts
  - src/frameworks/embedding/embedding-service.ts
  - src/frameworks/db/memory/embedding-task-queue.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/bootstrap/memory.ts
created_at: 2026-11-09
intent:
  problem: "后台 embedding 任务双账本：doc sync 把数千条文本预占进 RAM slotWaiters（fireAndForgetEmbedBatch→acquireSlot→embedBatch 三步配对），DB embedding_tasks 只见 retry；retry worker 逐条 embed(waitSlot 无超时) 挂在 bulk 长队队尾，tick 永久 inflightTick，旧任务 0 出队（生产实锤：09:14 迁入 1000 条，09:16 claim 50，至 10:22 出队 0；worker ~200% CPU 在做真实 ONNX 但队列无进展）"
  expected_effect: "旧任务与 doc chunk 同队列公平调度（priority ASC, next_retry_at ASC）持续出队；RAM 只剩实时短通道（fireAndForgetEmbed）有限在飞；所有 waitSlot 有界（默认 60s，超时 EmbedSlotTimeoutError + waiter 摘除）；重启后启动即消费存量任务；pendingTaskStats（最老任务年龄/优先级分布）可观测"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "修复前失败复现（tests/.../embed-slot-wait-bounds F1/F2 + embedding-persistent-queue P1/P2/P3/P7/P-unavailable/P8 共 8 用例红，输出已存档）：waitSlot 无限挂起；洪峰任务不落库（DB pending=0）；retry 逐条 embed 无批消费"
      - "修复后同套 12 用例绿：P1 45 chunk 全部落库 bulk pending；P2 embedBatch 多条批消费；P3 洪峰+旧任务单 drain 周期全部出队；P3b 120 条跨轮持续出队；P4 live 直通优先；P5 批 store 失败回队；P6 重启恢复不丢不重；P8 stats 可观测"
      - "真实 bge-m3 ONNX（非 mock）：120 条真实中文 chunk 落库 67ms（RAM inFlight=0/waiters=0）→ drain 120/120 完成，0 超时 0 失败，1.13 条/s，token 闸门自动分批（50→2 子批）"
      - "alpha.sh 隔离实例端到端：注入 60 条存量任务重启 → 启动即消费 60/60（claimed=60 succeeded=60 timedOut=0 hardFailed=0，向量 60/60 写入 vec 表，SqliteError=0）；注入 40 条立即重启 → 40/40 恢复消费；真实模型双 lane 加载"
    rollback: "git revert 本 PR 单 commit 即回退；无 DB schema 变更（复用 embedding_tasks 现有列），无配置迁移；旧机制删除点见 retirement handover"
    risk_note: "批量消费语义变化：单批内 store 失败逐条回队（原来 batch 整体失败逐条入队，语义等价）；waitSlot 默认 60s 上界对极端慢 worker（单批>60s 排队）会周期性重排——由退避自然吸收，不丢任务"
---

# 背景

2026-11-09 生产实锤（主仓 pid3964 / worker3999）：09:14 启动迁入 1000 条 dark tasks，09:16:36 claim 50，至 10:22 旧任务 0 出队。worker ~200% CPU 做真实 ONNX（bge-m3），doc bulk 在内存 inFlightBulk 约 2000——CPU 在忙、队列无进展，典型的**活性饿死**而非死锁。

搭档原话（2026-11-09 10:39）：「按根治来（题外话，我点击按钮无反应，难道是bug？）」。

## 根因（代码锚点）

三层叠加：

1. **双账本**：`store-memory.ts` `fireAndForgetEmbedBatch` 把整批 chunk 预占进 RAM（`acquireSlot` → `slotWaiters` 长队 → `embedBatch(waitSlot:true, priority:bulk)`），DB `embedding_tasks` 完全看不到这些工作——pending 表读数为 0 但实际 ~2000 条 bulk 在内存排队。重启即丢（RAM 队列清零，chunk 成暗条目等下次 sync）。
2. **waitSlot 无界**：`embedding-service.ts` 的 waitSlot 循环 `while(full) await new Promise(resolve => slotWaiters.push(...))` 无任何超时。retry worker tick claim 50 后第一条 `embedWithSalvage → embed(waitSlot:true, priority:2)` 挂进 bulk 长队队尾——bulk 2000 条 × 每条槽位等待 = 实际永不轮到。
3. **tick 挂死传导**：`MAX_TICK_MS` 只在任务边界检查，第一条 embed 挂住 = `inflightTick` 永久挂起 = patrol 后续 duty 全部饿死（同型历史：F20261013ebps PR1465 retry 落后文档洪峰）。

F20261105embqg（PR1790）的生产端水位闸门（S3 联合水位）治了「洪峰灌入」没治「消费侧结构」——pending=0 时首次洪峰照样全提交进 RAM（水位含 bulkInFlight 但 RAM 队列本身仍是第二账本）。独立方案审视（检视獭-embedding方案）确认根治方向：统一持久化 + 有界等待 + 批量消费 + 重启验收。

# 方案

**删除/收窄（Modification-Class: scope-reduction）**——不叠新调度器，把管辖错误的双账本收成单一 DB 账本：

## 1. 后台任务统一落库（store-memory.ts）

`replaceChunksBySource` 不再调 `fireAndForgetEmbedBatch`，直接逐条 `enqueueRetry(entry.id, bulk)` 落库（ON CONFLICT 去重幂等）。同步路径不再依赖 gateway 可用性——worker 不可用时任务照样落库，恢复后由消费者吃掉。

**删除**：`fireAndForgetEmbedBatch`（~100 行）、`bulkInFlight` 计数、`DOC_CHUNK_GATE_BATCH` 分批闸门（S3 闸门的 doc sync 分支——队列深度水位本身保留，见 retirement handover）。

RAM 侧唯一合法批量等待入口收敛为 `fireAndForgetEmbed`（实时消息粒度，每次 1 条文本）。

## 2. waitSlot 有界（embedding-service.ts + embedding-gateway.ts）

- `waitForSlotOnce(priority, waitTimeoutMs)`：每轮挂入 `slotWaiters` 带超时 timer；超时 **reject `EmbedSlotTimeoutError`（继承 EmbedTransientError——retry 不计 attempts）并从队列摘除**（死 waiter 不占唤醒名额——不摘除的话 releaseSlot 可能把槽位发给已放弃的 waiter，白白丢一次槽位流转）。
- `embed()`/`embedBatch()` 的 waitSlot 循环统一走 `waitSlotWithBounds`（新 helper，降两入口复杂度）；默认 60s（单批 embedding 最长 120s BATCH_TIMEOUT 同量级），调用方可 `waitTimeoutMs` 覆盖。
- `releaseSlot`/`drainSlotWaiters` 唤醒 waiter 时同步清 timer。

**删除**：`acquireSlot`（接口与实现）——waitSlot 已内嵌 embed/embedBatch，独立槽位获取是双账本时代的三步配对残留（acquireSlot→embedBatch 的 TOCTOU 曾是 #1465 修复点，F20261020slvg 已把 waitSlot 内嵌后该接口无调用方）。

**新增**：`get stats: { inFlight, pendingWaiters }`——RAM 侧在飞/等待深度快照（可观测性不变量 ③）。

## 3. 批量消费 + 后台 drain（embedding-retry-worker.ts）

- `processClaimedTasks` → `processBatchSlice`（embedBatch 路径）+ `processTasksSingly`（单条回落，保留 salvage 双轨）：claim 的整批按 `EMBED_BATCH_SIZE=50` 组批串行 `embedBatch(waitSlot:true, priority=batchPriority)`，service 层 token 闸门（8192）再拆过大的批。worker 原生 embed-batch 一次前向（检视报告核实 transformers pipeline 支持批量）。
- `tickNow` 改**触发式**：守卫检查 + 有积压时 fire-and-forget 启动 `runBackgroundDrain`（轮间冷却 100ms 让出事件循环；MAX_DRAIN_ROUNDS=20 × BATCH_LIMIT=50=单轮 1000 条上限；10min 时间预算）。**patrol duty 不再被 drain 阻塞**（生产实锤：tick 挂死 1h+ 饿死其余 duty）。
- 错误分类保留原语义并扩展：busy（背压/槽位超时）终止本轮任务留 pending；timeout/transient 不计 attempts；hard 逐条 markTaskAttemptFailed（3 次 dead）。
- 批内单条 `storeEmbedding` 失败 → `enqueueRetry` 回队（ON CONFLICT 保留 attempts，不丢）。
- 熔断（连续全硬失败 3 轮）、退避（30→60→120s 封顶 1h）、ghost 任务分离（entry 已删转 dead）全部保留。

## 4. 启动即消费存量（bootstrap/memory.ts）

`createAndStartRetryWorker` 末尾 `void worker.tickNow()`（fire-and-forget）。根因：`PatrolWorker.start()` 在 buildApp 内同步跑首轮 tick，此时 `postListenInit` 尚未创建 retry worker（duty 跳过），存量任务要等下一个 1h tick——「重启接着处理已有任务」的验收要求不允许这个缺口（生产 09:14 启动能 09:16 消费纯属启动慢的巧合）。tickNow 内部 drainLoop 守卫与 patrol 触发的 drain 天然互斥。

## 5. 可观测（embedding-task-queue.ts + memory-queue.ts）

`pendingTaskStats()`：pending 总数 / 最老 pending 任务年龄（秒）/ 按优先级分布。验收抓手：**最老任务年龄单调下降 = 旧任务持续出队**；年龄停滞 = 消费停摆（生产事故里 09:14 迁入的任务到 10:22 attempts=0 本可用此指标秒级发现）。

# Retirement handover checklist（旧机制退役）

| 退役机制 | 原保护 | 接管方 |
|---|---|---|
| `fireAndForgetEmbedBatch` + `bulkInFlight` + `DOC_CHUNK_GATE_BATCH` | 首次洪峰受限（S3 联合水位，对抗审视发现 1） | **结构性消除**：洪峰不再进 RAM（落库 67ms/120 条），水位判据的 bulkInFlight 分量恒 0；`EMBED_QUEUE_HIGH_WATER`（memory-queue.ts）保留——启动暗扫（bootstrap/memory.ts）仍用它跳过存量迁移，防启动时 DB 被灌爆 |
| `acquireSlot` 接口 | sync 批量路径流速控制（#1465） | waitSlot 内嵌 embed/embedBatch（F20261020slvg 已完成内嵌，本 PR 删残留接口）+ 本 PR 有界等待 |
| retry 逐条 embedWithSalvage 消费 | 失败重试不丢任务 | `processBatchSlice` 批量 + 错误分类同语义迁移；单条路径（批内 1 条/无 embedBatch mock）保留 embedWithSalvage |
| tick 内联 drainRounds（阻塞式） | tick 有界（10min 预算） | `runBackgroundDrain` 后台循环：同 10min 预算 + 20 轮上限 + 不阻塞 patrol duty |
| S2a 槽位优先级唤醒 | live 消息插队（P0 先于 P2） | **保留不变**（releaseSlot 优先级扫描 + claim ORDER BY priority ASC） |

保留不变量：live 优先、worker crash respawn/watchdog/熔断、query/write lane 隔离、批量分片 token budget（8192）、超时晚到结果 salvage 幂等、ON CONFLICT 入队去重、disableVec 双重守卫、dead-letter 3 次。

# 验证

## 修复前失败（存档：对话工作区 evidence/prefix-failure-output.txt）

8 用例红，失败模式与根因一一对应：
- F1/F2（embed-slot-wait-bounds）：waitSlot 300ms 上界请求在修复前无限挂起（测试超时）——无界等待实锤。
- P1/P7/P-unavailable（store-memory）：45 chunk 落库后 DB pending=0（全在 RAM）；gateway.embedBatch 被调用 1 次（RAM 长队存在）；gateway 不可用时任务不落库。
- P2/P3（retry worker）：embedBatch 0 次调用（逐条 embed）；洪峰+旧任务单 tick 46 条仅 1 条完成（饿死）。
- P8：pendingTaskStats 不存在。

## 修复后行为（12/12 绿）

P1 45 chunk 全落库 bulk pending；P2 embedBatch 批消费（多文本单调用）；P3 洪峰+旧任务单 drain 全出队（46/46）；P3b 120 条跨轮持续出队；P4 live 直通 + live 任务先出队；P5 批 store 失败 2 条回队→重试成功；P6 重启恢复不丢不重；P7/P-unavailable gateway 零调用（同步路径解耦）；P8 stats（最老年龄 ≥3500s、优先级分布正确）。

## 全量回归

`npm test`：5749/5750 绿。1 失败 `durable-runtime.test.ts > reopens after a real process SIGKILL` 为 **pre-existing**：`git stash -u` 基线复跑同样失败（证据：evidence/durable-runtime-preexisting-with-change.txt），与 embedding 无关（pi-durable runtime 测试）。lint/typecheck/build 全过。

## 真实模型吞吐（evidence/real-model-throughput.txt）

真实 bge-m3 ONNX（双 lane fork，非 mock）：
- 洪峰 120 条真实中文 chunk（600-1000 字/条）落库 **67ms**，RAM `inFlight=0 pendingWaiters=0`；
- 单 tickNow 触发 drain：**120/120 完成**（claimed=120 succeeded=120 timedOut=0 hardFailed=0），**1.13 条/s**（worker 真实推理节奏）；
- token 闸门自动分批：50 条批 → 2 子批（budget 8192）；
- 120 条向量全部真实写入 memory_vec。

## alpha.sh 隔离实例端到端（evidence/alpha-e2e.txt）

- 轮 1：注入 60 条存量任务（模拟生产 09:14 迁入）→ 重启 → **启动即消费** 60/60（drain_summary claimed=60 succeeded=60），60/60 向量写入（memory_vec_rowids JOIN 验证），SqliteError=0；
- 轮 2：注入 40 条**立即重启**（不等消费）→ 40/40 恢复消费，向量 40/40 写入——重启不丢不重；
- 真实 bge-m3 双 lane 加载；doc sync 启动正常完成。

# 机制判定（R8.5 准入）

本 PR 是**删除/收窄旧机制**（scope-reduction），未新增机制：
- 无新配置开关、无新 DB schema、无新调度器/守护进程；
- 新增 `waitTimeoutMs` 可选参数与 `pendingTaskStats` 查询方法是既有接口的自然扩展（只读观测/参数默认值兜底），不改变任何决策归属；
- 三问：决策者不变（消费调度仍归 retry worker 原逻辑）；靠守卫（waiter 超时摘除是机械保证，测试 F2 断言摘除行为）；深潜成本降（stats 指标 + drain_summary 日志让队列健康可下钻）。

# 风险与回滚

- **回滚**：git revert 单 commit；无 schema/配置迁移。回退后回到 RAM 双账本行为（已知饿死缺陷）。
- **风险 1**：极端慢 worker 下 waitSlot 60s 上界会周期性重排批量消费——由退避自然吸收（任务留 pending 不计 attempts），不丢任务；实时消息受影响时 P4 直通路径不受 bulk 排队影响。
- **风险 2**：批量 embedBatch 单批失败整批按同分类处理（timeout/transient 不计 attempts）——原逐条路径语义等价迁移，但批内「部分坏文本」会拖累同批重试节奏；兜底：3 次 hard 转 dead-letter 后 scanDarkEntries 可见。
- **风险 3**：startup tickNow 在 doc sync 完成前触发可能与 sync 并发消费——claim 原子性（UPDATE...RETURNING）保证不重复，ON CONFLICT 保证入队幂等；alpha 轮 2 已验证重启并发场景。

# 最简实现检查

- 不追求表面极简：复用 embedding_tasks 现有表/attempts/next_retry_at/status/priority 列（lease 语义 = claim 原子推进 attempts + next_retry_at，重启恢复 = resetPendingAttempts 启动迁移既有机制），零 schema 变更；
- 未借机重构无关代码：改动集中在 6 个文件 + 测试；store-memory 删除的 S3 doc sync 分支在本 PR 语义下必然死代码（生产端不再有 RAM bulk），保留会误导后续维护者。
