---
id: F20260914usgm
title: 健康面板用量看板按模型统计改版
summary: 撤掉不可靠的成本展示（SDK 单价继承错误且多为 plan 无单价），用量/效率 Tab 以模型为主维度重构——per-model token 四分类/调用数/失败次数/缓存命中率、Token 与调用双占比环形图、单次 invoke 均值（总量 + 按模型）；獭维度降为折叠辅助视图
change_type: feature
capability_test: "n/a: 数据管道/UI 改版，行为由单元测试断言（tests/usecases/health/cost-output-collector.test.ts + tests/api/rhi-api.test.ts）"
created_in_conversation: cf698fdc-2cfd-46d1-9afa-d6631e8cef31
intent:
  problem: "成本展示用 SDK 模板单价本地估算，自定义端点模型继承错误单价（虚高 4.3-100 倍）且多为 plan 无单价，费用数字不可信；面板缺少搭档需要的模型维度用量统计与单次 invoke 均值"
  expected_effect: "用量/效率 Tab 以模型为主维度展示 token 四分类/调用/失败/命中率与单次 invoke 均值，无 cost 展示；新指标 error_call_count/invoke_count/avg_* 入库可查"
  verify_by:
    type: metric_probe
    probe: "health_snapshots 出现 metric_key=error_call_count/invoke_count/avg_tool_calls 行；GET /api/health/cost-output 返回 models[] 与 invokeStats[] 且无 cost 字段"
tags: [health, usage, model-dimension, dashboard, web]
modules:
  - src/usecases/health/cost-output-collector.ts
  - src/usecases/health/cost-output-rows.ts
  - src/usecases/health/rhi-scan-worker.ts
  - src/usecases/conversation/send-entry.ts
  - src/usecases/conversation/agent-turn-orchestrator/
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
  - web/src/api/client.ts
  - web/src/pages/health/index.tsx
---

# 背景

搭档想「站在 kimi k3 模型的角度统计每次问答的平均工具调用数/耗时/token 消耗」，打开健康面板发现只有一堆 token 费用，且不知道计价口径（2026-09-14 对话）。排查结论：

1. **费用不可信**：cost = pi-ai SDK `calculateCost()` 用模型目录单价本地估算。我们的模型全部走自定义端点（apiBaseUrl），模型不在 SDK 默认字典时 `models-factory.ts` 会继承「字典第一个模型」的单价当模板——anthropic 字典第一个是 claude-fable-5（$10/$50/$1 每百万）。验算 9/13-14 两天数据：glm-5.3 显示 $760.67，按智谱目录价（$1.4/$4.4/$0.26）真实约 $175，虚高 4.3 倍；glm-5.3-flash 因缓存读巨大虚高近 100 倍。
2. **多数模型无真实单价**：kimi/glm/mimo 都是订阅 plan，没有 per-token 单价——搭档拍板「不算价格，把用量展示好」。
3. **模型维度缺失**：采集粒度本就含 model，但面板只按獭展示；且獭是按对话分裂的临时实体（大獭互相独立、小獭只存活几轮），聚獭无意义——搭档拍板「模型是唯一统计主维度」。

# 目标

- T1 撤掉成本展示：面板「成本/产出」→「用量/效率」，删 cost 图卡与 $ 显示（采集管道保留 cost 字段，留作对账）
- T2 per-model 用量指标：token 四分类、调用次数、**失败次数**、缓存命中率——每模型一行
- T3 双占比图：Token 占比 + 调用次数占比（环形图，按模型）
- T4 单次 invoke 均值：总的一组 + 按模型各一组（工具调用数/耗时/输入输出 token）
- T5 獭维度降级：保留为折叠辅助视图（数据不丢，不占主视觉）

# 非目标

- 不修 models-factory 的单价继承 bug（cost 无消费方后留着无害；若未来要恢复费用展示需先修）
- 不做单次 LLM 调用耗时/首字延迟（JSONL 只有消息级 timestamp，口径不净）
- 存量 invoke（无 model 归属）归 unknown 桶，不回填

# 方案设计

## 数据流

```
session JSONL ──→ collectLlmCalls ──→ per-otter per-day per-model token/cost/errorCalls
invokes 表    ──→ collectInvokeStats ──→ per-day per-model (+_total) 单次均值
                      │
                      ▼
        buildCostOutputSnapshotRows + buildInvokeStatsRows
                      │
                      ▼
        health_snapshots (metric_type=cost_output)
                      │
                      ▼
        GET /api/health/cost-output → { series, models, invokeStats, otters, totals }
                      │
                      ▼
        Web「用量/效率」Tab
```

## 失败次数采集（errorCalls）

JSONL 每条 assistant message 有 `stopReason`，`"error"` 即 LLM 调用失败（如 k3 的 49 连 403）。collector 统计进 `errorCalls`，rows 层落 `error_call_count` 指标键（per-otter per-model 行 metadata 带 model）。端点层 `buildModelBreakdown` 按模型聚合。

## invoke 的 model 归属（零 migration 方案）

invokes 表无 model 列。利用现有 `metadata` JSON 列：orchestrator 在两条路径写 `metadata.model`——
- 成功路径：`tryCompleteInvoke` 里 `result.modelAlias`（SDK AgentRunResult 已回填）→ `callbacks.updateInvokeModel`
- 失败路径：`recordFailedAttempt` 后从 `err._modelAlias`（#543 已有机制）取 → 同回调

新增链路：`TurnCallbacks.updateInvokeModel?` → `agent-invoker` 适配 → `send-entry.updateInvokeModel`（merge 进 metadata，不动其他键）→ `invokeRepo.updateInvokeMetadata`。全部可选回调，测试 mock 零破坏。

## 单次 token 差分

invokes.token_usage_* 是 session 累计快照。`collectInvokeStats` 按 otter_id + started_at 升序相邻差分：首条/回退（新 session，累计值变小）取全量，否则取差值——与 agent-metrics.ts 差分逻辑同模式。均值分母只计有 token 值的行。

## 端点聚合（rhi-controller）

- `buildModelBreakdown`：窗口内全部 cost_output 行按 metadata.model 聚合（token 四分类/call/errorCalls/cacheHitRate 加权推导），totalTokens 降序
- `buildInvokeStats`：stats 行按 metadata.model 分组，取最新快照日值
- `buildCostTrendSeries`：加 errorCalls 进 AGGREGATE_KEYS；costTotal 移出（不再返回）
- `totals` 改从 models 汇总（原从 otters 汇总，语义不变但口径跟主维度）

## 口径防污染

invoke stats 行（invoke_count/avg_*）带 metadata.model，不进 series 的 AGGREGATE_KEYS 求和——两类指标键集合不相交（与 #583 混合求和说明同模式）。

# 改动清单

| 文件 | 改动 |
|---|---|
| cost-output-collector.ts | SessionMessageLine 加 stopReason；OtterCostRecord 加 errorCalls；新增 `collectInvokeStats`（差分 + per-model/_total 聚合） |
| cost-output-rows.ts | 新增 ERROR_CALL_COUNT + 5 个 invoke stats 指标键；新增 `buildInvokeStatsRows` |
| rhi-scan-worker.ts | persistCostOutputSnapshot 步骤追加 collectInvokeStats + buildInvokeStatsRows |
| orchestrator.ts | 成功/失败两路径写 `callbacks.updateInvokeModel?.` |
| agent-turn-orchestrator/types.ts | TurnCallbacks 加可选 `updateInvokeModel` |
| agent-invoker.ts | 适配 updateInvokeModel 回调 |
| send-entry.ts | 新增 `updateInvokeModel`（merge metadata） |
| rhi-controller.ts | 新增 buildModelBreakdown/buildInvokeStats；costOutput 响应加 models/invokeStats/errorCalls，删 cost 字段 |
| web/api/client.ts | DTO：RhiModelUsageDTO/RhiInvokeStatsDTO；totals 删 costTotal 加 errorCalls |
| web/pages/health/index.tsx | cost tab 重构：模型明细表 + 双占比环形图 + invoke 均值表 + 命中率/失败双轴图；獭明细折叠 |

# 决策记录

- **不修单价继承 bug**（L1）：cost 无消费方，修复无收益还引入 config 单价维护负担；留待真需要时再修
- **model 进 metadata 而非新列**（L1）：零 migration、复用现有 updateInvokeMetadata 通道；查询侧 JSON_extract 代价在采集端一次性承担
- **獭维度保留但折叠**（L2，搭档拍板）：獭是临时实体不适合做主维度，但数据不删——低优先展示

# 验证

- 单测：collectInvokeStats 差分/unknown 桶/耗时口径（cost-output-collector.test.ts）；models/invokeStats 聚合（rhi-api.test.ts）；error_call_count 行数（cost-output-rows.test.ts）
- 全量 vitest 244 files / 2876 tests 通过；tsc（主仓 + web）零错误
- 最简实现检查：已过——invoke stats 复用 invokes 表与现有 metadata 通道，无新表无 migration；模型聚合纯消费端重组，采集管道零改动
