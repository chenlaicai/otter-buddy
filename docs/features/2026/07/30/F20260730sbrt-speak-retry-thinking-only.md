---
id: F20260730sbrt
title: speak-retry-thinking-only
doc_type: feature

summary: |
  speak 重试机制增强 + 系统提示词增加困境上报原则：
  - handleSpeakRetry 用 toolCallCount 区分 thinking-only 空响应（toolCallCount=0）vs 有工具调用但漏 speak（toolCallCount>0），给予不同重试提示
  - thinking-only 重试提示引导 LLM 可以通过 speak 上报困境，而非泛泛要求"必须调用 speak"
  - 系统消息与重试 prompt 统一为同一文本，避免 LLM 上下文看到不一致的两条消息
  - .pi/SYSTEM.md 诚实直言段尾增加困境上报原则

status: final
change_type: feature
tags: [agent, speak, retry, system-prompt, llm-behavior]
modules:
  - .pi/SYSTEM.md
  - src/interface-adapters/agent-runtime/agent-invoker.ts

created_at: 2026-07-30
---

# F20260730sbrt speak 重试区分 thinking-only + 系统提示词困境上报

## 背景

对话《上下文长度超过100%确认》中，大獭在修复 ESLint complexity 问题时陷入死循环：

1. `_handlePostInvocation` 方法 complexity = 13，ESLint 上限 12
2. 大獭尝试了多种方式降 complexity（提取方法、改可选链），每次改完要么 complexity 仍超，要么测试挂
3. **Turn 5（seq 6）**：编辑了 3 个文件、跑了 6 次测试、耗时 ~96 分钟，最终卡在 complexity vs 测试的死结上，未调用 speak 即结束
4. **Turn 6（seq 8）**：系统注入"你必须使用 speak 工具来结束你的发言"重试，大獭继续尝试修复，LLM thinking 了 **20 分钟**后返回一条**纯 thinking 响应**（无正文、无工具调用），再次失败

### 问题分析

| 现象 | 根因 |
|------|------|
| LLM thinking 20 分钟后空响应 | LLM 陷入无法解决的死结，但没有机制表达"我卡住了" |
| 重试仍然失败 | 重试提示只说"你必须调用 speak"，没区分 LLM 是有结论忘调 speak，还是根本没结论 |
| 系统消息与重试 prompt 内容不一致 | sendSystem 和 userMessageContent 是两个不同文本，LLM 上下文里同时看到两条内容 |

### 当前重试机制

```
LLM 未调 speak → fail → sendSystem("你必须使用 speak...") → invokeConversation("[系统提醒] 你上一次发言没有调用 speak...这是错误的...")
```

问题：
- 不区分"有正文但忘调 speak"和"thinking-only 空响应"
- "这是错误的"对卡死的 LLM 没有指导意义
- 系统消息和重试 prompt 是两个文本，LLM 看到重复但不一致的内容

## 变更

### 1. 系统提示词：困境上报原则

**.pi/SYSTEM.md** — 诚实直言段尾增加一句：

> 尝试多种方案仍无进展时，如实说明困境比反复空转更有价值。

放在所有獭共用的 SYSTEM.md（而非 BIG_OTTER.md），因为这是通用行为原则。

### 2. speak 重试：区分 thinking-only

**agent-invoker.ts handleSpeakRetry** — 用 `toolCallCount` 区分两种情况（`result.text` 在 `PiSessionFactory._buildInvokeResult` 中硬编码为空字符串，不可用）：

| 情况 | 判断条件 | 重试提示 |
|------|---------|---------|
| thinking-only（空响应） | `toolCallCount === 0` | "没有调用任何工具。请调用 speak 结束发言——可以是结论，也可以是困境" |
| 有工具调用但漏 speak | `toolCallCount > 0` | "没有调用 speak 就结束了。请调用 speak 结束发言——可以是结论，也可以是困境" |

### 3. 系统消息与重试 prompt 统一

原来 `sendSystem` 和 `userMessageContent` 是两个不同文本：

```typescript
// 旧：两个不同的文本
sendSystem("你必须使用 speak 工具来结束你的发言。请重新组织答复并调用 speak。")
invokeConversation({ userMessageContent: "[系统提醒] 你上一次发言没有调用 speak 工具就结束了，这是错误的。..." })
```

现在统一为同一个 `retryMsg`：

```typescript
// 新：同一个文本
const retryMsg = isThinkingOnly ? "..." : "...";
sendSystem(conversationId, retryMsg)
invokeConversation({ userMessageContent: retryMsg })
```

## 设计决策

1. **困境上报放在 SYSTEM.md 而非身份文件**：这是所有獭（大獭/小獭）都应遵守的行为原则，不与特定身份绑定。

2. **用 `toolCallCount` 而非 `result.text` 判断 thinking-only**：`result.text` 在 `PiSessionFactory._buildInvokeResult()` 中被硬编码为空字符串（LLM 实际输出通过 SSE 事件流推送，未回填到 `AgentRunResult.text`），因此不可用。`toolCallCount` 由事件处理器在 `tool_execution_start` 时累加，准确反映本轮 LLM 是否调用了工具。

3. **两种场景都给"困境"出口**：thinking-only 和有工具调用但漏 speak 都允许 LLM 通过 speak 报告困境。调了工具但仍然卡住的情况同样存在，不应只给 thinking-only 这个出口。

4. **去掉"也没有输出正文"**：`toolCallCount` 只能证明 LLM 是否调用了工具，无法证明是否输出了文本（`result.text` 硬编码为空）。断言"没有输出正文"可能与事实矛盾，导致 LLM 困惑。

5. **去掉"这是错误的"**：原有重试 prompt 中的"这是错误的"是评判性语气，对卡死的 LLM 没有指导意义。改为直接说明情况和行动。

6. **`sendSystem` 与 `userMessageContent` 职责不同**：`sendSystem` 写入消息 DB（前端展示/审计记录），`userMessageContent` 传入 agent session（LLM 可见）。两者内容相同但通道不同，`sendSystem` 不会进入 LLM 的 session 历史。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `.pi/SYSTEM.md` | 诚实直言段尾加一句困境上报原则 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | handleSpeakRetry 用 toolCallCount 区分 thinking-only、统一重试文本、清理 extractAgentError 死代码 |
| `tests/interface-adapters/agent-invoker.test.ts` | sendSystem mock 捕获 body + thinking-only/工具调用两个场景的提示词验证 |

## 测试

- `npm run lint` — 无报错
- `npm test` — 697/697 通过
- `_handlePostInvocation` complexity — 未超限（三元表达式不增加 cyclomatic complexity）
- 新增测试：thinking-only（toolCallCount=0）提示词包含"没有调用任何工具"和"困境"
- 新增测试：有工具调用但漏 speak（toolCallCount>0）提示词不包含"没有调用任何工具"
