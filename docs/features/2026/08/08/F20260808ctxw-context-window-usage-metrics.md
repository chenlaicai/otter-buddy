---
id: F20260808ctxw
title: context-window-usage-metrics
doc_type: feature

summary: |
  修复对话消息"上下文 token 数"虚增（新开对话三四轮即显示 600k+）的口径 bug。
  根因：context_tokens 取的是 Pi SDK getSessionStats() 的 session 累计 token 消耗（每次工具调用往返都重发完整上下文，累计值把同一份上下文重复计几十遍），并非上下文窗口占用。
  修复：改用末次 assistant 消息的 usage（input+output+cacheRead+cacheWrite，与 SDK compaction 判定同公式）作为窗口占用口径，落库与 SSE 实时展示同源切换。

status: implemented
change_type: fix
tags: [agent-runtime, token-usage, observability]
modules:
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/agent-runtime/agent-invoke-port.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
causal_links:
  from:
    - F20260806btk7   # context_tokens 落库 PR，记录在案口径属存量设计问题，本 PR 收口
---

# F20260808ctxw: 上下文指标改为窗口占用口径

## 背景

### 现象

2026-08-08 搭档新开两个对话（《ui优化》《新消息数量不断增长》），三四轮对话后大獭消息上显示的"上下文 token 数"爆炸到 600k+。

### 数据实锤

`messages.context_tokens`（DB 实测，2026-08-08 两个新对话）：

| 对话 | 逐条消息 context_tokens |
|---|---|
| ui优化 | 74236 → 269996 → 91718 → 96213 → 408005 → 131909 → 165139 → 193010 → **634333** |
| 新消息数量不断增长 | 133316 → 365302 → 473298 → 85588 → 95245 → 127613 → **602497** |

数值会"回落"（408k→131k）——真实上下文不可能缩小，只有累计计数器在 session 重建时归零才会这样。

对应 session jsonl（《ui优化》）：98 次 LLM API 调用，累计 input+output = 573,933 ≈ DB 显示值；但单次调用 usage 为 input 2k-38k + cacheRead ~28k，**真实窗口占用仅 ~35-45k**，显示值虚增约 15 倍。

### 根因

`pi-session-factory.ts` `_buildInvokeResult` 取 `session.getSessionStats().tokens`——Pi SDK 的 **session 级累计 token 消耗**（每次工具调用往返都把完整上下文重发给模型，累计值把同一份上下文重复计几十遍）。该值经 `agent-invoker.ts` 以 `input+output` 公式同时落库（`messages.context_tokens`）和 SSE 实时推送（`message.complete` 的 `ctx` 字段），前端渲染为"上下文使用率"。

F20260806btk7（context_tokens 落库 PR）已将此口径问题记录在案："tokenUsage 语义是 session 累计值，非单轮上下文窗口占用……是否改为'窗口占用'口径呈搭档定方向"。2026-08-08 搭档拍板：要的就是窗口占用。

### 次生影响

`checkTokenWarning`（TOKEN_WARNING_THRESHOLD=100k）也用同一累计值，窗口还很空时就会误打 token 警告日志。

## 变更

1. **口径来源**（pi-session-factory.ts `_buildInvokeResult`）：新增 `ctxTokens` = `calculateContextTokens(getLastAssistantUsage(session.sessionManager.getBranch()))`，即末次 assistant 消息的 usage（input+output+cacheRead+cacheWrite）。两函数均为 pi-coding-agent SDK 公开导出，与 SDK 自身 compaction 判定同一公式。
2. **结果载体**：`AgentRunResult`（agent-invoke-port.ts / pi-session-factory.ts）新增 `ctxTokens?: number`；`tokenUsage` 保留 session 累计口径，仅用于成本日志。
3. **落库**（agent-invoker.ts `_handlePostInvocation`）：`contextTokens` 改取 `result.ctxTokens`。
4. **SSE**（agent-invoker.ts `completeAgentInvocation`）：`message.complete` 的 `ctx` 改取 `result.ctxTokens`，与落库同源。
5. **告警**（circuit-breaker-helpers.ts `checkTokenWarning`）：参数从累计 tokens 改为 `ctxTokens`，同一阈值（100k）在窗口占用口径下恢复本来语义。
6. **测试**（agent-invoker.test.ts）：mock 结果带 `ctxTokens: 42000`，断言落库值 = ctxTokens（不再断言 input+output=15）。

## 设计决策

- **为什么不用 SDK 的 `getContextUsage()`**：它要求 `model.contextWindow > 0` 才返回有效值，而 mimo 是自定义模型、config.yaml 未配 contextWindow（models-factory 自定义模型只继承连接属性），运行时必返回 undefined。直接取末次 usage 不依赖配置，且在 invoke 完成时点末次 assistant 消息即最终响应，trailing 估算增量为零，结果等价。
- **为什么公式含 output**：与 SDK compaction 的 `calculateContextTokens` 保持同公式（totalTokens || input+output+cacheRead+cacheWrite），口径一致性优先；output 通常仅数百 token，不构成误差。
- **tokenUsage 保留累计口径**：它是本轮真实成本（计费口径），日志排障仍需要；只是不再用于"上下文占用"展示。
- **session 重建/compaction 后数值自然回落**：窗口占用口径下这是正确行为（上下文确实变小了），不再是旧口径的"诡异回落"。
- **ctxMax 未配时前端兜底 200000**：存量行为不变；在 config.yaml 为模型补 `contextWindow` 后百分比条即准确，属配置项不在本 PR。

## Acceptance Test（验收测试）

### 需求推导

1. 需求1：消息的 context_tokens（落库与 SSE）反映末次 LLM 调用的窗口占用，不再随工具调用次数累计虚增
2. 需求2：session 重建/compaction 后数值回落是正常表现，新 session 从真实占用重新计起
3. 需求3：token 警告日志按窗口占用口径触发（>100k 窗口占用才告警）

### 权威证据

| 需求 | 权威证据来源 | 证据类型 |
|------|-------------|---------|
| 需求1 | `messages.context_tokens` 与 session jsonl 末次 assistant usage 一致（量级 35-45k，非累计 600k） | 运行时状态（DB + 文件内容） |
| 需求2 | 新 session 首条消息 context_tokens ≈ 首轮真实上下文（~35k） | 运行时状态（DB） |
| 需求3 | 单元测试 + 日志中不再出现窗口 35k 时的误告警 | 测试结果 + 文件内容 |

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|---------|
| AT-1 | 需求1 | 新开对话与大獭进行 3-4 轮含工具调用的对话，查 `SELECT context_tokens FROM messages ORDER BY sequence_num` | 各消息 context_tokens 在真实窗口量级（数万），且与 session jsonl 中末次调用的 input+cacheRead 量级一致；不出现 600k 级数值 |
| AT-2 | 需求2 | 对话触发 session 重建后继续发言 | 新 session 首条消息 context_tokens 回落到首轮真实占用 |
| AT-3 | 需求3 | `npm test` | 全部通过（1020 用例） |

### 能力测试映射

A 类纯代码逻辑改动，无 LLM 参与行为，不需要能力测试。验收以 AT-1/AT-2 的真实运行数据为准。

### 证据判定（验收执行后填写）

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| 需求1 | 待验收（合入后真实对话验证） | ❓ |
| 需求2 | 待验收（合入后真实对话验证） | ❓ |
| 需求3 | 证明完成：`npm test` 84 文件 1020 用例全绿（2026-08-08） | ✅ |

## 影响面

- **展示语义变化**：历史消息已落库的累计值（含 600k 级）不回填、不迁移，新旧消息口径不同——老消息显示的是累计消耗，新消息显示窗口占用。搭档已知情（本 PR 即搭档排查后立项）。
- **前端**：无代码变化（字段名/结构未动，仅值口径变化）。
- **告警**：`[token-warning]` 日志触发条件从"session 累计 >100k"变为"窗口占用 >100k"，误告警消除。
- **handoff**：仓内无基于 tokenUsage 的自动 handoff 实现（F20260722ta2k 文档中的 handoff 阈值代码示例未落地），无影响。
