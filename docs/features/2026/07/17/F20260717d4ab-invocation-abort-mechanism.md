---
id: F20260717d4ab
title: invocation-abort-mechanism
from_ids: [F20260713e8n4, F20260716bte2]
tags: [feature, agent-runtime, abort, graceful-shutdown]
modules: [agent-runtime, conversation]
doc_kind: spec
status: locked
created_at: 2026-07-17
---

# F20260717d4ab [invocation-abort-mechanism] Agent 流式中断优雅收尾

## [design-time]

> 以下章节在需求收敛与设计阶段（代码前）完成并锁定。

## 背景 [required]

### 问题

当前系统在 agent 流式响应过程中，用户可通过 `POST /api/messages/:id/abort` 或客户端断连触发中断。**中断链路本身已能工作**（abort → session.abort() → LLM 停止生成），但中断后的收尾存在 3 个问题：

1. **消息状态错误**：中断后消息被标记为 `"failed"`，但 `"failed"` 语义表示"系统出错"。用户主动中断应视为一种**正常的结束方式**。

2. **SSE 事件与状态不匹配**：`handleInvokeError` 发送 `message.aborted` SSE 事件，但消息状态是 `failed`——事件名和状态名语义矛盾。

3. **body 缺失**：中断后消息 body 保持 `NULL`，但 msg 是完整发言，中断也是结束，body 必须有内容。

### 关键认知纠正

**msg body 的设置机制**：body 不是 event 的堆积，而是 agent 使用工具（如 `send_message`）来设置的。流式过程中的 event（text_delta、tool_call 等）是逐条记录的过程日志，不是 body 的来源。

**abort 时的状态**：agent 被中断时还没来得及调用工具设置 body，所以 body 为 null。abort 后需要由系统（而非 agent）构造一个合成的 body 来标记这次中断。

### 当前中断链路（已能工作）

```
用户 abort 请求
  -> MessageController.abort()
    -> AgentInvoker.abort(otterId)
      -> abortedOtters.add(otterId)
      -> agentInvoke.abort(otterId)
        -> PiSessionFactory.abort(otterId)
          -> session.abort()  ← LLM 停止生成 ✓
```

**问题在收尾**（`handleInvokeError`）：

```
session.abort() 抛出异常
  -> catch(err)
  -> sendMessage.fail(messageId)  ← 状态为 "failed"，body 为 null
  -> onSSEEvent("message.aborted") ← 事件名与状态名矛盾
```

### 约束输入

- F20260713e8n4：消息流式模型（streaming -> completed | failed 状态机）
- F20260716bte2：Agent 熔断机制（`ToolCallCircuitBreaker`，`session.abort()`）
- D18：消息 append-only 语义（body 一旦设置不可修改）

## 用户意图锚 [required]

| # | 来源 | 用户原话（逐字引用） | 关键修饰语 | 架构师解读 |
|---|------|---------------------|-----------|-----------|
| UA-1 | Issue 摘要 | "在agent还在流式响应过程中，都必须支持用户中断" | 空间：流式响应过程中；行为：必须支持中断 | 当前中断链路已能工作，聚焦收尾完善 |
| UA-2 | Issue 摘要 | "并且要做好优雅收尾" | 期望：优雅收尾 | 正确更新状态、设置 body、通知客户端 |
| UA-3 | 用户纠正 | "一条msg的定位就是一个参与者的一次完整发言。当中中断时，这条msg也应该视为完整" | 定位：完整发言；中断=用户介入的结束 | abort 是一种"完成态"，新增 aborted 终态 |
| UA-4 | 用户纠正 | "msg body是必须有的，我认为可以设计一套用户中断场景下的body内容设置" | body：必须有；场景：用户中断 | 系统构造合成的 abort body |
| UA-5 | 用户纠正 | "turn不是一种能主动开不开的机制，turn是一种被动机制，是msg的一种组织结构" | turn：被动机制；关系：msg 的组织结构 | abort 只影响 msg，不影响 turn |
| UA-6 | 用户纠正 | "message event要严格按照agent的流式响应来一一对应，不允许做堆积，然后作为message的最终答复body的内容" | event：一一对应；禁止：堆积为 body | event 是过程日志，body 由工具设置 |

## 目标 [required]

### P1 - 优雅收尾

中断后：
- 消息状态为 `aborted`（终态，与 `completed`、`failed` 并列）
- body 由系统构造合成内容（不是 event 堆积）
- talkingStonePassedTo 传回用户
- SSE 事件语义匹配（`message.aborted` 事件 + `aborted` 状态一致）

### P2 - 可独立验证

通过单元测试验证：
- abort 后消息状态为 aborted
- abort 后 body 包含合成的中断声明
- talkingStonePassedTo 传回用户
- SSE 事件正确发送

## 非目标 [required]

- **不修改中断链路本身**（abort → session.abort() 已能工作）
- **不修改 buildDynamicContext 阶段**（后续迭代）
- **不修改 AgentInvokePort 接口**（不改 InvokeOptions）
- **不修改 turn 机制**（abort 只影响 msg，不影响 turn 的被动组织结构）
- 不修改前端 UI（前端已支持 abort 端点调用）
- 不修改 `POST /api/messages/:id/abort` HTTP 端点签名
- 不修改熔断器（F20260716bte2）的核心逻辑
- 不修改 SSE 传输协议

## 设计 [required]

### 核心思路

abort 后由系统构造合成的 abort body，设置 msg 状态为 `aborted`。body 不包含任何 event 堆积内容，只包含中断声明和上下文信息。

### 架构决策

**决策 1：中断后消息状态**

**选择**：新增 `aborted` 状态（终态）

- `aborted` 是终态（与 `completed`、`failed` 并列），turn 机制只关心"是否终态"——不影响 turn
- 可通过 status 直接查询"哪些消息是被中断的"
- `isTerminalMessageStatus` 纳入 `aborted`，turn 关闭逻辑自动覆盖

**决策 2：abort body 内容**

body 是系统构造的合成内容，**不包含任何 event 堆积**：

```
[用户中断] 经过 {toolCallCount} 次工具调用后，用户强制中断了当前发言。
```

**设计要点**：
- body 是固定的、可识别的模式，前端可样式化处理
- 包含工具调用次数，提供上下文信息
- 不包含任何 LLM 生成的部分文本（event 不堆积为 body）
- 不包含任何 event 回放内容

**决策 3：abort 检测与 toolCallCount 传递**

**abort 检测**：复用 `abortedOtters` Set，`handleInvokeError` 已有 `abortedOtters.delete(otterId)` 检查逻辑。

**toolCallCount 传递**：存入 `activeSessions` 条目，与 session 生命周期绑定。

```
activeSessions.set(otterId, { abort: () => session.abort(), toolCallCount: 0 })
```

`session.subscribe()` 中遇到 `tool_execution_start` 时 `entry.toolCallCount++`。abort 触发时从同一 entry 读取 count，时序安全。

**理由**：
- 不需要 `AgentAbortError`（abort body 不包含部分文本）
- toolCallCount 与 session 生命周期绑定，无需跨层传递异常属性
- `finally` 块中 `activeSessions.delete(otterId)` 之前，catch 块已读取过 count

**决策 4：完成路径**

**选择**：新增 `sendMessage.abort()` 方法

- 使用 `aborted` 状态需要专门的方法来设置
- `abort()` 方法复用 `complete()` 的大部分逻辑（body 设置、发言石传递、记忆索引、turn 关闭），仅状态不同
- body 由调用方构造（系统合成的中断声明）

### 行为规格

| ID | 当...时 | 应该... | 追溯 |
|----|---------|---------|------|
| B-1 | agent 流式响应被 abort | 消息 body 设为 "[用户中断] 经过 {N} 次工具调用后，用户强制中断了当前发言。"，status 设为 aborted | ← UA-3, UA-4, UA-6 |
| B-2 | 消息被 abort | SSE 事件发送 `message.aborted`，携带 abortBody | ← UA-2 |
| B-3 | 消息被 abort | `talkingStonePassedTo` 传回用户 | ← UA-3 |
| B-4 | 消息被 abort | body 被索引到记忆系统（中断标记可识别） | ← UA-3 |
| B-5 | 消息被 abort | turn 不受影响（终态自动覆盖） | ← UA-5 |
| B-6 | abort 后 | 熔断器 `clearSteerDeadline()` 被调用 | ← UA-2 |
| B-7 | abort 后 | session 被正确 dispose（通过 finally 块） | ← UA-2 |
| B-8 | 客户端断连触发 abort | 行为与主动调用 abort 一致 | ← UA-1 |

### 约束条件

| ID | 约束 | 原因 |
|----|------|------|
| C-1 | `aborted` 是终态，与 `completed`、`failed` 并列 | abort 是一种"完成态"，但系统需要区分 |
| C-2 | abort body 必须非空 | msg 是完整发言，body 是必须的 |
| C-3 | abort body 不包含 event 堆积内容 | event 是过程日志，不是 body 来源（UA-6） |
| C-4 | abort body 格式固定：`[用户中断] ...` | 前端可识别并样式化处理 |
| C-5 | `talkingStonePassedTo` 传回用户 | 发言中断，发言权回到用户 |

### 实现指引

**核心变更点**：

1. **MessageStatus 类型扩展**（`src/entities/conversation/message.ts`）
   - `MessageStatus` 增加 `"aborted"`
   - `isTerminalMessageStatus()` 增加 `aborted` 判断
   - `isValidTalkingStonePass()` 增加 `aborted` 状态处理

2. **SendMessage use case 扩展**（`src/usecases/conversation/send-message.ts`）
   - 新增 `abort(messageId, options)` 方法：streaming -> aborted
   - `options` 含 `body: string` 和 `talkingStonePassedTo: string[]`
   - 复用 `complete()` 的大部分逻辑（body 设置、发言石传递、记忆索引、tryCloseTurn），仅状态设为 `aborted`
   - 使用 `DomainError` 抛出校验异常（与现有代码一致）

3. **AgentInvoker 修改**（`src/interface-adapters/agent-runtime/agent-invoker.ts`）
   - `handleInvokeError` 增加 `senderId` 参数
   - 检查 `abortedOtters.delete(otterId)` 区分 abort/error
   - abort 路径：构造合成 body → `sendMessage.abort()` → SSE `message.aborted`
   - error 路径：`sendMessage.fail()` → SSE `error`

4. **PiSessionFactory 修改**（`src/frameworks/agent/pi-session-factory.ts`）
   - `activeSessions` 条目扩展为 `{ abort, toolCallCount }`
   - `session.subscribe()` 中 `tool_execution_start` 时 `entry.toolCallCount++`
   - **不累积 resultText 作为 body 来源**

5. **MessageController 修改**（`src/interface-adapters/http/controllers/message-controller.ts`）
   - SSE 事件 `message.aborted` 携带 abortBody

**关键代码路径**：

```
PiSessionFactory.invoke():
  activeSessions.set(otterId, { abort: () => session.abort(), toolCallCount: 0 })
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") entry.toolCallCount++
    ...
  })
  try { await session.prompt(...) }
  finally { activeSessions.delete(otterId) }

AgentInvoker.handleInvokeError(messageId, otterId, err, onSSEEvent, senderId):
  if (abortedOtters.delete(otterId))  ← abort 路径
    entry = activeSessions.get(otterId)
    toolCallCount = entry?.toolCallCount ?? 0
    body = `[用户中断] 经过 ${toolCallCount} 次工具调用后，用户强制中断了当前发言。`
    sendMessage.abort(messageId, { body, talkingStonePassedTo: [senderId] })
    onSSEEvent("message.aborted", { abortBody: body })
  else  ← error 路径
    sendMessage.fail(messageId)
    onSSEEvent("error", { message })
```

**toolCallCount 传递方式**：存入 `activeSessions` 条目，与 session 生命周期绑定。catch 块从同一 entry 读取，时序安全。

## 不兼容更新 [required]

| 变更 | 说明 |
|------|------|
| `MessageStatus` 类型新增 `"aborted"` | 新增终态值，不改变已有值。DDL 无需变更（status 是 TEXT 字段） |

## 验收标准 [required]

| ID | 标准 | 验证方法 |
|----|------|---------|
| AC-1 | abort 后消息状态为 aborted | 单元测试：验证 sendMessage.abort 被调用 |
| AC-2 | abort 后 body 包含合成的中断声明 | 单元测试：验证 body 格式 |
| AC-3 | abort 后 body 不包含 event 堆积内容 | 单元测试：验证 body 不含 LLM 生成文本 |
| AC-4 | SSE 事件为 message.aborted | 单元测试：验证 onSSEEvent 参数 |
| AC-5 | SSE 事件携带 abortBody | 单元测试：验证事件 data 字段 |
| AC-6 | talkingStonePassedTo 传回用户 | 单元测试：验证 talkingStonePassedTo 为 [senderId] |
| AC-7 | aborted 是终态 | 单元测试：验证 isTerminalMessageStatus 包含 aborted |
| AC-8 | 客户端断连触发相同 abort 流程 | 集成测试：断开 SSE 连接，验证消息状态 |

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 消息状态 | 新增 aborted（终态） | 复用 completed | 系统需区分正常完成和用户中断（UA-3） |
| body 内容 | 系统合成的中断声明 | event 堆积 / 部分文本 | event 是过程日志，不是 body 来源（UA-6） |
| 完成路径 | 新增 sendMessage.abort() | 调用 complete() | 需设置 aborted 状态，复用 complete 大部分逻辑 |
| abort 检测 | 检查 abortedOtters Set | AgentAbortError | 不需要传递 resultText，复用现有检查逻辑 |
| toolCallCount | 存入 activeSessions 条目 | 附加到异常对象 | 与 session 生命周期绑定，时序安全 |
| 记忆索引 | 索引（中断标记可识别） | 不索引 | 中断标记是可识别模式，不影响记忆质量 |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/entities/conversation/message.ts` | 修改 | MessageStatus 新增 "aborted"，更新相关函数 |
| `src/usecases/conversation/send-message.ts` | 修改 | 新增 abort() 方法 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | activeSessions 条目扩展为 { abort, toolCallCount }，subscribe 中跟踪工具调用次数 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | handleInvokeError 增加 senderId，abort 路径构造合成 body 调用 abort() |
| `src/interface-adapters/http/controllers/message-controller.ts` | 修改 | SSE 事件 message.aborted 携带 abortBody |
| `src/interface-adapters/agent-runtime/agent-invoke-port.ts` | 不变 | |
| `src/interface-adapters/http/sse-streamer.ts` | 不变 | |
| `src/frameworks/db/schema.ts` | 不变 | |

## 核心业务行为 [required]

| # | 场景 | 预期行为 | 意图锚 |
|---|------|---------|--------|
| B-Abort-1 | 当 agent 流式响应被 abort | 消息 body 设为 "[用户中断] 经过 {N} 次工具调用后，用户强制中断了当前发言。"，status 设为 aborted | ← UA-3, UA-4, UA-6 |
| B-Abort-2 | 当消息被 abort | SSE 发送 message.aborted 事件，携带 abortBody | ← UA-2 |
| B-Abort-3 | 当消息被 abort | talkingStonePassedTo 传回用户 | ← UA-3 |
| B-Abort-4 | 当消息被 abort | turn 不受影响（终态自动覆盖） | ← UA-5 |
| B-Abort-5 | 当客户端断连 | 触发与主动 abort 相同的收尾流程 | ← UA-1 |

## 关联 [required]

- **消息流式模型**：[F20260713e8n4](../../07/13/F20260713e8n4-message-streaming-model.md)（消息状态机基础）
- **Agent 熔断机制**：[F20260716bte2](./F20260716bte2-agent-circuit-breaker.md)（session.abort() 调用）
