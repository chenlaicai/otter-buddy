---
id: F20260914prdb
title: PR 标题日期校验基准注入：消灭「PR 放着越久越超窗」的时间漂移误伤
summary: CI 的 PR 标题特性 ID 日期校验以「校验运行时的当前时间」为基准，旧 PR 天然随时间漂移越窗（#789 创建于 9-04、ID 20260904 正确，9-14 复跑 CI 时偏差 10 天被拦）。校验意图是「发起时日期写对没有」，不是「PR 多久内必须合完」。本特性给 scripts/validate-commit-date.mjs CLI 加 --at <ISO> 基准注入，CI 改传 github.event.pull_request.created_at。
change_type: fix
capability_test: "n/a: CI 工作流与 CLI 脚本改动，验证走 tests/scripts/validate-commit-date.test.ts（27 用例，含 --at 新用例 + #789 现场复现）"
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
tags: [ci, date-validation, time-drift, pr-gate]
modules: [scripts/validate-commit-date.mjs, .github/workflows/ci.yml, tests/scripts/validate-commit-date.test.ts]
---

## 背景

处理 7 个遗留 PR（#789/#846/#849/#850/#853/#887/#903）时发现 #789 merge main 后 CI 仍挂：

```
❌ 错误：特性 ID 日期与系统日期不符（偏差 10 天）。
  ID 日期: 20260904  系统日期: 20260914
```

#789 创建于 2026-09-04，标题 `[F20260904wxeg]...` 的日期是**正确的**（发起时如实标注）。挂是因为校验以运行时当前时间为基准——PR 放 10 天后再跑 CI，必然超 ±7 窗。

历史脉络：
- F20260825dva2 建立该校验（防 #422「凭印象标日期」），单一实现 `scripts/validate-commit-date.mjs`，commit-msg 钩子与 CI 复用
- F20260913ctlv 把 ±2 放宽到 ±7（理由：长周期特性 PR 撞闸是设计盲区）——但放宽只是推迟撞墙时间，时间漂移的结构性误伤未根治

本 PR 根治：校验基准从「当前时间」改为「PR 创建时间」。

## 方案设计

1. **CLI 加 `--at <ISO>` 参数**：注入基准时间。参数校验 fail-closed（缺参数/非法 ISO → exit 1 + 明确报错）。剥离后剩余位置参数逻辑不变（argv[0] 或 stdin）。
2. **CI 改传 `github.event.pull_request.created_at`**：PR 标题校验步骤注入 `PR_CREATED_AT` 环境变量，调用改为 `node scripts/validate-commit-date.mjs --at "$PR_CREATED_AT"`。
3. **commit-msg 钩子不受影响**：钩子场景没有「PR 创建时间」概念，继续用当前时间（提交时刻即「发起时刻」，语义本来就对）。

## 取舍

- 不改 ±7 窗口宽度：窗口本身没错，错的是基准漂移。改基准后窗口语义回归本意（发起时 ±7 天内标注）。
- 不给 created_at 做专门 fallback：GitHub `pull_request.created_at` 在 pull_request 事件中恒存在；步骤已有 `if: github.event_name == 'pull_request'` 门控。
- 模块层 `validateCommitDate(firstLine, now)` 签名不动：now 注入点早就有（测试用），本次只是 CLI 层暴露它。

## 验证

- `tests/scripts/validate-commit-date.test.ts` 27/27 通过（22 旧 + 5 新；新用例含 #789 现场复现：--at 传创建时间 → 10 天前 ID 通过；发起时就写错 10 天 → 仍拦）
- 手工 CLI 验证：`--at "2026-09-04T03:56:11Z" "[F20260904wxeg]..."` → exit 0；`--at` + 错 10 天 ID → exit 1 偏差报错
- tsc 不涉及（.mjs + yml）

## 影响

- 立即解锁 #789（CI 重跑即绿）
- #846/#849/#850/#853（9-08 创建）后天起陆续撞墙——本 PR 合入后全部免疫
- 未来所有长周期 PR 不再因「放久了」被日期校验误伤

## 后续

无。若后续想对「PR 存活时长」设独立治理（如超 14 天提醒），应走独立机制（如 auto-close 已有的存活期逻辑），不要复用日期校验。
