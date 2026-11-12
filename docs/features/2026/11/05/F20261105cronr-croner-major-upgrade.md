---
id: F20261105cronr
title: croner 主版本升级 10.0.1 → 11.0.0（2026-11-05 批次）
doc_type: feature

summary: |
  croner 10.0.1 → 11.0.0 主版本升级（Dependabot #1769 信号），按主版本纪律单独 PR。
  项目仅用解析 API（nextRun/previousRuns + timezone）；API 签名兼容，startAt/dayOffset/previousRun 不命中，
  DST gap/overlap 的非上海时区结果按 Vixie 语义变化，已由回归用例锁定。

causal_links:
  from:
    - F20261101depup

change_type: feature-update
tags: [deps, dependencies, upgrade, dependabot, croner, major]
modules:
  - package-lock.json
capability_test: "n/a: 纯依赖升级，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-11-05

intent:
  problem: "croner 10 停留在主版本旧线，Dependabot 发出 11.0.0 升级信号；主版本升级混入常规批会放大回滚粒度与审视盲区"
  expected_effect: "解析 API 签名兼容；DST 时区结果按 v11/Vixie 语义修正并有 gap/overlap 回归覆盖，同时获得 previousRuns 月份通配/闰日修复，对账逻辑（#814 getPrevTime）更稳"
  verify_by:
    type: behavior_check
---

# F20261105cronr: croner 主版本升级 10.0.1 → 11.0.0

## 背景与决策

Dependabot #1769 发出 croner 10.0.1 → 11.0.0 主版本信号。按主版本纪律
（依赖升级自动化任务简报：主版本升级需要单独创建 PR，添加警告标记），
本 PR 独立于同日常规批（F20261112duqgd）。

## v11 破坏性变更对照（官方 release notes 逐条）

项目唯一使用点：`src/frameworks/scheduler/cron-parser.ts`。
API 面：`new Cron(pattern, { timezone })`、`job.nextRun(ref?)`、`job.previousRuns(n, ref?)`。

| v11 破坏性变更 | 项目命中？ | 依据 |
|---|---|---|
| DST 语义对齐 Vixie cron（interval 任务 fall-back 双跑、gap 内固定任务提前） | **是（DST 时区的解析结果）** | nextRun/previousRuns 是调度器 expected/nextTrigger/prevDue 的生产依据；主时区 Asia/Shanghai 无 DST 无感，America/New_York 等 DST 时区按 Vixie 语义修正，新增 gap/overlap 回归用例锁定 |
| `startAt` 变为包含边界 | **无** | 未使用 startAt（cron-parser.ts 全文无此选项） |
| `dayOffset` 相关方法语义修正 | **无** | 未使用 dayOffset |
| `previousRun()`（单数）返回值语义变化 | **无** | 项目用 `previousRuns()`（复数），语义不变 |

对项目有正面意义的修复（v11 Fixed 段）：
- `previousRuns()` 对月份通配模式（`0 9 * 4 *`）/闰日模式（`0 0 29 2 *`）曾抛
  TypeError——#814 对账路径 `getPrevTime` 正是用 `previousRuns(1, ref)`，修复后更稳。
- DST 时区下 nextRun/previousRuns 的多个计算错误修复（项目支持任意 timezone 调度，
  解析结果的正确性修复直接受益）。

残余风险（低，已评估）：
- DST 时区解析结果会与 v10 不同：spring-forward gap 内固定时刻改为 gap 后首个有效时间，
  fall-back interval 模式覆盖重复小时的两个 occurrence；这是上游 v11 明示的 Vixie 语义修正，
  不是 Asia/Shanghai 主场景的行为变化。
- `tests/frameworks/scheduler/cron-parser.test.ts` 新增 America/New_York spring-forward
  `nextRun` 与 fall-back interval `nextRun` 两条回归，固定上游 v11 预期结果。
  `previousRuns/resolveCronSlot` 的 DST 组合未逐一穷举，仍由既有槽位测试与 scheduler 专项回归兜底。

## 验证

- `node scripts/check-sdk-patch.mjs`：✅（worktree 首次 install 需手动 `npx patch-package`，
  与 F20261112duqgd 同现象，非本批引入）
- 调度专项：`tests/frameworks/scheduler/` + `tests/usecases/scheduler/` 全量
  8 文件 / 191 用例全绿 ✅（2026-11-12 rebase 解耦后复测；含新增 DST gap/overlap 2 用例）
- `npm run build` / `npm run lint`：✅ exit 0（pre-commit 链内跑过）
- `npm test` 全量：5663/5668——5 失败与升级无关（generate-guard-replay 时区缺陷 4 +
  rhi-scan-worker 断言 1，未升级主仓同样失败，见 F20261112duqgd 对照实验记录）

## Dependabot PR 处置

#1769 已关闭（关闭评论注明并入本 PR）；分支已清理。
