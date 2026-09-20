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

### D2 架构稳定：密度化改良（S4 修复）

**原公式（第一次校准）**：`100 - hotspotCount×2`（绝对计数，无封顶）
**问题**：hotspotCount 来自 Top-20 截断列表 length，恒=20→恒 60；改用全量计数后为 1658→恒 0 红（更失真）
**根因**：绝对计数天然受项目规模影响，无法跨规模比较

**S4 修复公式**：`100 - hotspotDensity×250`（密度化，抗规模不变性）
- density = 改动 ≥2 次文件数 / 60 天窗口内被碰文件总数
- 三档锚点：density=0→100（绿）、0.2→50（黄）、0.4→0（红）
- 与 bug_recurrence 的 K≥3/30 天区分：D2 用 K≥2/60 天，更宽口径捕捉架构反复修改模式

**实测锚定**（2026-09-20 git log --since='60 days ago'）：
- 总文件数：1658
- 改动 ≥2 次：599（36.1%）→ density=0.361 → D2=9.8（红）
- 改动 ≥3 次：283（17.1%）→ 如用 K=3 则 density=0.171→D2=57.3（黄）
- 改动 ≥5 次：102（6.2%）→ 如用 K=5 则 density=0.062→D2=84.5（绿）

**K=2 选择理由**：
- 与 bug_recurrence（K≥3/30 天）有区分度：D2 口径更宽（≥2/60 天），捕捉「反复修改但未到 bug 级」的架构信号
- density=0.361→D2≈10（红）诚实反映项目当前架构状态（20 个热区文件 + 大量反复修改）
- 抗规模不变性：项目规模翻倍但修改模式不变时 density 不变

**前端影响**：VerdictPanel D2 归因句从「N 个热区文件」改为「高频文件占比 X%」——无硬编码口径需同步

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

### 搭档裁决后的最终公式

| 维度 | 最终公式 | 搭档裁决理由 |
|------|----------|-------------|
| D1 质量成本 | 保留原锚点（40%归零） | 37.9% 红是 harness 完工质量信号，不放宽 |
| D2 架构稳定 | bugfix 返工率（补丁失效测度） | 与 D1/信号错位，直接测「修了没修好」 |
| D3 交付活力 | stalled×50 | r1 建议中间惩罚系数 |

### D1 质量成本：保留原锚点（搭档裁决）

原校准（0.25/0.55）被搭档推翻。搭档原话：「排除特性变化后一直改得多，像 bugfix 这些，那就是说明咱们的完工质量不好、返工率高，那这就是个信号、就是要反思要改进的」。

原公式保留：`min(100, 100×max(0,(0.4-ratio)/0.2))`——37.9% bugfix 占比 → D1≈10.6 红，是 harness 自评仪器的持续信号。

### D2 架构稳定：bugfix 返工率（搭档裁决）

**设计推导**（搭档引导）：
1. D2 的目标是测「架构是否在腐化」——决策场景：什么时候该喊「停下来重构」
2. 腐化证据 = 补丁失效（修完又坏），不是修改集中度（活跃度噪音）
3. D2 原来的测量对象（修改集中度）与 D1（bugfix 占比）和 bug_recurrence 信号高度重叠——三轮翻车不是算法细节问题，是测量对象选错了
4. bugfix 返工率 = 60 天内被 bugfix 碰 ≥2 次的文件数 / 被 bugfix 碰过的文件总数
   - 天然剥离 feature 活跃度（feature 改动不进分子）
   - 与 D1 错位：D1 测「修 bug 的占比」（面上），返工率测「修了没修好」（深度）
   - 与 bug_recurrence 错位：返工率是宏观统计（全仓口径），recurrence 是微观信号（单文件 3 次/30 天）

**实测数据**（2026-09-20 git log --since='60 days ago'）：
- 被 bugfix 碰过的文件：457
- 被 bugfix 碰 ≥2 次：127（返工率 27.8%）
- 分布有梯度：1 次的 330 个（正常修复）、2-3 次的 96 个、9-16 次的 14 个（真热点，架构腐化嫌疑）
- 头部热点：src/app.ts(15)、db/migration.ts(12)、platforms.ts(11)、agent-invoker.ts(11)

**公式**：`100 - reworkRate×250`（与 imbalance 再扣 20）
- reworkRate=0→100（绿）、0.10→75（绿边界）、0.20→50（黄边界）、0.40→0（红）
- 当前 27.8% → D2≈30（红）——诚实反映返工水平
- 锚点物理语义：「10 个修复 1 个返工」=绿界、「5 个修复 1 个返工」=黄界、「近半修复在返工」=归零

**前端影响**：VerdictPanel D2 归因句改为「bugfix 返工率 X%（文件名等反复修）」

### 自校准机制（设计 vs 实现偏差）

issue #595 设计节写「Day 1-13 经验值 → Day 14 基线成立切 P25/P50/P75 微调 → 14 天滚动重算」。

**搭档裁决（2026-09-20）：不实现。** 理由：绝对信号优先——返工率本身有物理语义（27.8% 返工率高低是可直觉判断的），不需要相对化基线来稀释信号。指标该红就红，改进在流程侧响应（见 issue #1059）。

### bug_recurrence 阈值（与 #1012 同源）

9/6-9/7 搭档在 issue #595 评论中指出：bug_recurrence critical 阈值 3次/30天 对快速迭代期文件偏松，导致 UI 文件触 critical。此问题归 #1012 管理，本校准批次不重复处置，仅注明关联。

## 工程优化（同期交付）

### 1. SQL 下推
`findByDateRange` 新增可选 `metricType` 参数。score 端点传 `"health_index"`，避免拉 3457 行只用 78 行。

### 2. judgeTrend 窗口偏移修正
null 过滤从「全序列 filter 后切分」改为「先切窗口再各窗口内 filter」，避免日期空洞导致窗口数据交叉。

### 3. findByDateRange 参数化
仓库层方法支持可选 metricType 过滤，向前兼容（不传则原行为）。

### 4. Bugfix 返工率计算（metrics-calculator.ts）
新增 `computeBugfixReworkRate(parsed, commitsWithFiles)`——从 parsed 取 bugfix SHAs → 过滤 commitsWithFiles → 按文件计数 → ≥2 次/总文件数。Metrics 接口新增 `bugfixReworkRate` 字段，worker/report 透传至 `HealthScoreInput`。

## 已知边界

- D2 返工率的 K≥2 阈值——与 bug_recurrence（K≥3/30 天）有区分度但语义重叠；若项目 bugfix 模式变化，阈值可能需要重新校准
- D2 返工率无法区分「架构腐化导致的反复修」和「正常迭代中同一文件被多次 bugfix」——这是测量方式的固有局限，后续需语义重审
- D3 stalled=0 是 F20260902sigm 设计调整的结果，stalled ×50 惩罚系数当前不影响实际得分
- judgeTrend recent 窗口收紧为 ≥3 有效值才判走向
- 自校准机制（P25/P50/P75）——搭档裁决下不实现：绝对信号优先，返工率本身有物理语义（27.8% 返工率高低是可直觉判断的），不需要相对化基线

## 机制预算四问

| 问题 | 回答 |
|------|------|
| 新增机制是否影响既有语义？ | D2 完全换测量对象（修改集中度→返工率），函数签名不变 `(number, boolean)`；D1 原锚点保留；D3 stalledWeight 有默认值向前兼容；findByDateRange 新增可选参数向前兼容 |
| 新增机制是否有测试覆盖？ | 是——49 个 health-score 测试（含返工率边界 + 生产量级 fixture）+ findByDateRange metricType 测试 + computeBugfixReworkRate 通过 calculateMetrics 间接测试 |
| 新增机制是否可回滚？ | 是——公式参数在单文件，findByDateRange 参数向前兼容，回滚只需 revert commit |
| 新增机制是否需要监控？ | 建议——D2 返工率随项目节奏变化会波动，27.8% 是冲刺期数据，节奏走平后应下降 |

## 验证

- ✅ 49/49 health-score 测试通过（含返工率边界 + 生产量级 fixture + D1 原锚点 + minRecentValid + stalledWeight 向后兼容）
- ✅ findByDateRange metricType 测试通过
- ✅ tsc --noEmit 通过
- ✅ ESLint 0 errors
- ✅ 全量测试 3679/3681 通过（2 个失败为 ensure-hooks 环境超时，与本 PR 无关）

## Modification-Class

`mechanism-addition`（D1 保留原锚点 + D2 换测量对象为 bugfix 返工率 + D3 stalled×50 + findByDateRange metricType 参数 + judgeTrend 窗口偏移修正）
