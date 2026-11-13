---
id: F20261113grplb
title: 固化 2026-11-12 守卫实录 4 条（BLOCK 4）
summary: 将 11-12 UTC 的 3 条下载管道解释器与 1 条 SSH config 读取实录按 BLOCK 固化，回放断言拦截类别，不改守卫实现。
change_type: feature-update
created_at: 2026-11-13
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
doc_type: feature
tags: [guard, replay, regression-pin, daily-health-check]
modules:
  - tests/guard/replay/cases-2026-10-29.ts
causal_links:
  - F20261010grig
  - F20261112grpld
intent:
  problem: "2026-11-12 UTC 的 4 条真实守卫拦截尚未进入回归套件，后续改动可能放松 download_exec 与 cred_dir_access 负门而无测试预警"
  expected_effect: "4 条完整 toolcall 按 BLOCK 固化，回放同时断言拦截类别词，覆盖 3 条下载管道进解释器与 1 条 SSH config 读取"
  verify_by:
    type: behavior_check
---

# 固化 2026-11-12 守卫实录 4 条（BLOCK 4）

## 数据源与裁决

候选原文：`data/guard-replay-candidates-2026-11-12.json`，`totalIntercepts=4`、`uniqueSamples=4`。

逐条对照完整 invoke toolcall，而非只看截断的 `commandHead`：

| healing | 规则 | 裁决 | 依据 |
|---|---|---|---|
| eec741af | download_exec | BLOCK | 外部网页 curl 直接管道 Python；后续改落盘解析 |
| f57c88c1 | download_exec | BLOCK | 同规则的另一外部网页实录 |
| 0dea2289 | cred_dir_access | BLOCK | 完整命令后段 grep `/Users/orca/.ssh/config` 与 `conf.d` |
| 84b50fe5 | download_exec | BLOCK | 远端 manifest curl 直接管道 Node；后续改落盘解析 |

裁决为 ALLOW 0 / BLOCK 4 / SKIP 0。只新增测试样本与本文档，不改守卫实现。

## 验证

- `npx vitest run tests/guard/replay/replay.test.ts`
- 新增 4 条均要求 `block`，并分别断言理由包含「下载即执行」或「凭证」。
- 全量既有回放必须保持通过；若新增样本与现行判定不符，先复查裁决，不改期望凑绿。
