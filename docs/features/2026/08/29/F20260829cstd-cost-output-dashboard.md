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
| `cost-output-collector.ts` | LLMCallCollector：解析 session JSONL，join agent_sessions+otters 表，按 date+otter+model 聚合 token/cost/cacheHitRate；OtterOutputCollector：查询 messages 表按 otter+date 聚合发言计数；新增 collectToolCallCounts（session JSONL 统计 toolCall content block）、collectPrCounts（git log merge commit 统计）、collectFdocCounts（docs/features/ frontmatter 统计）、collectDispatchTaskCounts（otter_context 表 dispatch:* key 统计已完成/失败任务） |
| `cost-output-rows.ts` | 将采集结果转为 health_snapshots 的 CreateSnapshotRow 格式（metric_type=cost_output，11 个指标键 per cost 记录 + 1 个 per output 记录；#602 删除 cache_hit_rate 死键后 13→11） |

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
| ~~cache_hit_rate~~ | 已删（#602）：无消费者死数据，消费端统一从 cache_read_tokens/input_tokens 推导 |
| message_count | 獭发言计数 |
| tool_call_count | 工具调用计数（session JSONL 中 toolCall content block 统计） |
| pr_count | PR 数（git log merge commit 统计，per-date 全局） |
| fdoc_count | F 文档数（docs/features/ frontmatter 统计，per-date 全局） |
| dispatch_count | 任务完成数（otter_context 表 dispatch:* key 统计，per-date 全局） |

### 设计红线

1. **Goodhart 防线**：成本/产出只作信号不作 KPI（行内不含排名/评分/百分位）
2. **数据边界**：session JSONL 只取 usage/统计类字段聚合入库，会话内容不入库
3. **幂等可重跑**：同日重扫 replaceForDate 覆盖写入，不产生重复数据
4. **传感器分离**：成本/产出采集失败不阻断信号管道（与 overview 指标同策略）

## 验证

### 测试覆盖

- `cost-output-collector.test.ts`：19 个用例（JSONL 解析/聚合/cache hit rate/日期过滤/行内 otterId 提取/跨日数据保留/tool call 统计/PR 数/F 文档数 + messages 表聚合/过滤/tool call 计数 + dispatch 任务统计/since 过滤）
- `cost-output-rows.test.ts`：10 个用例（行数/metadata JSON/指标映射/PR 数行/F 文档数行/dispatch 数行/空输入）
- `rhi-scan-worker.test.ts` 新增 2 个用例：costOutputSink 集成写入 + 向后兼容
- `health-snapshot-repository.test.ts` 新增 1 个用例：replaceForDate metricType 类型限定删除

### 最简实现检查

已过最简检查：
- 仓库已有 `HealthSnapshotRepository.replaceForDate()` → 复用（不新建落库逻辑）
- session JSONL 的 usage.cost 已由 SDK 折算 → 直接取用（不自建价格表）
- 现有 RHI 管道 + recharts 面板 → 按模式扩展（不新建系统）

### 自报教训（PR #583 第一轮审视）

第一轮审视发现实现者自报「与 issue 无偏差」与事实不符——产出计数实际只实现了发言数，但 issue L1 明确列 5 项。教训：**自检阶段必须逐条对照 issue 验收标准核对，不能凭印象断言「无偏差」**。此教训已追加为自检步骤的显式检查项。

## 审视修复（PR #598 review findings）

F20260829cstd 审视发现 3 严重 + 4 建议，全部处置完毕（2026-08-29）。

### 严重发现修复

| # | 发现 | 修复 |
|---|------|------|
| S1 | L1 scope 缺口：产出只实现发言数，issue 要求 5 项 | 新增 tool_call_count（session JSONL 统计 toolCall content block）、pr_count（git log 统计 merge commit）、fdoc_count（docs/features/ frontmatter 统计）、dispatch_count（otter_context 表查询 dispatch:* key 统计已完成/失败任务，按 completedAt 日期聚合） |
| S2 | ~480/670 历史 session 静默丢弃（agent_sessions 表每 otter 只保留最新 pi_session_id） | 三级 otterId 解析：行内提取（user message system prompt 中的 ID 字段）→ agent_sessions 映射 → unknown 桶兜底，不再静默丢弃 |
| S3 | 跨日 session 当日数据丢失（文件名前缀过滤导致） | 行级 timestamp 精确归属替代文件名粗过滤；放宽文件级过滤为 since-2天，精确过滤在 parseSessionFile 内按消息 timestamp 执行 |

### 建议发现处置

| # | 发现 | 处置 |
|---|------|------|
| 1 | 契约风格分裂（series snake_case vs otters camelCase） | 修复：统一 series 为 camelCase（d5d0cd04），与 otters 明细一致 |
| 2 | cache_hit_rate 单位不一致 | 接受修复：统一为 0-1 小数（API 响应全部返回 0-1，前端乘100显示百分比） |
| 3 | 已解散獭发言计入产出但无对应成本 | 修复：新增 includeAllOtters 参数，默认仅展示 active 獭（d5d0cd04） |
| 4 | UTC 日期口径未声明 | 接受修复：特性文档声明 UTC 口径（见下方「日期口径」节） |

### 第二轮 Delta 复核（检视獭·成本复核，2026-08-30）

7 项修复 6 项正确落实，修复引入 1 个新严重问题 + 3 项建议，全部本 PR 修复。

| # | 发现 | 修复 |
|---|------|------|
| S1 | 全局行（pr/fdoc/dispatch）重复累积：`replaceForDate` 只删扫描日，历史日期行每轮 +1 | `replaceForDate` 新增 `metricType` 参数限定删除范围；`persistCostOutputSnapshot` 按日期分批写入 |
| 建议① | cacheHitRate 三处口径分裂（series 简单平均 vs otters 覆盖写 vs 采集端加权） | `buildCostTrendSeries` 改从 `cache_read_tokens + input_tokens` 求和推导（真加权平均） |
| 建议② | 特性文档 2 处处置表与实现相反 + 「自报不实教训」未记 | 更新处置表 + 验证节追加自报教训 |
| 建议③ | unknown 桶无日志 + dispatch javadoc 矛盾 | `collectLlmCalls`/`collectToolCallCounts` 新增 unknown 会话计数+采样日志 |

## 日期口径

所有日期聚合使用 UTC 口径（`toISOString().slice(0, 10)`），与北京时间差 8 小时。

示例：北京时间 2026-08-29 02:00 的消息，在 UTC 口径下归入 2026-08-28。

这是有意选择：session JSONL 的 timestamp 字段为 UTC ISO 格式，保持一致性避免转换错误。

## 影响范围

- `src/usecases/health/` 新增 2 文件 + 修改 1 文件
- `src/interface-adapters/http/` 修改 2 文件（controller + router）
- `src/app.ts` 修改 1 文件（DI 注入）
- `web/` 修改 2 文件（API client + health page）
- `tests/` 新增 2 文件 + 修改 1 文件
- 新增 `tests/fixtures/sessions/` 测试数据目录
