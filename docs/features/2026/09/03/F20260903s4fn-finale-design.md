---
id: F20260903s4fn
title: 'sgp2 S4 终局：scheduler 换轨 + 看门狗语义迁移 + 游标 seq 化 + turn 写路径退役'
doc_type: feature
summary: |
  信号协议 v2 的收官段。四件套：① scheduler 入口换轨（最后一条直连链进闸门体系）；
  ② 看门狗语义迁移（静默窗判死 → 「attempt 终态 + 持续产出」双条件，#516 教训平移）；
  ③ 游标 seq 化（lastReadTurnNumber → lastReadSeq 双写迁移，刻度从 turn 换消息 seq）；
  ④ turn 写路径退役评估（读路径 #677 已派生视图化，写路径 createTurn/closeTurn 的
  消费面盘点后决定拆或留）。分四个独立 PR，每段可回滚。
status: draft
change_type: feature
tags: [signal-protocol, scheduler, watchdog, cursor-migration, turn-retirement]
modules: [src/usecases/scheduler/, src/usecases/conversation/, src/frameworks/db/]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
causal_links:
  from:
    - F20260902sgp2   # 父特性（S4 原规划）
    - F20260901sgpx   # 母方案（P4 turn 退役原设计）
---

# F20260903s4fn: S4 终局

## 0. 设计先行声明（搭档要求：方案呈报拍板后动工）

本文档是 S4 的设计稿，**未经搭档拍板不动工**。四个子段各自独立 PR。

## 1. S4a：scheduler 入口换轨（最小段）

现状：scheduler（定时任务）仍直连 executeChain（scheduler-service.ts:603），绕过路由器闸门——
限流熔断/用户停机期间定时任务照常点火（#766 文档自认的绕过面）。

方案：scheduler 的任务触发点改调 `signalRouter.routePendingSignals(conversationId)`，
与 web/IM/retry 同轨。**关键差异**：scheduler 的信号 sender 是 system/任务属主——
pending 判据的 `sender_type != 'system'` 过滤会排除 system 消息！
**解法**：任务触发的锚点消息以任务属主 otter 名义落库（senderType=otter, senderId=属主），
或 pending 判据放宽「system 但 signalLevel 非空」——两案取舍见 §6。

回滚面：装配开关（signalRouter 未注入时回落直连，既有降级面模式）。

## 2. S4b：看门狗语义迁移

现状：`watchChainWithActivity`（scheduler-service.ts）静默窗判死 = 锚点消息之后无新消息
（15min 默认，24h 硬上限）——「墙钟 + 消息存在性」启发式。

v2 语义迁移：判活条件升级为「**本任务触发的 dispatch_attempts 全部到终态 ∧ 终态后无新
产出**」。台账是持久真相源，重启后看门狗判定不丢（对比现状链 promise 内存态）。

风险与对策：#516 三次误杀教训（静默 ≠ 死亡）——长链 invoke 期间 attempt 行是
in_progress（非终态），天然不误杀；失败终态 ≠ 链活跃（v1 教训：失败可重试是 bug 不是
feature），判死即翻篇，重试走手动。

## 3. S4c：游标 seq 化（双写迁移）

现状：lastReadTurnNumber（turn 刻度）。turn 退役的前提是游标换刻度。

方案（母方案 P4 双写模式）：
1. participants 表加 `last_read_seq` 列（nullable）
2. markBatchRead 双写（turn_number + seq，seq 取本 turn 内最大 sequence_num）
3. getUnreadMessages 读路径切 seq 刻度（`sequence_num > last_read_seq`），turn 刻度保留
   为回滚列
4. 稳定一个观察期后停写 last_read_turn_number（列保留，S4 末段再议删）

风险：seq 与 turn 的映射边界（同 turn 多消息——markBatchRead 语义从「推进到 turn N」
变「推进到消息 X」，历史消息 seq 单调性依赖 sequence_num 全局递增——需勘测确认）。

## 4. S4d：turn 写路径退役（评估段，本设计只给结论框架）

turn 的现存职责盘点（勘测结论）：
- 分组元数据（turnId 在 message 行上）——#677 已读路径派生视图化，写路径仍生成
- 游标刻度——S4c seq 化后解除
- 链续跑聚合（turn-utils tryCloseTurn 聚合 talkingStonePassedTo）——#332 后链引擎直接
  消费 InvokeFnResult.aggregatedTargets，tryCloseTurn 的聚合是否仍有调用方待勘测
- 未读判定刻度——S4c 后解除

**结论框架**：若勘测确认 tryCloseTurn 无消费方 + 游标 seq 化完成，turn 写路径
（createTurn/closeTurn）可退役为「兼容性写入」（表保留、不再新建）——但**本设计不冒进**，
S4d 独立评估 PR（纯勘测报告），退役实施留待 S4e。

## 5. 迁移顺序与回滚

S4a（scheduler 换轨，独立可回滚）→ S4b（看门狗，依赖 S4a 的台账数据）→
S4c（游标 seq 双写，独立）→ S4d（评估）→ S4e（退役实施，视 S4d 结论）。

每段独立 PR + 独立回滚面。S4a/S4b 合入后 scheduler 全链过闸门，闸门绕过面清零。

## 6. 开放问题（呈搭档裁决）

1. scheduler 锚点消息的落库身份（任务属主 otter vs system+判据放宽）——我倾向前者
  （不污染 pending 判据，属主獭的「任务」本来就该是它的收件箱条目）
2. S4c 的 seq 刻度迁移是否需要停机窗口——双写期间新旧刻度并行，理论上无停机需求，
  但需勘测 sequence_num 的单调性保证
3. S4d 的评估深度：只勘测 tryCloseTurn 消费方，还是顺带盘点 turnId 在消息行的去留
  （消息行保留 turn_id 列作为历史分组元数据，成本极低，倾向保留）
