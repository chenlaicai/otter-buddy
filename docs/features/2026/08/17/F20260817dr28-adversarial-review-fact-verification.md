---
id: F20260817dr28
title: adversarial-review-fact-verification
doc_type: feature

summary: |
  修复 issue #258：检视獭基于错误的 schema 信息做出错误判断，没有实际查证数据库
  schema。在 adversarial-review 工作流中新增步骤 4「事实验证」，要求对涉及硬事实
  的判断先读取源文件验证。

causal_links:
  from:
    - F20260813dr28

status: development
change_type: prompt
tags: [skills, adversarial-review, prompt, fact-verification]
modules:
  - .pi/skills/adversarial-review/SKILL.md
capability_test: "n/a: prompt 变更，无代码逻辑"
---

# F20260817dr28: adversarial-review 增加事实验证步骤

## 背景

Issue #258：检视獭在对抗审视中，基于错误的 schema 信息做出了错误判断（声称 task_id
是普通字段，实际定义了 ON DELETE CASCADE 外键约束）。暴露了审视流程缺乏「验证事实」步骤。

## 目标

- T1: 在 adversarial-review 工作流中新增「事实验证」步骤
- T2: 对于涉及 schema/API/接口的判断，先读取相关源文件验证，不凭假设下结论

## 方案设计

在步骤 3（逐维度检查）的焦点维度块之后、步骤 5（独立核实）之前插入新步骤 4「事实验证」：
- 对于涉及数据库 schema、API 接口、配置约束等硬事实的判断，先读取源文件验证
- 审查报告中区分「已验证的事实」和「基于假设的推断」
- 对于 schema 相关的发现，强制附上 schema 文件的引用（file:line）
- 后续步骤编号顺延（原 4-5 → 5-6）

## 验收

- [x] 步骤编号 1-6 连续
- [x] 步骤 4 位于焦点维度块之后（不打断步骤 3 结构）
- [x] CI 通过
- [x] 对抗审视 delta 复核通过
