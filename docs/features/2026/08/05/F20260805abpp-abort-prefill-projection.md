---
id: F20260805abpp
title: abort-prefill-projection
doc_type: feature

# 记忆索引
summary: |
  修复"系统保护中断"事故的双根因：guard 工具结束后误用滑动超时窗口 + 前端 abort 终态投影丢失。
  guard resume 统一 re-arm 首字节窗口（post-tool 冷 prefill 与 prompt 首发同性质），删除冻结/恢复机制。
  前端常驻 /subscribe 通道补 message.aborted 处理器，续看轮询定点拉取提前于空增量返回、并改自续期循环。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260804dglp   # degenerate-loop-silence-fix（guard 重构，冻结语义在此引入）
    - F20260724cwgn   # 统一渲染通道 + 轮询续看（refreshMessages 原始设计）

# 元数据
status: development
change_type: fix
tags: [output-guard, timeout, sse, abort, frontend-projection]
modules:
  - src/frameworks/agent/output-guard.ts
  - tests/frameworks/agent/output-guard.test.ts
  - web/src/pages/conversation/index.tsx
  - web/src/lib/message-stream.ts
  - web/src/lib/message-stream.test.ts

# 时间
created_at: 2026-08-05
---

# F20260805abpp: 中断可见性修复——guard 工具后首字节窗口 + 前端 abort 投影

## 事故背景

2026-08-05 上午同一污染 session（大獭，mimo，上下文 67万~96万 token）连发两起"系统保护"中断，
排查中暴露两个独立缺陷：

### 事故 1：《对话列表的状态图标》—— streaming_timeout 误切

用户发"你继续"，大獭工具调用循环后，下一次模型生成 **120 秒零 delta**，
guard 以 `streaming_timeout`  abort（`timeoutMs=119880 totalLength=61`）。
该请求 input=351,906 token——工具结束后的冷 prefill 静默期超过滑动预算 120s。

### 事故 2：《关键资源太长了》—— abort 发生了但用户 6 分钟看不见

guard 于 01:38:03 真实触发 `degenerate_output`（repeat_window 50 次）并广播
`message.aborted`（subscriberCount=2，SSE 已转发）。但用户界面持续显示"生成中"，
直到 01:44:29 用户主动点中断（后端 409：消息已终态），前端重新拉取才显示出
6 分钟前落库的中断文案——用户误以为文案是自己点击的结果。

## 根因分析

### 根因 1（guard）：工具结束 resume 恢复的是滑动剩余预算，post-tool prefill 落入盲区

`OutputGuard.resume("tool")` 按 F20260804dglp 的冻结语义恢复暂停前的滑动剩余
（≤120s）。但工具执行结束后紧跟的是**新请求的冷 prefill**（全量上下文重算），
与 prompt 首发同性质——compaction/auto_retry 的 resume 早已 re-arm 首字节窗口
（300s），唯独 tool 走滑动剩余。大上下文 session 的 prefill 超 120s 即被误切。

### 根因 2（前端）：常驻 SSE 通道缺 message.aborted 处理器

会话页有两套事件处理器：随发送请求建立的流（有 `message.aborted`）和页面常驻
`/subscribe` 通道（**没有**）。混合架构下功能页间 MPA 整页刷新会杀死发送流，
刷新后 abort 终态只能经常驻通道到达，被 `handlers[currentEvent]?.(data)` 静默丢弃。

### 根因 3（前端）：续看轮询双重失效

`refreshMessages` 用本地最后一条消息作 `/after` 游标，而**增量结果严格在游标之后，
游标消息自身的 streaming→aborted 状态迁移永远不在增量里**。当 in-flight 消息恰好是
最新消息时增量恒为空，`newerMsgs.length === 0` 提前 return 使"in-flight 定点拉取"
兜底成为死代码；且空转不改变 state，依赖 effect 重跑排期的 2s 轮询链在首次无变化后
永久停转（日志证实事故中仅轮询一次即停止）。

## 修复方案

### Part 1：guard resume 统一首字节窗口（`output-guard.ts`）

**不变量**：所有 pause 原因（tool / compaction / auto_retry）结束后跟随的都是新请求的
冷 prefill → `resume` 计数归零时一律 `armTimer("first_byte", firstByteTimeoutMs)`。

- 删除冻结/恢复机制（`pausedRemainingMs` / `pausedKind`）：resume 不再有任何
  恢复剩余预算的路径，机制成为死代码；
- `pause` 纯化为停表 + ref-count；pause 期间到达的 delta 只更新 abort 引用；
- auto_retry 特例（生成中 delta 即释放 pause 并 arm 滑动计时器）保持不变——
  该路径 delta 已到达，prefill 确已结束。

### Part 2：前端 abort 投影（`conversation/index.tsx` + `message-stream.ts`）

- 常驻 `/subscribe` handlers 补 `message.aborted`（与发送流处理器对齐：
  upsert 终态消息 + toast + 清理 live 状态）；
- `refreshMessages`：in-flight 定点拉取移到空增量 early-return 之前（改为不提前返回），
  提取纯函数 `findStaleInFlight`（message-stream.ts）固化"/after 不含游标消息自身
  状态迁移"这一不变量；
- 续看轮询 effect 改自续期循环：`refreshMessages` 完成后无条件排下一轮，
  直到 allMessages 变化触发 effect 重跑时由入口条件（仍有 in-flight）决定去留——
  空转不再断链。

## 验证

- `tests/frameworks/agent/output-guard.test.ts`：
  - 工具结束 resume re-arm 首字节窗口，prefill 静默超滑动预算不误切（事故 1 回归）；
  - 并行工具 ref-count + 末个 resume 首字节窗口；pause 期间 delta 后 resume 仍首字节窗口；
  - attach 层 tool_execution_start/end 全链路（首字节窗口断言）。
- `web/src/lib/message-stream.test.ts`：`findStaleInFlight` 三例
  （in-flight 为最新消息必被挑出；终态/tmp/err/已在增量中的排除；user 消息不算 in-flight）。
- 根仓 `npm run check` 全绿（979 测试）；web `vitest run` + `tsc --noEmit` 全绿（73 测试）。

## 影响面

- **agent 行为**：工具调用后的首次模型响应窗口从滑动剩余（≤120s）变为首字节预算
  （默认 300s）。正常流式下首个 delta 到达即切回滑动窗口，无感知；大上下文 prefill
  不再被误切，真正挂死的请求仍会被 first_byte_timeout 兜底（文案"模型响应超时"）。
- **API/持久化**：无变化。
- **前端**：abort 终态在 MPA 刷新后可靠投影；in-flight 消息的轮询收敛不再断链。
