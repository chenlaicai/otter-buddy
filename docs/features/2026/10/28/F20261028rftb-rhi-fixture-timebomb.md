---
id: F20261028rftb
title: "rhi-scan-worker 测试时间炸弹拆除：fixture 日期动态化"
summary: "PR #1666 于 2026-10-27 20:34 CI 三绿，10-28 晨未改一字 check 变红（3 个 cost_output 断言挂）。排除法定位：同 commit 3710302f 跨 UTC 日界由绿转红——setupCostOutputFixture 写死 2026-08-28，恰在成本快照 60 天扫描窗口最后一天，10-28 出窗 1 天扫不到数据。fixture 日期改为运行时动态生成（今天-30 天，窗口中段），本地 11/11 绿。10-28 起全仓 PR check 均被此炸弹卡住。"
change_type: fix
capability_test: "npx vitest run tests/usecases/health/rhi-scan-worker.test.ts：修复前 3 failed（本机复现），修复后 11/11 passed；同环境同命令对照"
intent:
  problem: "fixture 日期写死 2026-08-28，与成本快照扫描的相对窗口（now - 60 天，rhi-scan-worker.ts:294）耦合——写死日期与滚动窗口的差值每天 +1，10-28（UTC）起 fixture 出窗，sessions 扫描无数据，cost_output 断言全红。同 commit 昨绿今红，CI 时间稳定性的定时炸弹。"
  solution: "FX_DATE = 运行时今天 - 30 天（ISO 日期），覆盖 fixture 全部 11 处写死点（session JSONL 三行时间戳、entries 种子时间、session 文件名两处、queryDay 断言四处、overview 种子/查询两处）；F 文档 seed（2026-08-01）保留——fdoc_count 按 F 文档真实创建日落库，不走 sessions 60 天窗口。"
  expected_effect: "任意日期运行测试，fixture 恒在扫描窗口中段（-30 天），永不出窗；CI 不再因日期推移变红。"
  verify_by:
    type: test
    assertions:
      - "修复前：3 failed（costOutputStored=0 / firstPass.length=0 / capturedMetricType=NOT_CALLED）"
      - "修复后：11/11 passed"
  risks:
    - "动态日期使测试不再确定性可重现（断言依赖 FX_DATE 而非常量）——已通过集中单点定义（FX_DATE 常量）缓解，出问题查一处即可"
created_in_conversation: f3567df1-e24b-49cd-a020-cdb39572f853
tags: [test, time-bomb, ci, health-metrics]
modules:
  - tests/usecases/health/rhi-scan-worker.test.ts
---

# rhi-scan-worker 测试时间炸弹拆除

## 案发现场

- 2026-10-27 20:34（北京）PR #1666 CI 三绿（check 18m44s / e2e / golden-selftest，run 40504965537）
- 2026-10-28 08:06（北京）搭档在 GitHub UI update branch（merge main，引入 #1669），CI 重跑——**同一个特性分支，改动内容未变**，check 红（run 40606640032）
- 失败 3 例全在 `tests/usecases/health/rhi-scan-worker.test.ts`：
  - `costOutputSink 注入后 scanOnce 写入成本/产出快照（#583）`：expected 0 to be greater than 0（:345）
  - `多轮扫描后历史日期 cost_output 行存活`：expected 0 to be greater than 0（:385）
  - `metricType 参数必须正确转发`：expected 'NOT_CALLED' to be 'cost_output'（:477）

## 根因分析

**排除法**：本地 worktree 分别 checkout 3710302f（昨晚绿 commit，不含 #1669）与 387a30a7（含 #1669）跑同测试——**两者均失败**。失败与 #1669 无关、与分支内容无关，只与**运行日期**有关。

**窗口耦合**：成本快照扫描 `src/usecases/health/rhi-scan-worker.ts:294`：

```ts
const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
```

fixture（`setupCostOutputFixture`，test:79）写死 `2026-08-28`。北京时间 10-27 晚 CI 运行于 UTC 10-27，since = 08-28 → fixture 恰在窗口内**最后一天**；UTC 10-28 起 since = 08-29 → fixture 出窗 1 天，sessions 扫不到 → costOutputStored=0 → 三断言全红。

时间线解释了「昨晚绿今晨红」：写 fixture 的人（PR #860，2026-09-09）当时距 08-28 约 42 天，离窗口边缘 18 天，两个月后精确引爆——典型的滚动窗口×写死日期时间炸弹。

## 修复

`tests/usecases/health/rhi-scan-worker.test.ts`：

- 新增模块级常量 `FX_DATE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)`（今天-30 天，60 天窗口中段，任意日运行都永不出窗）
- `FX_FILE_STAMP` 派生 session 文件名时间戳
- 全部 11 处写死点替换（session JSONL 三行时间戳 / entries 种子时间 / 文件名两处 / queryDay 断言四处 / overview 种子与查询两处）
- F 文档 seed 日期（2026-08-01，F20260801wwww）**保留不动**：fdoc_count 全局行按 F 文档真实创建日落库，与 sessions 60 天窗口无关（出窗 87 天昨晚仍绿为证）

## 验证

- 修复前：本地 vitest 3 failed（与 CI 签名一致）
- 修复后：11/11 passed
- commit 本身触发本地 pre-commit 全链（build/lint/smoke:boot 等）通过

## 影响范围与后续

- **10-28（UTC）起全仓所有 PR 的 check 被此炸弹卡住**，不止 #1666——需尽快合入解除阻塞
- CI 里已有「时间炸弹收窄扫描 v2」（#1173/F20260929dbmb）但未覆盖此 fixture——其扫描面（E1/E2 error 阻断）不含「滚动窗口×写死日期」形态，考虑后续增补该形态的检测（另立 issue 跟踪，见 Discovered Issues）
- PR #1666 在本 PR 合入 main 后需再 update branch 触发 CI 重跑，预期转绿

## Discovered Issues

- 时间炸弹扫描器 v2 未覆盖「写死日期 × 滚动窗口」形态（待立案：fixtures 中其他写死日期审计 + 扫描器增补规则）
