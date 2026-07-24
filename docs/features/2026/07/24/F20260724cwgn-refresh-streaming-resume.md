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
   streaming 中正文为空时显示"正在回复..."占位；ctx 缺失时不渲染 token 条。
4. **轮询续看**：`allMessages` 中存在 streaming/speaking 的 otter 消息时，每 2s 静默刷新
   listMessages（失败不 toast，下轮重试），全部终态后自动停止。
5. **轮询快照合并（mergeMessages）**：不用快照整体替换本地列表——过期快照不回退本地已终态的
   消息（响应发出于 complete 之前、到达于之后）；保留未上服务器的 tmp 乐观消息。
6. **渲染期去重**：MessageList 渲染历史列表时过滤 streamingMap 中存在的 id（实时视图优先），
   对"轮询带回 streaming 消息 + 同 id message.start"的所有竞态交错稳健；
   SSE 落列表（complete/failed/aborted/error）按 id upsert。
7. **进行中消息保留停止能力**：历史列表中的 streaming/speaking 消息渲染停止按钮
   （复用 `api.abortMessage`），刷新后用户仍可中止发言。
8. **孤儿消息 reconcile**：服务启动时将遗留 streaming/speaking 消息标记为 failed
   （`failInFlightMessages`，重启后不存在活跃 agent，消息不可能再到达终态）——
   这是轮询"全部终态后停止"前提的熔断保障；speaking 消息保留已有 speak body。

## 对抗检视记录（PR #87）

首轮实现经对抗性评审发现三个严重问题并全部修复：
- S1：轮询将 message.start 移走的消息重新加回历史 → 双重渲染（改为渲染期去重，变更 6）
- S2：孤儿 streaming 消息使轮询永不停止且无法进入终态（启动 reconcile，变更 8）
- S3：刷新后用户失去停止能力（历史消息停止按钮，变更 7）
另有 M1（过期快照回退闪烁）、M2（tmp 消息被擦除）由合并式更新（变更 5）解决；
A1（断开测试空转）改写为真实 cancel response body 的回归测试（对旧代码验证失败）。

第二轮复检新发现的轻微问题中，三个随本 PR 修复：
- N1：轮询活跃期间发新消息，tmp 乐观消息与服务端真实消息双重渲染——
  mergeMessages 丢弃快照中已存在等价内容（同 st/si/content）的 tmp 副本
- N2：abort 端点不校验消息状态，终态消息 abort 会留 stale abortedOtters 标记污染下次
  invoke 错误分类——端点增加 canAbortMessage 校验，终态返回 409
- N3：live 会话 SSE 中途断开轮询永不启动（S2 的对偶）——onError 时 refreshMessages
  播种进行中消息，轮询 effect 自动接管
- N4（遗留后续）：同 turn 多消息时流式气泡固定沉底，视觉时序可能倒置——
  需要 streaming 状态携带序号信息才能交错渲染，属独立改动

## 兼容性

- API：`POST /messages/:id/abort` 对终态消息从 202 改为 409（此前调用无实际效果，属错误用法显式化）；其余无变更（DTO 本已携带 status，前端此前未消费）。
- 行为变更：刷新/断开 SSE 不再（尝试）中止 agent 发言——此前该 abort 从未生效，故无实际行为回退风险。
- 持久化：无 schema 变更；启动 reconcile 一次性将历史孤儿消息置为 failed（可视为数据修复）。
- 重启语义：启动即 reconcile 意味着"重启 = 所有进行中发言中断"（进程消失必然如此，只是显式化）。

## 后续可选

- SSE 断流恢复（resume endpoint）替代轮询。
- streamingMap 按对话隔离（当前为全局 Map，跨对话可能串台，pre-existing）。
- speak complete 时持久化 token 用量（updateTokenUsage 当前无调用方，pre-existing）。
