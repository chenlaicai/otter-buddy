---
id: F20260928vitt
title: vitest 5 主版本升级（从 Dependabot PR #1143/#871 收编）
doc_type: feature
summary: |
  收编 Dependabot PR #1143（vitest 4.1.11 → 5.0.1）的主版本升级。
  9/24 依赖升级任务遗留半成品（worktree 已装依赖未提交），因 kimi 模型 429 断档搁置至 9/28。
  基线 fast-forward 至最新 main（9043c331，含时间炸弹修复 #1165）后全量测试 3993/3993 通过。
  检视獭（mimo-pro）对抗审视 0 严重/3 建议；建议②「v5 值域已改 skipped」被探针实验证伪，
  建议③ engines.node>=22.12 采纳，建议①②以注释足印+类型收紧保守处置。
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

| 文件 | 改确 | 说明 |
|------|------|------|
| package.json | vitest ^4.1.11 → ^5.0.1；新增 engines.node >=22.12 | engines 为检视建议③采纳 |
| package-lock.json | 锁文件同步 | |
| tests/capability/helpers/skip-reporter.ts | 注释更新（vitest 4/5 双版本探查说明 + 实验锚点足印） | 检视建议①②处置 |

## 对抗审视（检视獭 mimo-pro，2026-09-28）

- **B1-B4 全过**：lockfile 精确 5.0.1 无残留、`npm install --dry-run` 零漂移、[v5] 警告标记合规；独立复核 degenerate-detector 23/23；F 文档三处一致
- **焦点维度**：config API / CLI / programmatic 全过；skip-reporter v5.0.1 vs v4.1.11 版本对照实验行为一致，无回归
- **建议处置**：
  - ③ `engines.node`（vitest 5 要求 Node ≥22.12，当前 CI node 22/本地 24 满足，旧环境会炸）→ **采纳**，补入 package.json
  - ① `task?.mode` 依赖运行时私有表面（公开类型是 options.mode）→ **部分采纳**：保留运行时探查（探针实验证明 v5.0.1 实际有效），加防御性注释足印 + 类型收紧说明，v6 升级时按足印复核
  - ② `state === "skip"` 是死代码（声称 v5 值域已改 "skipped"）→ **证伪不采纳**：d.ts 实查 RunMode = "run"|"skip"|"only"|"todo"|"queued"（config.d.CU_b-wJj.d.ts:2286），且探针实验（2 skip 用例均被正确计数）证明该分支有效
- **结论**：0 严重 / 3 建议，comment 留痕于 PR #1180

## 验证

- 基线：origin/main @ 9043c331（fast-forward，包文件与基线无冲突）
- `npx vitest run`：**284 files / 3993 tests 全通过**
- 首轮基线（9/23 旧基线）曾有 1 例失败（rhi-api trends 日期序列），确认为时间炸弹测试残留（主修复 #1165 已合入 main），基线追平后消失——非 vitest 5 引入的回归
- capability 套件（vitest.capability.config.ts，独立 config）：skip-reporter 在 v5 下正常触发（「未配置 LLM → 全部 skip + 原因输出」天然探针场景验证）

## 风险与取舍

- 主版本升级：v5 相对 v4 的 breaking changes 未逐条核验，以全量测试通过 + 检视独立复核为验收锚点
- skip-reporter 的 `.task` 私有表面依赖：接受（v5 实测有效 + 注释足印），v6 升级时复核
- CI 上 e2e/golden-selftest 已跑双保险全绿（run 36366824415）

## 后续动作

- PR #1180 呈搭档终审（等待检视獭 delta 复核通过后）
- 合入顺序：#1155 先合（同为包文件改动，后合者需 rebase）
