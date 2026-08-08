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

1. **口径来源**（pi-session-factory.ts `_buildInvokeResult` → context-tokens.ts `getContextWindowTokens`）：`ctxTokens` = 末次有效 assistant 消息的 usage（input+output+cacheRead+cacheWrite），复用 SDK 公开导出的 `getLastAssistantUsage`/`getLatestCompactionEntry`/`calculateContextTokens`，与 SDK compaction 判定同公式。**compaction 边界与 SDK `getContextUsage()` 同语义**：压缩点后无有效 assistant usage 时返回 undefined（该轮不落 ctx），不显示压缩前峰值。
2. **结果载体**：`AgentRunResult`（agent-invoke-port.ts / pi-session-factory.ts）新增 `ctxTokens?: number`；`tokenUsage` 保留 session 累计口径，仅用于成本日志。
3. **落库**（agent-invoker.ts `_handlePostInvocation`）：`contextTokens` 改取 `result.ctxTokens`。
4. **SSE**（agent-invoker.ts `completeAgentInvocation`）：`message.complete` 的 `ctx` 改取 `result.ctxTokens`，与落库同源。
5. **告警**（circuit-breaker-helpers.ts `checkTokenWarning`）：参数从累计 tokens 改为 `ctxTokens`，同一阈值（100k）在窗口占用口径下恢复本来语义。
6. **contextWindow 接入 SDK model**（models-factory.ts，对抗检视 L1 发现）：自定义模型（不在 provider 字典，如 mimo-v2.5-pro）注入时把 config 的 `contextWindow` 带入 SDK model。此前 SDK 看到 `contextWindow=undefined→0`，`shouldCompact` 判定恒真——**35-45k 上下文的 session 每轮都触发 auto-compaction 摘要调用**（生产 session jsonl 实锤：3-4 轮对话 5 次 compaction），白跑摘要成本还无谓压缩上下文。kimi k3 在 SDK 字典自带 1M 不受影响。生产 config.yaml 已为 mimo/kimi 补 `contextWindow: 1048576`（mimo 官方文档 1M；kimi k3 经 `GET /coding/v1/models` 实测 context_length=1048576）。
7. **测试**：新增 context-tokens.test.ts（口径公式 8 用例 + checkTokenWarning 3 用例）；models-factory.test.ts 补注入断言 2 用例；agent-invoker.test.ts 断言落库值 = ctxTokens（不再断言 input+output=15）。

## 设计决策

- **为什么不用 SDK 的 `getContextUsage()`**：它要求 `model.contextWindow > 0` 才返回有效值，而本 PR 修复前自定义模型拿不到 contextWindow，运行时必返回 undefined。`getContextWindowTokens` 复用其全部语义（同公式、同 compaction 边界、同 usage 有效性规则），但不依赖配置即可返回值；ctxMax 展示仍走 modelPool 配置。
- **compaction 当轮不落 ctx（M1 拍板）**：threshold compaction 触发的那一轮，branch 末条 usage 是压缩前的，真实窗口已被压到 keepRecentTokens+摘要量级。此时落 undefined（前端该轮不渲染条），下一轮 LLM 响应后恢复准确值。搭档 2026-08-08 拍板按 SDK 语义修。
- **为什么公式含 output**：与 SDK compaction 的 `calculateContextTokens` 保持同公式（totalTokens || input+output+cacheRead+cacheWrite），口径一致性优先；output 通常仅数百 token，不构成误差。
- **tokenUsage 保留累计口径**：它是本轮真实成本（计费口径），日志排障仍需要；只是不再用于"上下文占用"展示。
- **session 重建/compaction 后数值自然回落**：窗口占用口径下这是正确行为（上下文确实变小了），不再是旧口径的"诡异回落"。
- **contextWindow 缺省不注入**：models-factory 仅在 config 显式配置时带入（条件展开），未配置时行为与此前一致，避免对未配置用户引入行为突变。

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
| 需求3 | 证明完成：`npm test` 85 文件 1033 用例全绿（2026-08-08，含口径公式 13 新用例） | ✅ |

## 对抗审视记录

独立 agent 对抗检视（2026-08-08，57 次工具调用逐项核验 SDK 源码与调用路径）：

| 编号 | 发现 | 严重度 | 处置 |
|------|------|--------|------|
| M1 | compaction 边界：直接取末次 usage 缺少 SDK 的 post-compaction 检查，threshold compaction 当轮会落库压缩前旧值且永久留 DB | Medium | **已修**：`getContextWindowTokens` 照搬 SDK 边界语义，压缩点后无有效 usage 返回 undefined。语义取舍呈搭档拍板：按 SDK 语义修（2026-08-08） |
| M2 | 口径公式零测试覆盖，改回累计值测试仍全绿，AT-3 回归防线名不副实 | Medium | **已修**：新增 context-tokens.test.ts 11 用例 + models-factory 注入断言 2 用例 |
| L1 | mimo 自定义模型 contextWindow=0 → SDK `shouldCompact` 恒真，35-45k 上下文每轮白跑摘要 compaction（生产 jsonl 实锤 3-4 轮 5 次）；kimi k3 字典自带 1M 不受影响 | Low（实际影响大） | **已修**：models-factory 注入时带入 config contextWindow；生产 config.yaml 补齐 1048576。搭档拍板"本次完整修复" |
| L2 | alias 未知时 `getContextWindow` 返回 undefined 而实跑回退默认模型，百分比失真 | Low | 存量，不修，记录在案 |

审视确认无问题的维度：getLastAssistantUsage 输入结构与 branch entry 匹配；abort/error/熔断路径无过期值落库；三条重试路径 ctxTokens 不串值；SSE 与落库同源；前端对小值与 1M ctxMax 渲染正常。

## 影响面

- **展示语义变化**：历史消息已落库的累计值（含 600k 级）不回填、不迁移（搭档拍板"不要管"），新旧消息口径不同——老消息显示的是累计消耗，新消息显示窗口占用。
- **前端**：无代码变化（字段名/结构未动，仅值口径变化）；compaction 当轮不渲染 ctx 条（ctx undefined，前端 `m.ctx != null` 守卫）。
- **告警**：`[token-warning]` 日志触发条件从"session 累计 >100k"变为"窗口占用 >100k"，误告警消除。
- **compaction 行为变化（L1 修复的副作用，实为修复本体）**：mimo session 不再每轮触发 auto-compaction——摘要 LLM 调用成本/延迟消除，长上下文不再被无谓压缩。这是本 PR 除指标外的实质收益。
- **handoff**：仓内无基于 tokenUsage 的自动 handoff 实现（F20260722ta2k 文档中的 handoff 阈值代码示例未落地），无影响。
