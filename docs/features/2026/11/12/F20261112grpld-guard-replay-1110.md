---
id: F20261112grpld
title: 11-10 守卫负门样本固化与日报回放路径纠正
change_type: fix
status: development
created_at: 2026-11-12
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 仅增加确定性 guard 回放数据、修正定时任务文档路径，不涉及生成式能力变化"
intent:
  problem: "日报仍指向已删除的 guard-v2-real-replay 测试文件，11-10 的 9 条真实负门无法按模板固化；截断 commandHead 还会掩盖后段 curl→python，导致裁决失真"
  expected_effect: "9 条按完整 transcript 裁决的 BLOCK 样本进入现存 ReplayCase 库并全绿；日报指向真实用例文件与测试命令，后续样本可直接落盘"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "9 个事件 ID 均在 ReplayCase 中且 expect=block，guard 回放全绿"
      - "日报不再引用不存在的 guard-v2-real-replay.test.ts"
      - "不修改 bash-safety-guard.ts，既有下载执行与主进程保护负门不放宽"
    rollback: "git revert 本 PR；仅测试数据与定时任务文档，无运行时 schema 影响"
    risk_note: "样本仅保留判定所需结构，密码等敏感值使用占位符"
causal_links: []
summary: 将 11-10 的 7 条 download_exec 与 2 条 self_kill_byname 负门按完整 toolcall 裁决固化，并修正日报回放路径。
---

# 11-10 守卫负门样本固化与日报回放路径纠正

## 预注册

- 预期根因：回放文件迁移后日报路径未同步；生成器 commandHead 截断使部分 curl→python 后段不可见。
- 预期成立标准：9 条实录均以 BLOCK 落库并通过 `npx vitest run tests/guard/replay/replay.test.ts`；模板步骤可直接执行。
- 放弃原预期的反例：若任一完整 toolcall 不含 fetcher→interpreter 或主进程按名杀死结构，则该条不得按 BLOCK 固化。

## 裁决证据

- 数据源：`healing_events` + `invoke_events.assistant_toolcall`，按事件时间精确对齐。
- 裁决：ALLOW 0 / BLOCK 9 / SKIP 0。
- `93eb6f5d`、`77af0d06`、`733b8843`、`61ecaeb5`、`dda4e3ab`、`9104da8c`、`3a9e0cec`：curl 输出直接进入 python3，与既有 `99f96502` 政策性负门同构。
- `8c01da82`、`5515810e`：按进程名匹配 `dist/src/main.js`，主进程保护负门。

## 变更

1. `tests/guard/replay/cases-2026-10-29.ts`：新增 9 条最小等价 BLOCK 样本；敏感值省略或占位。
2. `prompts/scheduled/daily-health-check.md`：追加位置改为现存 ReplayCase 文件，测试命令改为真实回放入口，并补完整 toolcall 对齐要求。
3. 守卫实现零改动，不改变现行政策。

## Acceptance Test

- [ ] 9 个事件 ID 均存在且 `expect: "block"`。
- [ ] `npx vitest run tests/guard/replay/replay.test.ts` 通过。
- [ ] `npx tsc --noEmit --pretty false` 通过。
- [ ] `git diff --check` 通过；`bash-safety-guard.ts` 不在 diff 中。
