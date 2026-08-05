---
id: F20260805f146
title: degenerate-output-gradient-intervention
doc_type: feature

summary: |
  degenerate_output 梯度介入：abort + 系统提醒重试一次，再犯才落终态。
  实证表明大獭 thinking 块分析结论往往正确，只是陷入复读循环出不来。
  复用 handleSpeakRetry 模式，重试期间前端展示过渡态而非死信。

causal_links:
  from:
    - F20260805abpp

status: development
change_type: feature
tags: [output-guard, degenerate, retry]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
---

# F20260805f146: degenerate_output 梯度介入

## 背景

2026-08-05 排查三起 `[系统保护]` 中断时确认：mimo 模型存在 repeat_window 复读倾向（干净上下文下也会自发退化）。当前 OutputGuard 对 `degenerate_output` 是一刀切终态：abort → 消息落库 `[系统保护]` → 轮次结束。

实证：事故中大獭 thinking 块的分析结论**是对的**，只是陷入复读循环出不来——abort+提醒重试大概率能救回这一轮。

## 方案

对 `degenerate_output` 做梯度介入（其他 trip 原因不变）：

1. guard 触发 → abort 当前流
2. session-sanitizer 清洗退化块（现有机制，在 `finally` 块中执行）
3. 注入系统提醒并重试一次（复用 `handleSpeakRetry` 模式）
4. 重试再犯 → 才落 `[系统保护]` 终态

### 提醒文案

```
[系统提醒] 你上一轮陷入重复循环，分析已在上下文中，不要重新推理，直接基于已有结论调用 speak 输出。
```

阻断"重新分析"，引导直接输出已有结论。

### 前端过渡态

重试期间前端通过 SSE 事件序列看到：
1. `message.failed` (body: "检测到输出异常重复，正在自我纠正")
2. `system.message` (提醒文案)
3. `message.start` (重试开始)

比直接亮 `[系统保护]` 死信体验好。

## 时序保障

`sanitizeSessionSafely` 在 `_executeWithSession` 的 `finally` 块中调用（`session.dispose()` 之后）。重试调用 `invokeConversation` → `_executeWithSession` 时，当前轮次的 session 文件已被清洗，上下文干净。

## 约束

- **仅 `degenerate_output` 适用**：`streaming_timeout` / `first_byte_timeout` 是挂死/传输类故障，提醒无意义
- **最多 1 次重试**：污染驱动的事故重试大概率再犯，"一次"保证可恢复的救回、不可恢复的只多烧一轮 token
- 大上下文下重试有一轮额外 token 成本

## 实现

### 核心改动：`_handlePostInvocation`

在 `_handleGuardAbortOrSpeakRetry` 中，检测到 `degenerate_output` 且 `retryCount === 0` 时，走 `handleDegenerateRetry` 而非直接 abort。

### 共享方法：`executeRetryWithSystemReminder`

`handleDegenerateRetry` 和 `handleSpeakRetry` 共用的重试逻辑：
1. `sendMessage.fail()` — 前端展示过渡态
2. `sendMessage.sendSystem()` — 注入提醒到 DB + LLM 上下文（失败降级为 abort）
3. `invokeConversation({ retryCount: 1 })` — 重试

### 降级策略

- `sendSystem()` 失败 → 直接走 abort 终态，避免 double-terminal 事件
- `invokeConversation` 抛异常 → error 路径处理

## 对抗审视修复

| 级别 | 问题 | 修复 |
|---|---|---|
| HIGH-1 | abortedMessages 泄漏 | `add` 移到 degenerate check 之后 |
| HIGH-2 | 测试 mock 不够真实 | 递增 message id + 6 个测试用例 |
| MEDIUM-1 | retryCount 传递链路 | 类型约束通过 p 对象透传 |
| MEDIUM-2 | sendSystem() 失败降级 | try/catch 包裹，失败走 abort |
| MEDIUM-3 | 重复代码 | 提取 executeRetryWithSystemReminder |
| LOW-1 | 重试 token 成本记录 | retry 完成后打日志 |
| LOW-2 | 圈复杂度 | 保留 _handleGuardAbortOrSpeakRetry 提取 |

## 验证

- 单元测试覆盖：6 个测试用例覆盖所有边界情况
- `npm test` 全量通过（989 tests）
