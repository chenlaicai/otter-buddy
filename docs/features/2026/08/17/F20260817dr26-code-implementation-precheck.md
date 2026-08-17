---
id: F20260817dr26
title: code-implementation-precheck
doc_type: feature

summary: |
  修复 issue #256：大獭修改工具权限白名单时先改了代码才发现测试冲突。在
  code-implementation 工作流中新增步骤 3「预检查」，要求动手实现前先检查相关
  测试断言和设计意图，识别潜在冲突。

causal_links:
  from:
    - F20260813dr26

status: development
change_type: prompt
tags: [skills, code-implementation, prompt, precheck]
modules:
  - .pi/skills/code-implementation/SKILL.md
capability_test: "n/a: prompt 变更，无代码逻辑"
---

# F20260817dr26: code-implementation 增加预检查步骤

## 背景

Issue #256：大獭在修改工具权限白名单时，先做了代码改动，然后才发现现有测试与改动冲突。
应该在动手前先检查相关测试和设计意图。

## 目标

- T1: 在 code-implementation 工作流中新增「预检查」步骤
- T2: 要求动手实现前先检查测试断言和设计意图，识别权限白名单、配置约束等易冲突区域

## 方案设计

在步骤 2（确认理解）之后、步骤 3（实现）之前插入新步骤 3「预检查」：
- 用 `grep` 扫描测试文件中的 `expect`/`not.toContain` 断言
- 识别潜在冲突（如权限白名单、配置约束、接口契约）
- 发现冲突时自行分析设计意图并给出建议方案，不把问题抛给用户
- 后续步骤编号顺延（原 3-9 → 4-10），参考索引同步更新

## 验收

- [x] 步骤编号 1-10 连续
- [x] 参考索引步骤引用正确（6/6 项匹配）
- [x] CI 通过
- [x] 对抗审视 delta 复核通过
