---
id: F20260721spea
title: speak-skill
doc_type: feature

# 记忆索引
summary: |
  消息流式模型（F20260713e8n4）定义了两层架构：事件（流式过程）+ body（最终答复）。但当前实现存在根本缺陷：agent 没有"发言"机制——body 来源是错误的（硬编码 "fixme"）。本特性创建 speak skill，让 agent 在结束发言前主动调用 speak 工具设置最终答复 body 和发言石目标。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260713e8n4
    - F20260714xk8a
    - F20260716t2ab
    - F20260721m3r1

# 元数据
status: design
change_type: feature
tags: [agent, skills, message, body, speak, streaming]
modules: [skills/, src/interface-adapters/agent-runtime/, src/frameworks/agent/]

# 时间
created_at: 2026-07-21
---


# F20260721speak speak Skill：Agent 发言机制

## 背景 [required]

### 问题

消息流式模型（F20260713e8n4）定义了两层架构：**事件是过程，body 是结论**。但当前实现存在根本缺陷——agent 没有"发言"机制。

当前流程（错误）：

```
1. sendMessage.start() → 创建 streaming 消息（body=null）
2. agent 运行 → 产生事件（工具调用、文本）→ 流式推前端 + 持久化到 DB
3. PiSessionFactory.invoke() 从 message_end 事件提取 _finalText → 丢弃
4. 返回 result.text = "fixme"（硬编码）
5. AgentInvoker 调用 sendMessage.complete({ body: "fixme", ... })
```

**三个错误叠加：**

| # | 错误 | 说明 |
|---|------|------|
| E-1 | body 来源错误 | body 从事件流推断（`_finalText`），但事件是过程，不是结论 |
| E-2 | 结果硬编码 | `pi-session-factory.ts:360` 写死 `resultText = "fixme"` |
| E-3 | 发言石时机错误 | `agent-invoker.ts:154` 写死 `talkingStonePassedTo: [senderId]`，而非由 agent 决定 |

### 根因

**tool 存在但 skill 缺失。** 类似 F20260721m3r1 记忆召回问题——有 `send_message` 工具，但没有 prompt 告诉 agent 如何用它来"闭嘴"。更关键的是，现有 `send_message` 工具的实现本身就是错的——它创建新消息，而非完成当前 streaming 消息。

### Snail Shell 的设计

Snail Shell 的 `set_final_body(text, ..., to_speakers)` 是 agent 的**终端操作**：

1. agent 运行过程中产生流式事件（tool calls、reasoning）
2. agent 准备结束时，调用 `set_final_body()` 设置最终答复 + 路由目标
3. 这是 agent 的主动"闭嘴"动作——body 不是从事件流推断的

### 现状分析

| 层 | 状态 | 问题 |
|----|------|------|
| Tool 层 | ❌ send_message 实现错误 | 创建新消息，而非完成当前 streaming 消息 |
| Prompt 层 | ❌ 无发言 skill | agent 不知道如何/何时设置 body |
| AgentInvoker | ❌ 硬编码 body | `result.text = "fixme"`，`talkingStonePassedTo = [senderId]` |

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "msg.body 的含义是本次发送消息的最终总结内容" | 最终总结；不是事件流衍生物 | body 是 agent 的主动结论，不是从事件中提取的 | 对话 |
| UA-2 | "event 是流式过程，body 是完全独立的另外一个最终答复，来源不是 event 中来的" | 完全独立；来源不同 | body 和 event 是两个独立概念，不能从后者推断前者 | 对话 |
| UA-3 | "让 agent 在准备结束本次发言前必须调用 skill 来填入" | 必须调用；skill（非 tool） | 需要 skill（tool + prompt），agent 必须在结束前主动调用 | 对话 |
| UA-4 | "还必须填写发言石要交给谁" | 必须填写；由 agent 决定 | talkingStonePassedTo 由 agent 在 speak 时决定，非系统默认 | 对话 |
| UA-5 | "我认为还是要做一个 skill 而不仅仅只是一个 Tool" | skill 而非 tool | 需要 prompt 引导 agent 行为，不只是工具实现 | 对话 |

## 目标 [required]

### T1 — 创建 speak skill

独立的 skill，定义 agent "闭嘴"的行为规范：何时调用、body 应包含什么、如何决定发言石目标。

### T2 — 实现 speak 工具

改造现有 `send_message` 工具为 `speak`，语义从"发消息"变为"闭嘴"。不再创建新消息，而是完成当前 streaming 消息。

### T3 — 消除 "fixme" 硬编码

修改 `PiSessionFactory.invoke()` 和 `AgentInvoker.invokeConversation()`，使用 speak 工具写入的 body 而非硬编码。

### T4 — messageId 全链路传递

将 `messageId` 从 `AgentInvoker` 传递到 `ToolContext`，使 speak 工具能直接操作当前 streaming 消息。

## 非目标 [required]

- 不修改消息实体模型（Message/MessageEvent 结构不变）
- 不修改 SSE 事件模型
- 不修改前端 UI

## 设计 [required]

### 1. speak Skill（SKILL.md）

**位置**：`skills/speak/SKILL.md`

**核心规则**：agent 在结束发言前**必须**调用 `speak` 工具。这是 agent 的"闭嘴"动作。

**Skill 内容要点：**

- **触发时机**：agent 准备结束本次发言时，必须先调用 `speak` 再停止生成
- **body 要求**：最终总结内容，不是中间推理过程；结构化、完整
- **talkingStonePassedTo 要求**：必须指定发言石目标（谁应该下一个发言）
- **终止信号**：speak 调用成功后**不要再生成任何内容**——你的发言已经结束
- **错误处理**：speak 返回错误时，修正参数后重新调用，不要放弃
- **禁止行为**：不调用 speak 就结束；body 为空；不指定发言石目标

### 2. speak 工具实现

**改造 `send_message` → `speak`**

| 维度 | send_message（当前） | speak（改造后） |
|------|---------------------|----------------|
| 语义 | 发送一条新消息 | 结束当前发言（闭嘴） |
| 行为 | 调用 `SendMessage.send()` 创建新 completed 消息 | 调用 `SendMessage.complete()` 完成当前 streaming 消息 |
| body 来源 | LLM 传入的 content 参数 | LLM 传入的 body 参数 |
| talkingStonePassedTo | LLM 传入的 recipientId | LLM 传入的 talkingStonePassedTo |
| 目标消息 | 新消息 | 当前 streaming 消息（通过 currentMessageId） |

**工具签名：**

```typescript
{
  name: "speak",
  description: "结束本次发言。设置最终答复内容和发言石目标。这是你的'闭嘴'动作——调用后本次发言结束。",
  parameters: {
    type: "object",
    properties: {
      body: {
        type: "string",
        description: "最终答复内容（总结/结论，不是中间推理过程）"
      },
      talkingStonePassedTo: {
        type: "array",
        items: { type: "string" },
        description: "发言石目标（下一个应该发言的参与者 ID 列表）"
      }
    },
    required: ["body", "talkingStonePassedTo"]
  }
}
```

**工具实现逻辑：**

```typescript
execute: async (_id, params) => {
  // 参数校验：直接返回错误，让 agent 感知自己犯了错
  const body = params.body as string;
  const recipients = params.talkingStonePassedTo as string[];

  if (!body || body.trim().length === 0) {
    return textResponse("[错误] body 不能为空。请提供你的最终答复内容，然后重新调用 speak。");
  }
  if (!recipients || recipients.length === 0) {
    return textResponse("[错误] talkingStonePassedTo 不能为空数组。请指定下一个应该发言的参与者 ID。");
  }

  try {
    await ctx.client.conversation.message.complete(ctx.currentMessageId, {
      body,
      talkingStonePassedTo: recipients,
    });
  } catch (err) {
    // complete() 失败（如消息已 abort/complete、数据库错误）→ 返回错误，让 agent 感知
    const msg = err instanceof Error ? err.message : String(err);
    return textResponse(`[错误] 发言结束失败：${msg}。请重试。`);
  }
  return textResponse("[ok] 发言已结束。不要再生成任何内容。");
}
```

**设计要点**：
- 参数校验失败 → 直接返回错误文本给 LLM，**不静默兜底**。LLM 收到错误后会自行修正参数并重试调用
- `complete()` 委托给 `SendMessage.complete()`，走正常 complete 流程（含记忆索引、Turn 关闭）
- 成功返回值包含 `"不要再生成任何内容"` 终止信号，降低 agent loop 继续生成的概率

### 3. ToolContext 扩展

```typescript
interface ToolContext {
  client: OtterToolClient;
  otterId: string;
  conversationId: string;
  currentMessageId: string;  // ← 新增：当前 streaming 消息 ID
}
```

### 4. OtterToolClient 扩展

```typescript
interface OtterToolClient {
  conversation: {
    message: {
      complete(messageId: string, params: {
        body: string;
        talkingStonePassedTo: string[];
      }): Promise<Message>;  // ← 新增
      // ... 其他方法不变（send 保留用于用户消息场景，speak 不走 send）
    };
  };
}
```

**内部实现**：`OtterToolClient.message.complete()` 委托给 `SendMessage.complete()`，不绕过 use case 直接操作 repository。装配时 `OtterToolClient` 持有 `SendMessage` use case 引用。

**关于 `send_message` 工具**：移除。speak 工具替代其"结束发言"语义，原有"创建新消息"行为与 speak 冲突，且无合理的 agent 间通信场景需要保留。

### 5. messageId 全链路传递

```
AgentInvoker.invokeConversation()
  │
  ├─① sendMessage.start({ conversationId, senderId, talkingStonePassedTo: [senderId] })
  │    → message = { id: "xxx", status: "streaming", body: null, talkingStonePassedTo: [senderId] }
  │    注：start() 时传入默认 talkingStonePassedTo（非 null），speak 调用时覆盖
  │
  └─② agentInvoke.invoke(otterId, message, {
         conversationId,
         messageId: message.id,        // ← 传递 messageId
         onEvent, dynamicContext
     })
     └→ PiSessionFactory.invoke(otterId, message, options)
          │
          ├─ buildCustomTools(otterId, conversationId, toolNames, options.messageId)
          │    └→ createTools({ client, otterId, conversationId, currentMessageId })
          │         └→ speak 工具通过 ctx.currentMessageId 操作消息
          │
          └─ session.prompt(fullMessage)
               └→ LLM 调用 speak(body, talkingStonePassedTo)
                    └→ sendMessage.complete(currentMessageId, { body, talkingStonePassedTo })
```

**接口变更链路**（需修改的接口，按依赖顺序）：

| # | 接口 | 变更 | 文件 |
|---|------|------|------|
| 1 | `InvokeOptions` | 新增 `messageId?: string` | `pi-session-factory.ts` |
| 2 | `AgentInvokePort.invoke()` | options 类型包含 `messageId` | `agent-invoke-port.ts` |
| 3 | `PiSessionFactory.buildCustomTools()` | 新增 `messageId` 参数 | `pi-session-factory.ts` |
| 4 | `ToolContext` | 新增 `currentMessageId: string` | `tool-factory.ts` |

### 6. "fixme" 消除

**PiSessionFactory.invoke() 改动：**

```typescript
// 删除：
let _finalText = "";
// ... _finalText 提取逻辑 ...
const resultText = "fixme";

// 改为：speak 工具已直接 complete 消息，invoke() 只需返回 tokenUsage 等元数据
return this.buildResult("", tokenUsage, circuitBreaker, ctxMax);
```

**AgentInvoker.invokeConversation() 改动：**

```typescript
// 删除：
await this.sendMessage.complete(message.id, {
  body: result.text,                          // "fixme"
  talkingStonePassedTo: [senderId],           // 硬编码
  contextTokens, contextTokensMax,
});

// 改为：speak 工具已直接 complete 消息
// AgentInvoker 只需检查消息状态，处理未调 speak 的重试场景
const msg = await this.sendMessage.getMessageById(message.id);
if (msg?.status === "streaming") {
  // agent 未调 speak → 进入重试机制（见第 7 节）
}
```

**speak 调用后的竞态处理**：

speak 工具调用 `complete()` 后，Pi SDK 的 agent loop 可能继续运行（LLM 收到工具返回后可能继续生成）。这些后续事件会被 `onEvent` 回调捕获并尝试 `appendEvent()`，但消息已 completed，`canAppendEvent()` 会返回 false。

处理策略：`AgentInvoker` 的 `onEvent` 回调中，`appendEvent()` 失败时静默忽略（catch + warn 日志）。这不影响数据完整性——事件是过程记录，speak 之后的"幽灵事件"无业务价值。

### 7. 兜底机制：speak 重试

agent 未调 `speak` 就结束（session.prompt 正常返回但消息仍为 streaming）时，系统执行**重试机制**而非静默降级：

#### 流程

```
otter1 发言结束
  → 检查消息状态 → 仍为 streaming（未调 speak）
  → 标记当前消息为 failed（body = "[系统] 未调用 speak 工具结束发言"）
  → 向当前 Turn 注入系统提醒消息（senderType = "system"，不开新 Turn）
     内容："你必须使用 speak 工具来结束你的发言，请重新组织答复并调用 speak"
  → 触发 otter1 重新发言（新一轮 invoke）
  → otter1 收到显式提醒 + speak skill 上下文 → 正常调用 speak
```

#### 重试上限与失败处理

**最大重试 1 次。** 第二次仍失败时，不再重试，转为发言石补偿：

| 场景 | 行为 |
|------|------|
| 第一次未调 speak | fail 当前消息 → 注入系统提醒（同 Turn） → 触发重试 |
| 重试后正常调用 speak | 正常完成，body 和 talkingStonePassedTo 由 agent 设定 |
| 重试后仍未调 speak | fail 当前消息 → 本 Turn 的发言石**额外包含 user**（发回用户） |

#### 第二次失败的发言石处理

第二次失败后，本 Turn 的发言石 = 正常消息已确定的接收者 + **user**（发起对话的用户 ID）。

实现路径：扩展 `SendMessage.fail()` 方法，新增可选参数 `talkingStonePassedTo`。当提供时，写入消息的 `talkingStonePassedTo` 字段（failed 状态下发言石校验豁免，`isValidTalkingStonePass` 对 failed 状态返回 true）。

```typescript
// send-message.ts 扩展
async fail(messageId: string, body?: string, talkingStonePassedTo?: string[]): Promise<void> {
  // ... 现有逻辑不变 ...
  // 当 talkingStonePassedTo 提供时，写入消息
}
```

这意味着用户重新获得发言权——可以检查 agent 的失败状态，决定下一步操作。这是合理的：agent 两次都无法正确闭嘴，应该把控制权交还给人类。

#### 与静默降级的区别

| 维度 | 静默降级（旧方案） | 重试机制（本设计） |
|------|-------------------|-------------------|
| body 来源 | LLM 原始输出文本（质量不可控） | agent 主动设定（重试后质量有保障） |
| 发言石 | 默认发回给发起者 | agent 主动决定；二次失败时额外包含 user |
| 参数错误 | use case 层抛异常，agent 不感知 | 工具返回错误文本，agent 必须自行修正 |
| 对 agent 的反馈 | 无（agent 不知道自己犯了错） | 显式提醒 + 工具错误反馈（agent 知道必须调 speak） |
| Turn 管理 | 无影响 | 系统消息插入同 Turn，不开新 Turn |
| 复杂度 | 低 | 中（需处理重试 + 发言石补偿） |

#### 实现要点

- 系统提醒消息使用 `SenderType = "system"`，作为当前 Turn 的一条消息（不开新 Turn）
- 系统消息豁免发言石校验（`isValidTalkingStonePass` 中 `senderType === "system"` 始返 true）
- 系统消息创建后立即 completed（`status = "completed"`），不影响 Turn 关闭逻辑
- `SendMessage` use case 需新增 `sendSystem()` 方法，支持创建 `senderType = "system"` 的消息
- 重试通过递归调用 `invokeConversation()` 实现，传入 `retryCount` 参数
- `AgentInvoker` 需要能从外部检查当前消息的 status（判断 speak 是否被调用）
- 重试的动态上下文应包含上一次失败的信息（"你上次未调用 speak 工具"）
- 第二次失败时，`fail()` 传入 `talkingStonePassedTo` 参数，写入发言石（含 user ID）
- 重试时 token usage 不累积——每次 invoke 独立计算，这是可接受的（重试是异常路径）

## 硬约束 [required]

1. speak 是 agent 结束发言的**唯一正规路径**——重试是异常处理，不是正常流程
2. `body` 必须非空（`isValidCompletedMessageBody` 校验不变）
3. `talkingStonePassedTo` 必须非空（`isValidTalkingStonePass` 校验不变）
4. speak 工具调用 `SendMessage.complete()`（通过 `OtterToolClient`），走正常 complete 流程
5. speak 工具参数校验失败时**必须返回错误给 LLM**，不静默兜底——agent 必须感知自己犯了错
6. `currentMessageId` 由系统注入，LLM 不传
7. 重试上限为 1 次——第二次失败直接 fail，不无限循环
8. 第二次失败时，发言石额外包含 user（发回用户，恢复人类控制权）
9. 系统提醒消息插入当前 Turn，不开新 Turn
10. `send_message` 工具移除，speak 完全替代
11. `OtterToolClient.message.complete()` 委托给 `SendMessage.complete()`，不绕过 use case

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 工具命名 | `speak` | `set_final_body` / `finalize` | `speak` 最直接表达"发言/闭嘴"语义 |
| send_message 处理 | 移除 | 保留 + 新建 speak | 两者语义冲突（创建新消息 vs 完成当前消息），无合理共存场景 |
| 兜底策略 | 重试机制（注入提醒 + 触发重新发言） | 静默降级（用 _finalText 填充 body） | 静默降级的 body 质量不可控；重试让 agent 有机会正确闭嘴 |
| 参数校验 | 工具内校验，错误返回 LLM | 依赖 use case 层抛异常 | agent 必须感知参数错误并自行修正，不能静默兜底 |
| 重试上限 | 1 次 | 无限重试 / 不重试 | 无限重试有死循环风险；不重试则 agent 一次失误就丢掉发言；1 次是合理平衡 |
| Skill vs Tool | Skill（tool + prompt） | 仅 Tool | agent 需要 prompt 引导才知道何时/如何"闭嘴"（UA-5） |
| messageId 传递 | ToolContext 注入 | speak 工具从消息列表中查找 | 注入更直接、无歧义、无额外查询 |
| 竞态处理 | appendEvent 失败静默忽略 | 阻止 agent loop 继续 | SDK 无法从工具层面终止 agent loop；静默忽略不影响数据完整性 |

## 验证 [required]

### 验收标准

- [ ] `skills/speak/SKILL.md` 存在且格式正确
- [ ] `speak` 工具定义在 `tool-factory.ts` 中，替代原 `send_message`
- [ ] `send_message` 工具已移除
- [ ] `ToolContext` 包含 `currentMessageId` 字段
- [ ] `OtterToolClient` 包含 `message.complete()` 方法，委托给 `SendMessage.complete()`
- [ ] `AgentInvokePort` 的 `InvokeOptions` 包含 `messageId` 字段
- [ ] `PiSessionFactory.invoke()` 不再返回 `"fixme"`
- [ ] `AgentInvoker.invokeConversation()` 不再硬编码 `body` 和 `talkingStonePassedTo`
- [ ] speak 工具参数校验失败时返回错误文本给 LLM，不静默兜底
- [ ] speak 调用后的幽灵事件被静默忽略，不抛异常
- [ ] `SendMessage.fail()` 支持可选 `talkingStonePassedTo` 参数
- [ ] `SendMessage` 新增 `sendSystem()` 方法支持系统消息
- [ ] `tsc --noEmit` 通过
- [ ] 重试机制：agent 未调 speak 时系统注入提醒并触发重试（最多 1 次）
- [ ] 重试后仍未调 speak 时消息正确标记为 failed，发言石包含 user

### 测试设计

| 测试用例 | 验证点 |
|---------|--------|
| agent 调用 speak(body, talkingStonePassedTo) | 消息 body 被正确设置，status 变为 completed |
| agent 调用 speak | talkingStonePassedTo 由 agent 指定，非系统默认 |
| speak 参数校验：body 为空 | 返回错误文本给 LLM，消息保持 streaming |
| speak 参数校验：talkingStonePassedTo 为空数组 | 返回错误文本给 LLM，消息保持 streaming |
| speak 调用失败（如消息已 abort） | 返回错误文本给 LLM，agent 可感知 |
| agent 未调 speak 就结束（第一次） | 当前消息 fail → 系统提醒注入（同 Turn） → 触发重试 |
| 重试后 agent 调用 speak | 正常完成，body 和 talkingStonePassedTo 由 agent 设定 |
| 重试后仍未调 speak | 消息标记为 failed → 发言石额外包含 user |
| speak 后 agent 继续生成事件 | 幽灵事件被静默忽略，不抛异常 |
| speak 工具的 currentMessageId | 与 sendMessage.start() 创建的消息 ID 一致 |
| speak 后记忆索引 | body 被正确索引到记忆系统 |
| speak 后 Turn 关闭 | tryCloseTurn 被正确触发 |
| 系统提醒消息 | senderType = "system"，同 Turn 内，不开新 Turn |
| 系统消息发言石 | senderType = "system" 豁免发言石校验 |
| SendMessage.fail() 含 talkingStonePassedTo | failed 消息的发言石被正确写入 |
| SendMessage.sendSystem() | 系统消息创建成功，status = completed |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `skills/speak/SKILL.md` | 新增 | speak skill 定义（tool + prompt） |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | 移除 `send_message`，新增 `speak`；ToolContext 加 `currentMessageId` |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` | 修改 | OtterToolClient 接口加 `message.complete()` 方法 |
| `src/interface-adapters/agent-runtime/agent-invoke-port.ts` | 修改 | `InvokeOptions` 新增 `messageId` 字段 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | 传递 messageId 到 buildCustomTools；删除 `_finalText` / `"fixme"`；更新熔断器 steer 消息为 `speak` |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | 传递 messageId 到 invoke options；删除硬编码 complete 调用；实现 speak 重试机制；幽灵事件静默忽略 |
| `src/usecases/conversation/send-message.ts` | 修改 | `fail()` 新增可选 `talkingStonePassedTo` 参数；新增 `sendSystem()` 方法 |
| `src/frameworks/main.ts` | 修改 | OtterToolClient 实现加入 message.complete（委托 SendMessage.complete） |

## 对抗审视修订记录

| 问题 | 级别 | 修复 |
|------|------|------|
| P0-1: OtterToolClient.message.complete() 应委托 SendMessage.complete() | P0 | §4 明确内部实现路径 |
| P0-2: LLM 可能传空 talkingStonePassedTo[] | P0 | §2 speak 工具内参数校验，错误直接返回 LLM |
| P0-3: AgentInvokePort 接口未提及变更 | P0 | §5 接口变更链路表补充 agent-invoke-port.ts |
| P1-1: speak 后 agent loop 继续 → 幽灵事件 | P1 | §6 竞态处理：appendEvent 失败静默忽略 |
| P1-2: 重试 token usage 不累积 | P1 | 实现要点中明确：可接受，重试是异常路径 |
| P1-3: 无 use case 支持创建 system 消息 | P1 | 实现要点：新增 sendSystem() 方法 |
| P1-4: send_message 与 speak 语义冲突 | P1 | 移除 send_message，speak 完全替代 |
| P1-5: start() 的 talkingStonePassedTo 覆盖不清 | P1 | §5 链路图明确 start 时传默认值，speak 时覆盖 |
| P2-1: speak 返回值可能让 LLM 继续生成 | P2 | §2 返回值含终止信号；§1 Skill 含"不要再生成任何内容" |
| P2-2: "发言石额外包含 user" 实现路径不明 | P2 | §7 明确扩展 fail() 方法接受 talkingStonePassedTo |
| P2-3: 熔断器 steer 消息引用 set_final_body | P2 | 改动范围表中 pi-session-factory.ts 说明更新为 speak |
| P2-4: speak 工具自身执行失败未讨论 | P2 | §2 speak 工具 catch complete() 异常，返回错误给 LLM |

## 关联 [required]

- **消息流式模型**：[F20260713e8n4](../13/F20260713e8n4-message-streaming-model.md) — 两层消息架构，本特性补全"最终答复"路径
- **消息设计审视**：[F20260714xk8a](../14/F20260714xk8a-msg-design-review.md) — talkingStonePassedTo 可空性修正，speak 工具对齐 set_final_body 模式
- **Tool/Skill 机制**：[F20260716t2ab](../16/F20260716t2ab-tool-skill-mechanism.md) — 工具/Skill 注入机制，本特性新增 speak skill
- **记忆召回 Skill**：[F20260721m3r1](./F20260721m3r1-memory-recall-skill.md) — 同类问题（tool 存在但 skill 缺失），参考其设计模式
