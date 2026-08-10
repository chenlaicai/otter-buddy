# 设计方案：无缝重试 — 隐藏 Speak 重试机制

## 背景

搭档 chen 原话：
> "当前海獭发言没用speak，系统会触发 提示+重新让发言，然后在ui侧，就会看到 海獭发言（无speak无body内容） > 系统提示 > 海獭发言（大部分会用speak）。但这个过程，对我来说（用户），我感觉有点累，因为其实对我而言，这本质上是一次发言。"

当前行为：Agent 未调用 speak 工具时，用户看到 3 条消息（失败消息 + 系统提醒 + 新消息），本质上是一次发言的重试过程被完整暴露给用户。

## 目标

T1: 用户在 Agent 重试时只看到一条连续的消息，从 message.start 到 message.complete，中间的重试过程不可见。
T2: Agent 的工具调用过程（tool_call 事件）在重试期间仍然实时可见，保持透明度。
T3: 重试失败时（所有尝试均未调用 speak），用户仍能看到明确的错误提示。

## 非目标

N1: 不改变 auto-retry（streaming_timeout、first_byte_timeout、circuit_break）的行为 — 这些重试有独立的用户价值（超时提示），噪音问题较轻，后续可独立优化。
N2: 不改变 degenerate_output 重试的行为 — 同上，退化检测有独立价值。
N3: 不改变消息的持久化模型 — 消息实体、事件存储、Turn 生命周期不受影响。
N4: 不改变 LLM agent session 的行为 — 系统提醒注入方式不变（仍通过 userMessageContent）。

## 全链路分析

### 1. 当前重试链路（用户可见的 3 条消息）

```
用户发送消息
  → AgentInvoker.invokeConversation()
    → sendMessage.start() → 创建消息 A (status=streaming)
    → agentInvoke.invoke() → LLM 执行，流式事件（tool_call, text）
    → classifyAndRoute() → 检测到 message.status !== 'speaking'
    → handleSpeakRetry():
      1. sendMessage.fail(messageId=A, body="[系统] 未调用 speak 工具结束发言")
         → 关闭当前 Turn
         → 发送 SSE: message.failed {messageId: A, body: "[系统] ..."}
      2. sendMessage.sendSystem(conversationId, retryMsg)
         → 创建系统消息到 DB
         → 发送 SSE: system.message {content: "你上一轮没有调用任何工具..."}
      3. invokeConversation() → 创建消息 B (新 messageId)
         → sendMessage.start() → 创建消息 B (status=streaming)
         → agentInvoke.invoke() → LLM 执行
         → sendMessage.complete(messageId=B)
         → 发送 SSE: message.complete {messageId: B, body: "..."}
```

**用户看到：**
- 消息 A（otter，failed）："[系统] 未调用 speak 工具结束发言"
- 系统消息："[系统提醒] 你上一轮没有调用任何工具..."
- 消息 B（otter，completed）：Agent 的最终回复

### 2. 优化后的链路（用户只看到 1 条消息）

```
用户发送消息
  → AgentInvoker.invokeConversation()
    → sendMessage.start() → 创建消息 A (status=streaming)
    → agentInvoke.invoke() → LLM 执行，流式事件（tool_call, text）→ 实时推送给用户
    → classifyAndRoute() → 检测到 message.status !== 'speaking'
    → handleSpeakRetry():
      1. sendMessage.fail(messageId=A, body="[系统] ...")  ← 内部操作，不发 SSE
         → 关闭当前 Turn
      2. sendMessage.prepareForRetry(messageId=A)
         → 重置 A.status = 'streaming'
         → 清空 A.body = null
         → 创建新 Turn
         → 更新 A.turnId = 新 Turn
      3. retryInvokeOnSameMessage(otterId, conversationId, retryMsg, senderId, messageId=A)
         → agentInvoke.invoke(otterId, retryMsg, {messageId: A, ...})
         → 流式事件继续推送给用户（同一 messageId A）
         → sendMessage.complete(messageId=A)
         → 发送 SSE: message.complete {messageId: A, body: "..."}
```

**用户看到：**
- 消息 A（otter）：从 streaming 到 completed，工具调用过程可见，最终 body 是 Agent 的回复
- 无失败消息，无系统提醒

### 3. 关键模块影响链

| 模块 | 文件 | 当前行为 | 改动 |
|------|------|----------|------|
| SendMessage | send-message.ts | 无 prepareForRetry | 新增方法 |
| AgentInvoker | agent-invoker.ts | handleSpeakRetry 创建新消息 | 改为复用同一消息 |
| ConversationRepository | conversation-repository.ts | 无 resetForStreaming | 新增方法 |
| 前端 index.tsx | conversation/index.tsx | 处理 message.failed + system.message | 无需改动（事件不再发送） |
| MessageList | MessageList.tsx | 渲染系统消息和失败消息 | 无需改动（数据不再到达） |

## 方案设计

### 核心思路

**单消息重试**：重试时复用同一消息 ID，不创建新消息，不注入系统消息到对话历史。系统提醒仅通过 userMessageContent 传递给 LLM，对用户完全透明。

### A. 后端改动

#### A1. 消息实体新增 `canPrepareForRetry` 守卫

```typescript
// entities/conversation/message.ts
/**
 * 是否可以准备重试（speak 重试专用）。
 * 仅 failed 状态的消息可被重置为 streaming。
 */
export function canPrepareForRetry(status: MessageStatus): boolean {
  return status === 'failed';
}
```

#### A2. SendMessage 新增 `prepareForRetry` 方法

```typescript
// send-message.ts
/**
 * 重置消息为可重试状态：failed → streaming（speak 重试专用）。
 * 前置条件：消息必须处于 failed 状态（canPrepareForRetry）。
 * 操作：清空 body、创建新 Turn 并关联消息、更新 FTS 索引。
 *
 * 设计决策：失败期间的 message_events 保留不删——包含两次尝试的完整
 * 工具调用链，有调试价值。FTS 索引清空以避免搜索命中旧 fail body。
 */
async prepareForRetry(messageId: string): Promise<Message> {
  const message = await this._repo.getMessageById(messageId);
  if (!message) throw new DomainError(`Message not found: ${messageId}`, "not_found");
  if (!canPrepareForRetry(message.status)) {
    throw new DomainError(`Cannot prepare for retry: status=${message.status}`, "conflict");
  }

  // 创建新 Turn（旧 Turn 已被 fail() 关闭）
  const turn = await this.ensureActiveTurn(message.conversationId);

  // 重置消息状态（含状态守卫 + FTS 清空）
  await this._repo.resetForStreaming(messageId, turn.id);

  return {
    ...message,
    status: 'streaming',
    body: null,
    turnId: turn.id,
    talkingStonePassedTo: null,
  };
}
```

#### A3. ConversationRepository 新增 `resetForStreaming` 方法

```typescript
// conversation-repository.ts (interface)
resetForStreaming(messageId: string, turnId: string): Promise<void>;

// sqlite-conversation-repository.ts (implementation)
async resetForStreaming(messageId: string, turnId: string): Promise<void> {
  const result = this.db.prepare(`
    UPDATE messages
    SET status = 'streaming', body = NULL, turn_id = ?, completed_at = NULL,
        talking_stone_passed_to = NULL
    WHERE id = ? AND status = 'failed'
  `).run(turnId, messageId);
  if (result.changes === 0) {
    throw new DomainError(`resetForStreaming failed: message ${messageId} is not in failed status`, 'conflict');
  }
  // 清空 FTS 索引（与 createStreamingMessage 对 null body 的处理一致）
  this.upsertMessageFts(messageId, '');
}
```

**检视修复记录**：
- [阻断 2] SQL 添加 `AND status = 'failed'` 守卫，防止并发 abort 将终态消息重置回 streaming
- [观察 2] 添加 `upsertMessageFts` 清空 FTS，避免重试期间搜索命中旧 fail body
- [观察 4] SQL 添加 `talking_stone_passed_to = NULL`，与 `createStreamingMessage` 初始状态对齐

#### A4. AgentInvoker 修改 `handleSpeakRetry`

```typescript
// agent-invoker.ts - handleSpeakRetry 方法修改
private async handleSpeakRetry(params: {
  messageId: string;
  otterId: string;
  conversationId: string;
  userMessageContent: string;
  senderId: string;
  emitEvent: (event: SSEEvent) => void;
  onSSEEvent?: (event: SSEEvent) => void;
  retryCount: number;
  startTime: number;
  tokenUsage?: { input: number; output: number };
  toolCallCount?: number;
}): Promise<ConversationInvokeResult> {
  const { messageId, otterId, conversationId, senderId, emitEvent, retryCount, startTime, tokenUsage, toolCallCount } = params;
  this.logger.info('Speak retry triggered', { messageId, otterId, retryCount });

  if (retryCount === 0) {
    // 1. 内部标记消息失败（不发 SSE 事件）
    const failBody = "[系统] 未调用 speak 工具结束发言";
    try { await this.sendMessage.fail(messageId, failBody); } catch { /* ignore */ }

    // 2. 重置消息为可重试状态
    try {
      await this.sendMessage.prepareForRetry(messageId);
    } catch (err) {
      // prepareForRetry 失败：降级为原有行为（发 message.failed）
      this.logger.warn('prepareForRetry failed, falling back to legacy retry', {
        messageId, error: err instanceof Error ? err.message : String(err),
      });
      return this.executeRetryWithSystemReminder({
        messageId, otterId, conversationId, senderId, emitEvent,
        onSSEEvent: params.onSSEEvent,
        failBody,
        retryMsg: this.buildSpeakRetryMsg(toolCallCount),
        tokenUsage,
      });
    }

    // 3. 重试（复用同一 messageId）
    const retryMsg = this.buildSpeakRetryMsg(toolCallCount);
    const retryResult = await this.retryInvokeOnSameMessage({
      otterId, conversationId, userMessageContent: retryMsg,
      senderId, messageId, emitEvent, onSSEEvent: params.onSSEEvent,
      retryCount: 1, startTime,
    });

    this.logger.info('Speak retry completed (seamless)', { messageId, otterId });
    return { ...retryResult, tokenUsage: retryResult.tokenUsage ?? tokenUsage };
  }

  // 第二次仍失败：发 message.failed（用户可见）
  this.logger.warn('Speak retry exhausted, failing message', { messageId, otterId, conversationId });
  const failBody = "[系统] 重试后仍未调用 speak 工具";
  try {
    await this.sendMessage.fail(messageId, failBody, [senderId]);
  } catch { /* ignore */ }

  const duration = Date.now() - startTime;
  const otter = await this.queryOtter.getById(otterId);
  emitEvent({ event: "message.failed", data: { messageId, otterId, otterName: otter?.name, body: failBody } });

  return { messageId, duration, tokenUsage };
}
```

#### A5. AgentInvoker 新增 `retryInvokeOnSameMessage` 方法

```typescript
/**
 * 复用同一 messageId 重试 Agent 调用。
 * 与 invokeConversation 的区别：不创建新消息，不发 message.start 事件。
 * 退出分类复用 classifyAndRoute，保证 user abort / guard abort / api error 路径一致。
 */
private async retryInvokeOnSameMessage(params: {
  otterId: string;
  conversationId: string;
  userMessageContent: string;
  senderId: string;
  messageId: string;
  emitEvent: (event: SSEEvent) => void;
  onSSEEvent?: (event: SSEEvent) => void;
  retryCount: number;
  startTime: number;
}): Promise<ConversationInvokeResult> {
  const { otterId, conversationId, userMessageContent, senderId, messageId, emitEvent, onSSEEvent, retryCount, startTime } = params;

  const dynamicContext = await this.buildDynamicContext(otterId);
  await this.injectWorkspacePath(dynamicContext, conversationId);

  try {
    const { result, toolCallCount } = await this.executeAgentInvocation({
      otterId, userMessageContent, dynamicContext, conversationId, messageId, emitEvent,
    });

    // 复用 classifyAndRoute 做退出分类（覆盖 user abort / guard abort / no_speak）
    return this.classifyAndRoute({
      messageId, otterId, senderId, result, toolCallCount,
      startTime, emitEvent, onSSEEvent, retryCount,
      userMessageContent, conversationId,
    });
  } catch (err) {
    const toolCallCount = (err as ErrorWithToolCallCount)._toolCallCount ?? 0;
    // 复用 classifyAndRoute 做退出分类（覆盖 user abort / guard abort / api error）
    return this.classifyAndRoute({
      messageId, otterId, senderId, err, toolCallCount,
      startTime, emitEvent, onSSEEvent, retryCount,
      userMessageContent, conversationId,
    });
  }
}
```

**检视修复记录**：
- [阻断 1] 正常路径和 catch 路径均复用 `classifyAndRoute`，保证 user abort → `abortTerminal`（终态 aborted）、guard abort → `routeGuardAbort`、api error → `routeApiError` 路径一致
- [观察 3] 移除死代码分支（`if (retryCount < 1)`），`classifyAndRoute` → `routeByReason` → `no_speak` → `handleSpeakRetry(retryCount+1)` 自然处理重试次数

#### A6. AgentInvoker 新增 `buildSpeakRetryMsg` 辅助方法

```typescript
private buildSpeakRetryMsg(toolCallCount?: number): string {
  const isThinkingOnly = (toolCallCount ?? 0) === 0;
  return isThinkingOnly
    ? "[系统提醒] 你上一轮没有调用任何工具。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。"
    : "[系统提醒] 你上一次发言没有调用 speak 工具就结束了。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。";
}
```

### B. 前端改动

**无需改动。** 前端的消息渲染逻辑已经正确处理以下情况：
- `message.start` → 插入占位消息
- `assistant_toolcall` / `tool.result` → 追加流式事件
- `message.complete` → 终态更新

由于 `message.failed` 和 `system.message` 事件不再发送，前端不会渲染失败消息和系统提醒。消息从 streaming 直接到 completed，用户看到的是一条连续的消息。

**唯一需要注意的边界情况**：SSE 断连后的轮询续看。轮询会拉取服务器上的消息状态，此时消息已经是 completed 状态（重试成功），前端正确渲染。

## 影响范围

| 功能 | 影响 | 说明 |
|------|------|------|
| Agent 对话 | ✅ 直接影响 | speak 重试行为变更 |
| 飞书消息广播 | ✅ 间接影响 | message.complete 时广播最终消息，不受影响 |
| 消息历史/DB | ✅ 直接影响 | 不再创建系统消息和失败消息（speak 重试场景） |
| Turn 生命周期 | ✅ 直接影响 | prepareForRetry 创建新 Turn |
| 定时任务链 | ❌ 不影响 | 定时任务不经过 speak 重试路径 |
| 招聘桥接 | ❌ 不影响 | 独立的消息处理路径 |
| 记忆索引 | ❌ 不影响 | 索引发生在 message.complete 时 |

## 风险与约束

### 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| prepareForRetry 状态转换失败 | 低 | 降级为原有重试行为（用户仍看到 3 条消息） | catch 后 fallback 到 executeRetryWithSystemReminder，日志告警 |
| 重试期间 SSE 断连 | 中 | 用户看不到重试过程，消息可能停留在 streaming | 轮询续看机制已覆盖（消息状态最终一致） |
| 重试期间用户 abort | 低 | 正常中断 | `retryInvokeOnSameMessage` 复用 `classifyAndRoute`，abort 路径与主路径一致 |
| 旧 Turn 空壳 | 低 | Turn 历史中出现无消息的 Turn | `prepareForRetry` 重置 turnId 后旧 Turn 的消息为空。Turn 历史若用于前端展示需处理空 Turn；若仅调试用可接受 |

### 约束

1. 消息状态机新增 `failed → streaming` 转换（`canPrepareForRetry` 守卫，仅 speak 重试场景使用）
2. 重试期间的事件序列号必须递增（`appendEvent` 从 DB 获取 max，自然递增，无问题）
3. `resetForStreaming` SQL 必须有 `AND status = 'failed'` 守卫，防止并发操作破坏终态不变量

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 重试时是否创建新消息 | 复用同一消息 | 创建新消息但前端合并 | 复用更简洁，避免前端复杂的状态合并逻辑 |
| 系统提醒是否注入 DB | 不注入 | 注入但前端隐藏 | 不注入更干净，避免对话历史污染 |
| 是否统一所有重试类型 | 仅 speak 重试 | 全部统一 | speak 重试噪音最严重（每次都触发），其他重试类型较少见且有独立价值 |
| prepareForRetry 失败时 | 降级为原有行为 | 抛错终止 | 用户体验优先，降级比失败好 |
| 重试次数 | 1 次（与当前一致） | 更多次 | 1 次已经足够，多次重试增加延迟和成本 |

## 不兼容更新

无。行为变更为用户侧体验优化，API 接口和数据模型不变。

## 验证

### 验收标准

1. **正常路径**：Agent 未调用 speak → 自动重试 → 用户只看到一条消息（从 streaming 到 completed）
2. **重试成功**：消息 body 是 Agent 的最终回复，事件包含两次尝试的 tool_call
3. **重试失败**：用户看到 message.failed（"[系统] 重试后仍未调用 speak 工具"）
4. **用户中断**：重试期间用户 abort → 消息状态变为 aborted（`message.aborted` SSE 事件），不创建额外消息
5. **SSE 断连**：断连后轮询 → 消息状态最终一致
6. **Guard abort**：重试期间 streaming_timeout → 消息状态为 aborted（guard abort 路径正确）
7. **降级路径**：prepareForRetry 失败 → 降级为原有行为（用户看到 3 条消息，日志有 warn）

### 测试设计

- 单元测试：`prepareForRetry` 状态转换（含守卫）、`canPrepareForRetry` 边界
- 集成测试：模拟 Agent 未调用 speak → 验证只产生一条消息
- 边界测试：
  - prepareForRetry 失败时的降级行为
  - 重试期间用户 abort → 终态为 aborted
  - 重试期间 guard abort（streaming_timeout）→ 终态为 aborted
  - `resetForStreaming` 对非 failed 状态消息的拒绝

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/conversation/send-message.ts | 修改 | 新增 `prepareForRetry` 方法 |
| src/usecases/conversation/conversation-repository.ts | 修改 | 新增 `resetForStreaming` 接口 |
| src/frameworks/db/conversation/sqlite-conversation-repository.ts | 修改 | 实现 `resetForStreaming` |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 修改 | 重构 `handleSpeakRetry`，新增 `retryInvokeOnSameMessage`、`buildSpeakRetryMsg` |
| src/entities/conversation/message.ts | 修改 | 新增 `canPrepareForRetry` 守卫函数 |

## 审视记录

### 第一轮审视（检视獭）

| # | 级别 | 发现 | 处置 | 理由 |
|---|------|------|------|------|
| 1 | 阻断 | `retryInvokeOnSameMessage` 绕过 `classifyAndRoute`，abort/guard 路径失效 | 接受并修复 | 正常路径和 catch 路径均复用 `classifyAndRoute` |
| 2 | 阻断 | `resetForStreaming` SQL 缺 `AND status = 'failed'` 守卫 | 接受并修复 | 防止并发 abort 将终态消息重置回 streaming |
| 3 | 阻断 | 重试期间 abort 导致事件序列不一致 | 接受并修复 | 与阻断 1 合并修复，`classifyAndRoute` 保证 abort 路径正确 |
| 4 | 观察 | 旧 Turn 在 turnId 重置后变成空壳 | 记录 | Turn 历史若用于前端展示需处理空 Turn；若仅调试用可接受 |
| 5 | 观察 | `resetForStreaming` 不更新 FTS | 接受并修复 | 添加 `upsertMessageFts` 清空 FTS |
| 6 | 观察 | `if (retryCount < 1)` 是死代码 | 接受并修复 | 移除死分支，`classifyAndRoute` 自然处理 |
| 7 | 观察 | `talkingStonePassedTo` 未重置 | 接受并修复 | SQL 添加 `talking_stone_passed_to = NULL` |
| 8 | 观察 | 降级路径仍创建 3 条消息 | 记录 | 在风险表中补充降级行为的用户可见效果 |
| 9 | 观察 | 事件历史包含两次尝试 | 记录 | 有意设计，保留调试价值，在设计文档中补充说明 |
