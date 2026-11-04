---
id: F20261105tzwfx
title: 时区窗口 flaky 修复：rhi-scan-worker 上海日界对齐 + generate-guard-replay UTC 播种
doc_type: feature

summary: |
  修复两处「上海凌晨 0-8 点跑测试必红」的时区窗口 flaky，并完成 hwl1 未竟的日界统一：
  rhi-scan-worker.test.ts 的 cost fixture 与生产 shanghaiDateKey 日界分叉；
  generate-guard-replay.test.ts 的本地时区播种与脚本 UTC 日界错位；
  collectOtterOutput 的 SQLite DATE()（UTC 日界）改为上海日界（+8h）——
  对抗审视采纳检视獭严重发现：钉正午只是避开分叉，生产侧双口径才是根。

causal_links:
  from:
    - F20261027hwl1

change_type: fix
tags: [test, timezone, flaky, health, scheduler]
modules:
  - src/usecases/health/cost-output-collector.ts
  - tests/usecases/health/rhi-scan-worker.test.ts
  - tests/usecases/health/cost-output-collector.test.ts
  - tests/scripts/generate-guard-replay.test.ts
capability_test: "n/a: 测试基建修复，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-11-05

intent:
  problem: "上海凌晨 0-8 点（UTC 16-24 点）跑 CI/本地测试，两个文件必红——任何在该窗口的 PR 合入与定时任务（07:30 daily-health-check、01:00 依赖升级）都受害"
  expected_effect: "三时区（Shanghai/UTC/New_York）全绿，时区窗口 flaky 根除；依赖升级 PR #1775/#1776 的 CI 可转绿"
  verify_by:
    type: behavior_check
---

# F20261105tzwfx: 时区窗口 flaky 修复

## 背景

2026-11-05 依赖升级批（F20261105depup）在 CI 上红：`rhi-scan-worker.test.ts`
costOutputSink 用例断言失败。对照实验排除升级嫌疑（未升级主仓同时段同样失败；
main 昨日 CI 绿）后定位为时区窗口 flaky——触发场景是「上海凌晨跑 CI」。

## 根因一：rhi-scan-worker cost fixture 日界分叉

生产侧两族行的日期口径不同：
- **cost 行**（tokens/cost）：`consumeLine` 用 `shanghaiDateKey(msg.timestamp)`
  （F20261027hwl1 从 UTC 裸 slice 改上海日界）
- **output 行**（message_count/tool_call_count）：`collectOtterOutput` 用 SQLite
  `DATE(e.created_at)`（UTC 日界）

测试 fixture 的 `COST_FIXTURE_DAY = COST_FIXTURE_ISO.slice(0, 10)`（UTC 日界）。
UTC 16-24 点（上海 0-8 点）时「冻结时钟-24h」跨上海日界：cost 行落上海昨日-1、
output 行落 UTC 昨日——断言查任何一天都缺另一族的键，`input_tokens`/
`message_count` 断言必假红（实测 2026-11-05 01:05 与 09:35 两次红）。

#605 的 CLOCK_SNAPSHOT 冻结只消除了种子随真实时钟漂移的问题，未覆盖 hwl1
引入的新分叉。

### 修法：fixture 时刻钉上海昨日正午（防御层）

不逐行对齐断言，而是把 fixture 时刻从「冻结时钟-24h」改为「上海昨日正午」
（= 04:00 UTC）——两种日界口径下恒属同一天，物理避开分叉窗。
`COST_FIXTURE_DAY` 同步用 `shanghaiDateKey`（import 生产同源函数）与 cost 行口径一致。

### 生产侧修复（对抗审视后追加，采纳检视獭严重发现）

初版只修了测试（钉正午避开分叉窗），检视獭-1105 指出这是掩盖而非修复：
collectOtterOutput 的 SQLite `DATE(e.created_at)`（UTC 日界）是 hwl1 复审 A4
改 toolCallCounts 日键时的漏改残留——同采集器内口径分裂违背 hwl1 注释明示意图
（「消灭同采集器内 UTC/Shanghai 口径分裂」）。且错配有实质后果：上海 0-8 点窗口
`toolCallCounts.get(r.date)` 按上海日键查不到 UTC 日键的行，toolCallCount 静默归零。

修法：SQL 三处 `DATE(e.created_at)` → `DATE(e.created_at, '+8 hours')`
（SQLite 无时区支持，+8h 后取 DATE 等价上海日），与 consumeLine/
countToolCallsInFile 同轨。无需 migration：写入侧逐日 replaceForDate 幂等覆盖
+ 60 天滚动全量重扫，口径修正后存量行自动重建。

回归钉子：cost-output-collector.test.ts 加 UTC 20:00 种子（上海次日凌晨），
断言归入上海次日且 toolCallCount 不归零——防口径回退。

## 根因二：generate-guard-replay 播种/窗口日界错位

脚本 `targetDate` 用 `getUTC*` 算 UTC 昨日（PR #1368 §3.3：healing_events
created_at 是 UTC ISO，窗口用 UTC 日界），测试播种用 `getFullYear()` 本地时区。
Asia/Shanghai 凌晨 0-8 点播种日=今天而窗口日=昨天，种子全部窗外。
（CI runner TZ=UTC 免疫；本地与任何非 UTC 环境凌晨必红。）

### 修法：播种改 UTC 日界（utcDate）

测试的 `localDate` → `utcDate`（getUTC* 同源口径），三处引用同步。
这纯是测试对齐脚本既有口径，无生产行为变化。

## 验证

**机器锚点**：
- 修复后三时区全绿（2026-11-05 09:50 本地实测，正处分叉窗 UTC 01:50 内）：
  - `TZ=Asia/Shanghai / UTC / America/New_York npx vitest run tests/usecases/health/rhi-scan-worker.test.ts` → 11/11 三连绿
  - 同三时区 `tests/scripts/generate-guard-replay.test.ts` → 6/6 三连绿
  - 同三时区 `tests/usecases/health/cost-output-collector.test.ts` → 21/21 三连绿（生产侧修复后新增）
- 修复前红（对照，同一机同窗口）：rhi-scan-worker 1 failed（message_count 断言）、
  guard-replay 4 failed（窗口错位 ENOENT）
- 边界反证（构造验证）：跨月（11-30→12-01）、跨年（12-31→01-01）、二月末三个边界
  下「上海昨日正午」构造的双口径归属恒同天
- SQLite +8h 语义验证：`DATE('2026-08-28 20:00:00','+8 hours')` → `2026-08-29`（上海凌晨归次日，与 shanghaiDateKey 一致）

**agent 陈述（未复验）**：CI runner 固定 TZ=UTC，本修复在 CI 上等价于旧行为
（修复主要收益是非 UTC 环境与上海凌晨窗口的全天候稳定）。

## 影响范围

两个测试文件 + collectOtterOutput 生产函数（SQL 日界统一）。依赖升级 PR #1775/#1776
rebase 本修复后 CI 转绿（或先合本 PR 再 rebase 升级批）。

## 与 #605 家族的关系

#605（时钟冻结）、#601（commit 窗口）、F20261029tzwin（#1704 author date 字典序）
同族——本修复延续该家族「口径同源 + 时刻钉边界窗内」的治理哲学。
建议后续若再出现日界 flaky，优先怀疑「测试与生产日界口径分叉」。
