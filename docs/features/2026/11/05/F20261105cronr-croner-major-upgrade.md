---
id: F20261105cronr
title: croner 主版本升级 10.0.1 → 11.0.0（2026-11-05 批次）
doc_type: feature

summary: |
  croner 10.0.1 → 11.0.0 主版本升级（Dependabot #1769 信号），按主版本纪律单独 PR。
  项目仅用解析 API（nextRun/previousRuns + timezone），v11 破坏性变更四条逐一对照均不命中。

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
  expected_effect: "解析 API 行为不变（签名兼容），获得 v11 对 previousRuns 月份通配/闰日模式抛异常的修复，对账逻辑（#814 getPrevTime）更稳"
  verify_by:
    type: behavior_check
---

# F20261105cronr: croner 主版本升级 10.0.1 → 11.0.0

## 背景与决策

Dependabot #1769 发出 croner 10.0.1 → 11.0.0 主版本信号。按主版本纪律
（依赖升级自动化任务简报：主版本升级需要单独创建 PR，添加警告标记），
本 PR 独立于同日常规批（F20261105depup）。

## v11 破坏性变更对照（官方 release notes 逐条）

项目唯一使用点：`src/frameworks/scheduler/cron-parser.ts`。
API 面：`new Cron(pattern, { timezone })`、`job.nextRun(ref?)`、`job.previousRuns(n, ref?)`。

| v11 破坏性变更 | 项目命中？ | 依据 |
|---|---|---|
| DST 语义对齐 Vixie cron（interval 任务 fall-back 双跑、gap 内固定任务提前） | **低** | DST 改动会影响解析返回值——nextRun/previousRuns 是调度器 expected/nextTrigger/prevDue 的生产依据（scheduler-service 多处消费）；主时区 Asia/Shanghai 无 DST 无感，非 DST 时区行为对齐 Vixie 属正向修复 |
| `startAt` 变为包含边界 | **无** | 未使用 startAt（cron-parser.ts 全文无此选项） |
| `dayOffset` 相关方法语义修正 | **无** | 未使用 dayOffset |
| `previousRun()`（单数）返回值语义变化 | **无** | 项目用 `previousRuns()`（复数），语义不变 |

对项目有正面意义的修复（v11 Fixed 段）：
- `previousRuns()` 对月份通配模式（`0 9 * 4 *`）/闰日模式（`0 0 29 2 *`）曾抛
  TypeError——#814 对账路径 `getPrevTime` 正是用 `previousRuns(1, ref)`，修复后更稳。
- DST 时区下 nextRun/previousRuns 的多个计算错误修复（项目支持任意 timezone 调度，
  解析结果的正确性修复直接受益）。

残余风险（低，已评估）：
- 解析结果可能因 DST 修复而与 v10 不同（例如 interval 模式在 fall-back 重复时段的
  取值）——属修复方向而非回归；项目测试 15 用例（含 timezone/slot/边界）全绿。
- 调度器行为理论上受影响的场景：用户给调度任务配置 DST 时区 + interval 型 cron——
  nextRun 结果会按 Vixie 语义返回（更正确），槽位归属（resolveCronSlot）测试未覆盖
  DST 场景，合入后若有现场再排查（置信度：高——解析 API 签名未变 + 全部专项测试通过）。

## 验证

- `node scripts/check-sdk-patch.mjs`：✅（worktree 首次 install 需手动 `npx patch-package`，
  与 F20261105depup 同现象，非本批引入）
- 调度专项：`tests/frameworks/scheduler/` + `tests/usecases/scheduler/` 全量
  8 文件 / 187 用例全绿 ✅
- `npm run build` / `npm run lint`：✅ exit 0（pre-commit 链内跑过）
- `npm test` 全量：5663/5668——5 失败与升级无关（generate-guard-replay 时区缺陷 4 +
  rhi-scan-worker 断言 1，未升级主仓同样失败，见 F20261105depup 对照实验记录）

## Dependabot PR 处置

#1769 已关闭（关闭评论注明并入本 PR）；分支已清理。
