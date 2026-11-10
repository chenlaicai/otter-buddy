---
id: F20261110rvded
title: 回查清单排除已通过 issue
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 调度清单生成与 gh 边界修复，无 LLM 参与行为"
intent:
  problem: "regression-verify 只按到期日筛选 closed issue，不读取已有回查评论，已 pass 条目每天重复进入清单并挤占每日回查额度"
  expected_effect: "生成清单前排除带本 issue verdict=pass 标记的评论；未回查、fail、unknown 与无 verdict 条目保留，评论查询失败返回 GH_FAILED"
  verify_by:
    type: behavior_check
causal_links:
  - F20260917rgsv
  - F20260929svfy
summary: regression-verify 对到期 issue 查询评论 marker，排除已通过项并显示排除数；外部查询失败 fail-closed，避免将未知状态误当未回查。
---

# 回查清单排除已通过 issue

## 问题

#1779 实测 16 条到期清单中 11 条是近三日已回查且 pass 的旧项。根因已核实：`buildRegressionVerifyBody` 只调用 `gh issue list` 取 body/closedAt，没有读取评论里的 `regression-verify` 结果。

## 修复契约

- 对到期 issue 顺序查询 `gh issue view <N> --json comments`；在每个完整 marker 内绑定解析 issue 与 verdict，同一 issue 以最后一个明确 verdict 为准，仅最新为 `pass` 时排除。
- 未回查、marker 属于其他 issue、无 verdict、`fail` 或 `unknown` 均保留：失败/无法判定不等于完成，不应被永久静默。
- 任一评论查询失败返回既有 `GH_FAILED`，由调用方记录告警并跳过本轮；不得把查询失败误当未回查后继续推送。
- gh runner 可显式注入以做 hermetic 测试，生产默认仍走真实 execFile；顺序执行避免最多 100 个到期项形成无界子进程并发。
- 清单标题显示待回查数与已排除数；无待回查项返回 null，沿用既有 skip/heartbeat。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 本 issue pass | 从清单排除 | ✅ |
| 无评论 / 他 issue marker / 无 verdict | 保留在清单 | ✅ |
| fail / unknown | 保留，允许后续再次回查 | ✅ |
| 评论查询失败 | 返回 GH_FAILED，不生成清单 | ✅ |
| 既有行为与静态闸 | scheduler 回归、tsc、ESLint、build、docs/intent/tests lint | ✅ |

## 验证记录

- 测试先行：新增两例修复前均红（pass 项仍入清单、评论失败未返回 GH_FAILED）。
- 修复后 scheduler 聚焦 2 文件 **124/124** 通过。
- `npx tsc --noEmit`、`npm run build`、相关 ESLint、`lint:docs`、`lint:intent`、`lint:tests` 通过；intent 仅有存量 warning。
- 真 LLM 不适用。

## 独立审查

检视獭-1779 r1 打回三项（marker/verdict 错配、动态 mock 穿透、gh 无界并发），已全部修复。r2 delta **通过**：混合 marker、marker 外 pass、最新 verdict、精确 9 次调用与 maxActive=1 均有回归；独立真实 execFile + fake gh 探针 7/7，scheduler 聚焦 124/124、tsc 全绿。
