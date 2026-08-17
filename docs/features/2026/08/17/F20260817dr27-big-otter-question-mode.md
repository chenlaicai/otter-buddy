---
id: F20260817dr27
title: big-otter-question-mode
doc_type: feature

summary: |
  修复 issue #257：大獭在技术方案讨论中把大量决策点抛给用户，而不是自行调研后
  给出建议方案。在 BIG_OTTER.md 中增加「提问模式」段落，区分「必须用户决策」
  和「我推荐 X，你有异议吗」两种模式。

causal_links:
  from:
    - F20260813dr27

status: development
change_type: prompt
tags: [prompts, big-otter, prompt, question-mode]
modules:
  - prompts/identity/BIG_OTTER.md
capability_test: "n/a: prompt 变更，无代码逻辑"
---

# F20260817dr27: 技术决策权增加提问模式说明

## 背景

Issue #257：大獭在技术方案讨论中倾向于把大量决策点抛给用户，而不是自行调研后给出建议方案。
一次提出 5 个问题，其中部分可以自行决策。

## 目标

- T1: 在 BIG_OTTER.md 中增加「提问模式」段落
- T2: 区分「必须用户决策」和「我推荐 X，你有异议吗」两种模式

## 方案设计

在「技术决策权」段落之后新增「提问模式」段落：
- 能自行决定的技术问题不问用户，给出推荐方案+理由
- 只在真正涉及产品方向、资源投入、对外承诺时才请示用户

## 验收

- [x] 段落位置正确（在「技术决策权」之后、「召唤小獭」之前）
- [x] CI 通过
- [x] 对抗审视通过（0 严重 / 2 建议）
