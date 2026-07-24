---
id: F20260724cwgn
title: refresh-streaming-resume
doc_type: feature

summary: |
  刷新页面后消息状态误报"已完成"修复：前端 LocalMessage 透传 status 并按真实状态渲染，
  进行中的消息轮询续看；删除 SSE 断开时从未生效的 abort 死代码。
  确立"前端是后端状态的投影"原则：发言生命周期由后端状态机管理，刷新≠停止。

causal_links:
  from:
    - F20260723mk75

status: draft
change_type: bugfix
tags: [streaming, sse, refresh, message-status, polling, frontend]
modules:
  - src/interface-adapters/http/
  - web/src/lib/
  - web/src/pages/conversation/

created_at: 2026-07-24
---

# F20260724cwgn 刷新页面消息状态误报修复

## 术语定义

| 术语 | 定义 |
|------|------|
| **投影** | 前端是后端状态机（streaming → speaking → completed）的只读投影，不含自有生命周期 |
| **轮询续看** | 刷新后历史中存在进行中消息时，前端每 2s 静默拉取 listMessages 直到全部终态 |
| **upsert** | SSE 事件落列表按 messageId 更新或追加，避免与轮询快照双写产生重复 |

## 背景

用户报告：大獭发言中刷新页面，消息显示"已完成"；再次刷新，流式过程内容还在增长。

### 根因 1：前端投影有损且撒谎（核心）

服务端 DTO 携带 `status`，但 `mapMessageDTO` 丢弃该字段；历史渲染的流式过程标题硬编码
"已完成 · {duration}"（MessageList.tsx）。进行中的消息因此被误标为已完成。

### 根因 2：SSE 断开时的 abort 是从未生效的死代码

`sendMessage` 的 onAbort 回调调用 `agentInvoker.abort(oid, "")`：空 messageId 使 sessionKey
退化为 `otterId`，而 session 注册键为 `otterId:messageId`，查找必然 miss。
该代码的存在暗示"刷新应中止发言"的设计意图，但这是因果倒置——
前端是展示层，后端发言是否继续不该由展示层事件驱动（决策：方向 A，刷新后继续生成，类 ChatGPT）。

### 根因 3（现象放大器）：speaking 状态可继续追加事件

`canAppendEvent` 允许 streaming/speaking（F20260723mk75 两阶段提交设计），
历史查询是 DB 实时快照，故两次刷新之间内容持续增长——这是合法行为，只是前端没有"进行中"概念。

## 变更

1. **后端**：删除 `message-controller.ts` 中失效的 onAbort abort 调用；`sse-streamer.ts` 的
   `onAbort` 改为可选参数。显式 abort 端点（`POST /messages/:id/abort`）保留。
2. **前端 status 透传**：`LocalMessage` 新增 `status` 字段，`mapMessageDTO` 映射 DTO status。
3. **按真实状态渲染**：流式过程标题按 status 显示 进行中（呼吸点动画）/ 失败 / 已中断 / 已完成·耗时；
   streaming 中正文为空时显示"正在回复..."占位。
4. **轮询续看**：`allMessages` 中存在 streaming/speaking 的 otter 消息时，每 2s 静默刷新
   listMessages（失败不 toast，下轮重试），全部终态后自动停止。
5. **双写去重**：`message.complete/failed/aborted/error` 落列表改为 upsert；
   `message.start` 将同 id 消息从历史列表移入实时流式视图，避免轮询快照与 SSE 重复渲染。

## 兼容性

- API：无变更（DTO 本已携带 status，前端此前未消费）。
- 行为变更：刷新/断开 SSE 不再（尝试）中止 agent 发言——此前该 abort 从未生效，故无实际行为回退风险。
- 持久化：无 schema 变更。

## 后续可选

- SSE 断流恢复（resume endpoint）替代轮询。
- 服务端启动时对孤儿 streaming/speaking 消息做 reconcile（如标记 failed）。
