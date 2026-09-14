---
id: F20260914prdb
title: PR 标题日期校验基准注入：消灭「PR 放着越久越超窗」的时间漂移误伤
summary: 日期校验体系适配 squash 模型的特性编号规则（搭档决策 2026-09-14）：PR 标题即 main 历史、特性文档 ID 必须与 PR 标题 ID 统一、定稿时改名为合入当天日期。配套：CLI 双基准（PR 创建时间 + 当前时间任一通过）、CI 加 edited 触发（改名后重验标题）、commit-msg 钩子偏差降级警告（bad_date 仍硬拦）。
change_type: fix
capability_test: "n/a: CI 工作流与 CLI 脚本改动，验证走 tests/scripts/validate-commit-date.test.ts（27 用例，含 --at 新用例 + #789 现场复现）"
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
tags: [ci, date-validation, time-drift, pr-gate]
modules: [scripts/validate-commit-date.mjs, .github/workflows/ci.yml, tests/scripts/validate-commit-date.test.ts]
---

## 背景

处理 7 个遗留 PR（#789/#846/#849/#850/#853/#887/#903）时发现 #789 merge main 后 CI 仍挂（创建 9-04、ID 标注正确，9-14 复跑偏差 10 天被拦）。首轮修复（--at 注入 PR 创建时间）呈终审时，搭档点破根本模型：

> squash 合入模型下，PR 标题就是 main 历史；特性文档会被记忆系统引入，同样重要；PR 内中间 commit 标题会被抹掉，不重要。**PR 标题 ID 和特性文档 ID 必须统一**，且应按合入当天日期更新，否则 commit 历史时间线乱。

由此规则定型：**创建 PR 用创建日 ID → 审视闭环后定稿，统一改名（PR 标题 + 文档文件名 + frontmatter）为合入当天日期 → squash 合入**。日期校验体系需三处配套，否则新规则被自己的校验拦住。

历史脉络：F20260825dva2 建立校验（防 #422 凭印象标日期）；F20260913ctlv ±2→±7 放宽只是推迟撞墙；本特性根治基准漂移。

## 方案设计（定稿改名模型三配套）

1. **CLI 双基准**：`--at <ISO>` 存在时，创建基准与当前基准任一在 ±7 内即过（bad_date 任一命中即拦）。创建日 ID 靠创建基准过、合入日改名靠当前基准过——PR 全生命周期畅通。
2. **CI 加 edited 触发**：`on.pull_request.types: [opened, synchronize, reopened, edited]`——PR 改名后标题校验重跑，否则 checks 停留在旧标题结果，新标题从未被验过（现存 bug，不只新规则场景）。
3. **钩子降级**：commit-msg 钩子改用 `--warn-on-drift`——中间 commit 标题会被 squash 抹掉，偏差阻断是纯摩擦（#789 处置被误拦实证）；bad_date（非法日期笔误）仍硬拦。

规则本身（创建日→定稿改名合入日、PR 标题 ID ≡ 文档 ID）成文在 commit-convention.md / docs/README.md，从 #789 起实践。

## 取舍

- 窗口宽度 ±7 不动：窗口没错，错的是基准单一。双基准下窗口覆盖 PR 全生命周期两端。
- 钩子偏差降警告而非删除校验：bad_date 仍拦「凭印象编日期」的笔误（#422 初衷），只放行跨天续特性的合法漂移。
- 不给 created_at 做 fallback：pull_request 事件中恒存在，步骤已有事件门控。
- 模块层 `validateCommitDate(firstLine, now)` 签名不动，双基准逻辑在 CLI 层组合。

## 验证

- `tests/scripts/validate-commit-date.test.ts` 32/32（27 旧 + 5 新：双基准改名/旧ID/双挂、warn 偏差降级、warn bad_date 仍拦；runCLI 换 spawnSync 使成功路径可断言 stderr）
- 手工 CLI 六场景验证全符合预期（改名/旧ID exit 0、双挂 exit 1、warn 偏差 exit 0、warn 非法 exit 1）
- tsc 不涉及（.mjs + yml + sh）

## 影响

- #789 定稿改名（F20260904wxeg → F20260914wxeg）畅通无阻，成为新规则首个实践
- #846/#849/#850/#853（创建日逼近窗口边界）全部免疫
- 未来长周期 PR 不再因「放久了」或「定稿改名」被拦

## 后续

- 规则成文：commit-convention.md / docs/README.md 补「定稿改名」章节（随 #789 实践时一并落地，本 PR 只改校验体系）
- #789 是新规则首个实践：合入前改名，验证双基准 + edited 触发全链路
