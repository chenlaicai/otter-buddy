---
id: F20260922txes
title: 超时重试耗尽 L3 升级上报（梯度防线补全）
doc_type: feature

summary: |
  生成超时（first_byte_timeout / streaming_timeout / circuit_break:event_timeout）
  自动重试耗尽后的终态补齐 L3 升级上报：healing medium 落账（errorType=timeout_retry_exhausted）
  + 会话内用户可见提示「自动重试后仍未恢复，可手动重试」。此前 L1 自动重试（软提示）→
  L2 硬中断 梯度完整但 L3 缺失——搭档只见「[系统保护] 已自动中断」，不知是重试失败终态，
  与 bash 守卫 bounce 机制（GUARD_BOUNCE_MAX 超限升级）不对称。

causal_links:
  from:
    - F20260831aksp
    - F20260907grdr

change_type: feature
tags: [gradient-guard, timeout, healing, observability, retry]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
  - src/entities/healing/healing-event.ts
capability_test: "n/a: 系统护栏行为（非 LLM 参与行为），覆盖于 tests/usecases/conversation/agent-turn-orchestrator/retry-policy.test.ts"
created_in_conversation: 5c8cc078-3655-4e1a-ae63-70af967f92f9
---

# F20260922txes: 超时重试耗尽 L3 升级上报

## 背景

搭档在对话中观察到 `[系统保护] 生成超时（长时间无输出），已自动中断`，质疑该拦截是否符合「提示>拦截」的梯度设计原则。源码核实结论：梯度本身成立——

| 层级 | 触发 | 动作 | 锚点 |
|---|---|---|---|
| L1 软提示 | 首次 first_byte_timeout / streaming_timeout | 自动重试 + 系统提醒「请重新生成/继续完成发言」 | retry-policy.ts `buildAutoRetryMsg` |
| L2 硬中断 | retryCount>0 仍超时 | `[系统保护] 已自动中断` | orchestrator.ts:439-445 |
| ~~L3 上报~~ | — | **缺失**（本次补齐） | — |

对比 bash 守卫 bounce 机制（#731）：拦截 → 自动回发引导 → `GUARD_BOUNCE_MAX` 超限后 healing high + 会话内升级通知（`escalateGuardBounce`）。超时路径在 L2 就断了，静默中断掩盖模型/网络异常信号。

## 方案设计

在 `abortTerminal` 中新增超时重试耗尽终态的判定与升级，与既有 `isGuardBounceTerminal` / `recordGuardBounceTerminal` 模式同构：

- **判定**（`isTimeoutRetryExhaustedTerminal`）：`kind === 'guard'` + `guardReason` 可重试（`isRetryableGuardAbort`）+ 非 bash_safety（bounce 有独立升级路径）+ `retryCount > 0`（即 L1 自动重试已发生仍失败）。
- **升级**（`escalateTimeoutRetryExhausted`）：
  1. healing 落账：`errorType=timeout_retry_exhausted`、`severity=medium`（单次重试耗尽多为临时波动，区别于 bounce 二拦的 high 自纠失败），context 含 guardReason/retryCount/toolCallCount；
  2. 会话内提示：`buildTimeoutRetryExhaustedMsg`——只写确证事实（重试过、仍未恢复、可手动重试），不归因模型/网络（沿用 F20260913ctlv 口径）。
- 两者均非致命：healing 写入与 sendSystem 失败不阻断终态化。

`HealingErrorType` 与 `HealingEventInput.errorType` 联合类型同步扩展 `timeout_retry_exhausted`。

## 影响范围

- 行为变化：仅超时/工具异常类自动重试耗尽的终态新增一条 healing 事件 + 一条会话内系统消息；首超时自动重试、bash bounce、degenerate 熔断路径均不受影响。
- healing 查询：新增 errorType 枚举值，`manage_healing_events` 按 errorType 过滤可直接定位。

## 验证

- `npx tsc --noEmit` 通过
- `npx vitest run tests/usecases/conversation/agent-turn-orchestrator/ tests/entities/healing/`：6 文件 76 用例全绿
- 新增用例：`buildTimeoutRetryExhaustedMsg` 四种 reason（first_byte/streaming/circuit_break/未知）文案断言

## 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| severity 定 medium 而非 high | medium | 单次重试耗尽多为临时服务波动；high 留给 bounce 二拦这类「LLM 无视引导自纠失败」的行为异常 |
| 提示文案不归因模型/网络 | 只写确证事实 + 排查建议 | 沿用 F20260913ctlv 搭档拍板口径：系统无法确证根因不写断言 |
| 挂在 abortTerminal 而非路由层 | abortTerminal | 与 isGuardBounceTerminal 同构，终态判定单点收口，路由层（routeExitReason）不增复杂度 |
