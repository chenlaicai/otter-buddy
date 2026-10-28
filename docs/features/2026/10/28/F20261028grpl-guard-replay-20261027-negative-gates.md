---
id: F20261028grpl
title: "10-27 真实拦截回放固化：守卫自测负门 4 条（#1670）"
summary: "每日体检守卫误拦样本固化段 10-27 批次：98 条拦截去重 94，固化 11 条（守卫自测破坏形态 6 条 BLOCK 负门 + #1661 合入后可验证的误拦形态 5 条 ALLOW 正门）；其余 83 条 SKIP 分类归置，重裁跟进挂 #1608。"
change_type: fix
capability_test: "n/a: 纯测试追加（vitest 58 passed），无 prompt/LLM 行为改动"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-28T08:55:00+08:00
causal_links:
  from: [F20260928grv2]
---

# 背景

每日体检守卫误拦样本固化段（2026-10-27 批次）：`scripts/generate-guard-replay.mjs` 从 healing events 提取 98 条拦截（去重 94），逐条人工裁决 verdict。

**时序注记（检视发现 1 修正）**：裁决定稿于 10-28 00:55Z，时点 #1661（守卫收敛）尚未合入、当时底座钉 ALLOW 会红；#1661 于 01:19Z 合入 main、本 PR 于 01:30Z rebase 提交后，检视复核实测典型误拦形态已全部 ALLOW——善后面从「不可钉」变为「可钉且应钉」，本 PR 据此补 5 条正门。

# 改动

`tests/frameworks/agent/guard-v2-real-replay.test.ts` 追加 describe 块「2026-10-27 真实拦截回放」11 条：

**负门（BLOCK）6 条**：
- 1027-D1/D2：`rm` 主仓探针文件 / `cd 主仓 && rm data/...` 相对路径形态 → data_destructive
- 1027-M1/M2：`rm 主仓探针 + echo` / `cd 主仓 && rm 相对路径自测文件` → main_write（检视发现 2 补钉，与 D1/D2 同族仅 ruleId 不同）
- 1027-K1/K2：`pgrep -f | xargs kill -TERM` 非字面 PID 管道 / `pgrep -P + kill 字面` 组合 → self_kill_nonliteral

**正门（ALLOW）5 条**（#1661 合入后补钉，防善后面回归）：
- 1027-A1：善后 `git worktree remove + branch -D` 已合入分支
- 1027-A2：feature 分支 `push --force-with-lease`
- 1027-A3：主仓只读 `printf + git log` 探查
- 1027-A4：`/tmp` heredoc 写实验配置
- 1027-A5：`node -e` 只读 require 探查

**回放保真度注记**：命令头取自样本（DB context 截断 ~120 字符）；D2 删「单批」词元系守卫自测当场临时文件名（非命令语法成分）；各条尾部超出截断区间按现场语义重构，与 1013 批次「多样本→典型化」先例同口径。

## SKIP 83 条分类归置表（检视发现 3/5 补）

| ruleId | 条数 | 归置 | 依据 |
|---|---|---|---|
| main_write_resolve | 27 | 归 #1608 重裁 | 善后/误拦主体（A1-A5 已钉典型形，其余同形或待重裁） |
| script_file_exec | 20 | 归 #1608 重裁 | colink 外部仓 + 各类文件执行形态，主体误拦 |
| unknown | 17 | 归 #1608 逐条定性 | 多数形似误拦；含 `rm -rf repo wt remote.git` 形似自测需逐条辨 |
| sleep_block | 15 | 不重钉 | 1013 批次 1013-B4 已钉同形负门（sleep N && cmd），本批系同形重复 |
| self_kill_nonliteral | 1 | 不重钉 | K1 已钉同形负门 |
| main_write | 3 | 归 #1608 重裁 | M1/M2 已钉典型形，余同形 |

# 验证

- `npx vitest run tests/frameworks/agent/guard-v2-real-replay.test.ts` → 65 passed | 6 skipped（新增 11 条全绿，存量无回归）
- 裁决依据：guard-replay-candidates-2026-10-27.json 样本 + #1472 计数噪音定性先例 + 检视复核实测（ALLOW/BLOCK 判定与断言方向三方吻合）

# 关联

- 误拦面重裁跟进挂 #1608「守卫误拦面整理」
- #1661（守卫收敛）合入是本批正门可钉的前提
