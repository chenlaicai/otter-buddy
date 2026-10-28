---
id: F20261028grpl
title: "10-27 真实拦截回放固化：守卫自测负门 4 条（#1670）"
summary: "每日体检守卫误拦样本固化段 10-27 批次：98 条拦截去重 94，守卫自测破坏形态 4 条（rm 主仓探针/pgrep 管道 kill）钉 BLOCK 负门；善后类误拦 90 条 SKIP 归 #1608/#1661 重构在途，不锁死期望。"
change_type: fix
capability_test: "n/a: 纯测试追加（vitest 58 passed），无 prompt/LLM 行为改动"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-28T08:55:00+08:00
causal_links:
  from: [F20260928grv2]
---

# 背景

每日体检守卫误拦样本固化段（2026-10-27 批次）：`scripts/generate-guard-replay.mjs` 从 healing events 提取 98 条拦截（去重 94），逐条人工裁决 verdict。当日拦截流量的主体是「bash拦截优化」对话的守卫自测与探针流量，其中破坏性形态应作为负门钉死；善后类误拦（worktree remove / branch -D / force-with-lease push）因守卫重构 #1608/#1661 在途，修复 PR 自带回归钉，本批不钉 ALLOW 防红。

# 改动

`tests/frameworks/agent/guard-v2-real-replay.test.ts` 追加 describe 块「2026-10-27 真实拦截回放」：

- 1027-D1/D2：`rm` 主仓探针文件 / `cd 主仓 && rm data/...` 相对路径形态 → BLOCK（data_destructive，现场 11:22 / 11:36）
- 1027-K1/K2：`pgrep -f | xargs kill -TERM` 非字面 PID 管道 / `pgrep -P + kill 字面` 组合 → BLOCK（self_kill_nonliteral，现场 12:03 / 14:35）

# 验证

- `npx vitest run tests/frameworks/agent/guard-v2-real-replay.test.ts` → 58 passed | 6 skipped（新增 4 条全绿，存量无回归）
- 裁决依据：guard-replay-candidates-2026-10-27.json 样本 + #1472 计数噪音定性先例

# 关联

- 误拦面（SKIP 部分）归 #1608「守卫误拦面整理」与 #1661 守卫收敛重构在途处理
