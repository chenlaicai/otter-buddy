---
id: F20260920hcal
title: 健康指标评分校准：五维度公式实测校准 + 三条工程优化
summary: >-
  基于 20 天实测 health_snapshots 数据校准 D1/D2/D3 公式参数，
  修复 D1 长期红（结构性 bugfix 占比撞 40% 归零锚点）和 D2 恒 40（×4+cap60 饱和）的
  区分度失真；D3 stalled 权重从 ×100 降至 ×50（r1 建议）；同期交付 SQL 下推、
  judgeTrend 窗口偏移修正、findByDateRange metricType 过滤三项工程优化。
change_type: feature
capability_test: n/a（评分公式纯函数，边界用例在 tests/usecases/health/health-score.test.ts 覆盖）
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-09-20T10:27:00+08:00
doc_type: feature
tags: [rhi, health-index, scoring, calibration]
modules:
  - src/usecases/health/health-score.ts
  - src/usecases/health/health-snapshot-repository.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
  - tests/usecases/health/health-score.test.ts
from:
  - F20260829hscx
---

# 健康指标评分校准

## 背景

issue #595 的 PR1（#597，8/29 合入）+ PR2（#606，9/1 合入）交付了五维度健康分评分引擎和面板。设计文档留下「合入后 ≥2 周实测数据校准权重/阈值」的后续项。今天 Day 20，health_snapshots 表有 20 天 health_index 快照，数据满足校准条件。

### 20 天实测暴露的问题

| 问题 | 实证 | 根因 |
|------|------|------|
| D1 长期红 | 10/20 天 D1 在 0-11 分；bugfix 占比 37-40% 撞上 40% 归零锚点 | 40% 归零阈值过紧：项目处于高密度迭代期 + issue 流水线模式，37-40% 是结构性现实不是质量腐烂 |
| D2 恒 40 无区分度 | 20 天 D2 纹丝不动 = 40 | ×4+cap60：≥15 热区文件即饱和封顶；项目一直有 20 个热区文件，15-100 个热区分数全一样 |
| 自校准机制缺失 | 设计写「Day 14 切 P25/P50/P75 微调」，health-score.ts 中 grep percentile/P25 零命中 | 设计 vs 实现偏差——本期不补，留搭档拍板 |
| stalled 惩罚过重 | D3 stalled ×100 与 zombie 同级；r1 建议中间惩罚系数 | 9/3 后 stalled=0（设计调整），但为未来复现预留 |

### 数据源

- `health_snapshots` 表 20 天全量数据（snapshot_date 2026-08-30 ~ 2026-09-20）
- `signals` 表 open 信号计数：critical=44, warning=106
- `chain_states` 最新快照：active=572, regressed=3, orphan=9（stalled=0 自 9/3 起）
- `git log --since="30 days ago"`：367 提交，BugFix=139（37.9%）

## 方案设计

### D1 质量成本：三档锚点重校

**原公式**：`min(100, 100×max(0, (0.4-ratio)/0.2))`
- 三档：≤20% 满分 / 30% = 50 / ≥40% 归零

**校准公式**：`min(100, 100×max(0, (0.55-ratio)/0.30))`
- 三档：≤25% 满分 / 40% = 50 / ≥55% 归零

**校准依据**（30 天 commit 分类统计）：
- git log 367 提交：BugFix=139（37.9%）、New Feature=113、Feature Update=59
- bugfix 占比 37-40% 是项目在 issue 流水线模式下的结构性产出，不是质量指标恶化
- 原 40% 归零 = 项目几乎永远红灯，丧失告警意义

**校准后效果**：

| 日期 | ratio | 旧 D1 | 新 D1 | 变化 |
|------|-------|-------|-------|------|
| 8/30 | 24.6% | 70.8 | 100 | +29 |
| 9/1 | 34.3% | 48.7 | 69 | +20 |
| 9/4 | 38.2% | 8.8 | 56 | +47 |
| 9/16 | 40.1% | 0 | 49.7 | +50 |
| 9/20 | 37.9% | 10.6 | 57 | +46 |

### D2 架构稳定：去除饱和封顶

**原公式**：`100 - min(60, hotspotCount×4) - (imbalance?20:0)`
- ≥15 热区时恒 = 40（饱和封顶）

**校准公式**：`100 - hotspotCount×2 - (imbalance?20:0)`
- 无饱和封顶，线性退化

**校准依据**：
- 20 天实测 D2 全部 = 40（hotspotCount 恒 20），指标完全丧失「走向」价值
- 原注释「×10 导致 10 热区即归零，20 热区与 100 热区无区分度」——但 ×4+cap60 引入了新的饱和：15-26 热区全 = 40
- ×2 无封顶：10 热区=80（绿）、15 热区=70、20 热区=60（黄）、30 热区=40（红）

**校准后效果**：

| 热区数 | 旧 D2 | 新 D2 | 变化 |
|--------|-------|-------|------|
| 10 | 60 | 80 | +20 |
| 15 | 40 | 70 | +30 |
| 20 | 40 | 60 | +20 |
| 30 | 40 | 40 | 0 |
| 50 | 40 | 0 | -40 |

### D3 交付活力：stalled 中间惩罚系数

**原公式**：`active%×100 - regressed%×150 - stalled%×100`
**校准公式**：`active%×100 - regressed%×150 - stalled%×50`（stalledWeight 默认 50）

**校准依据**：
- r1 建议：stalled-only 给 0 分与 zombie 同级，建议中间惩罚区分
- 当前 stalled=0（9/3 后消失），此校准是防未来复现的安全垫
- 向后兼容：`scoreD3(states, 100)` 等效旧公式

### judgeTrend 窗口偏移修正

**原实现**：`series.filter(v→v!==null)` → 按有效值切窗口
**修正实现**：先 `series.slice()` 按日期切窗口 → 各窗口内 `filter(v→v!==null)`

**问题**：null（无数据日）穿孔导致前窗口数据点被后窗口「借用」。当 series 有日期空洞（如 9/5 缺失），全序列 filter 后切分让前 7 天的有效数据可能混入后 7 天的窗口。

### SQL 下推：findByDateRange metricType 过滤

**问题**：`rhi-controller.ts score()` 端点调用 `findByDateRange` 拉全量快照行（包括 overview/distribution/cost_output），再 JS `.filter(r => r.metric_type === "health_index")`。14 天窗口拉 3457 行，实际只需 78 行 health_index。

**修复**：`findByDateRange` 新增可选 `metricType` 参数，SQL 层 `WHERE metric_type = ?`。score 端点传 `"health_index"`。

## 校准前后对照

### 旧公式 vs 新公式（20 天回放）

> **注意**：此对照表的 ratio 来自 health_snapshots 的 D1 归因元数据（bugfix 占比），反映快照计算时的 60 天窗口状态。当前数据库 overview 表的 ratio 可能因窗口滚动而略有差异（方向性结论不受影响）。

| 日期 | 旧 overall | 新 overall | 旧 D1 | 新 D1 | 旧 D2 | 新 D2 |
|------|-----------|-----------|-------|-------|-------|-------|
| 8/30 | 65.5 | 79.5 | 70.8 | 100 | 0 | 60 |
| 8/31 | 70.2 | 82.2 | 56.6 | 77.7 | 40 | 60 |
| 9/1 | 68.1 | 79.1 | 48.7 | 69.0 | 40 | 60 |
| 9/2 | 64.1 | 77.8 | 32.5 | 71.7 | 40 | 60 |
| 9/3 | 65.3 | 80.2 | 24.2 | 66.0 | 40 | 60 |
| 9/4 | 61.7 | 76.5 | 8.8 | 56.0 | 40 | 60 |
| 9/6 | 61.4 | 76.3 | 7.5 | 55.0 | 40 | 60 |
| 9/7 | 61.0 | 76.2 | 6.3 | 54.3 | 40 | 60 |
| 9/8 | 61.0 | 76.1 | 6.2 | 54.0 | 40 | 60 |
| 9/9 | 61.1 | 76.2 | 6.0 | 53.7 | 40 | 60 |
| 9/10 | 61.1 | 76.2 | 6.0 | 53.7 | 40 | 60 |
| 9/11 | 61.1 | 76.2 | 6.0 | 53.7 | 40 | 60 |
| 9/12 | 60.3 | 75.7 | 2.9 | 50.3 | 40 | 60 |
| 9/13 | 60.9 | 76.1 | 5.1 | 53.2 | 40 | 60 |
| 9/14 | 60.0 | 75.5 | 1.8 | 49.3 | 40 | 60 |
| 9/15 | 60.6 | 75.8 | 4.1 | 52.0 | 40 | 60 |
| 9/16 | 59.6 | 75.0 | 0 | 49.7 | 40 | 60 |
| 9/17 | 62.2 | 76.8 | 10.1 | 56.7 | 40 | 60 |
| 9/18 | 62.3 | 77.0 | 10.8 | 57.3 | 40 | 60 |
| 9/20 | 62.3 | 77.9 | 10.6 | 57.0 | 40 | 60 |

**总体效果**：
- 旧 overall 均值 62.4（黄色偏低），新 overall 均值 77.2（绿色）
- 旧 D1 均值 16.2（红色），新 D1 均值 59.0（黄色）——区分度从「全红无梯度」恢复为「黄色有梯度」
- 旧 D2 恒 40，新 D2 = 60（当前固定 20 热区，但恢复了 10-30 热区的梯度）

### 校准判断

校准不是粉饰：
- D1 的 bugfix 占比 37-40% 确实高于理想的 25%，新公式给 50-57 分（黄色）——仍标记为「需要关注」，但不再是「天天红灯喊狼来了」
- D2 的 20 个热区文件确实偏多，新公式给 60 分（黄色）——比原来的 40 分更准确反映「有热区但未到灾难级」
- 如果 bugfix 占比突破 55% 或热区文件超 30，新公式照样归零/归红——校准没有降低标准，是把标尺对准了实际刻度
- D2 热区计数改为全量（不受 Top-N 截断），确保校准梯度真实生效

### 自校准机制（设计 vs 实现偏差）

issue #595 设计节写「Day 1-13 经验值 → Day 14 基线成立切 P25/P50/P75 微调 → 14 天滚动重算」。今天 Day 20，health-score.ts 中 grep percentile/P25/baseline/selfCalibrat 零命中——**设计与实现有偏差，本期不补，留搭档拍板是否需要实现。**

### bug_recurrence 阈值（与 #1012 同源）

9/6-9/7 搭档在 issue #595 评论中指出：bug_recurrence critical 阈值 3次/30天 对快速迭代期文件偏松，导致 UI 文件触 critical。此问题归 #1012 管理，本校准批次不重复处置，仅注明关联。

## 工程优化（同期交付）

### 1. SQL 下推
`findByDateRange` 新增可选 `metricType` 参数。score 端点传 `"health_index"`，避免拉 3457 行只用 78 行。

### 2. judgeTrend 窗口偏移修正
null 过滤从「全序列 filter 后切分」改为「先切窗口再各窗口内 filter」，避免日期空洞导致窗口数据交叉。

### 3. findByDateRange 参数化
仓库层方法支持可选 metricType 过滤，向前兼容（不传则原行为）。

### 4. D2 热区计数去截断（F20260920hcal S3 修复）
metrics-calculator.ts computeFileHotspots 返回 `{ total, topN }`——total 用于 D2 评分（不受 Top-N 截断），topN 用于 UI 展示和归因句。Metrics 接口新增 `totalHotspotFiles` 字段。

## 已知边界

- D2 热区文件数现在使用全量计数（不受 Top-N 截断），30 热区=40 红的护栏声明成立
- D3 stalled=0 是 F20260902sigm 设计调整的结果，stalled ×50 惩罚系数当前不影响实际得分
- judgeTrend 窗口偏移修正要求 series 长度 ≥ 8（含 null）且 prior 窗口内有效值 ≥ 7——如果 prior 窗口 null 过多（≤6 个有效值），仍返回 null（数据不足）
- judgeTrend recent 窗口收紧为 ≥3 有效值才判走向（旧版放行 1 个，噪声过大）
- 对照表 ratio 来自快照计算时的 60 天窗口，当前 DB overview ratio 可能因窗口滚动而略有差异

## 机制预算四问

| 问题 | 回答 |
|------|------|
| 新增机制是否影响既有语义？ | 否——D1/D2/D3 公式参数调整不改变函数签名（D3 的 stalledWeight 有默认值），findByDateRange 新增可选参数向前兼容 |
| 新增机制是否有测试覆盖？ | 是——49 个 health-score 测试 + findByDateRange metricType 测试 + snapshot-rows totalHotspotFiles 测试 |
| 新增机制是否可回滚？ | 是——公式参数在单文件，findByDateRange 参数向前兼容，回滚只需 revert commit |
| 新增机制是否需要监控？ | 建议——D1/D2 分布变化可通过 health_snapshots 对比新旧参数快照追踪 |

## 验证

- ✅ 49/49 health-score 测试通过（含新旧公式边界 + 窗口偏移 + minRecentValid + stalledWeight 向后兼容）
- ✅ findByDateRange metricType 测试通过
- ✅ tsc --noEmit 通过
- ✅ ESLint 0 errors
- ✅ 全量测试 3681/3681 通过（0 失败）

## Modification-Class

`mechanism-addition`（D1/D2/D3 公式参数调整 + findByDateRange metricType 参数 + judgeTrend 窗口偏移修正 + D2 热区计数去截断）
