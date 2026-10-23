---
id: F20261021sprx
title: "定时任务执行獭按名解析与待执行列表"
summary: "定时任务的 talkingStonePassedTo 存建任务时刻的实体 otterId，导致历史獭（从未加入对话名册）被唤醒发言、前端名册查不到按 small 回退渲染（头像/颜色错乱）；叠加 #1471 互斥守卫被僵尸 running 占位连锁 skip、每日任务 skip=当天丢失。重构为：任务声明执行者角色名，invoke 时按对话名册解析当前实例；执行獭忙时触发入待执行列表（注入提醒+操作 tool，入列即完成），由獭忙完自行拉取决定补执行；互斥守卫随之退役（reapPreempting/reapStale 保留为 claim 锁存活链必需件）。"
change_type: feature
capability_test: tests/capability/scheduled-task-pending.capability.test.ts
intent:
  problem: "定时任务绑定历史 otterId，导致名册外獭被误唤醒且前端身份错渲染；执行獭忙时互斥 skip 又使每日任务丢失，残留 session 与无条件启动对账进一步妨碍僵尸清理。"
  expected_effect: "任务触发只解析名册内当前角色实例；忙时周期任务写入去重 pending 并记 completed，獭可按角色提醒拉取/ack；once 忙时系统消息明示删除；16 个存量任务迁移幂等，超龄无产出 execution 可 reap，近期有产出 execution 不被启动对账误翻 failed。"
  verify_by:
    type: behavior_check
created: 2026-10-21
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
tags: [scheduler, otter-identity, pending-queue, reliability]
modules: [src/usecases/scheduler/scheduler-service.ts, src/entities/scheduled-task/scheduled-task.ts, src/usecases/conversation/resolve-send-targets.ts, src/frameworks/agent/session-helpers.ts, web/src/lib/mappers.ts, src/frameworks/db/schema.ts]
causal_links:
  - F20260721x8k9   # 对话定时任务（本特性重构其执行者绑定语义）
  - F20260720qs9y   # 每对话独立大獭（按名解析的落点）
  - F20260815rstrt  # restartBeforeInvoke（本特性重述其触发时机）
  - F20261014rsgd   # 在途互斥守卫（本特性使其退役）
  - F20261020wgrt   # 看门狗克制化（保留不动；本特性风险节声明其放弃型 skip 不治）
---

# 定时任务执行獭按名解析与待执行列表

## 背景

搭档原话（意图锚，2026-10-21 对话《严重问题》）：

> 「在对话《三省吾身》中，我看到最近几次大獭发言的头像、气泡颜色都不是大獭，这是啥情况，感觉身份有点问题？」

> 「那这是定时任务有问题，不应该指定历史獭实例。或者说，定时任务分配的獭，只是个名字、应该指定到当前实例。」

> 「我有个新理解就是 大獭正在运行中，那么这次任务就要延迟执行，或者说，要有一个机制，先记起来一个列表，然后在大獭的上下文中注入，若手头的事情完结了，则去看一下这个列表（定时任务待执行列表），由海獭自行决定要不要补充执行；然后，对于定时任务机制来说，这一次触发记起来就是结束了。」

> 「这个待执行列表，不要把任务描述直接注入（因为我看任务描述都非常大），而是提供一个 机制+操作tool，提醒大獭列表里有待执行任务，等手头忙完了要去处理。」

案发现场（本对话排查实锤，锚点：`otter-buddy.db` 只读查询；数字经两轮审视獭 DB 复核订正）：

- **身份错乱**：`entries` 表显示《三省吾身》（`3241317b`）今天 00:37:39/00:45:48 两条「大獭」发言的 sender 是 `123354f2`（每日补丁清单回看执行獭，生于 09-08）与 `af8d35a4`（依赖升级自动化执行獭，生于 08-12）——两只獭均不在该对话 `conversation_participants`/`conversation_otters` 名册（名册内大獭只有 `87f172c6`）。前端 `mappers.ts:299-301` 钉死「type 不随 entry 携带，渲染时从名册查 sender id」→ 查不到按 `small` + `fnv1a(otterId)` 回退 → 两只獭各算各的颜色/头像。
- **sender_id 同病根（审视獭-glm 补 2）**：3 个任务的 `sender_id` 也钉着历史獭（cfa15c91→af8d35a4、d62737fc→123354f2、8ef499d8→fefd2c06）——历史獭发言的 entry sender 归属与执行獭绑定同源，不只是渲染问题。升格入问题清单。
- **规模**：全库 **279** 只 active「大獭」实体（F20260720qs9y 每对话一只的累积）；全库 **16 个定时任务分布 5 个对话**（active 13 / disabled 3），其中《三省吾身》9 个（8 例行 + 1 once）各自钉着不同历史时期创建的獭 id。
- **调度可靠性**：`scheduled_task_executions` 台账显示 10-20（3 条）+ 10-21（6 条）两日共 9 条 skip；10-20 一条 running 滞留 9.5h（00:00 补丁清单）连锁挡掉白天多轮任务，最后手动机械释放；10-20 01:00 self-healing 被 skip 后当日无补跑（每天一次的任务 skip=当天丢失）。

## 目标

- T1：定时任务的执行者声明与具体实体解耦——任务存「角色名」（如 `大獭`），invoke 时解析到对话名册内当前匹配实体；名册外历史獭不再可能被任务唤醒
- T2：执行獭忙时，触发不抢不重启——记入待执行列表（入列即完成，调度器侧语义闭环）
- T3：獭在后续唤醒中收到「有 N 条待执行任务」提醒（不注入任务全文），用操作 tool 拉取详情、自行决定补执行/跳过/重启后执行
- T4：同任务在列去重，列表不无限堆积
- T5：显示层防残留——entry 渲染不再只依赖名册查 type，任何名册外发言（历史数据/异常路径）也能正确渲染身份
- T6：退役互斥守卫（F20261014rsgd）——新机制在宽口径忙判定下消掉「重启掐断在途」的主要冲突窗口。**仅退役互斥守卫一件**：reapPreemptingExecutions（claim 僵尸即时清理）与 reapStaleRunningExecutions（轮询兜底）经第一性审视裁决为 claim 锁存活链必需件，保留且职责不变；F20261020wgrt 实为看门狗克制化（watchExecutionByLedger 静默窗/放弃窗口），不在本特性退役范围。遗留窗口声明见「风险与约束」

## 非目标

- 不改 F20260720qs9y「每对话独立大獭」设计本身——279 只 active 实体的存在是设计结果，本方案只改任务对它们的**引用方式**
- 不动小獭派发链（dispatch-chain-engine）——小獭任务的 yield/invoke 路由不变
- 不做「延迟队列自动重放」——补执行的决策权在獭（搭档明示），不造自动重试机制
- 不迁移历史 entries 的 sender_id——历史发言归属是事实记录，不改；显示层修复让它们正确渲染即可
- function executor（executorType='function'）路径不在本次范围——纯代码执行器无「獭忙」概念，维持现状

## 未决问题

- 待执行列表的**獭侧清理语义**：本期实现为逐条 ack（list/detail/ack），不做批量全清；后续确需批量时再单独定义理由留痕口径。
- 列表上限：是否需要硬上限（如 50 条）防爆？（倾向：先不设上限，去重 + 獭自主消化足够；设了上限就要定义溢出行为，多一个机制）

## 上线前运维动作（第一性审视补 4）

- **补丁清单回看 consecutive_failures=2/3，离熔断一步**：15 条 failed 中 12 条「进程重启对账」已豁免计数，但 2 次「Agent invocation timeout」走了计数——下一次 timeout 即 status=error 静默停跑。**上线时先 reset 该任务计数**，否则改造完成前可能先熔断。

## #1475 现场实证补充（2026-10-21 另一对话大獭比对确认，并入实现清单）

另一对话（issue #1475 once 任务线）的大獭将本方案与 #1475 现场数据比对，确认方向并入，补充三条检视未覆盖的现场事实：

1. **reapStale 选择性失效（两獭冲突裁决）**：`reapStaleRunningExecutions` 存在且 tick 调用（:541）。两报告冲突——glm 转述前轮「若真哑火」，mimo 给出反例：10-19 01:59 有实证 fire（8ef499d8 的执行被「孤儿执行清理：running 滞留超 2h 且无存活执行方，轮询扫描机械释放」），但 10-20 的 9.5h 僵尸行（每日补丁清单回看）是手动释放的。**裁决：选择性失效，不是从不响**——根因排查方向从「轮询没跑」改向「存活判定漏判」（isRunning 对出池 session 误报存活？）。实现时必须查清该根因并验证清理真会生效，否则「保留 reapStale 兜僵尸」是空话。实现清单加一项：reapStale 选择性失效根因排查 + 有效性验证。**排查方向假说（glm delta D-D，置信度中）**：`isOtterRunning` 只看「session 在池」（pi-session-factory :1407-1413）——invoke 挂死时 session 可能一直不出池 → 判活 → 永不释放；10-19 fire（周任务 session 不在池）/ 10-20 不 fire（补丁清单挂死 session 疑似在池）与此吻合。结构性要点：**忙判定与 reap 对同一函数需求相反**（挂死 session：忙判定想要 true「别打扰」，reap 想要 false「它是尸身」）——单一 isOtterRunning 无法同时满足。若假说成立，修复方向 = reap 判活改为 execution 侧证据（锚点后产出探测，F20261020wgrt 的 hasFreshOutputAfter 同族）而非 session 池。DB 无 10-20 现场 session 池快照，需运行时日志佐证。
2. **重启对账与 claim 释放有缝**：10-21 08:33 对账宣告「无存活现场」、08:38 同任务仍被 claim 拒（「已有 running 执行」）——对账清行与 claim 释放不原子。pending 拉取/补执行路径会撞同一个缝。**实现清单加一项：对账清行原子释放 claim**
3. **超时执法缺失（#1306 同族）**：补丁清单回看 timeout_minutes=60 但 9.5h 长跑无人掐。本方案治「不丢任务」不治「跑飞占工人」——跑飞任务会让 pending 排长队。**标注为可选配套：跑飞掐断/看门狗泛化可后续单独立项，不挡主线实现**（范围扩张控制）

## 方案设计

### ① 按名解析（T1）

**实体变更**：`ScheduledTask.talkingStonePassedTo: string[]`（otterId 列表）→ 新增字段 `executorRole: string`（角色名，默认 `'大獭'`）。`talkingStonePassedTo` 字段保留用于向后兼容读取（旧任务迁移前仍可跑），新写入一律走 `executorRole`。

**解析点**：`SchedulerService.triggerTask()` 入口处（`scheduler-service.ts:895` 起）新增解析步骤——

```
resolveExecutorOtter(task):
  participants = conversation_participants(active) ⨝ otters   // 名册源表锁定：participants（带状态名册表，schema.ts:446）；不选 conversation_otters（schema.ts:152，含已解散獭的历史关联表，会解析出 dissolved 实体）
  candidates = participants.where(name == task.executorRole && type == roleToType(task.executorRole))
  // roleToType：'大獭' → big（角色名与 type 的映射在实现层定义常量表，当前唯一映射；同名小獭不匹配大獭角色）
  return candidates.latestActive()  // 名册内同名多只时取最近活跃
  // 名册无匹配 → 落 skipped execution（reason: no-such-role-in-roster）+ healing low
```

解析结果（具体 otterId）下游照旧使用——`invoke`、`isOtterRunning` 判定、`yieldTargets` 等全部拿解析后的当前实体，不再直接读任务字段。

**存量迁移（对抗审视建议 3 + delta 复核 glm D-A/mimo D4 双重处置）**：**锁定启动时惰性迁移**——随代码同版本原子生效（应用启动后首个触发周期前，逐任务把 `talkingStonePassedTo[0]` 对应獭的 `name` 写入 `executorRole`，幂等）。「一次性脚本先行」选项作废——脚本先于代码上线会置空 `talkingStonePassedTo`，而旧代码 restart 分支条件 `talkingStonePassedTo.length > 0`（scheduler-service.ts:1013）静默失效、直投路由消费 `talkingStonePassedTo[0]`（:1355）变 undefined。

**迁移范围（mimo D4 处置）**：全量 16 个任务（含 3 个 disabled——disabled 任务日后启用若走旧 otterId 路径会复活原 bug），「13 个 active」口径作废。`sender_id` 同步迁移（glm 补 2 取舍已决）。

**迁移策略关键变更（glm D-A 处置）**：**迁移不置空 `talkingStonePassedTo`，保留旧值作为 fallback**——scheduler-service.ts 内该字段共 **17 处**直接消费点（grep 实数），包括两个保留件 `reapStaleRunningExecutionsForTask`（:411）与 `reapPreemptingExecutions`（:1284）的判活逻辑（`targetOtter = task.talkingStonePassedTo[0]`），以及看门狗 :1980、healing 落账圈（:437/:507/:783/:1815/:1849/:1877/:2169）、信号路由（:1322/:1348/:1355/:1376/:1398/:1403）。置空会使 :411 取得 undefined → `if (targetOtter && isOtterRunning)` 短路 → **判不出活按死处理**——保留件从「超龄且无存活执行方才释放」退化为「超龄全杀」，长任务被机械误杀。读路径改为「executorRole 解析成功用解析结果，失败 fallback 旧字段」，写路径停止写入旧字段。全部 17 处消费点逐一清点（传递解析结果 / 改读 executorRole / healing 场景容忍空值）。

**直投路由消费点显式列入改动范围**（同建议 3）：`:1355` 的直投路由（信号保留语义路径）也消费 `talkingStonePassedTo[0]`，必须同步改为消费解析结果，防漏改。

**前端/接口**：`scheduled-task-dto.ts` 增 `executorRole` 字段；任务创建/编辑 UI 从「选獭」改为「选角色」（当前实际只有大獭一种执行角色，UI 可简化为只读展示）。create_scheduled_task tool 参数同步调整。

### ② 待执行列表（T2/T3/T4）

**存储**：新表 `scheduled_task_pending_items`——

| 列 | 说明 |
|---|---|
| id | UUID |
| task_id | FK → scheduled_tasks |
| conversation_id | 冗余，按对话查列表 |
| role | 触发时的 executorRole 快照 |
| triggered_at | cron 触发时间 |
| status | `pending` / `consumed`（獭拉取详情并处置后记 consumed） |
| consumed_at | 处置时间 |
| resolution | 獭处置结果快照（`executed`/`skipped` + 一句话理由，獭 ack 时填） |

唯一约束：`(task_id, status='pending')` 部分唯一索引——同任务同时刻最多一条 pending（去重，T4 的机械保证）。

**入列路径**（triggerTask 内，解析出 executor 后；once 任务不进此分支，见下）：

```
busy = isOtterRunning(executorOtterId)                    // 窄口径：session 在池/在流
      || existsRunningExecutionOnOtter(executorOtterId)   // 宽口径补：该獭身上任何 execution 存活 running（含本任务，不排除）
if busy:
  insert pending_items (on conflict do nothing)   // 去重
  createExecution(status='completed', errorMessage=null,
                  messageId=null)                  // 入列即完成：execution 记 completed
  return                                          // 不 invoke、不 restart、不发消息
```

**忙判定宽口径（对抗审视发现 3 + 第一性审视 mimo B1 双重处置）**：`isOtterRunning` 只覆盖「session 在池」（pi-session-factory.ts:1407-1413），两个窗口需补：①session 出池但其他任务 execution 存活 running 的待点火窗口（发现 3）；②**同任务自身 execution 存活 running 的窗口**（mimo B1）——旧守卫查询显式排除本任务（:475 `if (t.id === task.id) continue`），若照搬到忙判定，同任务 <2h 僵尸会判闲 → 直发 → claim 拒 → 当天丢。**忙判定 = `isOtterRunning(executorOtterId) || existsRunningExecutionOnOtter(executorOtterId)`（含本任务，不排除）**——本任务 running 说明上一次触发还在跑，当前触发本就该让位（入列让獭判断，而不是 claim 拒后丢）。

**入列与双执行互斥（第一性审视 mimo B3 + delta 复核 mimo D2 双重处置）**：部分唯一索引只防「pending 表内堆积」，防不了两个双跑窗口：①第一次触发已直发 completed、第二次撞车触发在忙窗口落成 pending → 獭对一个刚跑完的任务补执行；②第一次还在 running、第二次撞来——最近 completed 是上一周期 → 不抑制 → 入列 → 第一次跑完后獭补执行 = 双跑（旧路径该场景由 claim「already has a running execution」去重，今晨 00:38 实测即此；新路径忙判定先于 claim，去重被绕过）。**抑制条件：同任务同一 cron 槽位已有 execution 且 status ∈ {running, completed} → 不入列、照常记 completed**。failed 不抑制（pending 正好兜失败重试）。「同一 cron 槽位」只认槽位相等，不用「<1 个周期」启发式（会误抑迟到 catch-up——周任务上周二补跑、本周一触发间隔 <7 天即被吃掉）。附带声明：running 抑制后若该执行随后 failed，本轮即漏——任务容忍度盘点（F20261020wgrt）已声明全部可容忍。**残留缝兜底（glm D-B3'）**：tool 的 detail/ack 动作执行前重查一次同槽位 completed——獭拉取时任务已完成则提示「本轮已直发覆盖」，与「獭自行判断」哲学兼容。

**once 任务排除（对抗审视发现 1 + 第一性审视双獭 once 关注处置）**：once 任务（scheduleType='once'）触发成功后任务行即被删除（`scheduler-service.ts:885` `taskRepo.delete`），忙时入列会让 pending 行的 `task_id` FK 悬空（獭拉 detail 查无此任务、列表挂死）。**决策：once 任务不进入忙时入列分支**——once 忙时维持现状语义（落 skipped execution）。但「维持现状」有个已知代价必须显式声明：**once 忙时 skip 的那一刻任务行即被删除**（:754-762 setTimeout 回调内 triggerTask 正常 return 后立即 `taskRepo.delete`，skip 是正常 return 非抛异常、不进 catch 重试链）——不存在「重试耗尽后蒸发」的窗口，是 skip 即删。这正是 issue #1475 的建案原始关切（once+互斥组合下守卫跳过后 once 任务被静默删除）。现存 once 任务 d3fb2064「#1553 观察期复查关单」是**承诺类**不是提醒类，skip=复查承诺蒸发。**配套处置（#1475 对账）：once 忙时 skip 落账的同时，向所属 conversation 注入系统消息提醒搭档**（任务名 + 将删除 + 承诺未执行）——成本一条 sendEntry，把「静默删除」变成「有声删除」。triggerTask 在 once 分支内先解析执行獭再忙判。

**once 分支忙判定（delta 复核 D-1 处置）**：互斥分支（1022-1043）被 §③ 删除后，once 的「忙则 skipped」不依赖被删代码——once 分支自带忙判定（同宽口径：isOtterRunning || existsRunningExecutionOnOtter（含本任务）），忙时在 once 分支内直接落 skipped execution 并返回。**once 分支内先解析执行獭再忙判**（原文「解析前判断 scheduleType」顺序倒置，glm D-C 订正）。

**入列 completed 落账警示（对抗审视建议 1 处置）**：入列的 execution 行必须**绕开 `completeExecution` 直接 INSERT**——该函数写 `messageId=''` 会踩 `FOREIGN KEY constraint failed`（function executor 分支已有实证绕行先例，scheduler-service.ts:985-993 Why 段）。实现层不得图省事复用。`consecutiveFailures` 不受影响（入列非失败）。`last_triggered_at` 照常刷新。

**提醒注入（T3）**：`buildMessageWithContext`（`session-helpers.ts:369`，实际组装在 dispatch-chain-engine.ts:847）的 DynamicContext 增 `scheduledTaskAlerts` 槽位（借用式，与 healingAlerts/signalAlerts 同构）——獭**每一次**被唤醒组装 user message 时，查其所在对话 `pending_items(status='pending')` 计数（按 role 过滤），非零则注入一段提醒。

**「忙完」不靠检测——机制上取消了这个判断（搭档追问后口径校准）**：不存在「检测忙完瞬间」的组件。獭在跑长任务时被唤醒，提醒照出现，獭手头有事就自主跳过（继续干完）；哪次唤醒时獭处于「搭话」态（搭档发新消息/新触发唤起），看到提醒、手头没压着事，就去拉列表处置。「忙完」的判断者就是獭自己，判断依据是它天然具备的「这轮唤醒我是不是有空」。该设计成立的前提：大獭是编排者，每轮任务以 yield 交棒结束，下一轮被唤醒就是天然检查点；提醒只是消息中的一段文字，不打断不抢占；精确检测空闲是假需求——獭空闲时根本不会醒着。

```
<system-reminder>
## 定时任务待执行列表
有 N 条定时任务在你忙时触发并入列（最近：任务名 HH:MM）。
手头事情完结后用 manage_scheduled_task_pending 查看并逐条处置（执行/跳过）。
</system-reminder>
```

**注入语义**：每次唤醒都注入（非一次性、非消费即删）——pending 非零就一直提醒，直到獭 ack 销账。提醒只是消息中的一段文字，不打断不抢占；獭连续无视 N 轮无副作用（列表有去重不爆量）。

只注入计数与最近一条的任务名+时间，不注入任务 body（搭档明示：任务描述非常大）。

**按 role 过滤（对抗审视建议 2 处置）**：注入判定时消费 pending 行的 `role` 快照列——只统计 `role == 当前被唤醒獭.name` 的行（多獭对话中小獭不应收到大獭任务提醒，防误处置与信噪比稀释）；提醒文案中标注目标角色名。

**操作 tool**：新增 `manage_scheduled_task_pending`（或复用 manage_scheduled_task 加 subcommand，实现时定）——

- `action: list`：返回本对话 pending 列表（任务名/触发时间/任务 id）
- `action: detail`：按 pending id 返回任务 body/description 全文
- `action: ack`：獭处置后销账——`resolution: executed|skipped` + 理由；`executed` 时由獭自行走正常发言/invoke 流程（工具不代办执行，只销账）

**獭侧执行语义**：獭决定补执行某条时，相当于它代替调度器跑这个任务——它自己决定是否先 `restart_otter`（restartBeforeInvoke 的「干净上下文」诉求由獭自主继承）、执行后发言落账。调度器不参与补执行。

### ③ 机制退役（T6）——按函数粒度拆开列（对抗审视发现 2 + 第一性审视 mimo B2 双重处置）

新路径上线并验证后：

- **删除**：`hasInflightExecutionOnOtter`（F20261014rsgd，`scheduler-service.ts:469-488`）及 `triggerTask` 内 1022-1043 的互斥分支——「忙时不碰獭」消掉了守卫的存在前提
- **保留且职责不变**：`reapPreemptingExecutions`（`scheduler-service.ts:1273-1305`）——**初稿「删除」是职能误判，收回（mimo B2 实锤）**：它在 `claimAndValidateTask` 内部被调用（:1249），注释明写「先即时清理超龄僵尸…该挡的挡住、僵尸不挡路」——职能是 **claim 时的僵尸即时清理**，不是互斥件。删除后同任务 <2h 僵尸永占 claim，任务饿死。
- **保留且职责不变**：轮询僵尸清理 `reapStaleRunningExecutions`（`scheduler-service.ts:382-395`）——claim 锁存活链必需件。**但已知选择性失效（见 #1475 补充 1 裁决），其根因排查与有效性验证是机制退役的前置条件**——退役互斥守卫前，必须先查清 reapStale 为何 10-19 能 fire、10-20 不 fire，并用注入僵尸行验证修复后真会生效。

### ④ 显示层修复（T5）

`mappers.ts:299-301` 注释钉死「type 不随 entry 携带」——后端 entries DTO 已带 `senderColor`（`mapEntryDTO` 消费），但 `senderType` 未随 DTO 透出（`conversation-dto.ts` 无此字段，仅 SSE invoke.start 事件带 `otterType`）。

修复：`EntryDTO` 增 `senderOtterType?: 'big'|'small'`（由 entry-repository 查 entries 时 join otters 一次带出，或 entry 创建时快照写入 metadata——倾向 join，快照会随獭 type 变更过时），`mapEntryDTO` 优先消费它，名册查询降级为兜底。历史名册外发言（本次事故现场的两条）随之正确渲染为大獭品牌棕。

### 机制预算四问（机制识别检查点命中：新增持久化存储 pending_items 表、新增 tool、新增状态生命周期 pending→consumed、新增跨模块调用路径）

① **谁需要它**：定时任务的拥有者（搭档）需要「任务不丢、不互相掐」；《三省吾身》对话的大獭需要「知道有活等着我」；调度器需要一个不依赖「查在途」的完成语义。《三省吾身》口径：当前 9 个任务中 8 个例行任务全部直接受益（台账实证：10-20 self-healing 丢失、两日共 9 条 skip）；1 个 once 任务（d3fb2064）不走入列路径（见 §② once 排除）。全库口径：13 个 active 任务分布 5 个对话同病。

② **失败后果**：pending 表写入失败 → 该轮触发按现有 failed 路径落账 + healing，不退化（比现状 skip 丢失更好）；提醒注入失败 → 獭不知道有列表，任务滞留 pending 直到下次成功注入——有每日健康检查兜底可见（pending 滞留可纳入健康检查指标）。獭永不 ack → pending 堆积但去重防同任务爆量，且每日补丁清单类任务本身会提醒搭档。

③ **后续机制**：新状态 `pending` 可能的出错方式——獭 ack 了但没真执行（resolution 谎报）：由 resolution 必填理由 + entries 发言记录可交叉核对；列表长期无人消费：健康检查加「pending 超 24h」告警（实现时评估，可作为后续小特性）；tool 被滥用批量 skip：resolution 留痕，日报可见。

④ **退役条件**：当「定时任务全部由 function executor 承担、不再 invoke 獭」时，整个待执行列表与按名解析可随 agent executor 路径一并删除。信号：active agent 任务数归零持续 30 天。

## 影响范围

- `scheduler-service.ts`：triggerTask 主路径重构（解析 + 忙判分支 + 互斥删除）；claim/reconcile 链路不动
- `scheduled-task.ts` 实体 + schema.ts + migration：`executor_role` 列、`scheduled_task_pending_items` 表、部分唯一索引
- `resolve-send-targets.ts`：定时任务 senderId 解析同步按名——**取舍已决：sender_id 随迁移一并回填为当前名册内大獭**（取舍表「sender_id 同步」行）
- `session-helpers.ts`：DynamicContext + buildMessageWithContext 增 alerts 槽位
- tool 面：`create_scheduled_task` / `manage_scheduled_task` 参数调整；新增 pending 操作 tool
- `mappers.ts` + `conversation-dto.ts`：senderOtterType 透出
- 前端任务管理 UI：角色字段展示（小改）
- 全库 16 个任务（5 个对话）一次性迁移（含 3 个 disabled，防日后启用复活原 bug）

## 风险与约束

- **獭不消化列表的行为依赖 prompt 纪律**：提醒注入只是可见性，獭「忙完去看列表」靠 SYSTEM.md/提醒文案约束，无机械强制——接受此风险（搭档明示「由海獭自行决定」，强制反而是反需求）
- **补执行时机的上下文质量**：獭在对话中途补执行补丁清单，发言会混入当前对话流——这是搭档模型的固有语义（列表注入对话上下文），非缺陷
- **迁移窗口双写**：迁移期旧任务仍可能以 otterId 路径触发一次（竞态窗口秒级）——幂等迁移 + 解析兜底（otterId 不在名册时按名重解析）覆盖
- **互斥退役的回归风险**：退役后「獭忙时触发」行为从 skip 变为入列——行为变更需在 PR 与特性文档显著标注（见「不兼容更新」）
- **忙判定宽口径的残留窗口声明（对抗审视发现 3 收敛 + mimo D5d）**：宽口径（session 在池 || 任何 execution 存活 running）覆盖了旧守卫的主要保护场景。两个残留窗口声明：①「execution 已 failed/completed 而獭侧副作用未落账」的亚秒级窗口——与现状 F20261014rsgd 的残留面同量级，接受；②忙判定→claim 的毫秒竞态（判定闲后到 claim 前另一个触发抢先 claim）——极小丢轮窗口，任务容忍度盘点（F20261020wgrt）已声明全部可容忍。「从根上消掉重启掐断冲突」的断言修订为「消掉主要冲突窗口」
- **fallback 路径的优雅降级声明（两獭收口提醒）**：executorRole 解析失败时回退旧 otterId 字段——理论上仍会唤醒历史獭、短暂复现身份错乱，属优雅降级（任务不丢优先）。新建任务旧字段为 `'[]'`，fallback 取 `[0]` 得 undefined——若走到保留件判活同款短路路径，语义回到「判不出活按死处理」；新任务+解析失败+恰逢 reap 是三层小概率叠加，实现时给 `resolveExecutor` 失败路径留一行日志即够。
- **看门狗放弃型 skip 不治（第一性审视 mimo 补充 1）**：执行级看门狗（#1048 克制版）的放弃路径（锚点后静默窗无产出 → WatchdogAbandonedError → skipped）是第三类丢任务来源，本方案不治——忙入列只治触发时刻。接受声明：看门狗放弃是「清坑保洁」语义（#1048 搭档定调），任务可于下次调度补跑。
- **对账误杀已完成执行（第一性审视 mimo 补充 2）**：补丁清单 00:37:39 已发言落库、00:50:53 被启动对账误判 failed——台账与实际背离。#1475 补充 2 只收了 claim 释放缝，这个「误杀已完成」症状独立存在。列入实现清单（对账逻辑核查），不单独开机制。

## 不兼容更新

- [Incompatible] `ScheduledTask.talkingStonePassedTo` 写入语义废弃（读取保留兼容）；任务创建 API 参数变更（executorRole 替代 talkingStonePassedTo）
- [Incompatible] 獭忙时触发行为：skip（记 skipped execution）→ 入列（记 completed execution + pending 行）。执行历史报表中 skipped 占比会下降、completed 含「入列完成」语义——报表消费方（prompt-discipline 指标 skipped-24h-ratio）需同步调整口径
- [Incompatible] F20261014rsgd 互斥守卫删除——依赖 skip 语义观察「任务冲突」的监控口径失效（由 pending 列表滞留告警替代）。reapPreemptingExecutions 与 reapStaleRunningExecutions **保留**（第一性审视 mimo B2 裁决：前者是 claim 僵尸清理件非互斥件，后者是 claim 锁存活链必需件）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 执行者声明形态 | 角色名 + invoke 时名册解析 | 保持 otterId + 名册外獭自动补名册 | 搭档拍板「指定到当前实例」；补名册会让 279 只历史獭逐步涌入名册污染在场语义 |
| 忙时处置 | 入列即完成（completed） | 入列记 skipped / 延迟队列自动重放 | 搭档拍板「记起来就是结束了」；自动重放剥夺了獭「过时任务不补」的判断权 |
| 列表注入内容 | 提醒（计数+最近任务名） | 注入任务全文 | 搭档明示「任务描述都非常大」，注入全文挤占上下文 |
| 补执行发起方 | 獭自主（tool 拉取+ack） | 调度器检测獭空闲后重新 invoke | 搭档明示「由海獭自行决定要不要补充执行」；调度器重 invoke 又需要「空闲检测」新机制 |
| pending 存储 | 新表 | 复用 executions 表加 pending 状态 | executions 语义是「已触发台账」，pending 是「待消费队列」，生命周期不同（pending→consumed vs running→终态）；混表会让两个语义互相污染查询 |
| 去重保证 | 部分唯一索引 (task_id, pending) | 应用层查重 | 机械保证优于约定；触发并发场景（catch-up 补触发）应用层查重有竞态 |
| restartBeforeInvoke 继承 | 獭补执行时自主决定 restart | 入列时快照 restart 意图、tool ack 时自动 restart | 獭最清楚自己当前上下文是否干净；自动 restart 会焚掉獭正在进行的对话上下文（#1471 的病以新形态复发） |
| senderType 透出 | DTO join otters 查出 | entry 创建时快照入 metadata | 獭 type 可能变更（big↔small 虽罕见），快照会过时；join 一次查询成本可忽略 |
| 互斥守卫处置 | 删除（不保留开关） | 保留但默认关 | 死代码开关是「留着的选择」，删除让「忙时不碰獭」成为唯一路径；git 历史可回溯 |
| sender_id 同步（审视獭-glm 补 2） | sender_id 一并迁移到名册内当前大獭 | 只迁 talkingStonePassedTo 不动 sender_id | sender_id 钉历史獭会让历史发言归属继续指向名册外实体；与执行獭绑定同源，一次迁净 |
| 净机制账（审视獭-glm 建议） | +1 表 +1 tool −1 机制（互斥守卫） | — | 复杂度不升反降——退役清单经 mimo B2 裁决后只剩互斥守卫一件，reapPreempting/reapStale 保留 |

**机制识别检查点判定**：命中（新增持久化存储/新增 tool/新增状态生命周期/新增跨模块调用路径）→ 四问已答（见上），重对抗门必过。

## 验证

- **按名解析**：构造名册内大獭 + 名册外历史獭同名场景，任务触发后 invoke 的 otterId = 名册内那只；名册无匹配时落 skipped + healing；同名小獭不匹配「大獭」角色（roleToType 映射）
- **忙入列（宽口径）**：session 在池 → 入列；session 出池但**任何** execution 存活 running（含本任务）→ 同样入列；同任务重复触发 → 仍一条 pending（唯一索引）
- **入列与双执行互斥**：同任务同一 cron 槽位已有 execution 且 status ∈ {running, completed} → 不入列、照常记 completed（两窗口覆盖：completed 后撞车 + running 中撞车）；failed 不抑制（pending 兜失败重试）
- **once 排除**：once 任务 + 獭忙 → 落 skipped + **向对话注入系统消息提醒**（任务名将删除、承诺未执行）；无 pending 行、无 FK 悬空
- **闲直发**：isOtterRunning=false 且无 running execution 时触发 → 行为与现状一致（invoke + restartBeforeInvoke 生效）
- **提醒注入**：pending 非零的对话中唤醒獭 → user message 含提醒段；ack 后不再注入（提醒 = 状态镜像，无独立「已读」态，ack 是唯一状态翻转点）
- **tool 链路**：list → detail → ack 全链；ack 后 status=consumed
- **reapStale 选择性失效根因（退役前置条件）**：查清 10-19 能 fire、10-20 不 fire 的存活判定漏判根因；修复后注入僵尸行验证轮询清理真会 fire 并落 failed + healing
- **对账原子性（#1475 补充）**：对账判死后，同任务立即可被 claim（不出现「对账已清行但 claim 仍拒」的缝）；对账不误杀已发言落库的执行（mimo 补充 2）
- **显示层**：名册外 sender 的历史 entry 渲染为正确 type（本对话事故现场两条发言回归验证）
- **迁移**：全库 16 个任务（含 disabled 3 个）迁移后 executorRole 正确，下次触发走新路径；sender_id 同步迁移；旧字段保留作 fallback——17 处消费点逐一清点验证（重点：reapStale/reapPreempting 判活逻辑不受迁移影响）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/entities/scheduled-task/scheduled-task.ts | M | executorRole 字段；pending item 实体 |
| src/frameworks/db/schema.ts + migration.ts | M | executor_role 列 + scheduled_task_pending_items 表 + 部分唯一索引 |
| src/usecases/scheduler/scheduler-service.ts | M | 按名解析 + 忙入列分支（宽口径忙判定含本任务 + once 排除 + once 有声删除）+ 互斥守卫删除（reapPreempting/reapStale 保留）+ 入列双执行互斥 + 直投路由消费点（:1355）同步改造 |
| src/usecases/scheduler/pending-item-repository.ts | A | pending 表仓储 |
| src/frameworks/agent/session-helpers.ts | M | DynamicContext.scheduledTaskAlerts + 注入段（role 过滤） |
| src/interface-adapters/agent-runtime/tools/ | A/M | manage_scheduled_task_pending tool（或并入 manage_scheduled_task） |
| src/interface-adapters/http/dto/scheduled-task-dto.ts | M | executorRole 透出 |
| src/interface-adapters/http/dto/conversation-dto.ts | M | EntryDTO.senderOtterType |
| src/usecases/conversation/entry-repository.ts | M | entries 查询 join otters 带 type |
| web/src/lib/mappers.ts | M | mapEntryDTO 优先消费 senderOtterType |
| web 任务管理 UI | M | 角色字段展示 |
| 迁移脚本（启动惰性迁移） | A | 全库 16 个任务（5 对话，含 disabled 3 个）executorRole + sender_id 回填；旧字段保留作 fallback 不置空 |

## 实现要点与自检记录（2026-10-21）

- 按名解析落在 `resolve-executor-otter.ts`：active participants ⨝ active otters，`roleToType` 仅含 `大獭→big`，同名 small 不匹配；同角色多实例按 invoke/speak 最近活跃选择。解析失败才读旧 `talkingStonePassedTo[0]`，字段全程保留；不可用则 skipped + low healing。delta 复核重新 grep 后 scheduler 内剩 8 处旧字段代码消费 + 1 处注释，代码消费均为 healing 的 otterId 归属并容忍空值；reap/直投/重启/quota 重试均传解析结果。
- pending 使用 SQLite 部分唯一索引 `(task_id) WHERE status='pending'`；忙判扫描所有 running execution（无 20 条窗口，含本任务历史），本轮 execution 只排除自身。入列直接 INSERT completed(message_id=NULL)，绕过空 messageId FK；同槽位 running/completed 抑制，failed/skipped 不抑制。detail/ack 的“已直发覆盖”只认 completed 且 message_id 非空，避免 pending 自身 completed 把补执行永久误判为已覆盖。
- once 在建立 running 前先解析再忙判；忙时 skipped + system entry 明示将删除且承诺未执行，不入 pending；executions 台账随任务行 CASCADE 删除，可见性由保留的 system entry 承担。闲时正常直发。function executor 不走角色/pending 通道，保留原函数互斥。
- `scheduledTaskAlerts` 是 DB 状态镜像，每次唤醒按当前獭 name 精确过滤，非零即注入计数+最近任务名/时间，不含 body；ack 后状态变 consumed 才消失。新 tool 提供 list/detail/ack，ack 条件更新保证幂等，reason/resolution 必填；加入大獭白名单与 deferred manifest。
- `senderOtterType` 与 senderColor 在 entries 读路径同批 join otters 投影，DTO 优先于名册兜底；任务 UI 只读展示执行角色，不再写历史 otterId。
- 迁移幂等补列并全量回填（含 disabled）；sender_id 只在原值确为 otter ID 时同步到名册内当前大獭，system 不动。生产在线 backup 副本经 `initDatabaseAndModels` 完整启动及二次启动验证：16/16 角色非空、disabled=3、旧字段保留=16、pending 表+两索引齐全、SQLite error=0；foreign_key_check 前后均 4 条既有 execution 孤儿，增量 0 且逐项一致，未擅自清洗。
- `deleteExpiredPendingInvokes` 与 `hasInflightExecutionOnOtter` 在当前基线全仓检索均无后者定义/调用残留，前者也不存在；没有 :362 引用可替换。互斥分支已删除，reapPreempting/reapStale 保留。
- 保留件有效性根因：`PiSessionFactory.isRunning` 对 activeSessions 任意条目都判活，残留 session 可使超龄行永不释放（高置信；DB 无历史池快照，不能把该推断写成历史现场实录）。现改为 execution 侧证据优先：锚点后 2h 内有产出才保活；有锚点但无产出即使 session 残留也 reap；无锚点的停机冻结形态保留原保护。启动对账保留近期产出 execution，其余单次 UPDATE 翻篇，随后可立即 claim；避免把已发言工作仅因 running 残留误翻 failed。
- delta 修复（PR #1599 第一轮对抗审视）：同槽位不再用墙钟字符串等值，而由现有 `croner` 按 cron + timezone 计算真实 `[slotStart, slotEnd)`，同时供 running/completed 抑制与 detail/ack 直发覆盖检查；准点、毫秒差和相邻槽位均有真实 SQLite/解析器用例。判活只认系统锚点后本次 invoke 的新鲜 `invoke_start` / `speak`，搭档、其他獭或同獭其他 invoke 均不续命；`invoke_start` 保留尚未首次发言的当前执行。执行锚点改为 invoke 前写入 running 行（quota 重试同步更新），否则崩溃遗留行没有可查证据。旧版本遗留且无锚点的 running 无法反推 invoke，仍按无证据翻篇；不再保留“对话内任意新 entry 即可保活”的宽松口径。
- 忙判性能建议的量化处置：生产副本为 16 个任务 / 5 个对话，且任务为日/周/月级触发，当前不是热点；本 PR 不复制一套与 `resolveExecutorOtter` 可能漂移的 SQL 角色解析规则，后续规模上升再基于真实指标收口。
- 自检负面向：本变更有意废除“忙时 skip”“空 talkingStonePassedTo 创建报错”和“启动对账所有 running 一律 failed”三项旧契约；completed 现含“入列即完成”语义。互斥重启保护改由忙判承接，看门狗放弃型 skip、跑飞超时与 pending 滞留告警不在本特性扩大治疗。最简检查：未新增服务/事件总线；角色映射、pending 仓储和提醒均为单一实现，沿用现有 DI/SQLite/DynamicContext/tool 白名单。
- 验证：后端主套件 414 文件 / 6623 passed + 6 skipped；web 72 文件 / 737 passed，build 通过；tsc/eslint/tool-manifest/prompt/docs/tests/criteria 闸通过。delta 相关 4 文件 131 项通过，含真实毫秒差、相邻槽位、混合发送者、invoke 前锚点与未首次 speak 用例；`npm run check` 通过。生产副本启动验证如上。capability：录音网关确定性回放 1 passed（提醒按角色进入 wire user message、正文不注入、tool 实调成功、list 不消费）；真 LLM 行为用例因当前环境未配置端点显式 skip 1，不宣称真模型采样已通过。
- delta 负面向与最简检查：收窄掉“对话内任意新 entry 可保活”的误判；旧版本遗留的无锚点 running 无法反推 invoke，仍按无证据翻篇，不伪造保活证据。复用现有 `messageId` 与 croner，无新列/新依赖/新服务；仅为槽位计算增加一个小型纯函数，为运行中锚点增加一次既有仓储 UPDATE。已过最简检查。
