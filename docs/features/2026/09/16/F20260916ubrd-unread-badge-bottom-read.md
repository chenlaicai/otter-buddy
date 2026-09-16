---
id: F20260916ubrd
title: 底部即已读：修复人在对话底部时新消息不自动标记已读致小红点残留
summary: |
  搭档 9/15 报告「人正在对话中，未读小红点仍亮着，必须切走再切回来才消除」。
  根因：已读游标（conversation_user_read_state.last_read_message_seq）只有三个推进
  渠道——首次进入初始化、滚动到底部（onReachBottom）、发言时（handleSend）。用户
  停驻在底部既不滚动也不发言时，新条目（speak/system）落库后后端 unreadCount>0，
  左侧栏小红点残留；生产 DB 实测印证（游标 1 < 最新 seq）。修复：新增统一
  scheduleMarkReadIfAtBottom（复用既有 markRead 端点 + 500ms 防抖 + MAX 钳制），
  在两条新消息到达路径（轮询 refreshMessages、SSE 常驻通道 effect）中，若用户
  在底部则顺手推进已读游标。未读统计口径（speak/system）不覆盖的 invoke_start/
  invoke_end/yield 条目天然容忍游标越过。修法排序①（既有「底部=已读」语义内补
  触发点），无净新增机制。
change_type: fix
capability_test: "n/a: 纯前端触发点补齐（A 类），无 LLM 行为变化；行为由 web 单测 + tsc + 既有 markRead 相关用例（merge-conversations）回归覆盖"
created_in_conversation: d6833675-6d81-4a30-9ed9-89d5f327c46a
tags: [conversation, unread, mark-read, ux, badge]
modules: [web/src/pages/conversation/index.tsx]
created_at: 2026-09-16
---

# 底部即已读：修复人在对话底部时新消息不自动标记已读致小红点残留

## 问题现象

搭档 9/15 报告：「对话的未读小红点，如果我正在这个对话中，为什么还会有未读，然后我必须点其他对话再点进来一次才会消除，感觉这个小红点有点太不准了」。

复现路径：
1. 用户打开对话并停在消息底部，既不滚动也不发言
2. 海獭/系统产生新条目（speak/system）
3. 左侧栏轮询带回服务端权威 unreadCount>0 → 小红点亮起
4. 用户明明看到了新消息，小红点却不消失
5. 必须切到其他对话再切回来（触发首屏 onReachBottom），小红点才消除

## 根因分析

**已读游标推进渠道盘点**（修复前只有三个）：
| 渠道 | 位置 | 触发条件 |
|---|---|---|
| 首次进入初始化 | index.tsx:288 `loadConversationDetail` | `lastReadSeq===0 && unreadCount===0` |
| 滚动到底部 | MessageList.tsx:325 `onReachBottom` → index.tsx:1003 `handleMarkRead` | 用户滚轮/触板滚动 |
| 发言即已读 | index.tsx:725 `handleSend`（F20260904smsj） | 用户发消息 |

**漏网场景**：用户停驻在底部不动时，新消息经两条路径到达——
- SSE 常驻通道（index.tsx:397 effect 内 entry.speak/entry.system 等 handler → `batchUpdateMessages`）
- 轮询兜底 `refreshMessages`（index.tsx:317，SSE 断连时拉 entries after 游标）

两条路径都**不推进已读游标**。后端 `getUnreadCount`（sqlite-conversation-repository.ts:202）按 `entry_type IN ('speak','system') AND seq > last_read_message_seq` 计算，游标不动则计数>0，左侧栏小红点残留（merge-conversations 策略：服务端权威）。

**生产实测印证**（2026-09-15，对话 d6833675）：`conversation_user_read_state.last_read_message_seq=1`，而 entries 已有 seq=2（invoke_start）——游标在用户静观期间纹丝不动。

**为什么切走再切回来能消除**：重新进入对话触发 `loadConversationDetail`，首屏渲染后 MessageList mount-only effect 调 `onReachBottom` → `handleMarkRead` 把游标推满。

## 机制识别检查点（修法排序①判定）

逐项打勾：
- [ ] 新增配置字段/枚举/开关 —— 无
- [ ] 新增状态生命周期 —— 无（游标语义不变，只多一个推进触发点）
- [ ] 新增定时任务/后台进程 —— 无（复用既有防抖 ref 模式）
- [ ] 新增信号类型/消息格式 —— 无
- [ ] 新增持久化存储 —— 无（复用 conversation_user_read_state 表与 markRead 端点）
- [ ] 新增决策分支（结果被记住）—— 新增运行时分支 `isAtBottomRef.current === true → markRead`，其结果写入已读游标——但该分支是「底部=已读」既有语义（F20260814h2rg、F20260904smsj 两次拍板确立）的触发点补齐，不是新决策语义
- [ ] 新增跨模块调用路径 —— 无（index.tsx 内部，api.markRead 既有调用）

**结论**：走修法排序①（既有机制语义内修）。未读统计口径（speak/system）不覆盖 invoke_start/invoke_end/yield，因此 markRead 到全部条目的最大 seq 不会跳过任何真实未读内容——游标越过居中条目天然安全，无需按类型过滤，保持窄修复。

## 修复方案

在 `web/src/pages/conversation/index.tsx` 新增一个统一函数：

```ts
scheduleMarkReadIfAtBottom(convId: string)
```

- 若 `isAtBottomRef.current === true`（用户在看底部）：取 `allMessagesRef` 中该对话真实消息（排除 tmp-/err- 乐观气泡）的最大 seq，经 500ms 防抖后调 `api.markRead(convId, maxSeq)`（fire-and-forget）
- 防抖：复用既有 `markReadTimerRef`（per-conversation timer map），高频 SSE 事件合并为一次调用；组件卸载 cleanup
- 失败不回滚：网络失败时下轮新消息到达会重试，且服务端 upsert 用 MAX 钳制只前进不后退

**两个挂接点**：
1. `refreshMessages`：轮询拉到新条目且实际合并进列表后调用
2. SSE 常驻通道 effect：新增 `useEffect(() => {...}, [activeId, activeMessages.length])`，任何途径（SSE/POST 流/重试流）导致活动对话消息数变化后检查一次

挂接点 2 选择「消息数变化」而非逐个 SSE handler 内嵌：entry.speak/entry.system/invoke.start/entry.yield 等 handler 共 5+ 处，统一 effect 一处覆盖全部，且 POST 发送流/重试流（不走常驻 effect handlers 但也经 `batchUpdateMessages`）同样受益。

## 影响范围

- 单文件改动：`web/src/pages/conversation/index.tsx`
- 不改后端：markRead 端点、防抖、MAX 钳制全部复用既有机制
- 不影响：上翻阅读历史（isAtBottomRef=false 时不触发）、未读分隔线定位（loadConversationDetail 的 firstUnreadSeq 逻辑不变）、新消息 N 条浮窗（不在底部时才计数，与本修复互斥）
- 与 F20260904smsj「发言即已读」同源同语义：用户停留位置=已读

## 对抗审视结论（2026-09-16，检视獭-ubrd / mimo）

**0 严重发现，4 建议发现**（B1-B5 基础维度全过：CI 通过、文档完整、tsc+439 用例全绿、标识一致、无撞车）。初轮 comment 留痕，无代码处置项，检视獭确认无需 delta 复核。

处置：4 个建议发现均判「更好但本 PR 窄修复无法承载」，聚合成 issue #964（tech-debt/P2）后续迭代——统一 markRead scheduler（S2）+ 提取 getRealMessages/getMaxSeq 工具函数（S3+S4）+ scheduler 统一后 S1 时序窗口自然消除。

## 验证

- `npx tsc --noEmit` 通过
- `npx vitest run` web 全量用例回归（含 merge-conversations 的 markRead 相关用例）
- 人工验收（合并后）：① 停在底部等獭回复 → 小红点不再残留；② 上翻阅读历史时新消息到达 → 小红点正常亮起（不误标已读）；③ 切走再切回 → 行为不变
