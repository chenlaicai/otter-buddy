---
id: F20260920trrt
title: turn 系统整体退役：闲置预警口径重写（发言 seq 差 + 2h 时间护栏）+ turns 表拆除
date: 2026-09-20
change_type: refactor
capability_test: "n/a: schema/仓储层重构（verify_by=static_only：3633 单测全绿 + 迁移幂等用例；预警行为面由 dispatch-chain-engine.test.ts 10 用例锁定）"
created_in_conversation: 804600de-080e-4241-8253-a2e42600114d
summary: 起因是「大獭已闲置 54 轮是否解散」乌龙——解散提示发给了小獭，且「轮」口径已失真（F20260913ctlv 后 turn 碎片化 + lastActiveTurnNumber 停摆）。搭档拍板：① 预警只对 big 发、口径换「距上次发言的 seq 差」叠加「2h 内被唤醒不告警」时间护栏；② turn 系统发现的残留本次完整梳理移除——turns 表 drop、entries.turn_id / participants turn 列退役、get_turn_history 工具下线、写路径 turn-blind 化
tags: [turn-retirement, idle-warning, schema-migration, entries, seq-cursor]
modules: [src/usecases/conversation/dispatch-chain-engine.ts, src/frameworks/db/schema.ts, src/frameworks/db/migration.ts, src/frameworks/db/conversation/, src/usecases/conversation/send-entry.ts, src/usecases/conversation/turn-utils.ts, src/interface-adapters/agent-runtime/tools/, src/entities/conversation/]
from:
  - F20260819idnw  # 闲置预警原实现（turn 刻度）——本特性重写其口径
  - F20260913ctlv  # entries 彻底切换（turns 表保留的决策在本特性翻转）
  - F20260902sgp2  # S4 turn 写路径退役评估——本特性完成其遗留的表级拆除
---

# turn 系统整体退役 + 闲置预警口径重写

## 预注册（troubleshooting 流程，动手前冻结）

- **预期根因方向（问题 1）**：预警注入点对所有被唤醒目标生效，不筛大小獭
- **预期根因方向（问题 2）**：闲置刻度 = maxTurn - lastActiveTurnNumber，turn 粒度碎片化 + 活跃度只在「被唤醒」时推进，两头失真
- **验证标准**：dispatch-chain-engine.ts 注入点与 pi-session-factory.ts 推进点代码实证
- **最强反例方向**：若预警有筛 big 逻辑则查消息组装层；若 turn 完整则查计数函数
- **结果**：两个预期全部命中（见下文根因分析）

## 问题现象

2026-09-18，某对话中小獭发言称「系统提示大獭已闲置 54 轮是否解散」。两个问题：
1. 解散提示不该发给小獭（dissolve 是大獭专属权限）
2. 「54 轮」计数失真——该对话中小獭只发言一两次

## 根因分析

### 问题 1：预警不筛接收者

预警注入点是 `buildMessageWithContext`（组装派发上下文），被 `executeOneHop` 对**本 hop 所有被唤醒目标**调用——小獭被派工唤醒时同样收到「现场有小獭闲置，你评估下是否顺手解散」。而小獭视角下，刚 yield 完石子的大獭因 `lastActiveTurnNumber` 停摆被误报为闲置对象。

### 问题 2：「轮」口径已死

- **turn 粒度碎片化**：F20260913ctlv 后 turn 变成「无 open turn 就创建、invoke 全终态即关」——一次链式协作开多个 turn，turn 数 ≠ 对话轮次。54 ≈ 对话累计碎片 turn 数。
- **活跃度记号失真**：`lastActiveTurnNumber` 只在「被唤醒」时推进（pushCursorOnStartup），不是发言时；批4c 修复前 JOIN 长期 miss 停摆。

## 修复设计（搭档拍板）

### ① 预警口径重写（narrow-fix）

- **receiver 限 big**：非 big 直接短路——解散权专属，从根上断乌龙
- **闲置 = 发言 seq 差**：该小獭最后一条 speak 之后对话又新增的发言数（entries 全类型计数；未发言过按 0 计，差值 = 入群以来对话总推进，不误伤刚入场）
- **时间护栏**：seq 差超阈值但 2h 内被唤醒过（invokes.started_at）不告警——防高频干活小獭被误报（搭档 09-18 拍板）
- 阈值：`otter_idle_threshold` 语义换轨为 seq 差（默认 30）；新增 `otter_idle_grace_hours`（默认 2）
- 实现：读时聚合三查询（getMaxEntrySeq / getLastSpeakBySender / getLastInvokeStartedAtByOtter），零写路径；speak 时间不参护栏（发言后又有 K 条发言才计入差值，语义自洽）

### ② turn 系统整体退役（scope-reduction + deletion）

行为消费面摸排结论（退役前逐一核实）：
- `get_turn_history` 工具：唯一行为消费方 → 下线（工具+白名单+manifest+客户端面+档案）
- entries.turn_id / participants turn 列：FK 簿记，无读消费 → 拆列
- turns 表：链调度簿记残余（tryCloseTurn 聚合）→ drop
- artifact/participant 的 turn 戳：纯账面记录无消费 → 拆
- scheduled_task_executions.turn_id：死字段（从未写入非 null）→ 拆
- SSE `turn.complete` 事件名：历史兼容名，前端按名消费 → 保留事件名不动（重命名会断前端）

迁移顺序硬约束：① entries 去 turn_id（拆 FK）→ ② participants 去 turn 列（拆 FK）→ ③ turns drop。FK 事务模式与 rebuildAttachmentsKindCheck 同款（PRAGMA foreign_keys 事务外关、事务后恢复）。幂等：新库 PRAGMA 检测不到 turn_id 直接返回。

## Verification

- 全量 267 文件 3633 测试通过，tsc 零错误
- 预警新口径 10 用例（big 限定/护栏边界/未发言计差/降级路径/阈值 fallback）
- 迁移幂等：retireTurnSystem 二次执行零副作用（PRAGMA 短路）
- messages-to-entries 迁移回归：存量库形态（含旧 turns 表）迁移路径全绿

## 不兼容更新

- [Incompatible] turns 表 drop（存量库迁移自动拆除）
- [Incompatible] entries.turn_id / conversation_participants turn 族列 drop
- [Incompatible] get_turn_history 工具下线（Agent 工具面）
- [Incompatible] linked_resources 的 linked_at_turn_number / status_changed_at_turn_number 列 drop
- [Incompatible] scheduled_task_executions.turn_id 列 drop
- ConversationParticipant / Entry / LinkedResource / Turn 实体字段收窄（嵌入方需同步）
