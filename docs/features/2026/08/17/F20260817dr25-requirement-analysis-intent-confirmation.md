---
id: F20260817dr25
title: requirement-analysis-intent-confirmation
doc_type: feature

summary: |
  修复 issue #255：大獭在需求讨论中出现理解偏差，用户说「特性文档应在流程中
  同步产出」，大獭理解成「事后检查 PR 有没有特性文档」。在 requirement-analysis
  工作流中新增步骤 2「意图确认」，要求用自己的话复述用户意图后再进入方案设计。

causal_links:
  from:
    - F20260813dr25

status: development
change_type: prompt
tags: [skills, requirement-analysis, prompt, intent-confirmation]
modules:
  - .pi/skills/requirement-analysis/SKILL.md
capability_test: "n/a: prompt 变更，无代码逻辑"
---

# F20260817dr25: requirement-analysis 增加意图确认步骤

## 背景

Issue #255：大獭在需求讨论中出现显著理解偏差——用户说的是「特性文档应在流程中同步产出」，
大獭理解成了「事后检查 PR 有没有特性文档」。用户不得不多次纠正和补充提示。

## 目标

- T1: 在 requirement-analysis 工作流中新增「意图确认」步骤，要求用自己的话复述用户意图
- T2: 区分「用户想要什么」和「我打算怎么做」，确认理解正确后再进入方案设计

## 方案设计

在步骤 1（解析需求）之后、步骤 2（检索上下文）之前插入新步骤 2「意图确认」：
- 用自己的话复述用户意图
- 区分「用户想要什么」和「我打算怎么做」
- 对于涉及「流程」的需求，主动区分「流程内嵌」和「事后检查」两种模式
- 后续步骤编号顺延（原 2-6 → 3-7），参考索引同步更新

## 验收

- [x] 步骤编号 1-7 连续
- [x] 参考索引步骤引用正确
- [x] CI 通过
- [x] 对抗审视通过（0 严重 / 1 建议）
