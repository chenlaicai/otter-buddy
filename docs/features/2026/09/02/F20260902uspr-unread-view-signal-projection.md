---
id: F20260902uspr
title: '未读视图投影丢失 talkingStonePassedTo：信号路由器全入口静默哑火'
doc_type: feature
summary: |
  修复信号路由器（F20260901sgpv）上线后所有会话用户发言不再触发海獭调用的回归。
  根因：getUnreadMessages 投影硬编码 talkingStonePassedTo: null（SQL 未查该列），
  路由器收件箱判别恒空，web/飞书/微信/resume 补扫四入口全部静默丢弃信号且无日志。
  修复：投影补齐该列的查询与解析，恢复「未读视图返回完整 Message 实体」契约。

causal_links:
  from:
    - F20260901sgpv   # 信号路由器 P1：第一个消费未读视图 talkingStonePassedTo 的调用方

status: final
change_type: fix
tags: [signal-protocol, dispatch, conversation, bugfix]
modules:
  - src/frameworks/db/conversation/conversation-repository-mixins.ts
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
capability_test: "n/a: 纯数据投影修复（A 类），行为由真实仓储回归测试覆盖"
---

# F20260902uspr: 未读视图投影丢失 talkingStonePassedTo

## 现象

更新代码（合入 #692 信号路由器 P1）重启后，所有会话中用户发言不再触发任何海獭调用：

- web 发消息正常落库（`Message sent` / `completed` / `talking_stone_passed_to` 解析正确），但无 `发言链调用` / `Agent invocation started` 日志
- 飞书/微信入口同样哑火；resume 启动补扫（routeAllPending）无效
- 定时任务正常触发（scheduler 走直连链，P1 边界刻意不换轨）——故非 LLM/装配层问题
- 全程无任何错误日志（路由器成功路径静默，`pending.length === 0` 直接 continue）

## 根因分析

信号路由器的收件箱设计（F20260901sgpv）：未消费信号 = 目标獭未读视图（`getUnreadMessages`）内、`talkingStonePassedTo` 指向该獭的 completed 消息。判别链：

```
pendingSignalsFor → getUnreadMessages(conversationId, otterId)
                  → filter(m => m.talkingStonePassedTo?.includes(otterId))   // ← 恒 false
```

两层缺陷叠加：

1. `conversation-repository-mixins.ts` 的 `getUnreadMessages` SQL **未查询 `talking_stone_passed_to` 列**
2. `sqlite-conversation-repository.ts` 映射处**硬编码 `talkingStonePassedTo: null`**

该投影自建立起即有损，但路由器之前没有任何消费方需要从未读视图读取此字段，故一直无害；#692 换轨后成为第一个消费者，接缝即断。

**为什么单测没拦住**：signal-router 的 9 个用例 mock 了 conversationRepo，mock 返回的 Message 携带真值 `talkingStonePassedTo`——mock 与真实投影的分歧使接缝从未被真实路径测过（与 PR #365 embedding 版本锚同类病）。

**数据侧排查实录**（排除项）：消息 completed、目标獭 active、参与者游标未推进（last_read 210 < 消息 turn 211）、目标无 streaming 残留（isOtterActive false）、dist 构建新鲜与源码一致——数据与装配均正常，唯一断点在投影。

## 修复

恢复「未读视图返回完整 Message 实体」契约（根因修复，非路由器侧绕行）：

1. mixins SQL 补查 `m.talking_stone_passed_to`，返回类型同步扩展
2. 仓储映射处按 conversation-mapper 同约定解析（`JSON.parse`，null 保持 null）

路由器代码零改动——其按 Message 实体契约编写的判别逻辑本来正确。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/db/conversation/conversation-repository-mixins.ts | 修改 | SQL 补列 + 返回类型 |
| src/frameworks/db/conversation/sqlite-conversation-repository.ts | 修改 | 映射解析真值替代硬编码 null |
| tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts | 修改 | 回归测试：真实 DB 路径断言 talkingStonePassedTo 投影 |

## 验收结果

### AT-1 真实仓储路径投影完整

- 复现：createParticipant + createCompletedMessage（talkingStonePassedTo 携带目标）→ getUnreadMessages
- 预期：返回消息的 talkingStonePassedTo 为真值数组（含目标判别命中）；无目标消息保持 null
- 结果：`npx vitest run tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts` 50 passed（新增 1 用例）

### AT-2 全量回归

- `npm test` 全量通过、tsc 干净（见 PR CI）

## 教训

- **mock 分歧是结构性风险**：新消费方依赖既有仓储投影的某字段时，必须有真实 DB 路径的契约测试锚定，mock 测试无法暴露投影层丢字段
- 静默跳过（`continue` 无日志）正是 F20260901sgpv 自己要消灭的「不可见的坏」——路由器 pending 空判定的可观测性缺口记为后续观察项
