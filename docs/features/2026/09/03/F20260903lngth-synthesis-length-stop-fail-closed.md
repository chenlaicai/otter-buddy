---
id: F20260903lngth
title: 交接摘要合成 length-stop fail-closed——截断摘要拒绝落盘
summary: 交接合成链路对 LLM 截断响应（stopReason=length）fail-closed：截断信号经 BuildInvokeResultResult 透传至合成闭包，闭包 throw 走防线②机械转储降级；附合成结果 metrics 埋点。借鉴 Pi SDK getSummarizationFailure 的负向验证模式。
change_type: fix
created_in_conversation: 9d326c9d-9818-40a2-9982-898315fe7aa4
from:
  - F20260901mbfx
  - F20260901dtfx
---

# 交接摘要合成 length-stop fail-closed

## 背景与问题

搭档同事问及 Pi SDK compaction 的保存点算法，大獭读源码（`pi-coding-agent/dist/core/compaction/compaction.js`，667 行）后产出借鉴清单，经 mimo（mimo-compaction-review，对抗审视）+ 大獭独立核查合并裁决：4 条中仅 length-stop fail-closed 值得修。

**缺口**（mimo 挖出根因）：Pi 对摘要生成被截断（`stopReason=length`）fail-closed——`getSummarizationFailure`（compaction.js:467-475）拒绝把截断摘要当 checkpoint 落盘。我们的合成链路截断信号在 SDK→应用代码边界即被丢弃（`BuildInvokeResultResult` 无 stopReason 字段），合成闭包只检查 `synthesisText.length === 0`——**截断但非空的摘要以"成功"面目写进 session.summary，误导下一代海獭**。

影响有界：件②③④（文件轨迹/近期原文/活状态盘点）是独立机械数据不经合成路径；但件①叙事摘要截断即静默失真。

## 修复设计

三层改动，真信号优先于启发式（mimo 曾建议"检查是否含 ## Next Steps 标题"，但那是 Pi 8 段式锚，七段模板没有且正向启发式会误杀——否决）：

1. **边界透传**：`context-tokens.ts` 新增 `getLastStopReason(entries)`——从 session branch 取末条 assistant 的 stopReason。与 `validAssistantUsage` 过滤规则互补：后者跳过 aborted/error，前者不过滤——截断（length）信号恰恰需要从"看起来成功"的响应里暴露。
2. **结果携带**：`BuildInvokeResultResult` / 两个 `AgentRunResult`（pi-session-factory 本地 + sdk-invoke-port）新增 `lastStopReason?` 字段，`buildInvokeResult` 统一填充。
3. **fail-closed 判定**：`buildSynthesisFunction`（agent-invoker.ts）合成闭包在提取文本前检查 `lastStopReason === 'length'` → `recordSynthesis('truncated')` + throw——外层 `generateSummary` 的 catch 走防线②机械转储降级，与 Pi 同立场：截断摘要不许当 checkpoint。

附带（mimo 反向查漏发现，合并实施）：合成结果 metrics 埋点——`AgentMetricsPort.recordSynthesis(outcome)`，封闭枚举 `success | empty | truncated | error | timeout`，prom counter `agent_handoff_synthesis_total{outcome}`。success/empty/truncated 在合成闭包内计数；timeout/error 在 `synthesizeWithTimeout`（新提炼辅助函数，携带 `SynthesisFailureError.outcome`）经 `onSynthesisOutcome` 回调计数。

## 变更文件

| 文件 | 变更 |
|---|---|
| `src/frameworks/agent/context-tokens.ts` | +`getLastStopReason()` |
| `src/frameworks/agent/circuit-breaker-helpers.ts` | `BuildInvokeResultResult` +`lastStopReason`；`buildInvokeResult` 填充 |
| `src/frameworks/agent/pi-session-factory.ts` | 本地 `AgentRunResult` +`lastStopReason` |
| `src/usecases/ports/sdk-invoke-port.ts` | port `AgentRunResult` +`lastStopReason` |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 合成闭包 length fail-closed；`buildAutoHandoffOptions` 传 `onSynthesisOutcome` |
| `src/frameworks/agent/handoff-package-builder.ts` | `HandoffPackageOptions` +`onSynthesisOutcome`；提炼 `synthesizeWithTimeout` + `SynthesisFailureError` |
| `src/usecases/ports/agent-metrics-port.ts` | +`recordSynthesis(outcome)` |
| `src/frameworks/metrics/agent-metrics.ts` | +`agent_handoff_synthesis_total` counter |
| `tests/`（2 文件） | context-tokens 单元 4 例 + invoker handoff 集成 2 例（截断拒绝 / 非 length 不误杀）；metrics spy 补 mock |

## 本次变更对旧特性做了什么

- **F20260901dtfx（directText 修复）**：合成闭包的 fallback 链（directText → text）不变，length 检查插在文本提取之后、empty 检查之前——截断拒绝优先于空串拒绝。
- **F20260901mbfx（边界修复）**：`HandoffPackageOptions` 扩展一个可选回调字段，既有字段语义不变。

## 验证

- tsc 0 错误 / eslint 0 error（复杂度回归：引入SynthesisFailureError 前 generateSummary 复杂度 16 超限 12，提炼辅助函数后达标）
- 新增测试 6 例全绿：getLastStopReason 单元 4（取末条/与过滤互补/回溯跳过/空输入）+ 闭包集成 2（length throw 拒绝 / stop_end_input 正常返回不误杀）
- 全量 231 文件 2859/2859 通过
- 已过最简实现检查：真信号方案（边界透传）优于启发式校验（无需模板锚、无误杀）；未引新依赖
- golden gate：n/a（纯类型/逻辑层变更，无 prompt/skill/协议层软代码改动）
