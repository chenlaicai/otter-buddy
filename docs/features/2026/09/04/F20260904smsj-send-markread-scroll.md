---
id: F20260904smsj
title: "发言即已读：消除发言后视口上跳与最新消息不可见"
doc_type: feature
summary: >
  修复 09-03 查明但未落地的体验问题（欠账）：用户发言后，未读分隔线定位 ×
  自动滚底门控竞争导致视口向上跳；且 isAtBottomRef=false 时插入新消息不滚底，
  最新消息不可见。修法：发言 = 已看完全部（聊天通用语义）——handleSend 开头
  立即标记已读到当前最新 seq、强制回底部、清未读分隔线与新消息计数。
change_type: fix
tags: [conversation, scroll, unread, mark-read, ux]
modules: [web/src/pages/conversation/index.tsx]
capability_test: "n/a: 前端滚动交互行为，现有 MessageList.test.tsx 9 用例回归通过（视口跳动的因果在 CSSOM/滚动时序，jsdom 无法模拟，人工验收）"
created_in_conversation: bffea3ae-a1df-47d6-b9b3-83606c230448
causal_links:
  from:
    - F20260903ah68   # S3.5 横幅/徽标——同期查明的两个体验问题之一（本修法当时已定未落地）
---

# F20260904smsj: 发言即已读：消除发言后视口上跳与最新消息不可见

## 需求背景

搭档报告（09-03 查明根因，09-04 同现象复现——修复一直未落地）：
「为什么我发言后，ui 上对话框中的焦点位置老是会往上跳一下？然后界面上就看不到最新消息了」

根因两个，都在前端 web 层：

1. **视口上跳**：发言时若上一轮獭回复未被标记已读（如上一条消息还没滚到底看过），
   `loadConversationDetail` / 轮询会按 `firstUnreadSeq` 渲染「未读消息」分隔线；
   该分隔线的定位计算与 MessageList 的「在底部自动滚到底」门控竞争，
   视口跳向未读消息位置（历史位置），而非停在最新消息。
2. **最新消息不可见**：MessageList 的增量滚动 effect 以 `isAtBottomRef.current` 为
   前置条件——发言前用户若不在底部（例如刚被 ① 跳上去），插入新消息后不触发滚底，
   用户消息 + 后续回复都堆积在视口之下。

## 方案设计

**语义修正**：发言 = 已看完全部（微信/Slack 等聊天软件通用语义）。用户主动发消息
意味着不再需要「未读」提示的锚定，分隔线与滚底门控的竞争自然消失。

`handleSend`（web/src/pages/conversation/index.tsx）开头追加四步，在乐观插入用户消息之前执行：

1. `isAtBottomRef.current = true` —— 喂回滚底门控：后续 messages.length effect
   视用户为「在底部」，插入消息后正常滚到底（修复根因 2）
2. `setNewMessagesCount(0)` —— 清新消息计数浮窗
3. `setUnreadSeparatorSeq(null)` —— 清未读分隔线，轮询 merge 不会重画（修复根因 1）
4. `api.markRead(activeId, maxSeq)` —— 标记已读到当前最新服务端 seq（不含 tmp- 前缀乐观消息），
   fire-and-forget；服务端 lastReadSeq 推进后，后续轮询/重进会话不再判为未读

失败路径不回滚：markRead 网络失败时下次滚到底仍会标记（既有 handleMarkRead 兜底），
分隔线与计数已在本地清掉，本地体验不受影响。

## 影响范围

- 单文件单函数改动（handleSend），前端 web 层
- 不影响：上翻加载历史的 preserve-scroll（pendingScrollRestoreRef 路径）、
  跳转定位（handleJumpToMessage）、多模态附件发送、S3.5 横幅/徽标
- markRead API 复用既有端点与节流机制，无后端改动

## 验证

- `npx tsc --noEmit` 通过
- `npx vitest run` 47 文件 404 用例全绿（含 MessageList.test.tsx 9 用例回归）
- `npm run lint` 通过
- 人工验收（合并后）：① 底部发言 → 无上跳，视口停最新消息；② 上翻中途发言 → 视口回到底部（而非停在历史区）；③ 上一轮回复未读时发言 → 分隔线消失、计数归零
