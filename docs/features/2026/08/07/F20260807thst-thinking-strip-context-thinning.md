---
id: F20260807thst
title: thinking-strip-context-thinning
doc_type: feature

summary: |
  LLM thinking 块全量累积导致 context 膨胀，用 SDK context extension event 在每次 LLM 调用前 strip 历史 thinking。
  真实 session 15 轮累积 ~13K tokens thinking 占 cached prefix 19%，大部分是早期推理笔记对当前任务无价值。
  保留当前轮 thinking 不动，JSONL 完整保留可审计。

change_type: feature
status: implemented
tags: [agent-runtime, context-optimization, sdk-extension]
modules:
  - src/frameworks/agent/pi-session-factory.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260807thst: thinking 块上下文瘦身

## 背景

Pi agent session 中，LLM 产出的 thinking 块（模型推理过程）会全量持久化到 JSONL 文件。后续每轮 invoke 时，这些 thinking 块作为 session history 发回 LLM，导致 context 膨胀。

### 真实数据

从 session `2026-08-07T03-28-36-045Z` 采集：

| 指标 | 数值 |
|------|------|
| 对话轮次 | 15 轮 |
| thinking 块数量 | 15 个 |
| thinking 总字符数 | 39,881 chars |
| thinking 约 tokens | ~13,293 tokens |
| 占 cached prefix 比例 | ~19% |
| 最大单个 thinking 块 | 13,355 chars（分析 abort/speak/steer 交互） |

### thinking 块特征

- 每轮 assistant 响应都产出 thinking 块，大小从 184 chars 到 13,355 chars 不等
- thinking 内容是模型的推理笔记（"Now I see the key pieces: 1. Backend abort endpoint..."）
- 历史轮次的 thinking 结论已被后续 text 输出覆盖，但仍在 context 中累积
- compaction 是唯一的清理机制，但触发前 thinking 一直在膨胀
- 已知退化问题：mimo 模型 thinking 块会完全重复 4 次（F20260807tprt），abort 后 153KB thinking 污染 context（F20260804dglp）

## 变更

在 `PiSessionFactory.ensurePiCodingAgent()` 中，通过 SDK 的 `DefaultResourceLoader.extensionFactories` 注册一个 `thinking-strip` inline extension，监听 `context` 事件。

### 核心逻辑

1. 每次 LLM 调用前，`context` 事件触发，handler 收到完整的 `AgentMessage[]`
2. 找到最后一条 assistant 消息的 index（当前轮）
3. 遍历所有 assistant 消息，strip 历史 thinking 块，保留当前轮不动
4. abort 场景保护：如果 assistant 消息只有 thinking 块（无 text/toolCall），保留原消息防止 API 400

### 关键设计选择

**选择 `context` 事件而非 `message_end`**：

| 维度 | `context` 事件 | `message_end` 事件 |
|------|---------------|-------------------|
| 作用时机 | 每次 LLM 调用前 | 消息写入时 |
| JSONL 保留 | 保留完整 thinking（可审计） | 永久删除 |
| 历史 strip | 自然覆盖所有历史消息 | 只能处理当前写入的消息 |
| 当前轮保护 | 需要识别"最新 assistant 消息" | 天然只处理刚完成的消息 |

`message_end` 的问题：永久丢失 thinking 数据无法审计；多步工具调用中间步骤的 thinking 被 strip 后，后续步骤的 LLM 调用看不到之前的推理。

**保留当前轮 thinking**：

- 当前轮的 thinking 是模型正在进行的推理，strip 掉会导致模型"失忆"
- 多步工具调用场景下（一次 invoke 内多次 LLM 调用），模型依赖上一次 thinking 来决定下一步行动
- 历史轮次的 thinking 结论已被后续 text 输出覆盖，但当前轮尚未完成

## 设计决策

### KV Cache 影响

Anthropic prompt caching 是 prefix-based。cache breakpoint 在 system prompt、最后一个 tool、最后一个 user message。assistant 消息夹在中间，全部属于 cached prefix。

- **第一次 strip**：prefix 变化 → cache miss（一次性惩罚）
- **后续 turns**：strip 后的 prefix 重新稳定 → cache hit
- **净收益**：一次性 cache miss < 持续的 prefix 缩小收益（prefix 小 19%）

### SDK 钩子机制

SDK 的 `emitContext` 在调用 handler 前做 `structuredClone(messages)` 深拷贝，handler 返回新数组不影响原始 state。inline extensions 最后加载，不会被其他 extension 干扰。

## Acceptance Test

### 需求推导

1. **历史 thinking 不进入 LLM context**：strip 后 LLM 收到的 messages 中，历史 assistant 消息不含 thinking 块
2. **当前轮 thinking 保留**：最新 assistant 消息的 thinking 块不被 strip
3. **JSONL 完整性**：session 文件中 thinking 块仍然存在
4. **abort 安全**：只有 thinking 无 text 的 assistant 消息不被 strip

### 权威证据

| 需求 | 权威证据来源 | 证据类型 |
|------|-------------|---------|
| 历史 thinking 不进入 context | agent 日志中 LLM 请求的 messages | 文件内容 |
| 当前轮 thinking 保留 | agent 日志中最新 assistant 消息含 thinking | 文件内容 |
| JSONL 完整性 | session JSONL 文件中 thinking 块存在 | 文件内容 |
| abort 安全 | abort session 的 assistant 消息 content 不为空 | 文件内容 |

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|---------|
| AT-1 | 历史 thinking strip | 启动 otter，进行 3+ 轮对话，检查 LLM 请求 | 前几轮 assistant 消息无 thinking 块 |
| AT-2 | 当前轮保留 | 同上，检查最新 assistant 消息 | 最新 assistant 消息含 thinking 块 |
| AT-3 | JSONL 完整 | 检查 session JSONL 文件 | 所有 assistant 消息的 thinking 块仍在 |
| AT-4 | abort 安全 | 中断一个正在思考的 otter，检查下一轮 context | abort 的 assistant 消息 thinking 未被 strip |

### 能力测试映射

纯代码逻辑改动，无 LLM 参与行为，不需能力测试。

### 证据判定

验收执行后填写。

## 对抗审视决策史

### Round 1：红队审视

**❌ 必须修复：abort 场景 content 为空**

红队在 6 个真实 session 中发现 12 条 assistant 消息只有 thinking 块（`stopReason: "aborted"`），strip 后 `content: []` 会触发 Anthropic API 400 错误。修复：strip 前检查 `nonThinking.length === 0`，若为空则保留原消息不动。已采纳。

**✅ 无问题项**

| 审视项 | 结论 | 证据 |
|--------|------|------|
| 策略正确性 | ✅ | `transformContext` 在每次 LLM 调用前触发（agent-loop.js:181） |
| structuredClone | ✅ | runner.js:746 在 handler 前做深拷贝 |
| Handler 执行顺序 | ✅ | resource-loader.js:449 inline extensions 最后加载 |
| SDK 保证消息交替 | ✅ | assistant/user/toolResult 严格交替 |
| 性能 | ✅ | filter 微秒级，structuredClone 毫秒级 |
| 可扩展性 | ✅ | 独立 extension，可参数化 |

**⚠️ 有风险但可接受**

| 审视项 | 说明 |
|--------|------|
| 模型推理上下文 | thinking 结论通常反映在 text 输出中；极端情况可接受 |
| mimo 退化 thinking | strip 退化 thinking 反而是好事 |
| message_end 替代 | 可行但永久丢失数据 + 多步工具调用中间步骤丢失 |
| JSONL 持久化修改 | 侵入 SDK 内部，不可维护 |

**❌ 被否决方案**

| 方案 | 否决理由 |
|------|----------|
| `setThinkingLevel("off")` | 丧失所有推理能力 |
| `message_end` strip | 永久丢失 + 多步工具调用中间步骤丢失 |
| 修改 JSONL 持久化 | 侵入 SDK，升级风险大 |
