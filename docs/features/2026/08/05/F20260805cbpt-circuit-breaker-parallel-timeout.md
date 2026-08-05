---
id: F20260805cbpt
title: circuit-breaker-parallel-timeout
doc_type: feature

summary: |
  修复熔断器 per-event 超时在并行工具调用下失效的 bug。
  根因是单一 eventTimer 被后续 start 覆盖、被任意 end 提前 clear。
  按 toolCallId 分别跟踪计时器（Map<toolCallId, timer>），每个工具独立超时。

causal_links:
  from:
    - F20260804dglp   # PR #138 发现的同构问题
  to: []

status: development
change_type: fix
tags: [circuit-breaker, timeout, parallel]
modules:
  - src/frameworks/agent/circuit-breaker-helpers.ts
---

# F20260805cbpt: 熔断器并行工具调用超时修复

## 根因分析

### 问题描述

`circuit-breaker-helpers.ts` 的 per-event 超时机制使用单一 `eventTimer` 变量：

1. `tool_execution_start` 时：`clearEventTimer()` 后重新 arm（后一个 start 覆盖前一个的计时器）
2. `tool_execution_end` 时：直接 `clearEventTimer()`

pi-agent-core 默认 `toolExecution: "parallel"`（agent.js:132），一条 assistant 消息含 ≥2 个 toolCall 时连发 N 个 `tool_execution_start` 再各自发 `tool_execution_end`。

### 故障场景

1. **第二个 start 重 arm**：第一个工具的计时被丢弃
2. **第一个 end 就把计时器 clear 掉**：仍在执行的慢工具失去 `maxPerEventTimeMs`（600s）超时保护，可无限挂死

### 同构问题

与 OutputGuard 在 PR #138 中修掉的 S1（并行工具击穿 ref-count）完全同构。

## 修复方案

### 核心改动

将单一 `eventTimer` 改为 `Map<string, ReturnType<typeof setTimeout>>`，按 `toolCallId` 分别跟踪计时器：

```typescript
// 修改前
let eventTimer: ReturnType<typeof setTimeout> | undefined;
const clearEventTimer = () => { if (eventTimer) { clearTimeout(eventTimer); eventTimer = undefined; } };

// 修改后
const eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
const clearEventTimer = (toolCallId?: string) => {
  if (toolCallId) {
    const timer = eventTimers.get(toolCallId);
    if (timer) { clearTimeout(timer); eventTimers.delete(toolCallId); }
  } else {
    // 清除所有计时器（用于 unregister 等场景）
    for (const timer of eventTimers.values()) clearTimeout(timer);
    eventTimers.clear();
  }
};
```

### 事件处理

```typescript
// tool_execution_start：按 toolCallId 独立启动计时器
if (e.type === "tool_execution_start") {
  const toolCallId = e.toolCallId ?? "unknown";
  clearEventTimer(toolCallId);
  const timer = setTimeout(() => {
    logger.warn(`[circuit-breaker] PER_EVENT_TIMEOUT: otter=${otterId} toolCallId=${toolCallId} elapsed=${maxPerEventMs}ms`);
    doAbort("circuit_break:event_timeout");
  }, maxPerEventMs);
  eventTimers.set(toolCallId, timer);
  // ...
}

// tool_execution_end：只清除该工具的计时器
if (e.type === "tool_execution_end") {
  clearEventTimer(e.toolCallId);
}
```

## 验证

### 测试用例

添加了两个测试用例验证并行工具调用场景：

1. **并行工具调用各自独立计时**：两个工具并行执行，各自在阈值内完成，不触发超时
2. **并行工具调用中单个超时不影响其他**：一个工具超时触发 abort，另一个正常完成

### 测试结果

```
Test Files  1 passed (1)
Tests  16 passed (16)
```

## 参考

- 事件契约：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`（ToolExecutionStartEvent/EndEvent 均带 toolCallId）
- 同构修复样本：PR #138 output-guard.ts 的 pause 计数实现
