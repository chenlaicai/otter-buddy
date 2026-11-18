---
id: F20261118alive
title: 全局表达风格——自然、真诚，有活人感
summary: 在全局 SYSTEM.md 增加大小獭共同继承的表达风格，让日常回应更自然、有判断、随场景调整；不设海獭人设或幽默指标，不改 speak 工具契约，严肃场景仍保持直接克制。
causal_links:
  relates:
    - F20261030lvgov
change_type: prompt
capability_test: "n/a: 纯表达风格增量，无独立行为触发场景；由人工判读与 SYSTEM 核心 prompt 锚点重放验证"
created_in_conversation: 6b8384a6-6c88-495f-8edb-7ef2175dcc2e
created_at: 2026-11-18
tags: [prompt, speaking-style, natural-language, llm-voice]
modules:
  - .pi/SYSTEM.md
intent:
  problem: "全局提示词缺少大小獭共享的表达风格约束，日常回应容易滑向客服腔、公文腔或固定模板；仅在大獭身份层治理无法覆盖小獭"
  expected_effect: "普通问答与顺利进展汇报能根据语境自然组织语言、直接表达判断，不依赖固定开场、公文句式或海獭梗；故障、风险与严肃决策仍先讲事实和行动，不为幽默增加篇幅"
  verify_by:
    type: human_judge
---

# 全局表达风格——自然、真诚，有活人感

## 背景

搭档希望海獭们说话更有趣味性，随后把目标明确为“活人感”，并确认不需要刻意携带“獭”的意象。方向是：像可靠同事一样自然回应、有明确判断、语气随场景变化，而不是强行卖萌或给每句话加段子。

既有 `prompts/identity/BIG_OTTER.md` 已有反 LLM 腔纪律（F20261030lvgov），但小獭不继承该身份文件。本次只补全局共享层，不改写大獭已有规则。

## 设计取舍

- **落点选 `.pi/SYSTEM.md`**：表达风格每轮生效，且大小獭都需要；放在全局层避免只治大獭。
- **`speak` 工具描述不动**：它继续负责发言通道、形态与工具纪律，不额外承载人设规则。
- **不设幽默频率或海獭人设**：避免把“活人感”执行成段子 KPI；幽默只是语境合适时的一种可选表达。
- **严肃场景收住**：故障、风险、安全、权限、合入终审和严肃决策仍以事实、影响和行动为先。
- **机制识别检查点**：未新增工作流、skill、守卫、协议或决策归属，属于既有系统提示词的纯表达规则增量，`Modification-Class: docs-config`。

## 变更清单

| 文件 | 改动 |
| --- | --- |
| `.pi/SYSTEM.md` | 新增“表达风格：自然、真诚，有活人感”一节，大小獭共同继承 |
| `docs/features/2026/11/18/F20261118alive-natural-speaking-style.md` | 记录方向、边界与验证方式 |

## Acceptance Test

| 场景 | 操作 | 预期结果 |
| --- | --- | --- |
| 普通问答 | 人工判读日常回答 | 先接住问题再给判断，语言自然，不机械套用固定开场或同规格列表 |
| 顺利进展 | 人工判读完成汇报 | 可以轻松但不过度表演，不因幽默增加无关篇幅 |
| 故障或严肃决策 | 人工判读回应 | 不用俏皮话稀释问题，事实、影响与下一步保持清晰 |
| 核心行为回归 | 至少重放 5 条坏锚点与 3 条好锚点，由异体模型评审 | 好锚点产出不变味，坏锚点同类错不再现，全部得到 YES |

## 验证

- `git diff --check`：通过。
- `npm run lint:intent`：本期文档 intent 与 verify_by 声明率均为 100%；存量 warning 不阻断。
- `npm run lint:capability`：通过；`npm run lint:prompt-size`：9 个模板均不超预算；`npm run lint:prompt-anchors`：通过；`npm run lint:docs`：通过，存量 warning 不阻断。
- `npm run check`：通过，含 TypeScript 构建、ESLint、schema lint、全栈装配冒烟（9 项）与存量库冒烟（4 项）、脚本参数/端口身份/otterbar 探测、connector 构建闭包检查。
- **Golden Gate**：`n/a`（`verify_by=human_judge`，纯表达风格增量，无对应行为场景可跑）。
- **核心 prompt 锚点重放**：坏锚点 A1/A2/B2/C5/D5 与好锚点 A3/B1/D2 共 8 条；kimi 按修改后 SYSTEM.md 独立重放，glm 异体评审，**8/8 YES**。重放与评审原文分别在 `/tmp/F20261118alive-anchor-replays.md`、`/tmp/F20261118alive-anchor-review.md`。
- **最简检查**：只增加一个全局 prompt 小节与一份特性文档，未新增代码、依赖、测试框架或工具描述；全局层是覆盖大小獭的最小落点。

## 负面向验收

- 不修改 `speak` 工具描述，不改变六形态路由、交棒或其他工作流程。
- 不删除既有大獭反 LLM 腔纪律，不覆盖小獭专属任务提示。
- 风险：模型可能把口语化误读成随意，或把幽默当成硬性任务；文案已明确“不刻意加戏”“不假装成人类”“严肃场景克制”“不额外增加篇幅”。
