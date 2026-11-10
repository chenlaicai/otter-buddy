---
id: F20261110rvsep
title: 检视权与设计权分离——检视报告退役修复方案槽位
summary: 检视者只产出事实/位置/影响/证据/严重度，不再给修复路线或预指派处置。skill 报告模板删除「建议修复」槽位并立硬边界，anti-patterns 收编 Solution-Leading Review（含 PR #1806 案发现场），作者协议明确方案设计权在作者，派工模板禁要求检视獭给修复建议。
change_type: prompt
capability_test: "n/a: prompt/skill 纪律层变更，无运行时行为；行为生效以下场真实检视为准（verify_by=human_judge）"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  from: [F20260807arop]
  supersedes: []
tags: [skills, adversarial-review, review-boundary, anti-sycophancy, prompt]
modules:
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/adversarial-review/references/anti-patterns.md
  - .pi/skills/adversarial-review/references/author-response-protocol.md
  - .pi/skills/otter-summon/references/collaboration-patterns.md
created_at: 2026-11-10
intent:
  problem: "检视报告模板每条发现带「建议修复」槽位、派工指令要求检视獭「发现含修复建议」——制度性引导检视者越界设计。后果：作者被锚定（方案空间收窄到检视者想象力）；delta 复核退化为检视者验证自己的方案（确认偏误回环）；方案出问题时实现责任与设计责任混同。"
  expected_effect: "检视报告不再出现修复路线/实现方案/代码草稿/处置预指派；作者按决策树自行设计方案与处置，不以「检视者没说怎么修」悬置处置；发现必处置硬规则不变（不重开「记录」黑洞）。"
  verify_by:
    type: human_judge
    bugfix_acceptance:
      - "下场真实检视（含本特性 PR 自身的独立检视）报告不含修复路线——狗食验证第一现场"
      - "作者侧不再以检视者未给方案为由迟延处置；分级与处置决策树行为不变"
    rollback: "git revert 本 PR 合入 commit；纯 markdown 变更，无 schema/运行时影响"
    risk_note: "检视质量不因失去方案槽位下降——证据要求（复现/核验命令）保留；若作者侧出现「没方案不动手」的悬置，按 author-response-protocol 新条款判 Inaction"
---

# F20261110rvsep: 检视权与设计权分离

## 案发现场与第一性原理

2026-11-10，PR #1806（F20261110ryrev）独立检视：检视者给出 A/B/C 三条修复路线，作者选 A；delta 复核时检视者被迫申报「作者已按我建议修改→复核者确认偏误」结构性偏见——需要靠申报偏见打补丁，本身就是结构已被污染的证据。搭档确认第一性原理：**检视权与设计权必须分离，否则检视的独立性在越界那一刻自我瓦解**——独立检视的不可替代价值是「未被设计者思维污染的第二双眼睛」，给出修复方案的那一刻这个价值就没了。

同场的轻量形态：检视者列「残留非阻断」并给每条预指派处置（「建议 F 文档收编」）——处置本是作者决策树（author-response-protocol）的产物，检视者先替作者走了决策树。

## 变更清单

1. **SKILL.md**：两处报告模板删除「建议修复」槽位，发现字段重构为「事实与影响 + 证据（复现/核验命令）」；新增硬边界块「检视者不写修复方案」（与「发现必处置」硬规则并列，含三条 Why 与边界）；审查者自省清单加一条越界自检；快报模板同步标注不含修复方案。
2. **anti-patterns.md**：新增 Solution-Leading Review 反模式（Symptom/Problem 四条机理/PR #1806 案发现场/Fix/边界）。
3. **author-response-protocol.md**：新增「方案设计权在作者」节——作者不得以检视者未给方案为由悬置处置；检视报告中的方案只当一个假设独立评估；检视者不得要求作者先给方案再提发现。
4. **collaboration-patterns.md**（otter-summon）：检视獭 systemPrompt 指引补「不要求修复建议」——堵住派工层把检视獭推向越界的入口（本特性案发链之一）。

## 不变式（防重开旧洞）

- **发现必处置硬规则原样保留**：全部发现（含建议级）必有显式处置终态才能「通过」——本变更只改「谁设计、谁决策」，不改「必须处置」。
- 复现/验证命令是定位证据不是方案，保留；严重级「必须整改」是分级政策不是方案指派，保留。
- 反驳门槛、四分类响应、建 issue 前置闸全部不动。

## 验证

- Golden Gate: n/a（verify_by=human_judge，无场景可跑）——本变更是协作纪律层，行为生效以下场真实检视为准；**狗食验证第一现场 = 本特性 PR 自身的独立检视**（检视者按新规矩执行，报告应不含修复路线）。
- `npm run lint:skills` / `lint:docs` / `lint:intent` / `lint:date-bombs` / `lint:prompt-anchors` / `lint:evidence-anchors` 通过（见 PR）。
- 纯 markdown 变更，无代码/测试改动，无运行时行为。

## 边界

- troubleshooting/排查类 skill 的「输出修复建议」**不在本变更范围**——排查獭是调查者不是独立检视者，其职责就是给方案；本边界只约束 adversarial-review 的独立检视场景。
- 存量历史检视报告不回改；本规则对新检视即刻生效（含口头约定先行：2026-11-10 对话内已即时执行）。
