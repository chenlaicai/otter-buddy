---
id: F20260829cstd
title: 成本/产出看板（RHI 效率维指标组）
summary: 新增 LLMCallCollector（解析 session JSONL 聚合 per-otter per-day token/cost）+ OtterOutputCollector（查询 messages 表聚合发言计数），接入 RHI 管道写入 health_snapshots（metric_type=cost_output），新增 GET /api/health/cost-output 端点和 Web 成本/产出 Tab（趋势折线图 + 獭明细 + 缓存命中率 + 成本占比堆叠条）。
change_type: feature
status: development
created_in_conversation: fe63e059-635f-4387-9dcd-5b685a58e6e8
capability_test: tests/usecases/health/cost-output-collector.test.ts
tags: [rhi, cost-output, health-dashboard, metrics, efficiency]
modules:
  - src/usecases/health/cost-output-collector.ts
  - src/usecases/health/cost-output-rows.ts
  - src/usecases/health/rhi-scan-worker.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
  - src/interface-adapters/http/router.ts
  - src/app.ts
  - web/src/api/client.ts
  - web/src/pages/health/index.tsx
from:
  - F20260824rhib
  - F20260825rweb
  - F20260825sgnw
  - F20260829hviz
supersedes: []
---

# F20260829cstd 成本/产出看板（RHI 效率维指标组）

## 背景与目标

RHI 健康指标体系已有「流程合规」维度（提交质量、特性链状态、信号检测），但缺少「效率」维度——LLM 成本和产出效率不可观测。

**目标**：v1 实现 per-otter per-day 的成本/产出指标采集和展示，作为 RHI 首个效率维指标组。

**非目标**（v2 留待观察期数据后再定）：
- 不做质量加权产出（v2）
- 不新建独立系统（挂 RHI 现有管道）
- 不动 L3 信号阈值体系（观察数据后定）

## 方案设计

### 数据路径

```
session JSONL ──→ LLMCallCollector ──→ per-otter per-day token/cost
                                           │
messages 表   ──→ OtterOutputCollector ──→ per-otter per-day 发言计数
                                           │
                                           ▼
                                   buildCostOutputSnapshotRows()
                                           │
                                           ▼
                              health_snapshots (metric_type=cost_output)
                                           │
                                           ▼
                              GET /api/health/cost-output
                                           │
                                           ▼
                              Web 成本/产出 Tab (recharts)
```

### 新增模块

| 模块 | 职责 |
|------|------|
| `cost-output-collector.ts` | LLMCallCollector：解析 session JSONL，join agent_sessions+otters 表，按 date+otter+model 聚合 token/cost/cacheHitRate；OtterOutputCollector：查询 messages 表按 otter+date 聚合发言计数 |
| `cost-output-rows.ts` | 将采集结果转为 health_snapshots 的 CreateSnapshotRow 格式（metric_type=cost_output，12 个指标键 per cost 记录 + 1 个 per output 记录） |

### 修改模块

| 模块 | 变更 |
|------|------|
| `rhi-scan-worker.ts` | 新增 `costOutputSink`/`sessionsDir`/`agentSessionSource`/`costOutputDb` 选项；scanOnce() 步骤 8 调用 `persistCostOutputSnapshot()` |
| `rhi-controller.ts` | 新增 `GET /api/health/cost-output?days=30` 端点 |
| `router.ts` | 注册 `/api/health/cost-output` 路由 |
| `app.ts` | 注入 cost-output 依赖（agentSessionSource、costOutputSink、sessionsDir、costOutputDb） |
| `web/api/client.ts` | 新增 `getRhiCostOutput()` + DTO 类型 |
| `web/pages/health/index.tsx` | 新增「成本/产出」Tab（汇总指标卡 + Cost 趋势图 + Token 消耗图 + 缓存命中率图 + 獭明细表 + 成本占比堆叠条） |

### 指标键清单

| metric_key | 含义 |
|-----------|------|
| input_tokens | 输入 token 数 |
| output_tokens | 输出 token 数 |
| cache_read_tokens | 缓存读取 token 数 |
| cache_write_tokens | 缓存写入 token 数 |
| total_tokens | 总 token 数 |
| cost_input | 输入成本 |
| cost_output | 输出成本 |
| cost_cache_read | 缓存读取成本 |
| cost_cache_write | 缓存写入成本 |
| cost_total | 总成本 |
| llm_call_count | LLM 调用次数 |
| cache_hit_rate | 缓存命中率（cacheRead / (cacheRead + input)） |
| message_count | 獭发言计数 |

### 设计红线

1. **Goodhart 防线**：成本/产出只作信号不作 KPI（行内不含排名/评分/百分位）
2. **数据边界**：session JSONL 只取 usage/统计类字段聚合入库，会话内容不入库
3. **幂等可重跑**：同日重扫 replaceForDate 覆盖写入，不产生重复数据
4. **传感器分离**：成本/产出采集失败不阻断信号管道（与 overview 指标同策略）

## 验证

### 测试覆盖

- `cost-output-collector.test.ts`：13 个用例（JSONL 解析/聚合/cache hit rate/日期过滤/空目录 + messages 表聚合/过滤）
- `cost-output-rows.test.ts`：7 个用例（行数/metadata JSON/指标映射/空输入）
- `rhi-scan-worker.test.ts` 新增 2 个用例：costOutputSink 集成写入 + 向后兼容

### 最简实现检查

已过最简检查：
- 仓库已有 `HealthSnapshotRepository.replaceForDate()` → 复用（不新建落库逻辑）
- session JSONL 的 usage.cost 已由 SDK 折算 → 直接取用（不自建价格表）
- 现有 RHI 管道 + recharts 面板 → 按模式扩展（不新建系统）

## 影响范围

- `src/usecases/health/` 新增 2 文件 + 修改 1 文件
- `src/interface-adapters/http/` 修改 2 文件（controller + router）
- `src/app.ts` 修改 1 文件（DI 注入）
- `web/` 修改 2 文件（API client + health page）
- `tests/` 新增 2 文件 + 修改 1 文件
- 新增 `tests/fixtures/sessions/` 测试数据目录
