---
id: F20260806btk7
title: context-tokens-persist
doc_type: feature

# 记忆索引
summary: |
  修复重新进入对话后上下文使用率（token 条）消失：_handlePostInvocation 调 complete
  时漏传 tokenUsage/ctxMax，token 数据只走 SSE 实时事件从未落库（101 条已完成消息
  context_tokens 全 NULL）。complete 补传 contextTokens（input+output，与 SSE 口径一致）
  与 contextTokensMax，一处修复覆盖全部正常完成路径。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260724cwgn   # refresh-streaming-resume（M3"ctx 缺失不渲染"守卫在此引入，历史未持久化缺口在此记录为已知）

# 元数据
status: development
change_type: fix
tags: [token-usage, context, persistence, sse, message-complete]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - tests/interface-adapters/agent-invoker.test.ts

# 时间
created_at: 2026-08-06
---

# F20260806btk7: token 用量随 complete 落库——修复刷新后上下文使用率消失

## 问题现象

在线对话时每条 otter 消息的 token 条（上下文使用率）正常显示；
重新进入对话（MPA 整页刷新 / 切换会话回来）后全部消失。

搭档判断：上下文使用率应该是每条 message 的字段属性——排查证实该判断正确，
持久化链路早已建好，断在最后一环。

## 根因分析

**链路盘点（全部存在）**：DB schema 有 `context_tokens` / `context_tokens_max` 列
（schema.ts）；实体 ↔ mapper ↔ DTO 映射完整（DTO 条件输出 `ctx`/`ctxMax`）；
repo `completeMessage` 支持写入；`CompleteMessageInput` 有两个字段。

**唯一断点**：`agent-invoker.ts` `_handlePostInvocation` 调
`sendMessage.complete(p.messageId)` 只传 messageId。`p.result` 携带的
`tokenUsage`/`ctxMax` 仅用于随后的 SSE `message.complete` 实时事件
（`completeAgentInvocation`），从未落库。

**数据实证**：本地库 101 条已完成 otter 消息，`context_tokens` 101 条全 NULL，
0 条有值——100% 复现，不是偶发。

**显示机制分野**：
- 在线：SSE 实时事件带 ctx → 前端 `m.ctx != null` → token 条渲染；
- 重进：`GET /messages` 读 DB → context_tokens 为 NULL → DTO 不带 ctx →
  M3 守卫（`MessageList.tsx`，"ctx 缺失不渲染"）拦截 → 不渲染。

M3 守卫本身是 F20260724cwgn 引入的合理防御（进行中消息 ctx 缺失不该显示空条），
但它把"历史未持久化"这个写入侧缺口显性化了——当时留作已知，本次补齐。

## 修复方案

`_handlePostInvocation` 一处修复（agent-invoker.ts）：

```ts
const totalTokens = p.result.tokenUsage ? p.result.tokenUsage.input + p.result.tokenUsage.output : undefined;
const cr = await this.sendMessage.complete(p.messageId, {
  contextTokens: totalTokens,
  contextTokensMax: p.result.ctxMax,
});
```

**口径决策**：落库值与 SSE 实时事件保持同一算法（input+output）、同一 result 对象、
同一 ctxMax——构造级一致，不存在"在线显示 X、刷新变 Y"的漂移可能。

**路径覆盖**：speak 重试 / degenerate 重试的旧消息走 fail（过渡态，不写 token 合理），
重试产生的新消息重新 invoke 后再次经过同一 complete 调用点——全仓仅此一处业务调用，
一处修复覆盖所有正常完成路径。abort/fail 终态不写 token：body 为合成中断文案、
非 completed 态，token 条无展示语义。

**undefined 边界**：tokenUsage 缺失时 complete 收到 undefined → repo 层 `?? null`
绑参写 NULL，与修复前行为一致（不渲染），无崩溃风险。

## 验证

- `tests/interface-adapters/agent-invoker.test.ts`：
  - mockSendMessage 的 complete mock 记录调用参数（`_completeCalls`）；
  - 正常流程测试补断言：complete 收到 `{ contextTokens: 15, contextTokensMax: 200000 }`
    （result tokenUsage input=10/output=5，10+5=15）——回退修复必红，非 mock 自洽；
  - 28 个测试全过。
- `send-message.test.ts` 25 过；`tsc --noEmit` 通过；ESLint 干净。
- web 前端零改动（message-stream 合并逻辑天然兼容：incoming 携带字段优先）。

## 对抗审视记录（一轮：complete 路径覆盖 / 口径一致性 / 测试真实性 / undefined 边界）

检视獭独立审视（diff 与 worktree 逐行比对 + 全仓 complete/updateTokenUsage 调用点排查 +
20 个 otter 工具通读），结论：**通过，可以合入**，6 维度无未解决问题。

- 【核验】complete 全仓唯一业务调用点即修复处；speak 工具只调 startSpeaking；
  MessageController、DispatchChainEngine 无 complete 调用——覆盖完备。
- 【核验】落库值与 SSE ctx 同源同公式，构造级一致。
- 【核验】新增断言验证 invoker→SendMessage 真实数据流，回退修复必红。
- 【核验】undefined 边界经 repo `?? null` 安全落 NULL；既有无 tokenUsage 用例天然覆盖。
- 【观察项，存量，已立项】`SendMessage.updateTokenUsage` 与 repo 实现全仓零调用——
  当初"设计好没接线"的预留路径，本 PR 走 complete 直传后彻底成为死代码。
  处置：issue #168 独立清理（usecase 方法 + 接口声明 + repo 实现 + mock 残留），
  不塞本 PR。
- 【记录在案】tokenUsage 语义是 session 累计值（getSessionStats），非单轮上下文窗口
  占用——SSE 实时展示一直用此口径，本 PR 目标是落库与实时一致，已达成；
  语义本身属存量设计问题，是否改为"窗口占用"口径呈搭档定方向。

## 影响面

- **持久化**：新完成的 otter 消息 context_tokens/context_tokens_max 正常落库；
  刷新后历史消息 token 条恢复显示。
- **存量数据**：101 条历史消息 token 用量未留存在任何其他位置（sessions 数据无
  per-message 对应），无法低成本回填，老消息 token 条仍不显示。已告知搭档。
- **API/前端**：无变化（DTO 字段条件输出逻辑、前端渲染守卫均未动）。
- **合入后验证**：跑一次真实对话，确认 DB 新消息 context_tokens 非 NULL
  （静态审查覆盖不了真实 SQLite 写入）。

## 关联

- PR：#167
- 死路径清理：issue #168
