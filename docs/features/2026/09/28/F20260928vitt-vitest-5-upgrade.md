---
id: F20260928vitt
title: vitest 5 主版本升级（从 Dependabot PR #1143/#871 收编）
doc_type: feature
summary: |
  收编 Dependabot PR #1143（vitest 4.1.11 → 5.0.1）的主版本升级。
  9/24 依赖升级任务遗留半成品（worktree 已装依赖未提交），因 kimi 模型 429 断档搁置至 9/28。
  基线 fast-forward 至最新 main（9043c331，含时间炸弹修复 #1165）后全量测试 3993/3993 通过。
  检视獭（mimo-pro）对抗审视两轮：首轮 0 严重/3 建议；大獭首轮误判建议②（字段错位：RunMode vs result().state），
  delta-2 全域探针实锤维持原判——state 值域无 "skip"，旧分支是死代码。已按 patch 修复（skipped+todo 排除、
  options.mode 公开回退链、engines 对齐官方），并新增计数语义固化测试 12 用例。
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
| package.json | vitest ^4.1.11 → ^5.0.1；新增 engines.node（^22.12.0||^24.0.0||>=26.0.0，与 vitest 官方一致） | 检视建议③采纳 + delta-2 对齐 |
| package-lock.json | 锁文件同步 | |
| tests/capability/helpers/skip-reporter.ts | 计数修复：state === "skipped" && mode !== "todo"（旧 === "skip" 是死分支）；回退链改 task?.mode ?? options?.mode；注释含全域探针实测语义 | delta-2 处置 |
| tests/capability/skip-reporter.capability.test.ts | 新增：计数语义固化测试（5 类用例探针表 + v6 回退安全网 + 死分支哨兵，12 用例） | delta-2 处置 |

## 对抗审视（检视獭 mimo-pro，2026-09-28，两轮）

- **B1-B4 全过**：lockfile 精确 5.0.1 无残留、`npm install --dry-run` 零漂移、[v5] 警告标记合规；独立复核 degenerate-detector 23/23；F 文档三处一致
- **焦点维度**：config API / CLI / programmatic 全过；skip-reporter v5.0.1 vs v4.1.11 版本对照实验行为一致，无回归
- **首轮处置 → delta-2 复核（维持原判 + 撒回部分）：**
  - ③ engines.node —— 采纳；delta-2 对齐 vitest 官方值域 `^22.12.0||^24.0.0||>=26.0.0`（首轮 >=22.12 会放行 23.x/25.x 非支持版）
  - ② state === "skip" 死代码 —— 首轮误判为证伪（用 RunMode 类型反驳，实为字段错位：state 比较的是 result().state，类型 `readonly state: "skipped"`，plugin.d.CN87HSxv.d.ts:350），delta-2 全域探针实锤维持原判。**已修**：`state === "skipped" && mode !== "todo"`（todo 的 state 同为 skipped 须排除）；首轮「2 skip 正确计数」归因错误（计数由 task?.mode 路径完成）
  - ① task?.mode 私有表面 —— 检视獭撒回原建议（ctx.skip() 的 options.mode="run"，换公开字段反而漏计）；保留运行时探查正确。**已修**：回退链 task?.mode ?? options?.mode（旧回退 testCase.mode 是 5/5 不存在字段，空网）；注释改真实语义；固化测试覆盖 v6 回退场景
  - 幻影锚点（注释引用已删除的探针文件）—— 已修：探针表固化为常驻测试 skip-reporter.capability.test.ts（12 用例）
- **结论**：首轮 0 严重/3 建议 → delta-2 维持「需修改」→ 已按 patch 修复；真探针验证计数行为不变（2 skip + 1 todo + 1 normal → 计 2）

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
