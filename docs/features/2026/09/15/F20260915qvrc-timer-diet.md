---
id: F20260915qvrc
title: 闹钟瘦身：高频常驻循环降频（Polling/Pool Sweep/Metrics Flush/Embedding Retry）
summary: 应 chen 15:09「后台循环太多」裁决 + 15:24「一个 PR 处理完」指令：四个高频常驻循环降频——调度 Polling 30s→5min、Session Pool Sweep 1min→5min、Metrics Flush 1min→5min、Embedding Retry 30s→1h。每个降频都论证过业务粒度容忍度（任务最小粒度 1min、池 TTL 10min、指标看趋势、暗化条目仅影响语义召回）。同构循环合并（4 个扫台账循环 → 巡检 worker）与 RHI on-demand 评估另开 issue 排期。
type: feature
status: development
created: 2026-09-15
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
modules: [scheduler, agent, metrics, memory]
capability_test: 无新行为——全量回归（3035/3035）+ CI
intent:
  goal: 常驻循环频率降到业务粒度容忍的下限，消灭「闹钟太多」的系统税负
  why: chen 15:09 体感裁决：「polling 补触发有点没必要了，感觉太重了，后台循环太多了吧」——盘点 8 个常驻 setInterval，高频的四个都有降频空间
  non_goals:
    - 不砍 Polling（#640 App Nap 是 OS 行为不会自愈，砍了回到 9 点档随缘迟到）
    - 不动 SSE keep-alive（前端连接心跳，不是闹钟）
    - 不做同构循环合并（巡检 worker）与 RHI on-demand——另开 issue 排期
---

# 闹钟瘦身：高频常驻循环降频

## 背景

chen 15:09 裁决：「polling 补触发有点没必要了，感觉太重了，让本系统的后台循环太多了吧」→ 大獭全仓盘点 8 个常驻循环（工作区 timer-audit-20260915.md）→ chen 15:24 指令：「你直接一个 PR 处理完」。

## 改动（4 处常量/默认值）

| 循环 | 位置 | 原值 | 新值 | 业务粒度容忍论证 |
|---|---|---|---|---|
| Scheduler Polling | scheduler-service.ts `POLL_INTERVAL_MS` | 30s | **5min** | 任务最小粒度 1min 且全为日报/周报级，补触发晚 5min 无体感；⚠ 本值兼作 #640 快路径去重窗——窗口涨后 setTimeout 快路径失败的回补延迟最多 5min（可接受） |
| Session Pool Sweep | pi-session-pool.ts `sweepIntervalMs` 默认值 | 1min | **5min** | 池 TTL 10min，过期 session 多躺 ≤5min 只是内存里多一个轻量句柄 |
| Metrics Flush | registry.ts `DEFAULT_FLUSH_INTERVAL_MS` | 1min | **5min** | 指标看趋势，进程崩溃最多丢 5min 数据点 |
| Embedding Retry | embedding-retry-worker.ts `intervalMs` 默认值 | 30s | **1h** | 暗化条目仅影响语义近邻召回（关键词召回不受影响），1h 重建延迟可接受；并入「扫台账」族的 1h 节奏 |

## 影响范围

- 4 个文件各 1 行（+注释）
- 测试注释同步（POLL_INTERVAL 窗口描述 3 处）
- 无行为契约变化：所有注入点（options 传参）不受影响，测试显式传参的用例不受默认值变化影响

## 取舍

- **不降 SSE keep-alive（15s）**：前端连接心跳，按连接续命用，动了前端断线
- **不降执行级看门狗（15s）**：只在任务执行期间活着，非常驻
- **合并与 RHI 不动**：同构循环合并（巡检 worker）与 RHI on-demand 是结构化改动/产品行为变更，另开 issue 排期

## 验证

- 全量 3035/3035 + tsc 0 + eslint 0
- 显式传参的测试用例（embedding 30s/flush 100ms 等）不受默认值影响，零测试改动（仅注释同步）

## 后续（issue 排期）

- 四个「扫台账」循环（运行时对账/Signal Aging/RHI/Embedding Retry）合并为单一巡检 worker
- RHI Scan 改 on-demand（打开面板现算）评估——产品行为变更需拍板

## 决策史

- 2026-09-15 15:09 chen 裁决「后台循环太多」（本特性起点）
- 2026-09-15 15:16 chen 指令「完整分析来做」→ 大獭盘点 8 循环（timer-audit-20260915.md）
- 2026-09-15 15:24 chen 指令「一个 PR 处理完」（本特性范围定稿：降频先做，合并/评估另开 issue）
