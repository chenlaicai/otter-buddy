---
id: F20260812mtrc
title: metrics-infra-and-scheduler
doc_type: feature

summary: |
  引入 prom-client metric 框架 + JSONL 文件持久化 + /metrics 端点，
  先接入 scheduler 模块。frameworks/metrics/registry.ts 提供 Counter/Histogram/Gauge
  标准化 API，定期 flush 到 data/metrics/metrics-YYYY-MM-DD.jsonl，按 7 天自动过期清理。
  scheduler 已接入 5 个核心指标（触发次数、执行耗时、重试、过期、active 任务数）。

causal_links:
  from:
    - F20260811onst
    - F20260812a2b3
  related_issues:
    - "#242 (可观测性基础设施)"

status: implemented
change_type: feature
tags: [observability, metrics, prom-client, scheduler]
modules:
  - src/frameworks/metrics/
  - src/usecases/scheduler/scheduler-service.ts
  - src/bootstrap/server.ts
  - src/bootstrap/platforms.ts
  - src/app.ts
capability_test: "n/a: 纯 A 类改动（metric 基础设施 + scheduler 接入），无 LLM 参与行为"

created_at: 2026-08-12
---

# F20260812mtrc Metric 基础设施 + Scheduler 接入

## 背景

### 痛点（Issue #242）
- 仓库只有结构化日志（`Logger`），没有 metric/counter 系统
- 飞书 post+md 降级频率、broadcaster 成功率、熔断器触发次数等都散落在日志里
- 出生产问题时只能 grep 日志统计，无自动告警路径

### 决策
**框架选 prom-client + 文件持久化**：
- 标准化 Prometheus 语义（Counter/Histogram/Gauge）
- 持久化到本地 JSONL 文件（不污染业务 SQLite）
- 7 天自动过期（监控数据"近期有用"场景）

详见"决策记录"。

## 方案

### 数据分层

| 数据类型 | 存储 | 生命周期 |
|------|------|------|
| 业务数据 | SQLite | 永久 |
| 行为流水 | logs/ | 日志式 |
| 运维指标 | data/metrics/*.jsonl | 7 天过期 |

### 核心组件

**`src/frameworks/metrics/registry.ts`** — MetricsRegistry
- 基于 prom-client 的 Registry 封装
- 提供 `counter/histogram/gauge` 工厂方法（重复注册同名返回相同实例）
- `start()`：清理旧文件 + 启动定期 flush 定时器
- `flush()`：把当前 metric 快照 append 到 `metrics-YYYY-MM-DD.jsonl`
- `dispose()`：清除定时器 + 强制 flush（幂等）
- `metricsText()`：Prometheus 文本格式（供 `/metrics`）
- 全局单例（`initMetricsRegistry` / `getMetricsRegistry` / `resetMetricsRegistry`）

**`src/frameworks/metrics/scheduler-metrics.ts`** — SchedulerMetrics
- 封装 scheduler 模块的 5 个 metric 定义

### 持久化策略

- 进程内存累积（prom-client 默认）
- 每 60s 自动 flush（`flushIntervalMs` 可配）
- 进程退出（dispose）强制 flush
- 启动时清理超过 `maxAgeDays`（默认 7）的旧文件
- 文件名：`metrics-YYYY-MM-DD.jsonl`（UTC 日期）
- 行格式：`{"ts":"ISO","metric":"name","labels":{...},"value":N}`

### Scheduler Metric 清单

| 名称 | 类型 | 标签 | 说明 |
|------|------|------|------|
| `scheduler_trigger_total` | counter | type, status | 触发总次数（type=cron\|once, status=completed\|failed\|skipped） |
| `scheduler_execution_duration_ms` | histogram | type | 单次执行耗时 |
| `scheduler_retry_total` | counter | type | once 任务重试次数 |
| `scheduler_expired_total` | counter | - | once 任务过期（F20260812a2b3 起改为直接 delete，本 metric 仍统计过期触发次数） |
| `scheduler_active_tasks` | gauge | type | 当前 active 任务数（start 时上报） |

### 端点

- **GET /metrics**：Prometheus 文本格式，供 Prometheus 抓取或浏览器手动查看
- metric 未初始化时返回 503

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/metrics/registry.ts | 新增 | MetricsRegistry + 全局单例 |
| src/frameworks/metrics/scheduler-metrics.ts | 新增 | SchedulerMetrics 封装 |
| src/usecases/scheduler/scheduler-service.ts | 修改 | 接入 metric + 抽出 resolveEffectiveBody + refreshActiveTaskGauge + try/finally 覆盖全路径 |
| src/bootstrap/server.ts | 修改 | 暴露 /metrics 端点 |
| src/bootstrap/platforms.ts | 修改 | initAgentAndScheduler 支持 metrics 参数 |
| src/app.ts | 修改 | 初始化 metric registry + dispose 改 async await flush |
| src/main.ts | 修改 | gracefulShutdown/uncaught/unhandled 改 async + await dispose |
| tests/frameworks/metrics/ | 新增 | registry + scheduler-metrics 单元测试 |
| tests/usecases/scheduler/scheduler-metric-integration.test.ts | 新增 | metric 集成测试（独立文件，真实 SchedulerMetrics + mock repo，12 个 AT 场景） |
| tests/usecases/scheduler/scheduler-service.test.ts | 修改 | 移除原内嵌 metric 测试（迁到独立文件） |
| package.json | 修改 | 新增 prom-client 依赖 |

## 验收测试

| AT | 场景 | 操作 | 预期 |
|----|------|------|------|
| AT-1 | counter 注册与累加 | 创建 counter + inc + metricsText | 包含累加值 |
| AT-2 | histogram observe | observe 多个值 | 产出 bucket counter |
| AT-3 | flush 写文件 | inc 后 flush | 今日 JSONL 文件包含对应记录 |
| AT-4 | 旧文件清理 | 启动时存在 8 天前文件 | 文件被删除 |
| AT-5 | dispose 幂等 | 连续 dispose 两次 | 不抛错 |
| AT-6 | 重复注册同名 | 同名注册两次 + inc | 返回同一实例，metricsText 包含 |
| AT-7 | scheduler 成功触发 metric | trigger 任务成功 | recordTrigger(type, completed) + observeExecutionDuration 被调用 |
| AT-8 | scheduler 失败触发 metric | trigger 任务失败 | recordTrigger(type, failed) 被调用 |
| AT-9 | once 过期 metric | scheduleOnce 过期分支 | recordExpired 被调用 |
| AT-10 | start 上报 active 任务数 | start 时有多个任务 | setActiveTasks 按类型聚合 |
| AT-11 | claim 失败记 skipped | claimTask 返回 false（60s 重复触发） | recordTrigger(type, skipped) |
| AT-12 | 对话不可用记 skipped | conversation 不存在 | recordTrigger(type, skipped) |

全部 1173 个测试通过。

## 决策记录

| 决策 | 结论 | 理由 |
|------|------|------|
| 框架选型 | prom-client | 标准化 Prometheus 语义，未来接 Prometheus + Grafana 无痛 |
| 持久化位置 | data/metrics/*.jsonl | 监控数据量大事务性弱，不污染业务 SQLite；文件易归档清理 |
| 过期策略 | 7 天自动清理 | 监控数据"近期有用"，问题近期解决；类似日志轮转 |
| 全局单例 vs DI | 全局单例 | metric 是跨模块全局状态，DI 在此规模下开销大于收益；测试用 resetMetricsRegistry |
| flush 频率 | 60s | 平衡 IO 压力与数据完整性；进程退出强制 flush 兜底（await） |
| 接入范围 | 本 PR 只接 scheduler | "PR 范围聚焦"，broadcaster/circuit-breaker 后续分 PR 接入 |
| histogram buckets | [100,500,1k,5k,10k,30k,60k,120k,300k] ms | 覆盖 LLM 触发的快速/慢速场景 |
| histogram 测量范围 | 仅 inner try 阶段（sendMessage/invoke/complete/reset） | 排除 claim/resolve/createExecution 前置操作；前置抛错不计 histogram |
| 启动时 setActiveTasks + onChange 刷新 | 是 | start 给基线 + 每次 created/updated/deleted 后 refreshActiveTaskGauge，避免 gauge 长期失效 |
| trigger_total status 枚举 | completed/failed/skipped | 见下"skipped 语义"说明 |
| 默认 status='failed' | 是 | 任何未显式置 status 的抛错路径（resolveEffectiveBody/createExecution 抛 DB 错等）一律记 failed，避免误记 completed |
| dispose 改 async + main.ts await | 是 | 原 fire-and-forget 在 process.exit 前丢数据，违背可观测性初衷 |
| flush 是快照模式（非增量） | 文档记录 | 跨 UTC 日期边界按天聚合需取每日最后一条；当前消费者是浏览器手动查看，不致命 |
| 与 F20260812a2b3（once 任务自动删除）共存 | 兼容 | F20260812a2b3 把 once 任务"过期/触发后 disabled"改为 delete；本 PR 的 recordExpired 仍会在过期分支调用，metric 语义不变（统计"过期触发次数"，与"是否保留任务记录"解耦） |

### `skipped` status 语义说明

`skipped` 涵盖两种情况：
1. **claim 失败/对话不可用**（异常场景，可能是并发抢占或会话已结束）
2. **healing null（无待处理事件）**（正常"没事可做"场景）

两种情况混合在同一个 `skipped` 标签下。如果未来发现高 `skipped` 量需要细分归因，可加 `skipped_reason` 标签或拆出 `noop` status。当前阶段（scheduler 模块）频率低，混合可接受。

## 未覆盖（后续 PR）

按 Issue #242 的"全仓基础设施"目标，本 PR 只完成 metric 框架 + scheduler 接入。待接入：
- `feishu/client.ts` 降级路径 counter
- `im/message-broadcaster.ts` 广播成功率
- `agent-runtime/circuit-breaker` 触发次数
- 告警规则（运维侧）

---

[大獭] 🦦
