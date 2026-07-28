---
id: R20260728cbfx
title: circuit-breaker-toolname-misread
doc_type: research
summary: |
  排查对话 t002（2026-07-28）中大獭执行「确认 git diff 并提 PR」任务时被「[系统保护] 输出异常，
  已自动中断」误杀的事故。根因：circuit-breaker-helpers 从 pi-coding-agent SDK 的
  tool_execution_start 事件读取工具名时取错字段（e.name，实际为 e.toolName），导致所有工具
  调用被记为 "unknown"，连续相同工具检测必然误报，steer 死线最终在模型正常生成长文本期间
  强制 abort 了一次完全健康的调用。
causal_links:
  from:
    - F20260716bte2   # agent-circuit-breaker（熔断器设计与引入）
    - F20260727guard  # OutputGuard（internal_abort 的对外呈现路径）
status: final
exploration_type: incident
tags: [circuit-breaker, pi-sdk, incident, bugfix, tool-call, steer]
conclusion: 事件字段名取错导致熔断器必然误报；修复为 e.toolName ?? e.name ?? "unknown"，并补 attachCircuitBreaker 回归测试
created_at: 2026-07-28
---

# 熔断器误杀健康调用 · 排查报告

## 事故现象

2026-07-28 17:07（本地，UTC 09:07），对话 **t002**（conversation `0e3a8e31-6f15-402f-bd45-485492f64d03`）中，搭档向大獭下达任务：

> 这个修改我看见好几次了，我感觉是代码遗漏，每次重新编译都会出现这个 git diff。你确认下，如果是问题，那你就提交一个github pr

大獭正常工作约 102 秒后，消息被标记为 `aborted`，前端仅显示：

> [系统保护] 输出异常，已自动中断。

大獭此前已完成：查 `git diff`（package-lock.json 的 bin 路径改动）、确认 remote 与 `gh` 可用、创建分支 `fix/package-lock-bin-path-normalization`、暂存改动并跑 `npm run check`；**被中断时正在推敲 commit message 模板格式**。分支与暂存改动残留，commit 与 PR 未完成。

## 现场证据链

### 服务端日志（data/logs/otter-buddy.log）

```
09:09:23 [circuit-breaker] Steer timeout: otter=0710b3b0-… — force aborting after 30000ms
09:09:23 [circuit-breaker] CIRCUIT_BREAK: otter=0710b3b0-… trigger=steer_timeout calls=9 history=[unknown,unknown,unknown,unknown,unknown,unknown,unknown,unknown,unknown]
09:09:23 Agent invocation error: "[output-guard] internal_abort" isAbort=true
```

关键点：**9 次工具调用的名字全部是 `unknown`**。

### Pi session 转录（data/sessions/2026-07-28T09-05-10-048Z_….jsonl）

- 大獭实际发起 9 次工具调用（`bash` 为主），**每次命令内容都不同**，无任何循环迹象。
- 从第 6 次调用起，每次工具结果后都被注入一条 user 消息：
  `Consecutive identical tool "unknown" called N times. Break the pattern.`（N = 6,7,8,9）
- 09:08:53 第 9 次调用注入 steer 后，模型开始生成一段较长的 thinking（研究 commit 模板），期间无新工具调用；09:09:23（整 30 秒后）生成被强制截断。

## 根因分析

### 根因：事件字段名取错（circuit-breaker-helpers.ts）

pi-coding-agent SDK 的 `tool_execution_start` 事件载荷为（`dist/core/extensions/types.d.ts` 中 `ToolExecutionStartEvent`）：

```ts
{ type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
```

而 `src/frameworks/agent/circuit-breaker-helpers.ts:27` 修复前的实现：

```ts
const e = event as { type?: string; name?: string };
if (e.type === "tool_execution_start") {
  const result = circuitBreaker.check(e.name ?? "unknown");  // e.name 永远 undefined
```

工具名恒为 `"unknown"`。同一进程内 `agent-invoker.ts` 的正确写法是 `e.name ?? e.toolName`——两处对同一事件的取值方式不一致，说明该 hook 在编写/重构时未对照 SDK 实际事件形状验证。

### 误杀放大链：三个机制串联

1. **连续相同工具检测（B-3）必然误报**：所有调用名字相同（`unknown`），`consecutiveCount` 无脑递增，第 6 次调用（`maxConsecutiveIdentical=5`）起每次工具调用都触发 steer。工具用得越勤，越像「死循环」。
2. **steer 死线（B-5b，30s wall-clock）**：每次 steer 通过 `setSteerDeadline` 重置 30 秒硬边界，只有新的工具调用才能续命。模型停止调工具、专心写长文本（恰是 steer 期望的「收敛」行为）时，没有任何机制清除死线——**「听从 steer 开始输出」本身就是死线触发的条件**。
3. **OutputGuard 呈现层掩盖真实原因**：force abort 走 `wrappedAbort()`，未传 reason，记为 `internal_abort`，最终对用户呈现为「输出异常，已自动中断」，把一次熔断器误杀伪装成模型输出退化。

### 为什么之前的会话没炸

该 bug 自熔断器引入起就存在。此前大多数对话工具调用轮次少（< 6 次）或模型在 30 秒死线内完成了输出，未踩中「连续 6 次工具调用 + 随后 30 秒无工具调用的长生成」的组合条件。t002 的任务（多步 shell 操作 + 长 commit 推敲）恰好全部命中。

## 修复内容

- `circuit-breaker-helpers.ts`：工具名取值改为 `e.toolName ?? e.name ?? "unknown"`（优先 SDK 实际字段，`name` 保留为兼容兜底）。
- 新增 `tests/frameworks/agent/circuit-breaker-helpers.test.ts`：
  - 回归测试：SDK 形状事件下不同工具交替调用不触发误判（事故场景复现）；
  - 同名单工具连续超限仍正常 steer（不误伤真实检测能力）；
  - `name` 旧字段兼容、字段缺失兜底 `unknown`、terminate 动作调用 abort。

## 遗留问题（本次未修，建议后续立项）

1. **steer 死线语义缺陷**：模型听从 steer 停止工具调用、转入长文本生成时，死线应被清除或改由 OutputGuard 的流式超时接管。当前实现惩罚的正是它想诱导的行为。建议：agent 开始产出 assistant 文本/speak 时调用 `clearSteerDeadline()`。
2. **abort 原因传递**：`wrappedAbort()` 无参调用导致熔断器触发的 abort 一律记为 `internal_abort`，用户侧文案与真实原因脱节。建议 force abort 时传入 `circuit_break:<trigger>` 作为 reason。
3. **测试盲区**：熔断器此前只有单元测试（直接构造 breaker），没有覆盖 `attachCircuitBreaker` 与 SDK 事件形状的集成路径——字段名错误正是从这个缝隙漏出去的。本次新增的测试补上了这个面。
