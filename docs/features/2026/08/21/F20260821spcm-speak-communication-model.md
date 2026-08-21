---
id: F20260821spcm
title: speak-communication-model
doc_type: feature

summary: |
  三层防御机制解决海獭在多人对话中直出 text 而不用 speak 发言的问题。
  根因：LLM 不知道"聊天室"通信模型，把 direct text 当正常输出。
  方案：prompt 预防 + 重试纠正 + 触点强化 + metrics 可观测性。

causal_links:
  from:
    - F20260820d338
  references:
    - "#354"
    - "#357"

status: development
change_type: feature_update
tags: [agent, speak, yield, prompt, retry-policy, observability, multi-otter]
modules:
  - prompts/identity/BIG_OTTER.md
  - prompts/identity/SMALL_OTTER.md
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
  - src/usecases/ports/agent-metrics-port.ts
  - src/usecases/ports/sdk-invoke-port.ts
  - src/frameworks/metrics/agent-metrics.ts
capability_test: "n/a: prompt 改动 + retry-policy 纯函数 + metrics counter，无 LLM 行为依赖"
---

# F20260821spcm: 聊天室通信模型注入

## 背景

海獭在多人对话中经常直接输出 text 而不用 speak 工具发言，导致：
- 搭档在聊天界面看不到这些内容（需点开流式过程才能看到）
- 其他海獭完全看不到（系统只推送 speak 内容）

**根因**：LLM 的默认心智模型是「assistant text = 对用户的回复」，这是所有 chat 微调数据里的默认通信模型。本系统把模型改成了「speak = 唯一发言通道，text = 私有草稿」，但没有向 LLM 显式声明这个新模型。

**三方讨论**（大獭 + mimo + kimi）后确定三层防御方案。

## 实现内容

### Phase 1：通信模型段 + speak 描述强化（预防）

**变更**：
- `BIG_OTTER.md` + `SMALL_OTTER.md`：身份段之后加「对话通信模型」段（4 条规则）
- `tool-factory.ts`：speak 描述前置「你在聊天室里唯一的发言通道」声明

**设计决策**：
- 放 .md 文件不放 IdentityBuilder 代码——prompt 编辑比改代码灵活，且大小獭都需要
- 放身份段之后、其他内容之前——身份认知的一部分

### Phase 2：no_yield 分类细化 + 文案按形态定制（纠正）

**变更**：
- `pi-session-factory.ts`：将 `turnText.text` 携带到 `result.directText`
- `orchestrator.ts`：新增 `detectOrphanText()` 检测旁白流失（no_yield + directText ≥ 20 字符）
- `retry-policy.ts`：`buildYieldRetryMsg` 按形态定制文案

**关键设计**：
- 重试消息在上下文最末尾（注意力最强位置），抗 context rot
- 直接点破认知错误（"你的文本没人看到"）而非只纠正行为（"你没调 speak"）
- 利用现有 turnText 资产，零额外流式开销

**定制文案**：
> [系统提醒] 你刚才输出了一段文本，但那是**只有你自己能看到的草稿**，搭档和其他海獭都看不到。请把那段内容通过 speak(body) 重新输出，然后 yield 交棒。

### Phase 3：可观测性（metrics + 日志）

**变更**：
- `agent-metrics.ts`：新增 `agent_no_yield_orphan_text_total` counter（按 otter_id 分组）
- `orchestrator.ts`：检测到旁白流失时记录 info 日志（otterId + orphanTextLength）
- `agent-metrics-port.ts` + `sdk-invoke-port.ts`：接口补充

**Metrics**：
- `agent_no_yield_orphan_text_total{otter_id}`: 旁白流失触发次数（按獭分组）
- 日志关键字: `Orphan text detected: LLM output direct text without calling speak`

## 明确不做的

| 方案 | 否决理由 |
|------|----------|
| auto-capture 兜底 | 会改变 LLM 的学习信号——系统每次默默兜底，LLM 永远不会学会正确使用 speak |
| OutputGuard delta 层实时介入 | abort 整轮作废代价高，steering 注入在 speak 上有事故史（circuit-breaker-speak-steer-loop） |
| result.text 落库 | 旁白多是思考碎片，落库质量差 |

## 影响范围

### 直接影响
- LLM 在多人对话中使用 speak 的频率预期提升
- no_yield 分类更精细，重试消息更有针对性

### 间接影响
- 重试消息在注意力最强位置，可能影响后续工具调用决策
- metrics counter 按 otter_id 分组，可排查哪些獭更容易犯此错误

## 验证

### 测试覆盖
- `retry-policy.test.ts`：5 个用例覆盖 hasOrphanText 三态 + 兼容性
- `detect-orphan-text.test.ts`：8 个用例覆盖检测逻辑边界
- `agent-invoker-metrics.test.ts`：mock 补齐
- 全量测试：112 files / 1344 tests 通过

### CI 状态
- 通过

## Discovered Issues

1. **阈值调优待观察**：当前阈值 20 字符（原方案建议 50），需生产环境验证——Issue [#357](https://github.com/chenlaicai/otter-buddy/issues/357)
2. **重试成功率待统计**：定制文案是否有效纠正 LLM 认知，需实际运行观察
