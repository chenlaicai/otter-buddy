---
id: F20260824srst
title: 自重启无限循环修复
summary: |
  修复海獭自重启无限循环 bug。根因是 handleSelfRestartSignal 递归调用时传入原始用户消息（"你重启自己"），新 session 的 LLM 会再次执行 restart_otter(self) → 无限循环。修复方案：消息语义修正（传 continuation message）+ 防循环复用熔断机制（healing_events 上限判定）+ tool 层拦截。
change_type: bugfix
status: active
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 7d763038-88ae-4a20-bec5-ec0dab156ca7
---

# 自重启无限循环修复

## 背景与需求

### 问题描述

搭档在对话中让大獭重启自己，大獭反复多次重启、多次调用自己，形成无限循环。

### 根因分析

**问题不在 LLM 的指令遵循，在 otter-buddy 的 `handleSelfRestartSignal` 设计缺陷。**

调用链路：

```
用户消息 "你重启自己"
  → LLM 调用 restart_otter(self)
    → tool-factory.ts: ctx.pendingRestart = { summary }（标记，不执行）
    → 返回 textResponse "已标记重启当前獭生。当前发言完成后将自动执行。"
  → SDK 标记 result._selfRestart
  → agent-invoker.ts: opts?.onSelfRestart?.(result._selfRestart)（闭包捕获信号）
  → orchestrator.executeTurn 完成
  → agent-invoker.ts:162 检测到 pendingSelfRestart
  → handleSelfRestartSignal:
      1. restartSession(otterId, summary) ← 创建新 session
      2. invokeConversationInner({ ...params, retryCount: 0 }) ← 递归调用，传入原始用户消息！
         → 新 session 的 LLM 看到同一消息 "你重启自己"
         → 再次调用 restart_otter(self)
         → 回到第 1 步，无限循环
```

**根因**：递归调用 `invokeConversationInner` 时传入原始用户消息。"你重启自己"是一次性指令，执行一次即完成，不应被重放。

**对比熔断机制（F20260818cbkr）**：熔断重放的是任务消息（"分析这个 bug"），任务没做完所以重放是对的；但"你重启自己"执行一次就完成了，重放 = 再次执行 = 循环。

### 为什么没有防护

- 没有递归深度计数
- 没有时间窗口检查（对比：熔断机制有 `maybeSecondaryCircuitBreak`）
- `invokeConversationInner` 调用时 `retryCount: 0`，重置了所有计数
- 注释说"自重启不需要写 circuit_break healing 事件"，完全没有留痕

## 方案设计

### 修复思路

三层防御，从不同层面消除循环：

1. **消息语义修正**（消除根因）：递归调用时传 continuation message（"你已重启，请继续"）而非原始消息
2. **healing_events 上限判定**（硬防线）：self_restart 事件标记新 session，连续自重启被拦截
3. **tool 层第一道防线**（更早拦截）：restart_otter 工具检查当前 session 是否由自重启创建

### 方案来源

Kimi 架构审视确认。核心观点：根因不是"缺防护"，而是消息语义错误——"你重启自己"是一次性指令，不应被重放。

## 实现细节

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/entities/healing/healing-event.ts` | 修改 | HealingErrorType 新增 `self_restart` |
| `src/usecases/conversation/agent-turn-orchestrator/types.ts` | 修改 | HealingEventInput errorType 新增 `self_restart` |
| `src/interface-adapters/agent-runtime/circuit-break-support.ts` | 修改 | 新增 `isSessionSelfRestartCreated` + `writeSelfRestartEvent` |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | `handleSelfRestartSignal` 三层防御实现 |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | `isSelfRestartLoop` + tool 层拦截 |
| `src/usecases/ports/otter-tool-client.ts` | 修改 | 新增 `getActiveSession` 接口 |
| `src/bootstrap/clients.ts` | 修改 | 新增 `getActiveSession` 实现 |
| `tests/interface-adapters/agent-invoker-self-restart.test.ts` | 修改 | 新增 AT-7/8/9 测试用例 |

### 关键代码变更

**1. continuation message（消除循环根因）**：

```typescript
// agent-invoker.ts: handleSelfRestartSignal
const continuationMessage = summary
  ? `[系统] 你已完成自重启。前情摘要：${summary}\n请基于前情摘要继续当前工作。如果没有明确任务，请告知搭档你已重启完成，等待新指令。`
  : `[系统] 你已完成自重启，前世上下文已封存。请告知搭档你已重启完成，等待新指令。`;
return await this.invokeConversationInner({
  ...params,
  userMessageContent: continuationMessage, // ← 替代原始消息
  retryCount: 0,
  manualRetry: false,
});
```

**2. healing_events 上限判定（硬防线）**：

```typescript
// circuit-break-support.ts
async isSessionSelfRestartCreated(otterId: string): Promise<boolean> {
  const session = await this.deps.manageSession.getActiveSession(otterId).catch(() => null);
  if (!session) return false;
  const events = await this.deps.healingRepo.findRecentByOtter(otterId, 'self_restart', 20);
  return events.some(e => {
    const ctx = e.context as { newSessionId?: string } | null;
    return ctx?.newSessionId === session.id;
  });
}
```

**3. tool 层拦截（第一道防线）**：

```typescript
// tool-factory.ts
if (targetOtterId === ctx.otterId && await isSelfRestartLoop(ctx, healingRepo)) {
  return errorResponse('[系统保护] 当前 session 已由自重启创建，不允许连续自重启。请通过新消息与獭交互。');
}
```

### 修复后流程

```
用户 "你重启自己"
  → LLM restart_otter(self, summary="用户要求我重启")
  → 标记 pending → prompt 完成 → 捕获信号
  → handleSelfRestartSignal:
      1. 上限检查 → false
      2. restartSession → newSession
      3. 写 self_restart event → 标记 newSession
      4. invokeConversationInner(userMessageContent="[系统] 你已完成自重启...")
         → 新 LLM 知道自己已重启，基于 summary 继续或等指令
         → 若再调 restart_otter(self) → tool 层拦截 → 循环终止
```

## 验收标准

### 测试覆盖

| 测试 | 场景 | 验证点 |
|------|------|--------|
| AT-7 | 防循环 | session 由自重启创建时，restart 未被执行 |
| AT-8 | continuation message | re-invoke 传入的不是原始消息，而是 continuation message |
| AT-9 | healing 事件写入 | self_restart 事件被写入，context.newSessionId 指向新 session |
| AT-1~6 | 向后兼容 | 原有自重启场景不受影响 |

### 测试结果

- 1448 tests passed（全量）
- 9 tests passed（自重启测试，含新增 AT-7/8/9）
- tsc --noEmit exit 0

## 影响范围

- 影响模块：agent-runtime（自重启机制）
- 影响文件：8 个
- 使用者：所有海獭的 restart_otter(self) 调用
- 破坏性变更：无（自重启行为从"无限循环"变为"一次重启+继续"，符合预期）

## 设计决策

| 问题 | 决策 | 理由 |
|------|------|------|
| continuation message 内嵌 summary | 有意冗余 | continuation message 是给 LLM 的直接指令，session summary 是系统上下文，两者目的不同 |
| getActiveSession 必填 | 编译期强制 | 防循环第一道防线必需，可选标记会导致防线静默失效 |
| invoker 层拦截静默返回 | 不发系统消息 | tool 层已拦截绝大多数场景，invoker 层是纯兜底，warn 日志已记录 |
| self_restart 事件类型 | 复用 healing_events 框架 | 不新造基础设施，与 circuit_break 同构 |

## 参考

- PR: #387
- Kimi 架构审视：self-restart-review.md（Kimi arch-reviewer）
- 相关特性：F20260818cbkr（degenerate-session-reset-circuit-breaker）、F20260819rscn（self-restart-continue）
