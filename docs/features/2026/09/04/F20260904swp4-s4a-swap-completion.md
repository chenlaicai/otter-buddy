---
id: F20260904swp4
title: 'sgp2 S4a 真换轨补完：scheduler/招聘入口过闸门 + 执行对账 + seq 停写（#775）'
doc_type: feature
summary: |
  09-04 审查发现 #771(S4a) 被叙述为「scheduler 换轨」但点火路径仍直连 executeChain——
  判据清零删除 system 排除防波堤的前提（scheduler 已进闸门体系）不成立。本特性补完
  五件事：① scheduler 触发改走 routeDirectSignal（路由器直投：闸门+台账+busy 语义）；
  ② 招聘桥接入口同款换轨；③ 执行记录启动对账（僵尸 running 翻篇）；④ seq 刻度存量
  回填 + markBatchRead 停写旧 turn 刻度（观察项①收尾）；⑤ 路由器头注释/pendingClause
  引证失真更正。判定：v2「五入口全部经闸门+台账」语义闭环，无残留直连链。
status: implemented
change_type: fix
tags: [signal-protocol, scheduler, dispatch-ledger, cursor-migration, gate]
modules:
  - src/usecases/conversation/signal-router.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/usecases/recruiting/process-inbound-recruit.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/frameworks/db/conversation/
  - src/frameworks/db/scheduled-task/
  - src/bootstrap/
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
capability_test: "n/a: 调度/记账/游标逻辑（A 类），无 LLM 参与行为变化；回归由全量 2936 用例 + D1-D5/A1-A3 判据块覆盖"
causal_links:
  from:
    - F20260902sgp2   # 父特性（信号协议 v2）
    - F20260903s4fn   # S4 终局（本特性补完其 §7 迁移表 S4 行的「scheduler 换轨」承诺）
---
## 1. 背景：换轨的「验收叙述链」断裂点

09-04 上午审查（搭档令「新版功能要完整上线，不要残留」）核对 diff 发现：

| 环节 | 叙述 | 事实 |
|------|------|------|
| 设计文档 §7 | S4 =「scheduler 换轨…定时任务走台账」 | — |
| 裁决记录 09-03 16:53 | 「S4a 换轨后前提消失，防波堤删除——判据特例清零」 | — |
| #771 commit | 标题「scheduler **前置**修正」；diff 内 scheduler 点火路径**零改动** | 「前置」二字在验收叙述链中丢失 |
| main 现状 | scheduler-service.ts:609 直连 executeChain；process-inbound-recruit.ts:237 同 | 判据清零的**前提不成立** |

残余面（清零前）：① 双跑窗口——system 行动消息落库后、链记账前的扫描窗口，记账
失败仅日志（硬约束 1）留白后下轮扫描必然双跑；② 闸门盲区——用户 halt/限流熔断期间
定时任务照常点火（09-03 ihlt 事故形态的 scheduler 面）；③ 注释失真——signal-router
头注释仍是旧边界，pendingClause 注释误引 #744（S2 web/IM 换轨）为「scheduler 已换轨」依据。

## 2. 设计决策

### 2.1 直投通道 routeDirectSignal（原点独占点火权）

Why 不让 scheduler 走 routePendingSignals（整会话扫描）：

1. **触发面失控**：扫描会把任务锚点外的历史 pending 一并点燃
2. **闸门拦截即假死**：扫描路径被闸门拒时静默保留信号，scheduler 若等待会空转轮询到
   硬上限（24h）——直投被拒时抛 `DirectChainGatedError`，调用方**立即**记 skipped
3. **双跑收敛**：入口从原点独占点火权，路由器只服务「重启后无主信号」的补扫
   （彼时执行记录已判死，无并发写者）；即使直投与补扫竞态，幂等记账（INSERT OR
   REPLACE）+ 阻尼（60s 最小点火间隔）在账面上挡住双跑

### 2.2 执行级看门狗 watchExecutionByLedger

换轨后点火是路由器 fire-and-forget（scheduler 无 chainPromise 可握），判活只能靠
持久台账：`allAnchorAttemptsSettled`（S4b 复用）——有 in_progress 在途即活（#516 教训：
静默 ≠ 死亡），全终态即收工，硬上限 24h 兜底。闸门冻结期不判死：直投在点火前就被
拒（skipped 记账），**不会进入等待循环**——「等待中信号被冻结」这个状态在直投语义下不存在。

### 2.3 调度闸门 = 环境冲突，非任务失败

`DirectChainGatedError`（gate: skipped_halted / skipped_rate_limited / skipped_no_signal /
skipped_inactive 等）→ execution 记 **skipped**：不 increment consecutiveFailures、不触发
3 连败熔断（#654 锁冲突同款语义）。信号保留在台账，恢复后由补扫/下次触发消化。

### 2.4 seq 停写（观察项①收尾）

- 数据评估（09-04）：两次真实重启后 seq 路径正常消化（turn 252↔seq 275 同步推进），
  641 行 participants 零异常 → 具备停写条件
- **回填语义**：NULL 行回填为「同会话最大 sequence_num」而非 0——这些行从未走过
  新路径，事实状态是「已读到最新」；回填 0 会把全部历史当未读（rbsg 形态误判）
- markBatchRead 停写 `last_read_turn_number`（旧列冻结为历史快照）；读路径 NULL 回退
  保留（防御极端脏数据，非功能依赖）；`updateLastActiveTurnNumber` 不受影响（发言
  活跃度与游标无关）

## 3. 变更清单

| 文件 | 变更 |
|------|------|
| signal-router.ts | +`routeDirectSignal`（直投：闸门→routeTarget；不可路由抛 DirectChainGatedError）；+`DirectChainGatedError`；头注释更新（P1 边界已消解的注记） |
| scheduler-service.ts | invokeAgentWithTimeout 换轨分支（signalRouter 注入时直投+台账看门狗）；DirectChainGatedError → skipped 记账；+`watchExecutionByLedger`；+`attachSignalRouter`（装配顺序：路由器晚于 scheduler 诞生）；start() 启动对账 |
| process-inbound-recruit.ts | triggerDispatch 换轨（signalRouter 可选注入，第 7 参）；闸门拦截记 warn 不重试（信号已在台账） |
| platforms.ts / app.ts | schedulerService.attachSignalRouter(signalRouter)；ProcessInboundRecruit 注入 signalRouter |
| scheduled-task-repository.ts / sqlite 实现 | +`failAllRunningExecutions`（启动死亡证明，不记连败） |
| conversation-repository-mixins.ts / sqlite 实现 / 接口 | +`backfillLastReadSeq`（NULL→会话最大 seq，幂等只更新 NULL 行） |
| database.ts | signal-ledger 启动块追加 seq 回填（NULL 计数守卫，失败不阻塞启动） |
| dispatch-chain-engine.ts | markBatchRead 停写旧列 |
| signal-router.ts（pendingClause 注释） | 引证纠正：#744 是 S2 web/IM 换轨不含 scheduler；本 PR 补完后前提才成立 |

## 4. 验证

- 全量 2936 tests 绿（235 files）；tsc 0 error；eslint 0 error（5 warnings 均为既有 no-console/react-hooks）
- 新增判据块：D1-D5（routeDirectSignal 直投/缺失/停机闸门/busy 入队/幂等防双跑）+ A1-A3（换轨生效/闸门 skipped 不熔断/启动对账）
- 最简实现检查：已过——routeDirectSignal 复用 routeTarget 全部闸门/记账/busy 逻辑（~40 行新代码），看门狗复用 allAnchorAttemptsSettled，无新表无新依赖
- 回滚面：摘除 platforms.ts/app.ts 两处注入（attachSignalRouter + 构造参数）即回直连链，与 sgpv 降级基线同语义

## 5. 遗留与关联

- 观察项①（seq 旧列停写评估）：**本 PR 关闭**（停写+回填完成；旧列保留为快照，列删除属 schema 清理，不急）
- 观察项②阻尼#5（yield 墓碑）：维持拆出排期（需改 yield 写入路径，与信号协议不同面）
- 观察项③busyQueue 重启语义告知：UX 新需求，维持待办
- 观察项④判据清零可见性：本 PR 的 D3 用例锁定「闸门期信号保留」语义；轨迹 UI 已有四态投影，无额外工作
