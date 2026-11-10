---
id: F20261110wdsgn
title: workspace_delete 按路径区分循环签名
change_type: fix
status: development
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 确定性工具签名与熔断单测，无 LLM 参与行为"
intent:
  problem: "workspace_delete 未接入既有 workspace path 签名，连续清理不同路径被当作同一调用，第 7 次触发 loop_tool_block 误拦"
  expected_effect: "不同 path 连续删除不累计连续同构；同一 path 无论 recursive 取值仍使用同一签名并在超阈值后熔断；缺失 path 保持名称兜底"
  verify_by:
    type: behavior_check
causal_links:
  - F20261102sgtrc
summary: 按搭档选定方案1，将 workspace_delete 纳入现有 workspace path 行为签名，保留同目标重复调用的循环保护。
---

# workspace_delete 按路径区分循环签名

## 问题与决策

#1802 实证：每日体检对话连续调用 `workspace_delete` 清理不同 path，第 7 次被 `Consecutive identical call` 拦截，最终改走 bash 收尾。根因是该工具未接入 #1399 已有的 workspace 行为签名，所有调用退化为工具名。

2026-11-10 搭档在完整背景说明后确认「按你推荐来」，选定方案 1：签名包含 path；不豁免清理工具，不改变熔断阈值。

## 修复契约

- `workspace_delete(path)` 签名为 `workspace_delete: <path>`，不同目标不共享连续同构计数。
- `recursive` 是删除方式而非目标标识：同一 path 无论 recursive 为何值，都归入同一签名；同目标反复调用超过既有阈值仍 steer。
- path 缺失或为空时保持 `workspace_delete` 名称兜底，避免无参调用绕过保护。
- 复用 #1399 的 workspace 分发与统一长度 cap；不修改实际删除语义、权限边界或生产数据。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 7 个不同 path 连续删除 | 全部 allow | ✅ |
| 同一 path 连续删除 | 前 5 次 allow，第 6 次 steer | ✅ |
| recursive 参数变化 | 同 path 签名保持一致 | ✅ |
| 缺失 path | 退化为工具名，保留保护 | ✅ |
| 既有签名与熔断行为 | 目标文件 60/60，agent+guard 55 文件 730/730 | ✅ |

## 验证记录

- 红测先行：新增不同 path 用例在修复前得到 `workspace_delete`，与期望 `workspace_delete: review-1782` 不符；同 path 控制组在旧实现下仍能触发熔断。
- 修复后：`tool-call-circuit-breaker.test.ts` **60/60**；相关 `tests/frameworks/agent` + `tests/guard` **55 文件、730/730** 全绿。
- `npm run build`、`npx tsc --noEmit`、目标 ESLint、`lint:docs`、`lint:intent`（仅存量 warning）、`lint:tests`、`git diff --check` 全绿。

## 独立审查

待独立检视。
