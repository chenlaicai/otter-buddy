---
id: F20260928vitt
title: vitest 5 主版本升级（从 Dependabot PR #1143/#871 收编）
doc_type: feature
summary: |
  收编 Dependabot PR #1143（vitest 4.1.11 → 5.0.1）的主版本升级。
  9/24 依赖升级任务遗留半成品（worktree 已装依赖未提交），因 kimi 模型 429 断档搁置至 9/28。
  基线 fast-forward 至最新 main（9043c331，含时间炸弹修复 #1165）后全量测试 3993/3993 通过。
  PR 标题带 [v5] 警告标记（主版本升级规范）。
created: 2026-09-28
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [deps, testing]
---

# vitest 5 主版本升级

## 背景

- Dependabot PR #1143（4.1.11 → 5.0.1）与 #871（4.1.11 → 5.0.0）按「仅 Dependabot 集中处理」决策（搭档 2026-08-25，PR #419 关闭评论）收编
- 9/24 依赖升级任务（F20260924deps）规划了本单独 PR（主版本单独开），worktree 装完依赖即遇 kimi 429 断档，未提交未建 PR
- 9/28 每日 issue 处理扫尾时发现，续完交付

## 改动范围

| 文件 | 改动 |
|------|------|
| package.json | vitest ^4.1.11 → ^5.0.1 |
| package-lock.json | 锁文件同步 |

## 验证

- 基线：origin/main @ 9043c331（fast-forward，包文件与基线无冲突）
- `npx vitest run`：**284 files / 3993 tests 全通过**
- 首轮基线（9/23 旧基线）曾有 1 例失败（rhi-api trends 日期序列），确认为时间炸弹测试残留（主修复 #1165 已合入 main），基线追平后消失——非 vitest 5 引入的回归

## 风险与取舍

- 主版本升级：v5 相对 v4 的 breaking changes 未逐条核验，以全量测试通过为验收锚点
- CI 上 e2e/golden-selftest 将在 PR 上跑双保险

## 后续动作

- PR 创建后走对抗审视（worktree-isolation 小改动路径：简化审视 B1-B4 + 搭档终审）
