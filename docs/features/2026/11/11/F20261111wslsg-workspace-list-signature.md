---
id: F20261111wslsg
title: workspace_list 按路径区分循环签名
change_type: fix
status: development
created_at: 2026-11-11
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 确定性工具签名与熔断单测，无 LLM 参与行为"
intent:
  problem: "workspace_list 未接入既有 workspace path 签名，连续列举不同目录被当作同一调用，可能触发 loop_tool_block 误拦"
  expected_effect: "不同 path 连续列举不累计连续同构；同一 path 反复列举仍在超阈值后熔断；缺失或空 path 保持名称兜底"
  verify_by:
    type: behavior_check
causal_links:
  - F20261102sgtrc
  - F20261110wdsgn
summary: 收口 #1767 补充清点中最后未接入实体签名的 workspace_list，复用 workspace path 行为签名并保留同目标循环保护。
---

# workspace_list 按路径区分循环签名

## 问题与范围

#1767 主问题 `workspace_delete` 已由 #1826 修复，补充评论中的 `workspace_read/write`、`write`、`create_linked_resource` 也已有实体签名与回归。逐项回读当前 main 后，剩余缺口只有 `workspace_list`：它仍退化为纯工具名，连续列举不同 path 会共享连续同构计数。

本修复仅将 `workspace_list` 接入既有 workspace path 签名，不重复修改已合入工具，不改变熔断阈值、工作区访问边界或实际列举语义。

## 修复契约

- `workspace_list(path)` 签名为 `workspace_list: <path>`，不同目录不共享连续同构计数。
- 同一 path 反复列举仍使用同一签名，超过既有阈值后 steer。
- path 缺失、为空或不是字符串时保持 `workspace_list` 名称兜底，避免异常调用绕过保护。
- 复用统一签名长度 cap；不新增工具豁免或批量接口。

## Acceptance Test

| 场景 | 权威证据 | 状态 |
|---|---|---|
| 7 个不同 path 连续列举 | 全部 allow | ✅ |
| 同一 path 连续列举 | 前 5 次 allow，第 6 次 steer | ✅ |
| 缺失或空 path | 退化为工具名，保留保护 | ✅ |
| 既有签名与熔断行为 | 目标文件 62/62；agent+guard 55 文件 732/732；全量 457 文件 5871/5871 | ✅ |

## 验证记录

- 红测先行：新增不同 path 用例在修复前得到 `workspace_list`，与期望 `workspace_list: review-a` 不符；同 path 控制组在旧实现下仍能触发熔断。
- 修复后：`tool-call-circuit-breaker.test.ts` **62/62**；相关 `tests/frameworks/agent` + `tests/guard` **55 文件、732/732**；全量 **457 文件、5871/5871**。
- `npm run build`、`npx tsc --noEmit`、目标 ESLint、`lint:docs`、`lint:intent`（仅存量 warning）、`lint:tests`、`lint:criteria`、`lint:evidence-anchors` 与 `git diff --check` 全绿。
