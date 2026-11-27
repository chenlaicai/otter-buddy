---
id: F20261127grplf
title: "固化 2026-11-26 守卫实录回放：8 条放行、4 条负门"
summary: "逐条回读完整 Durable toolcall，将 11-26 的 12 条 guard_intercept 去重样本固化进 replay；当前 5 条 cred_dir_access 文本误拦仍以红灯保留，不修改守卫实现、不宣称修复。"
change_type: fix
capability_test: "n/a: 仅沉淀既有 guard replay 样本，不新增生产能力；tests/guard/replay/replay.test.ts 直接承载验证"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
intent:
  problem: "11-26 守卫拦截只有 commandHead 时容易把测试文本误判为真实凭证访问，也可能把真实 pkill 与主服务重启误当误拦，缺少逐条可重放的语义裁决。"
  solution: "回读完整 Durable toolcall，按同一数据流语义将 12 条样本及 expect 固化到 tests/guard/replay/cases-2026-10-29.ts；故意保留当前误拦红，不改生产规则。"
  expected_effect: "后续守卫修复可直接重放 8 条 ALLOW 与 4 条 BLOCK；真实 pkill、主服务 restart 绕过和 curl 管道解释器负门不会因消误报被削弱。"
  verify_by:
    type: static_only
tags: [guard, replay, regression, daily-review]
modules: [guard, tests]
created_at: 2026-11-27
---

# 11-26 守卫实录回放固化

## 范围

- 数据源：`data/guard-replay-candidates-2026-11-26.json`，12 条拦截、12 条去重候选。
- 每条均按 otter、时间窗回查 `invoke_events.assistant_toolcall` 的完整 command；没有仅凭截断的 commandHead 裁决。
- 只改 `tests/guard/replay/cases-2026-10-29.ts`，不改 `src/`、不改守卫政策。

## 裁决

- ALLOW 8：`824dab6c`、`7084a345`、`9313b320`、`5ce9e5ef`、`3245d407`、`dd0e86d8`、`ed41f7e0`、`9c15a713`。共同点是测试/评论文本、probe 或公开目录与元数据只读，不是实际私钥读取、写凭证或按名杀进程。
- BLOCK 4：`2584af6d`、`93e3272c` 为 curl 输出直接进 Node/Python；`a88b4b81` 末段实际执行 `pkill -9 -f`；`41049bc6` 用 nohup 延迟执行主服务 restart 脚本，绕过受控通道。
- SKIP 0。

## Verification

### 失败用例证据（bugfix）

本 PR 是样本固化，不包含生产修复。修复前命令：

```text
npx vitest run tests/guard/replay/replay.test.ts
→ Test Files 1 failed (1)
→ Tests 5 failed | 233 passed (238)
```

5 条红灯均为 expect=allow、实际 block：`824dab6c`、`5ce9e5ef`、`3245d407`、`dd0e86d8`、`ed41f7e0`。`7084a345`、`9313b320`、`9c15a713` 在当前 main 已放行，因此 12 条实录中仅 5 条构成当前可复现红灯；不把历史 7 条 cred 拦截都写成当前失败。

修复后输出：本 PR 不宣称修复，故没有伪造「修复后全绿」；后续生产修复 PR 必须复跑同一文件至 238/238（或当时全量数）通过。

### 风险与回滚

- 风险：新增 5 条预期红灯会让本分支测试不绿，这是保留缺陷证据，不能作为已修复分支合入。
- 回滚：revert 本 PR 即删除 12 条样本，不改变任何生产行为。

机制识别：无新配置、状态生命周期、后台任务、消息格式、持久化、决策分支或跨模块调用；`Modification-Class: narrow-fix`，仅补既有回放覆盖。
