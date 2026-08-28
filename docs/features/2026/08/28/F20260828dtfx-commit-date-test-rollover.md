---
id: F20260828dtfx
title: "测试日期滚动缺陷修复：validate-commit-date 集成用例动态生成日期"
summary: "CLI 集成测试硬编码 F20260825/F20260818 日期，8/28 起偏差超 ±2 天容忍必然失败，阻塞全仓所有分支 CI。改为运行时动态生成今天/3 天前日期，测试永不随时间衰减"
change_type: fix
created_in_conversation: "7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d"
status: development
capability_test: "tests/scripts/validate-commit-date.test.ts（21/21 绿）"
tags: [test, ci, commit-convention]
from:
  - F20260825dva2
---

# 测试日期滚动缺陷修复

## 背景

8/28 在 PR #537（纸面交易 PR4）本地验证时发现 1 个测试失败。排查确认：与 PR 内容无关，是 main 上 `tests/scripts/validate-commit-date.test.ts` 的 CLI 集成用例硬编码了 `F20260825abcd`（valid 用例）和 `F20260818abcd`（reject 用例）。`validate-commit-date.mjs` 按系统当前日期判定 ±2 天容忍，8/28 起 valid 用例偏差 3 天必然失败——**阻塞全仓所有分支的 CI**（CI 跑 `npm test`）。

## 根因

集成用例（runCLI 走真实脚本、真实系统日期）用了和单元用例（显式传 `now` 参数）相同的硬编码日期写法。单元用例传参所以稳定；集成用例没传参入口，日期滚动即衰减。这正是 #422「禁止凭印象标日期」教训的测试层变体：**任何依赖「当前日期」的测试，日期来源必须是运行时动态生成或注入，不能硬编码**。

## 修复

集成用例改为运行时动态生成：
- valid 用例：`F${今天}abcd`（偏差 0 天）
- reject 用例：`F${3天前}abcd`（偏差 3 天 > ±2 容忍）
- 时区说明：本地时区近似即可，±2 天容忍下 UTC/Shanghai 差 1 天不影响结论

## 验证

- `npx vitest run tests/scripts/validate-commit-date.test.ts` → 21/21 绿（2026-08-28 实跑，即缺陷触发日）
- 未动单元用例（显式传 now，本就稳定）

## 影响

纯测试修复，无生产代码变更。解除全仓 CI 日期炸弹（该测试自 8/28 起会让所有含 npm test 的 CI 必挂）。
