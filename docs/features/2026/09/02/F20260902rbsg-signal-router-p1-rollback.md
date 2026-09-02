---
id: F20260902rbsg
title: '信号路由器 P1 回滚：装配摘除回落直连链，待重新设计'
doc_type: feature
summary: |
  回滚 F20260901sgpv 信号路由器 P1 的入口换轨（装配层摘除，非 git revert）。
  动机：P1 上线当日连发两起事故——投影哑火（F20260902uspr）修复后，
  启动补扫将存量「未读」批量误判为待消费信号，3 分钟点燃 19 个休眠会话 126 次
  invoke。根因是收件箱「未读=待行动」语义不成立，属设计层缺陷，回滚后重新设计。

causal_links:
  from:
    - F20260901sgpv   # 被回滚的特性
    - F20260902uspr   # 揭开第二起事故的投影修复
  supersedes: []   # 不 supersede sgpv：类与测试保留，装配恢复即重新启用

status: final
change_type: fix
tags: [signal-protocol, dispatch, rollback, incident]
modules:
  - src/app.ts
capability_test: "n/a: 装配回滚（A 类），行为回归由既有直连链路径测试覆盖"
---

# F20260902rbsg: 信号路由器 P1 回滚

## 决策

摘除 SignalRouter 装配（`app.ts` 不再构造/注入），四入口全部回落直连链——这正是 sgpv 自己设计的可选注入降级面（「灰度回滚面——出问题改装配即回滚，不动业务代码」）。**非 git revert**：后续已叠加 #700 等提交，revert 冲突面大；`signal-router.ts` 类与 9 个单测保留，作为重设计参考；恢复装配一行即重新启用。P0 的 `signal_level/signal_meta` 列与 yield level 参数保留（无行为影响）。

## 事故时间线（2026-09-02）

| 时间 | 事件 |
|------|------|
| 10:25 | 更新代码（含 #692 sgpv）重启。`getUnreadMessages` 投影硬编码 `talkingStonePassedTo: null`，路由器收件箱恒空——**全入口哑火**（用户发言不触发任何调用，无错误日志） |
| ~11:00 | 合入 #700（F20260902uspr 投影修复）重启。修复拆掉了哑火的保险丝，`routeAllPending` 启动补扫第一次「看见」存量积压 |
| 10:57:26-11:00 | **批量点火**：100ms 内点燃数十条链，3 分钟 126 次 invoke、19 个会话复活（含 test001/002/003 等垃圾会话），用户杀进程 |

## 根因分析（重设计输入）

### 核心缺陷：「未读」≠「待行动」的语义混淆

P1 定义「收件箱 = 未读游标视图，消费 = markBatchRead 推进游标」（取舍表明确拒绝独立消费标记，理由「防第二真相源」）。两个被画等号的概念实际语义不同：

- **未读（游标）**：上下文注入账本——「我看到哪儿了」，供 `buildMessageWithContext` 注入历史。推进时机是**自己发言**；per-otter、允许永久滞后
- **信号（待行动）**：行动义务——「这次投递要求目标行动」。正确生命周期：**投递时产生 → 派发尝试时消费**（发起即消费，成败皆终态）

假阳性来源（游标滞后 ≠ 欠行动）：
1. **多獭会话稳态滞后**：只有发言者推进游标，非末位獭永远有未读。历史上一条点名过它但未接住的消息（被别的獭答了/链在接棒前死了/被用户 abort）= 永久 pending。事故中 19 个会话里 7 个多獭会话各点燃 2-5 只
2. **用户 abort**：abort 语义 =「别动了」，路由器仍认为欠行动——直接违背用户意图
3. **failed 后未重试**：旧世界 = 接受损失翻篇；路由器 = 债务永存

假阴性（碰巧未暴露）：獭因别的原因被调用并发言，游标跨过旧消息——「发过言 ≠ 消费过派发」。P1 验收场景全部是两语义恰好重合的 case（单獭会话+尾巴真未答），故未炸。

### 实现放大器：入口无 filter 的会话级全量重扫

sgpv 文档写的入口语义是「信号 = talkingStonePassedTo 指向的每个獭」（本次投递的目标），但 MC 调 `routePendingSignals(conversationId)` **不带 filter** → 会话级全量重扫 → 最近 200 条消息的所有滞留目标点火。后果：炸弹不止启动时——**有滞留游标的多獭会话里每条用户消息都会重燃全部陈年 pending**；invoke 完成后的 debounce 重扫同样全量 → yield 环自续燃（单獭 23 次反复 invoke）。

### 佐证数据

- 128 个会话末条消息 100% 是 otter（正常闭环成立——用户说话必触发响应，游标随之推进）
- `restart_pending_resumes` 空：僵尸 streaming（kill 时 14 条）不会被 resume 复活，仅转「服务重启，发言中断」终态
- 事故唯一合法 pending = 当日 broken window 的未答用户消息——语义正确的补扫应该只点这批

### 正确语义（供重设计）

**pending := 已投递 ∧ 该 (消息, 目标) 无派发记录**。消费由派发尝试记账，不由发言记账；游标回归唯一的本职（上下文注入）。派发台账才是行动义务的唯一真相源——系统已有碎片可复用：F20260821i336 派工台账、message_events、getPendingResumes。此语义天然落在 P2 已规划的「写路径 emitter」上。用该语义回放事故：broken window 消息 = 合法 pending（该补），多獭稳态滞后/abort/failed 翻篇 = 全部非 pending，两类皆对。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/app.ts | 修改 | 摘除 `new SignalRouter` 与三处注入（controllers/platforms/RIS），移除 import；留回滚注释块 |

## 验收结果

### AT-1 四入口回落直连链

- tsc 干净、eslint 0 error、全量 219 files / 2776 tests 通过
- 重启后验证：web 发消息 → `发言链调用`/`Agent invocation started` 日志恢复；启动无批量点火（无 routeAllPending）

### AT-2 无残留点火源

- `restart_pending_resumes` 0 条（实测）；僵尸 streaming 由 failInFlightMessages 转终态，不产生 LLM 调用
- scheduler 直连链路径未受 sgpv 影响，全程正常

## 后续

- 信号协议重设计：以上根因分析为输入，重点挑战 sgpv 取舍表第一条（游标视图 vs 消费标记）——本事故证明游标不是行动义务的合法真相源
- 重设计落地前，直连链即稳定基线；恢复装配前必须补「真实仓储 × 滞留游标」的集成测试（本次两起事故均由 mock 与真实投影/存量的分歧所致）
