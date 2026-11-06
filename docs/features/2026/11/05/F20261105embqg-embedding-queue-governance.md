---
id: F20261105embqg
title: embedding 队列治理——生产端闸门 + 任务优先级 + 消费端 respawn
summary: 第一性原理治本：入队端按消费水位限流（D1）、任务与槽位双优先级保活消息（D4）、worker 意外死亡自动重建（D3）。当日实锤 7173 条/秒级灌入 + 外部 SIGTERM 后写 lane 永久瘫痪。
change_type: fix
capability_test: 'n/a: 韧性修复，无用户可感行为界面；验证走单测（respawn/优先级/闸门三组）'
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  from:
    - F20260812mrcq
    - F20261013ebps
    - F20261016ebrt
    - F20261020slvg
  supersedes: []
tags: [embedding, memory, queue, resilience]
modules:
  - src/frameworks/embedding/embedding-service.ts
  - src/frameworks/db/memory/embedding-task-queue.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/usecases/memory/store-memory.ts
  - src/bootstrap/memory.ts
  - src/usecases/memory/embedding-gateway.ts
created_at: 2026-11-05
intent:
  problem: "embedding 队列生产端无闸门（全量操作秒灌数千条）、无优先级（活消息被存量重算堵死）、消费端 worker 意外死亡后写 lane 永久瘫痪"
  expected_effect: "worker 外部 SIGTERM 后自动 respawn 恢复写入；积压期间活消息 embed 延迟从 retry tick 周期（最差 1h）降到单批时长（~14s 量级）；队列深度超水位时全量生产者暂停入队不再淹没消费端"
  verify_by:
    type: behavior_check
---

# 背景

搭档原话（意图锚）：

> 「重启不还是排队挤压吗？我觉得这个设计是否有问题啊。这个堆积问题之前也反复修复好几次了！我严重怀疑是否当前实现机制就是还有问题！你从第一性原理出发来分析下！」
> 「你先做2来治本」

2026-11-05 事故链（全部当日实锤，详见本对话调查）：

1. **13:04:49 一秒内 7173 条任务入队**（DB：`embedding_tasks` 中 7173 条同秒 `created_at`，`last_error='Worker exited with code=null signal=SIGTERM'`，全部为存量文档 chunk）——某实例全量重嵌入操作瞬间灌满队列，主进程日志 13:01-13:16 空洞（写入者非主进程）。
2. 单 worker（写 lane 串行，MAX_IN_FLIGHT=1）满转 8 小时消化不动（200% CPU，真实推理非活锁——`sample` 调用栈 `InferenceSession::Run → MatMul::Compute`）。
3. 18:44 e2e 实例抢占内存（其 worker RSS 峰值 10.8G）→ 32G 物理内存耗尽，swap 10.7G → 单批延迟秒级→30-40 分钟。
4. 21:04 经 restart-service 受控终止膨胀 worker 后，**写 lane 永久瘫痪**：`handleWorkerExit`（embedding-service.ts:463-477）只拒绝挂起请求不重建 worker；watchdogTick 因 `!readyState.ready` 直接跳过（embedding-service.ts:227）——消费端归零且无自愈。

第一性原理定位（对话内已呈报搭档）：堆积 ⟺ 入队速率 > 消费速率；成灾 ⟺ 消费端中断无恢复。六轮历史修复（#1453 背压、#1460 泄漏、F20260812mrcq retry 队列、F20261013ebps 批量、F20261016ebrt 双 lane+泄洪、F20261020slvg salvage+看门狗）全部作用于**消费侧闸门与超时语义**，未触及两个根属性：

- **D1 生产端无闸门**：全量操作（启动暗扫/文档重嵌入/迁移）入队零成本、队列无限容量
- **D4 无优先级**：活消息与存量重算同队，积压期间活消息入库延迟最长达 retry tick 周期（1h）
- **D3 消费端单点**：worker 非自愈路径死亡（外部 SIGTERM）→ 写 lane 永久瘫痪，仅主进程重启可恢复

# 目标

- T1（D3）：worker 意外死亡（exit 事件、非 dispose/熔断路径）后自动重建，写 lane 自愈，不再依赖主进程重启
- T2（D4）：活消息 embed 优先于存量重算——任务表优先级（claim 顺序）+ 写 lane 槽位优先级（排队唤醒顺序）双层保证
- T3（D1）：全量入队路径受消费水位闸门约束——队列深度超阈值时全量生产者暂停入队/发 embed，活消息路径不受闸门影响
- T4：部署后当日积压（7300+ 条）经泄洪通道按优先级有序消化，不再饿死活消息

# 非目标

- **B 惰性补算替代全量重扫**（检索时发现无向量再补）——牵动检索语义与冷启动行为，需独立设计（requirement-analysis 单独立项）
- 不改动 query lane / write lane 双 lane 划分（F20261016ebrt 已定，本次不动）
- 不改动 watchdog 判死语义（F20261020slvg 已定「慢≠死」）
- 不引入多 worker 并行消费（当前瓶颈是内存颠簸而非并行度；多 worker 会加剧内存竞争，与事故放大器同向）
- 不做队列持久化优先级抢占（已开始处理的批不中断）

# 未决问题

- UQ1：13:04 灌入 7173 条的非主进程实例身份未完全定位（日志空洞，写入者已退出）。**不阻塞本 PR**：闸门对任意全量生产者生效，与身份无关。线索：主进程日志 60MB 尾部 143 次 session 归档、另两实例今晨 10:44 同刻启动。留待后续（如复发，闸门日志会记录拦截现场）。
- UQ2：水位阈值 2000 的调参依据是「单 worker 饱和吞吐 ~1h 的队列深度」，上线后按 `embedding_retry_tick_summary` 观测数据再调（见验证节）。

# 方案设计

## S1（T1）：worker exit 自愈重建

`handleWorkerExit`（embedding-service.ts:463）在现有善后（摘缓存、拒挂起、放行 waiter）之后追加重建：

```
handleWorkerExit:
  if disposed → return（现状）
  ...现有善后...
  + attemptRespawn(`worker exited unexpectedly, code=... signal=...`)
```

新增 `attemptRespawn(reason)`（从 `restartWorker` 拆出公共尾部）：

- 复用**同一套**限流与熔断：`RESTART_WINDOW_MS=5min` 窗口内 `RESTART_MAX_IN_WINDOW=3` 次，超限 `openCircuit`（与 watchdog 重启共享 `restartTimestamps`——外部杀与卡死杀是同一类「消费端死亡事件」，共享熔断防风暴：失控脚本反复杀 worker 时 3 次后熔断降级 FTS5-only，不再无限重建）
- 复用 `logRestartSnapshot`（观测增强：重启现场快照含 RSS/loadavg/worker 画像）
- 复用代际机制：`workerGeneration++` + `spawnNewWorker()` + `setupHandlers()` + 画像归零 + `lastWorkerActivityAt=now` + `loadError=null`（让 `waitForReady` 挂起等新 worker ready）

**为什么 exit 路径现在不重建是缺口而非设计**：F20261015selfheal 引入 workerFactory 时 `handleWorkerExit` 早于代际机制（F20261015kill）存在，重建当时只从超时路径接入；后续无外部杀 worker 的生产路径（restart-service 白名单是 #844 之后才引入），缺口未暴露。今日常态化运维（受控终止膨胀 worker）首次踩中。

## S2（T2）：双层优先级

### S2a 写 lane 槽位优先级（embedding-service.ts）

`slotWaiters: Array<() => void>` → `Array<{ priority: number; resolve: () => void }>`；`releaseSlot()` 从「FIFO 弹头」改为「弹最高优先级（数值最小）」；`acquireSlot(priority = 1)` / `embed(text, { waitSlot, priority })`。

活消息路径（store-memory 消息投影 `fireAndForgetEmbed`，store-memory.ts:121）改为 `waitSlot: true, priority: 0`：lane 忙时挂起等槽（最长约一个串行批的时长）而非背压 reject 入队等 retry tick（最差 1h）——消息 embedding 延迟从「tick 周期」降到「单批时长」。

### S2b 任务表优先级（embedding-task-queue.ts + schema.ts）

`embedding_tasks` 幂等加列（沿用 schema.ts:711 既有模式）：

```sql
ALTER TABLE embedding_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 1
-- 0=活消息 1=默认（fact/检索补算/retry 回流） 2=全量重算（文档同步/暗扫）
```

- `enqueueRetry(db, entryId, error, priority = 1)`——消息路径传 0，chunk 路径传 2；`ON CONFLICT DO UPDATE` **不更新 priority**（保留首次入队优先级，防低优先级覆盖高优先级）
- `claimPendingTasks` 选取顺序 `ORDER BY priority ASC, next_retry_at ASC`——积压泄洪期间活消息任务（若有入队）先于 7300 条存量重算被消费
- `claimPendingTasks` RETURNING 增加 `priority`，retry worker 处理链透传（`markTaskAttemptFailed` 不动 priority）

**新增 schema 字段消费方声明（⑥）**：`priority` 的读取方 = `claimPendingTasks`（选取顺序）+ enqueueRetry（写入）；无「先存了再说」的悬空字段。

## S3（T1/T3）：生产端水位闸门

`embedding-task-queue.ts` 新增 `pendingTaskCount(db)`；阈值常量 `EMBED_QUEUE_HIGH_WATER = 2000`（约单 worker 1h 饱和吞吐量级，UQ2 观测后调）。

受闸路径（全量生产者）：

- `bootstrap/memory.ts` `scanDarkEntries` 批量 enqueueRetry 循环（memory.ts:198）：入队前查水位，超阈值 → 跳过本轮暗扫入队并 `logger.warn`（暗条目保持现状，下次启动重扫——正是 retry 队列「可延后」语义的边界）
- `store-memory.ts` `replaceChunksBySource` 批量 embed（store-memory.ts:230 附近）：发 embedBatch 前查水位，超阈值 → 本批不发 embed、不入队（chunk 保持暗条目，FTS5 关键词检索不受影响，向量检索缺失该批——**显式取舍：宁可向量暂时缺失，不灌死消费端**）

**不受闸路径**：活消息（fireAndForgetEmbed，priority 0）、fact（replaceBySource，priority 1）——量小且价值密度高，即使积压也允许入队（claim 优先级保证它们先出队）。

闸门判据单一（队列深度），无时间维度、无自适应——机械可测、行为可预期。

# 影响范围

- 写 lane embed 全部调用方：消息投影（store-memory execute 路径）、fact（replaceBySource）、文档 chunk（replaceChunksBySource）、retry 泄洪（drainRounds）——优先级参数默认值保证不改调用方时行为不变（全部退化为 priority 1）
- `MemoryQueue` 端口接口（enqueueRetry 增可选参数）——sqlite 实现同步改，测试 mock 同步改
- 启动路径：`scanDarkEntries` 在积压超水位时行为变化（跳过入队，日志可见）
- DB schema：`embedding_tasks` 加列，幂等迁移，旧库自动升级，无数据回填（存量行默认 1）

# 风险与约束

- **R1 respawn 风暴**：外部脚本反复杀 worker → 无限重建循环。缓解：与 watchdog 共享 5min/3 次熔断（超限降级 FTS5-only 直到进程重启），熔断路径已有充分历史验证（F20261015selfheal）
- **R2 槽位优先级饥饿**：priority 2 的 chunk 批在活消息持续不断时可能长期排不上。缓解：活消息是脉冲不是恒流（对话间歇），且 chunk 路径有 retry 泄洪兜底（错过的批由下次 tick 重扫暗条目补）——饥饿上界=活消息静默期
- **R3 闸门误伤**：水位 2000 若长期贴近（健康积压），全量路径反复跳过。缓解：跳过是幂等安全操作（暗条目可重扫），且有 warn 日志可观测；阈值是常量可调
- **R4 优先级倒挂**：活消息在 lane 忙时入队（P0）+ 已在槽位排队的 P2 批正在处理——P0 需等当前批完成（不抢占进行中的批）。这是刻意的：不引入批中断机制（复杂度与收益不成比例）
- **R5 与 pi-durable-runtime PR #1783 的交叉**：该 PR 改 session runtime，不碰 embedding 路径；本 PR 改 embedding/memory，无文件级冲突（已核对改动清单）

# 不兼容更新

无破坏性变更。schema 加列幂等、接口参数可选默认、行为变化仅在积压超水位/worker 被外部杀两个异常路径。

# 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 生产端闸门 vs 消费端扩容 | 闸门（S3） | 多 worker 并行消费 | 事故放大器是内存颠簸，多 worker 加剧竞争；闸门消灭「秒灌」这个根属性 |
| 槽位优先级 vs 队列优先级 | 双层都做（S2a+S2b） | 只做一层 | 槽位层管「活请求排队顺序」，任务层管「积压消费顺序」，覆盖两种拥堵形态 |
| exit 自愈 vs 只修 watchdog | exit 接重建（S1） | 文档声明「不许外部杀 worker」 | 运维需要外部终止通道（今日本例）；靠纪律禁操作是前六轮失败的共同模式 |
| 闸门判据 | 单一队列深度 | 深度+增速+时间窗口 | 单判据机械可测；多因子自适应闸门自身会成为新的不可预期机制 |
| 活消息 waitSlot | 消息路径加 waitSlot+P0 | 保持背压 reject 入队 | reject 入队的消息要等 retry tick（最差 1h）；waitSlot 延迟上界=单批时长（~14s 量级） |
| priority 保留语义 | ON CONFLICT 不更新 priority | 冲突时以新值为准 | 防低优先后到覆盖高优先级；同优先级重复入队语义不变 |

## 机制预算四问（净新增机制：schema 字段 priority / respawn 行为分支 / 水位闸门决策分支）

① **谁需要它**：用户（chen）——今天的风扇狂转与「杀 worker 后写 lane 瘫痪」直接损害使用体验；所有依赖记忆检索的 agent 对话（积压期间活消息入库延迟 1h → 检索缺失窗口）。具体角色：运维动作（受控终止 worker）的执行者需要 S1；活跃对话中的 agent 与用户需要 S2；全量同步操作（sync_docs/启动暗扫）的执行链需要 S3 防止自我淹没。

② **失败后果**：S1 失败（respawn 循环）→ 熔断降级 FTS5-only，关键词检索可用，向量检索缺失（可感知但可生存，且熔断有日志）；S2 失败（优先级错序）→ 活消息延迟回到 tick 周期（今天的现状，不更糟）；S3 失败（闸门误关）→ 全量同步延后、暗条目暂缺向量（FTS5 可用），误开 → 回到今天的事故。**三类失败的降级态都不劣于现状**。

③ **后续机制**：priority 字段可能出错的新状态——存量行默认 1 与新语义不一致（部分老活消息任务被当作默认级）：影响=消化顺序次优，修复=一次性 UPDATE 或自然消化；闸门阈值不合适 → R3 描述的反复跳过，修复=调常量（观测 tick_summary）；respawn 与未来多 worker 演进冲突 → 届时 respawn 语义需重定义（单 worker 假设写死在 attemptRespawn）。这些是新机制自带的维护债，已知且 bounded。

④ **退役条件**：S3 闸门在「生产端全部路径天然限速」（如惰性补算 B 方案落地消灭全量生产者）后可退役——信号是 pendingTaskCount 长期 < 100 且无 warn 日志；S1 respawn 无退役条件（worker 单进程模型的永久伴随机制，除非架构改为进程池）；S2 priority 在队列出队速率恒高于入队（无积压世界）后冗余但无害，保留。

## 机制提案准入三问（R8.5）

① **决策者变了么**：无。闸门不替人决策（全量操作仍执行，只是排队延后）；优先级不改变「什么该被嵌入」的决策，只改变顺序；respawn 不改变任何决策归属。本 PR 全部是资源调度与自愈，决策权零迁移。

② **靠自觉还是靠守卫**：闸门是机械代码路径（深度查询+分支，单测覆盖）；优先级是 SQL ORDER BY（机械）；respawn 是事件驱动代码路径。无一项依赖「调用方自觉遵守」——前六轮修复的教训（F20261026emct 注释原话：「靠调用方纪律正是前 6 轮的失败模式」）直接写入设计。语义不可机械判的部分：无（全机械）。

③ **深潜成本降了吗**：升。本次事故的根因链（谁灌入/为何瘫/怎么恢复）此前需要跨 823MB 日志 + DB + 调用栈采样三源交叉才能拼出；本 PR 的可观测性（闸门 warn 日志、respawn 快照、tick_summary 含优先级分布）让同类事件从「考古」降为「看两条日志」。

**P0 负面清单核对**：不命中。无自动巡检替人盯（watchdog 是既有机制且判死不判活）、无随机审计、无产出限速替人排优先级（闸门限的是机器队列灌入速率，不是人的产出；优先级排序是系统内部资源调度，不触碰「agent 产出要不要看」的决策归属）、无自动跳过人类审视环节。

# 验证

## 对抗审视记录（检视獭-1790，3 严重发现全部修复）

- **发现 1（S3 首次洪峰未受限）**：原实现仅预查一次 pendingTaskCount，空队列首次全量灌入（独立复现：2001 条全提交）不受闸。修复：联合水位（pending + 在飞 bulk 计数 bulkInFlight）+ 每 DOC_CHUNK_GATE_BATCH=20 条分批提交前复查，任一时刻在飞 bulk 有硬上界（HIGH_WATER+19）。新测试 embed-queue-review-fixes.test.ts「发现 1」固化独立复现反例。
- **发现 2（retry 优先级执行端丢失）**：claim 返回的 priority 被 EmbeddingTask 类型丢弃，embedWithSalvage 未传；bulk 写库失败回队漏传。修复：EmbeddingTask 加 priority 字段、embedWithSalvage 透传 task.priority、批量回队显式 bulk。新测试「发现 2」验证 live retry 任务 embed 调用携带 priority=0。
- **发现 3（跳过暗条目无运行时恢复路径）**：高水位跳过的暗条目无 pending task、无向量、无后续调度，可能长期无向量。修复：retry tick 空闲时（claimed=0 且 pending=0）有界回填暗条目为 bulk 任务（IDLE_BACKFILL_LIMIT=200/tick，不挤兑 live）。新测试「发现 3」验证空队列 tick 后暗条目以 bulk 优先级入队。
- 检视确认无缺口：S1 respawn 代际/共享熔断、S2a 槽位唤醒、S2b SQL 消费序验证方法。

**单测（新增/扩展）**：

1. `tests/frameworks/embedding/embedding-service.test.ts`
   - 外部 exit（SIGTERM 模拟）后 workerFactory 被调用、新 worker ready 后 `available=true` 恢复（S1）
   - 窗口内 3 次死亡 → 熔断打开、不再重建、`available=false`（S1 共享熔断）
   - 槽位竞争：P0 waiter 先于 P2 waiter 被唤醒（S2a）
   - 消息路径 waitSlot 挂起→批完成→P0 先入（S2a 集成）
2. `tests/frameworks/db/memory/embedding-task-queue.test.ts`（如无则新建）
   - `claimPendingTasks` 优先级序：P0 任务先于 P2 被 claim（S2b）
   - `enqueueRetry` 重复入队不降 priority（S2b）
   - `pendingTaskCount` 计数正确（S3 依赖）
3. `tests/usecases/memory/store-memory.test.ts`
   - 水位超阈值时 `replaceChunksBySource` 不发 embedBatch、不入队、entry 已入库（S3）
   - 活消息 embed 带 `waitSlot+priority 0`（S2a 契约）
4. `tests/bootstrap/` scan-dark-entries 相关：水位超阈值跳过入队 + warn 日志（S3）

**验收标准**：

- A1 全套测试绿（含既有 embedding 测试无回归）
- A2 手工验证脚本（worktree 内 alpha 实例）：灌 2500 条假任务 → chunk 同步被闸门拦截（日志可见）→ 消息 embed 正常完成且不被排队阻塞
- A3 部署后观测（上线 24h）：`embedding_retry_tick_summary` 显示积压单调下降；活消息 `created_at → storeEmbedding` 间隔 P99 < 60s（积压消化期间）

**失败用例证据（bugfix）**：修复前复现——外部 kill 写 lane worker 子进程，观察 `available` 永久 false、后续 embed 全部 EmbedTransientError（本日 21:04-21:35 生产实锤，日志 `"Worker exited with code=null signal=SIGTERM"` 后 retry tick `succeeded=0`）；修复后同操作 → respawn → 恢复。以单测固化该复现（测试名 `respawns-after-external-sigterm`）。

# 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/embedding/embedding-service.ts | M | S1 attemptRespawn + S2a 槽位优先级 + EmbedCallOptions.priority |
| src/frameworks/db/schema.ts | M | embedding_tasks 幂等加列 priority |
| src/frameworks/db/memory/embedding-task-queue.ts | M | enqueueRetry 优先级参数 / claim ORDER BY / pendingTaskCount |
| src/frameworks/db/memory/sqlite-memory-repository.ts | M | MemoryQueue 端口委托签名同步 |
| src/usecases/memory/store-memory.ts | M | 消息路径 P0+waitSlot；chunk 路径 P2+水位闸门 |
| src/bootstrap/memory.ts | M | scanDarkEntries 入队前水位闸门 |
| src/usecases/memory/embedding-gateway.ts | M | embed 选项透传 priority/waitSlot |
| tests/frameworks/embedding/embedding-service.test.ts | M | S1/S2a 测试组 |
| tests/frameworks/db/memory/embedding-task-queue.test.ts | M/A | S2b/S3 测试组 |
| tests/usecases/memory/store-memory.test.ts | M | S2a 契约 + S3 闸门测试 |
| docs/features/2026/11/05/F20261105embqg-embedding-queue-governance.md | A | 本文档 |
