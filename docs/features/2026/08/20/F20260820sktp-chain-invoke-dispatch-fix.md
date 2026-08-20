---
id: F20260820sktp
title: 链外 invoke 路径走 DispatchChainEngine 续跑发言链
summary: 修复 retry 端点和 scheduler 路径直接调 invoke 而不经过 DispatchChainEngine，导致 aggregatedTargets 无人消费、被点名的海獭不被唤醒的问题
change_type: bugfix
status: implemented
created_in_conversation: 6872acb4-d914-45fa-825e-a946e35324a7
capability_test: "n/a: 纯 A 类代码逻辑修复（链引擎路由），无 LLM 参与行为"
---

# 链外 invoke 路径走 DispatchChainEngine 续跑发言链

## 问题现象

手动重试（retry 端点）和定时任务（scheduler）两条路径直接调用 `agentInvoker.invokeConversation()`，不经过 `DispatchChainEngine`。invoke 返回的 `aggregatedTargets`（yield 传递目标）无人消费，被点名的海獭不被唤醒，多獭协作静默中断。

**案发现场**（2026-08-19，审计确证 2 起）：
- 对话《优化协作机制-即时交棒》11:30:52：架构-GLM 小獭两次 LLM API 400 失败后经重试按钮重新 invoke，`talking_stone_passed_to=["大獭"]`，但大獭从未被调用
- 对话《issue处理》16:25:40：review-otter-4 因 content_filter 失败后经重试按钮重新 invoke，`passed_to=[大獭]`，大獭被晾 12 分钟

## 根因分析

| 路径 | 问题代码 | 机制 |
|------|----------|------|
| retry 端点 | `message-controller.ts:374-392` 直接调 `agentInvoker.invokeConversation()` | 返回的 `aggregatedTargets` 无人消费 |
| scheduler | `scheduler-service.ts:395-414` 直接调 `agentInvokePort.invokeConversation()` | 同上 |

正常路径（`message-controller.ts:249-268`）和 recruiting 路径（`process-inbound-recruit.ts:222-236`）已通过 `DispatchChainEngine.executeChain()` 走链引擎，`aggregatedTargets` 被正确消费续跑发言链。

## 修复方案

### 1. MessageController.retry 改走 DispatchChainEngine

```typescript
// Before: 直接 invoke，aggregatedTargets 丢失
this.agentInvoker.invokeConversation({ otterId, conversationId, ... })

// After: 走链引擎，invokeFn 包装 agentInvoker
this.dispatchChainEngine.executeChain({
  conversationId, userMessageContent, senderId,
  initialTargets: [otterId],
  invokeFn: async (params) => this.agentInvoker.invokeConversation({
    ...params, retryCount: 1, manualRetry: true,
  }),
})
```

### 2. SchedulerService 注入 DispatchChainEngine

- `SchedulerServiceOptions` 新增可选 `dispatchChainEngine` 依赖
- `invokeAgentWithTimeout` 优先走链引擎，未注入时降级为直接 invoke（向后兼容）
- bootstrap 层将 `dispatchChainEngine` 传入 SchedulerService

### 3. 降级兼容

`dispatchChainEngine` 为可选依赖。未注入时（如测试场景或旧装配），`invokeAgentWithTimeout` 降级为原来的直接 invoke 行为，保持向后兼容。

## 影响范围

| 路径 | 变更前 | 变更后 |
|------|--------|--------|
| retry 端点 | 直接 invoke（aggregatedTargets 丢失） | 走 DispatchChainEngine（续跑发言链） |
| scheduler 触发 | 直接 invoke（aggregatedTargets 丢失） | 走 DispatchChainEngine（续跑发言链） |
| 正常发送 | 走 DispatchChainEngine | 不变 |
| recruiting | 走 DispatchChainEngine | 不变 |

## 已知限制

1. **多 hop 超时语义变化**：scheduler 路径的 5 分钟超时现在覆盖整条链（多 hop 共享），而非单次 invoke。实际链深度通常 1-2 hop，风险较低。若未来链深度增加，需考虑 per-hop 超时或放大超时窗口。
2. **retry 路径无单元测试**：MessageController 无单元测试（存量问题），retry 路径依赖集成测试验证。

## 变更文件

- `src/interface-adapters/http/controllers/message-controller.ts` — retry 方法改走 executeChain
- `src/usecases/scheduler/scheduler-service.ts` — 注入 dispatchChainEngine，invokeAgentWithTimeout 优先走链引擎
- `src/bootstrap/platforms.ts` — 传递 dispatchChainEngine 到 SchedulerService
- `src/app.ts` — initAgentAndScheduler 调用时传入 dispatchChainEngine
- `tests/usecases/scheduler/scheduler-service.test.ts` — +3 个测试（链引擎路径、降级路径、失败路径）
