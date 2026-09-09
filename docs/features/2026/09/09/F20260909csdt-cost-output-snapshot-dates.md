---
id: F20260909csdt
title: 成本/产出快照日期修复：per-otter 行按真实日期落库
summary: 修复成本/产出趋势只有单日数据的断链——buildCostOutputSnapshotRows 原先把 60 天窗口的全部 per-otter 记录日期覆盖为扫描日，导致历史日期只剩 pr/fdoc/dispatch 全局行。改为所有行取记录自带日期，逐日 replaceForDate 幂等写入，60 天滚动窗口每次全量重扫自动回填历史。
change_type: fix
capability_test: tests/usecases/health/cost-output-rows.test.ts
tags: [rhi, cost-output, health-dashboard, bugfix]
modules:
  - src/usecases/health/cost-output-rows.ts
  - src/usecases/health/rhi-scan-worker.ts
  - tests/usecases/health/cost-output-rows.test.ts
  - tests/usecases/health/rhi-scan-worker.test.ts
created_in_conversation: 7cde6e5e-a8ef-4bec-8161-bceccf3d16df
created_at: 2026-09-09T10:20:00+08:00
---

# F20260909csdt 成本/产出快照日期修复：per-otter 行按真实日期落库

## 背景

搭档（2026-09-09）：「健康面板中的用量为什么每次打开都只有一天的，不应该每天都有然后才形成趋势指标，否则这指标就没有意义了」。

排查实证（生产库 `health_snapshots`）：`metric_type='cost_output'` 的 token/cost/message/tool_call 行**只有 2026-09-09 一天**（369+1008 行），7-08 至 9-08 的每个历史日期只剩 1 行 `fdoc_count`。

## 根因

`buildCostOutputSnapshotRows(snapshotDate, costRecords, outputRecords, …)` 把所有 per-otter per-day 记录的 snapshotDate 一律写成入参「扫描日」。扫描 worker 每次重采 60 天滚动窗口，产出的几百行历史数据全部被盖上「今天」的戳，`replaceForDate(今天, rows, "cost_output")` 先删再插——历史日期上原有的 per-otter 行不会被恢复，而全局行（pr/fdoc/dispatch）因为在 `appendGlobalRows` 里用 `rec.date` 写入而幸免。

结果：趋势序列（`GET /api/health/cost-output` 按 snapshot_date 聚合）永远只有 1 个点，30 天 totals 实际是当日值。

## 改动

| 文件 | 改动 |
|------|------|
| `cost-output-rows.ts` | `buildCostOutputSnapshotRows` 删除 `snapshotDate` 入参；per-otter cost 行（11 键）与 output 行（2 键）改用 `rec.date` 为行日期，与全局行口径统一；头部注释加防复活警示 |
| `rhi-scan-worker.ts` | 调用点同步去参；`rowsByDate` 逐日 `replaceForDate` 分组逻辑不变（现覆盖全部行，不只全局行）；注释更新 |
| `cost-output-rows.test.ts` | 全部调用点去参；新增「跨日记录按各自日期生成行」用例（3 天 fixture 断言日期集合与逐日取值） |
| `rhi-scan-worker.test.ts` | #583 快照写入用例断言从「今天」改为按 fixture 真实日期 2026-08-28 查询 |

## 历史数据回填

不需要独立回填脚本：采集侧本就是 60 天滚动窗口全量重采（`collectLlmCalls`/`collectOtterOutput` 带 `since`），修复合入后**下一次扫描**即把所有历史日期逐日 replaceForDate 写齐。7-08 之前的数据超出 60 天窗口，不可回填（session JSONL 仍在但窗口口径如此，与 overview 指标一致）。

## 本次变更对旧特性做了什么

- 对 F20260829cstd（#583 成本/产出看板）：修复其落库管道断链——采集与 API 聚合逻辑不动，只修正行日期口径。原设计意图（趋势图、30 天 totals）自此才真正生效。
- 对 S1 修复（全局行按历史日期入库）：本次把同一正确口径推广到 per-otter 行，S1 的 rowsByDate 分组机制复用不改动。

## 验证

- `cost-output-rows.test.ts` + `rhi-scan-worker.test.ts` + 全 health 目录 + rhi-api：283 用例通过
- 全量测试：248 文件 3115 用例通过
- eslint / tsc --noEmit：0 error
- 已过最简检查：方案 = 改行日期来源 + 复用已有分组逻辑，无新文件新依赖；回填靠既有滚动窗口自然完成，不写一次性脚本
- 取舍说明：不保留 `snapshotDate` 入参做「默认日期」——唯一调用点已同步，保留死参数只会造成口径分裂陷阱

## 不变

- 成本/产出只作信号不作 KPI（F20260829cstd 红线延续）
- 传感器分离：采集失败不阻断信号管道
- 数据边界：usage/统计类字段入库，会话内容不入库
