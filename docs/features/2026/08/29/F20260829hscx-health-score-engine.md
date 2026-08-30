---
id: F20260829hscx
title: 健康指标评分引擎：五维度健康分与拖累归因
summary: 在 RHI 可观测数据之上建语义层后端：五维度健康分纯函数（质量成本/架构稳定/交付活力/流程合规/信号压力）+ 状态分级 + 走向判定 + 拖累归因，worker 旁路写 health_index 快照行 + score API 端点，CLI/backfill 口径继承。全确定性规则，复用既有快照管道零新表。
created: 2026-08-29
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
status: development
change_type: feature
capability_test: "n/a: 纯评分函数逻辑，边界由 health-score.test.ts 36 用例覆盖，无 prompt 行为"
tags: [rhi, health-index, scoring]
modules:
  - src/usecases/health/health-score.ts
  - src/usecases/health/rhi-scan-worker.ts
  - src/usecases/health/health-report.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
from:
  - F20260824rhib
  - F20260829hviz
---

# 健康指标评分引擎：五维度健康分与拖累归因

## 背景

搭档（2026-08-29）：「当前你只是给我展示了一些数字……我期望能看到各种健康指标能反映出系统的健康走向、健康状态。可观测数据 > 健康指标。」——#557 四图看板解决了数据可读性，本特性在其上建**语义层**，让面板能回答「系统健康吗 / 往哪走 / 哪里拖后腿」。

设计经异模型对抗审视闭环（检视獭-hidx，mimo）：3 严重发现全修（D1 公式矛盾+clamp、D5 活跃链口径、冷启动确定性化）。设计与实施追踪见 issue #595。本 PR 为其中 **PR1 评分引擎**（PR2 面板展示另行交付）。

## 方案

### 评分模型（全确定性，无 LLM 判定）

| 维度 | 评分函数 | 无数据条件 |
|---|---|---|
| D1 质量成本 | `min(100, 100×max(0,(0.4-ratio)/0.2))`——≤20% 满分、30% 得 50、40% 归零 | 无提交 |
| D2 架构稳定 | `100 - 热区文件数×10 - imbalance?20:0`，clamp | — |
| D3 交付活力 | `active占比×100 - regressed占比×150 - zombie占比×100`，clamp | 无 chain_states 行 |
| D4 流程合规 | `compliance_rate × 100` 线性 | 无提交 |
| D5 信号压力 | `100-(critical密度×40+warning密度×30)`，密度=信号数/活跃链数 | 活跃链=0 |

- 活跃链口径（审视 S2）：state∈{active, stalled}（zombie/orphan 积压由 D3 惩罚，不重复压 D5）
- 状态分级：≥75 绿 / 50-74 黄 / <50 红；综合分 = 加权（D1×0.25+D2×0.20+D3×0.25+D4×0.10+D5×0.20），无数据维度权重归一
- 走向判定：近 7 天均值 vs 前 7 天均值，±5 判 ↑/↓（不足 8 数据点为 null「—」）
- 拖累归因：最低维度 + 该维度最大扣分项 → 人类可读一句话（D3 扣分项四级优先级 zombie > regressed > orphan > stalled，取第一个非零项；全零时无归因）

### 数据流

- **worker 旁路**（主口径，最全）：`rhi-scan-worker.persistSnapshot` 在标准 11+1 行后追加 health_index 行（D3/D5 含链数据）——评分失败与快照失败同降级，不阻断信号管道
- **CLI/backfill 口径**：`HealthReport.generate` 持久化时同步追加（chainStates=null → D3/D5 无数据，综合分按 D1/D2/D4 归一）；worker 当日扫描 replaceForDate 全量覆盖，最后写入者口径最全
- **score API**（`GET /api/health/score`）：读近 14 天 health_index 行 → 最新日维度分+状态+归因 + 每维走向；无行时返回 `available:false` 空态

### 实测观察（留给 #595 校准项）

真实仓库冒烟：bugfix_ratio 25.2% → D1=74、D4=74、D2=0（hotspot topN=20 时 20 文件×10 分必扣满）→ overall=47 红。**D2 线性斜率对 topN 敏感**：热区文件数≈topN 时 D2 恒 0——权重/斜率校准已列 #595 后续（上线 ≥2 周实测后调整）。

## 自校准阈值（本 PR 未实现）

设计含 14 天基线 P50 微调 + 冷启动策略（Day1-13 经验值→Day14 切换留痕→14 天滚动）。本 PR 交付固定经验阈值与评分骨架，自校准作为 #595 后续增强（settings 表 key 预留设计）。

## 验证

- **单测**（39 个新增）：D1 公式边界（0/0.05/0.2/0.3/0.4/0.9）+ clamp 上下界、D2 失衡与 clamp、D3 惩罚系数与归因（含四级优先级 zombie>regressed>orphan>stalled）、D5 活跃链口径与零链降级、状态分级边界（49.9/50/74.9/75）、走向判定（±5 严格大于边界、不足 8 点 null、null 点剔除）、综合分权重归一、health_index 行构建
- **worker 端到端**：临时仓库+真 sqlite 断言 18 行（11+1+6 health_index），含维度/overall 行与 metadata
- **全量回归**：2158/2158 通过；tsc 零错误；eslint 零 error（3 个既有 warning 非本次引入）
- **真实仓库冒烟**：115 commits 真实数据 → 归因句正确指认 `src/app.ts` 热区为主要拖累
- **顺手修复**：rhi-scan-worker 测试 flaky（同秒 commit 日期排序平局致 active/regressed 随机翻转）——夹具改为递增 1 小时唯一日期，5 连跑稳定
- **最简实现检查**：已过——评分纯函数复用既有 metrics/chainStates 零新采集；health_index 行复用 health_snapshots 零新表；CLI 扩展走 HealthReport 单点，backfill 零改动继承

## 影响范围

| 文件 | 变更 |
|---|---|
| `src/usecases/health/health-score.ts` | 新增：评分纯函数 + 行构建（约 300 行含注释） |
| `src/usecases/health/rhi-scan-worker.ts` | 修改：options +signalRepo；persistSnapshot 旁路追加 health_index 行 |
| `src/usecases/health/health-report.ts` | 修改：持久化追加 CLI 口径 health_index 行 |
| `src/interface-adapters/http/controllers/rhi-controller.ts` | 修改：+score 端点 + 聚合辅助函数 |
| `src/interface-adapters/http/router.ts` | 修改：+1 路由 |
| `src/app.ts` | 修改：worker 装配注入 signalRepo |
| `tests/usecases/health/health-score.test.ts` | 新增：36 用例 |
| `tests/usecases/health/rhi-scan-worker.test.ts` | 修改：断言 18 行 + flaky 修复 |

## 后续

- PR2：面板综合分卡 + 五维雷达图（消费本 PR 的 score API）
- #595 后续：自校准阈值实现、权重/斜率实测校准、Phase 3 判据接口契约
