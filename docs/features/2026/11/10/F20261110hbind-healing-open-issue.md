---
id: F20261110hbind
title: healing 批量归口仅允许开放 issue
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 工具入口与 GitHub 外部边界修复，无 LLM 参与行为"
intent:
  problem: "manage_healing_events batch_bind 未查询目标 issue 状态，可向 CLOSED、不存在或状态不可核实的目标写入归口"
  expected_effect: "真实写入前复用 checkOpenIssue，非 OPEN 与查询失败均拒绝且事件不变；OPEN 正常归口，dryRun 只做本地预览且不调用外部边界"
  verify_by:
    type: behavior_check
causal_links:
  - F20261105bndst
  - F20261008hbbd
summary: healing batch_bind 注入并复用 RHI 的 checkOpenIssue 外部状态闸，CLOSED/不存在/查询失败零写入，OPEN 与 dryRun 保持既定语义，工具契约同步更新。
---

# healing 批量归口仅允许开放 issue

## 问题

PR #1785 已为 RHI 归口接入 `checkOpenIssue`，但 healing `batch_bind` 仍直接写 `bound_issue`。归口到已关闭或不存在的 issue 会让后续收尾与提醒落点失真。

## 修复契约

- `createManageHealingEventsTool` 接受可注入的 `CheckIssueBinding`，生产默认复用 `checkOpenIssue`。
- 真实 `batch_bind` 在 repository 写入前查询目标状态；CLOSED、不存在、gh 查询失败均返回错误且不改变事件。
- dryRun 保持本地预览，不调用 gh、不写库；OPEN 目标沿用既有批量归口与 bind≠resolve 语义。
- 工具 description 和 issueNumber 参数说明同步为「仅 OPEN」；SQLite repository 与状态机不变。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| CLOSED / 不存在 / 查询失败 | 真实工具 + SQLite 返回错误，事件 status/boundIssue/boundAt 不变 | ✅ |
| OPEN | 归口成功，boundIssue 写入且事件仍 open | ✅ |
| dryRun | 返回 matched，不调用状态检查、不写库 | ✅ |
| 真实 gh 边界 | 既有 checkOpenIssue 的 OPEN/CLOSED/MERGED/UNKNOWN/失败/畸形输出回归 | ✅ |
| 既有行为与静态闸 | 聚焦测试、tsc、ESLint、build、docs/intent/tests lint | ✅ |

## 验证记录

- 测试先行：新增 4 例在修复前全部红（三种非法目标仍成功，OPEN 路径未调用状态检查）。
- 修复后聚焦 4 文件 **30/30** 通过，含真实 gh 外部边界 7 例。
- `npx tsc --noEmit`、`npm run build`、相关 ESLint、`lint:docs`、`lint:intent`、`lint:tests` 通过；intent 仅有存量 warning。
- 真 LLM 不适用。

## 独立审查

检视獭-1786 r1 **通过**，无打回项。独立探针使用生产默认装配（不注入检查器）验证 CLOSED/查询失败拒绝与 SQLite `total_changes()` 零写入，dryRun 不触外部命令；聚焦回归 34/34、默认装配探针 5/5、tsc 全绿。
