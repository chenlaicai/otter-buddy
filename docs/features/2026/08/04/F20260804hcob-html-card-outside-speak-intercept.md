---
id: F20260804hcob
title: html-card-outside-speak-intercept
doc_type: feature

summary: |
  修复大獭声称"已用 HTML 卡片呈现"但前端什么都看不到的缺陷。根因：模型把 ```html-card 围栏写在 speak 之外的 assistant 文本里，而只有 speak body 会落库渲染，assistant 文本随流式结束即丢弃；契约只说"speak 之后的输出不展示"，没说 speak 之前的文本同样不可见，模型被纠正后能正确自我诊断却原样重犯。修法：speak execute 闭包检测本轮 assistant 文本含围栏而 body 没有则拒绝（不 terminate，错误信息指导重试），并补强 speak description 明确"卡片必须写进 body 参数"。

causal_links:
  from:
    - F20260728htar   # html-card-dual-speak-format：纯契约无强制力的软肋是其设计文档自述的已知风险
  to: []

status: implemented
change_type: fix
tags: [html-card, speak, tool-contract, interception, frontend-invisible]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/interface-adapters/agent-runtime/tools/tool-helpers.ts
  - src/frameworks/agent/pi-session-factory.ts
  - tests/interface-adapters/speak-tool.test.ts
---

# F20260804hcob: html-card 写在 speak 外的检测拦截

## 问题现象

对话《关键资源太长了》（2026-08-04）中，搭档两次被告知"方案已用 HTML 卡片呈现"，但前端从未出现任何卡片。

## 根因分析

从 session 记录（`data/sessions/2026-08-04T07-49-07-778Z_*.jsonl`）还原的模型行为：

1. **第一轮**：模型先输出 6078 字 assistant 文本（含完整 ` ```html-card ` 围栏卡片）→ 再调 speak，body 只有 496 字摘要并声称"详细方案已用 HTML 卡片呈现"。**卡片从未进入 body**。
2. **搭档质疑后**：模型自我诊断完全正确（"上一轮我把 HTML 卡片写在了 speak 之外"）→ 然后把 3150 字卡片又写进 assistant 文本 → speak body 仅 34 字。**诊断对了，行为原样重犯**。

机制链条：

- 只有 speak 的 `body` 会经 `startSpeaking` 落库并渲染（`send-message.ts` → DB → SSE → `HtmlCard` 沙箱 iframe）。
- speak 之前的 assistant 文本只作为流式 event-log 瞬时展示，发言完成后即丢弃，前端无从渲染。
- speak description 原措辞只说"speak **之后**的任何输出都不会被展示"，未覆盖 speak **之前**的文本——模型的心智模型是"先写正文、再调 speak 总结"，正好踩中盲区。
- 纯契约无强制力（F20260728htar 自述软肋），且本次证明连"被纠正后重试"都救不回来：模型的"文本先行、工具收尾"生成惯性压过了显式纠错。

结论：按信道分层原则，契约补强（让 LLM 理解）为主，但必须配工程拦截兜底——尤其是"自我诊断正确仍重犯"这类惯性错误。

## 修复方案

### 1. 工程拦截（兜底）

speak execute 闭包新增校验（`validateSpeakBody`，`tool-helpers.ts`）：

- 本轮 invoke 的 assistant 文本含 ` ```html-card ` 围栏 **且** body 不含 → 拒绝本次 speak：
  - 返回错误文案，明确"那段文本不会进入消息，搭档根本看不到卡片"，指导把围栏完整移入 body 重新调用
  - 不带 terminate，loop 继续，模型当场重试（比搭档事后发现再纠正低一轮成本）
- `html-card-reply`（回执围栏）用负向前瞻排除，不误伤
- 未注入 `getTurnAssistantText` 的调用方（测试、其他 Composition Root）行为不变

### 2. 本轮文本累积（检测能力）

`ToolContext` 新增可选 `getTurnAssistantText: () => string`，由 `PiSessionFactory` 接线（`updateTurnText`）：

- 缓冲**按 assistant 消息隔离**：`message_start`（role=assistant）清零、`message_end` 追加文本块——检测范围收窄到"本条消息"。若按整个 invoke 累积，上一轮文本里的 stray 围栏会误拒后续所有无卡 speak，且无合规出口形成 livelock（对抗审视 H1）
- 时序依据（已对照 SDK 源码验证）：pi-agent-core `agent-loop.js` 在 `message_end` emit 之后才 `executeToolCalls`，因此 speak execute 运行时缓冲已包含同消息文本——正是失败模式现场
- `user`/`toolResult` 的 message_start 不清零、message_end 不累积

### 3. 契约补强（主手段）

speak description 两处修改：

- "speak 之后的任何输出都不会被展示" → "speak 之外的任何输出（**之前或之后**）都不会进入消息，搭档看不到"
- 【HTML 卡片】段新增硬规则："卡片围栏必须完整写在 body 参数内——写在 speak 之外文本里的卡片搭档看不到，系统会检测并拒绝该次调用"

`get_html_card_contract` 完整契约同步补充该强制规则（契约工具是唯一事实源，不能只改 description）。

## 验证

- `tests/interface-adapters/speak-tool.test.ts` 新增 5 例：
  1. 文本有围栏 + body 没有 → 拒绝、不提交、不 terminate，错误文案含 html-card/body 指引
  2. 文本有围栏 + body 也有 → 正常提交（不阻断合法用法：先起草后定稿）
  3. body 用 `~~~` 围栏（渲染侧合法）→ 与 ``` 草稿混用不误拒（围栏判定与渲染侧对齐）
  4. 文本只有 `html-card-reply` → 不误伤
  5. 未注入 `getTurnAssistantText` → 行为不变（向后兼容）
- `tests/frameworks/agent/turn-text-buffer.test.ts` 接线层 6 例：message_start 清零（防 livelock）、message_end 累积、user/toolResult 不影响、同消息文本+speak 工具调用场景、assistantMessageEvent 包装形状、空内容边界
- 全量 `vitest run` 通过；`eslint` 通过（validateSpeakBody 抽到 tool-helpers 以控制 execute 圈复杂度与文件行数）

## 对抗审视记录

PR 评审 agent 对照 pi-coding-agent SDK 源码逐条验证后 request changes，处置如下：

| 发现 | 结论 | 处置 |
|------|------|------|
| H1 缓冲按 invoke 累积 → 误拒 + livelock | 成立 | 改为按 assistant 消息隔离（message_start 清零） |
| M1 正则与渲染侧围栏判定不对称（`~~~` 漏匹配） | 成立 | 正则扩为 `(?:```\|~~~)html-card(?!-reply)`；行内提及误伤记入已知边界 |
| M2 接线层零测试，SDK 改版会静默失效 | 成立 | 补 turn-text-buffer.test.ts 6 例 |
| L1 healing event 在校验通过前落库，被拒会产生重复事件 | 成立但低危 | 记入已知边界，不改（拆分剥离/持久化收益不抵复杂度） |
| L2 熔断器 steer 文案 "Call speak immediately" 与拒绝态矛盾 | 成立但低危 | 记录在案，不改（兜底场景本需人工介入） |
| L3 F 文档"重试拿到新缓冲"表述不准 | 成立 | 本文档已修正 |
| L4 契约工具未同步强制规则 | 成立 | html-card-contract-tool.ts 已补 |
| 时序/事件形状两大假绿嫌疑 | **不成立** | SDK 源码验证 message_end 先于工具执行、载荷形状正确 |

## 已知边界

- 检测依赖 pi SDK `message_end` 先于工具执行的事件顺序；若 SDK 改版打乱顺序，拦截退化为"检测不到"（静默通过），不会误伤。接线测试（turn-text-buffer.test.ts）守住本仓库侧的形状假设，SDK 侧升级需回归验证。
- 行内提及误伤：模型在文本里以行内代码形式讨论 ` ```html-card ` 语法（非围栏块），正则同样命中，若 body 无卡会被拒。判定逻辑与渲染侧（mdast `code.lang`）并非同一事实源，完全对齐需共享 mdast 解析，收益不抵复杂度，暂以正则为准。
- 被拒绝的 speak 若携带 healing report，healing event 已在校验前落库（L1），重试再报会产生重复事件——低频且无害（管理工具可按 messageId 去重），暂不处理。
- 只拦截 html-card 一类"文本 vs body"错位；模型把其他关键内容（如表格、长文）写在文本里而 body 只写摘要的泛化问题不在本特性范围——契约措辞的"speak 之外的输出搭档看不到"对该类问题同样起预防作用。

## 影响范围

- 运行时行为变化仅一处：speak 在"文本有卡片而 body 没有"时从"静默成功"变为"拒绝 + 重试指引"。
- 前端、DB schema、消息渲染管线零改动。
- 顺带删了 pi-session-factory 一条冗余 debug 日志（`[execute] Building message`，与紧随的 `LLM request` info 日志重复）——为 max-statements 限额腾位。
