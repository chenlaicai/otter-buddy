---
id: F20260818b2hr
title: adversarial-review-b2-hard-rule
doc_type: feature

summary: |
  修复 issue #292 和 #295：检视獭初次检视时将特性文档缺失降级为可接受。
  在 adversarial-review skill 的 B2 维度增加硬规则：特性文档缺失 = 严重发现，不可降级。

causal_links:
  from:
    - F20260817dr28

status: development
change_type: prompt
tags: [skills, adversarial-review, prompt, b2-hard-rule]
modules:
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
capability_test: "n/a: prompt 变更，无代码逻辑"
---

# F20260818b2hr: adversarial-review B2 维度增加硬规则

## 背景

Issue #292 和 #295：4 只检视獭在初次检视时，全部将 B2（文档完整性）维度中「特性文档缺失」
判断为「可接受」。用户指出后才纠正为严重发现。根因是 skill 规则层面的缺陷。

## 目标

- T1: 在 B2 维度描述中增加硬规则：「特性文档缺失 = 严重发现，不可降级」
- T2: 在 review-dimensions.md 中增加判断标准和检查步骤

## 方案设计

1. SKILL.md B2 表格行增加「特性文档缺失 = 严重发现，不可降级」标注
2. SKILL.md 增加 B2 硬规则独立段落
3. review-dimensions.md 增加判断标准硬规则和检查步骤

## 验收

- [x] B2 硬规则在 SKILL.md 中存在
- [x] review-dimensions.md 中判断标准完整
- [ ] 模拟审视验证修复效果
