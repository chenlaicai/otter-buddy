---
id: F20260824n38v
title: a1-investigation-methodology-issue-handling
summary: |
  针对 claim-before-verify 模式问题，对 SYSTEM.md 进行三处改进：A1 调查方法论、A2 能力边界确认、R2 issue 处理规范。
change_type: prompt
tags:
  - a1-execution
  - claim-before-verify
  - investigation-methodology
  - issue-handling
modules:
  - .pi/SYSTEM.md
status: active
capability_test: "n/a: 纯 prompt 改进，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# F202608241659: 强化 A1 调查方法论 + issue 处理规范

## 概述

针对 issue #352 中大獭 claim-before-verify 模式问题，对 SYSTEM.md 进行三处改进。

## 背景

**问题来源**：[daily-review] 2026-08-20 大獭 claim-before-verify 模式：先下结论再核实，被用户逐条纠正

**问题根因**：
1. 先做断言再找数据验证，而不是先收集数据再得出结论
2. 过早宣布结论
3. 错误声明能力边界
4. 处理方案草率

## 改进内容

### 1. A1 执行强化

在 A1 中补充「先收集数据再归纳结论，不先推测再找数据佐证」——明确调查方法论：先查事实（工具调用、memory、self-healing events），再从数据中归纳结论；禁止先推测一个"合理的故事"再找数据佐证。

### 2. 能力边界确认

在 A2 中补充能力边界确认的指导：不确定自己的能力边界时先测试再声明，不凭印象断言。例如：声称"无法跨对话查询"前，先测试 memory、healing events、list_messages 等工具是否覆盖需求。

### 3. Issue 处理规范

在 R2 中补充 issue 处理规范：每个 daily-review issue 必须有具体修复方案（代码/配置/prompt/流程），不能只写「留评论跟踪」。修复方案可以是 Prompt 层（修改引导语）或代码层（增加检查逻辑），但不能是「分析类不需要PR」。

## 影响范围

- 仅修改 `.pi/SYSTEM.md`，影响全局行为规范
- 不涉及代码逻辑变更
- 对所有 Otter 的行为有指导意义

## 验证方式

- 人工审阅 SYSTEM.md 的修改内容
- 后续 daily-review issue 处理时验证是否遵循新规范

## 关联 Issue

- #352: [daily-review] 2026-08-20 大獭 claim-before-verify 模式：先下结论再核实，被用户逐条纠正
- #338: [daily-review] 小獭输出退化：单条消息中重复输出相同内容 + 11 个 self-healing 事件（已修复）

## 决策记录

- 2026-08-21: 创建特性文档，记录 SYSTEM.md 改进内容
