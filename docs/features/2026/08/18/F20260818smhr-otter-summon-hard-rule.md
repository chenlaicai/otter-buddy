---
id: F20260818smhr
title: otter-summon-hard-rule
doc_type: feature

summary: |
  修复 issue #294：大獭处理 4 个 PR 时未按 skill 要求召唤小獭。在 otter-summon
  skill 中增加硬规则：搭档明确提到多个任务/PR/并行处理时必须召唤。

causal_links:
  from:
    - F20260817dr28

status: development
change_type: prompt
tags: [skills, otter-summon, prompt, hard-rule]
modules:
  - .pi/skills/otter-summon/SKILL.md
capability_test: "n/a: prompt 变更，无代码逻辑"
---

# F20260818smhr: otter-summon 增加用户明确要求时必须召唤的硬规则

## 背景

Issue #294：大獭读取了 otter-summon skill，但自行判断「单步可答的事自己做」，跳过了召唤。
用户明确期待并行处理 + 全新审视。

## 目标

- T1: 在触发部分增加硬规则：搭档明确提到多个任务/PR/并行处理时必须召唤
- T2: 在判断示例表格中增加「用户说处理 N 个 PR」行

## 方案设计

1. 触发部分「排除」之后增加硬规则段落
2. 判断示例表格增加「用户说处理 N 个 PR」行

## 验收

- [x] 硬规则在 SKILL.md 中存在
- [x] 判断示例表格新增行正确
