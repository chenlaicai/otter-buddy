---
id: F20260829hviz
title: 健康面板数据断链修复 + 可视化看板
summary: 修 RHI 健康面板两条数据断链（scanOnce 不写指标、CLI 写错库），新增 GET /api/health/trends 历史序列端点与 recharts 可视化看板（趋势折线图/类型环形图/模块热区/五态堆叠条），并用真实 git 历史回填 30 天快照让面板立刻有内容。
change_type: feature
status: development
created_in_conversation: 09bf83a5-8a9a-4aba-815e-a92c783b4800
capability_test: tests/usecases/health/rhi-scan-worker.test.ts
tags: [rhi, health-dashboard, metrics, recharts, visualization, bugfix]
modules:
  - src/usecases/health/rhi-scan-worker.ts
  - src/usecases/health/snapshot-rows.ts
  - src/usecases/health/health-report.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
  - src/interface-adapters/http/router.ts
  - src/app.ts
  - scripts/health-report.mjs
  - scripts/health-backfill.mjs
  - web/src/pages/health/index.tsx
  - web/src/api/client.ts
from:
  - F20260824rhib
  - F20260825rweb
  - F20260825sgnw
supersedes: []
---

# F20260829hviz 健康面板数据断链修复 + 可视化看板

## 背景与问题

搭档 8/28 反馈：健康面板"一堆指标里只有严重有值，其余都没值……只是原始数字的列出展示，想要折线图/比率图"。排查发现两条数据断链 + 一处展示层缺失：

1. **断链 A（管道缺环）**：`RhiScanWorker.scanOnce()` 只跑「git 采集 → 链构建 → 信号检测 → 信号落库」，从头到尾不调 `MetricsCalculator`，指标永远不进 `health_snapshots` 表。面板「立即扫描」无效——critical/warning 有值是因为读的是另一张 signals 表。
2. **断链 B（CLI 错库）**：`scripts/health-report.mjs` 默认写 `data/otter.db`（废弃路径），服务实际用 `data/otter-buddy.db`（config.database.path）。唯一会写指标的通道写进了孤儿库。
3. **展示层**：前端总览是 8 张静态数字卡，无任何图表能力；无历史序列端点。

## 方案设计

三步走（搭档 8/28 14:07 确认"开始"）：

### Fix A：scanOnce 接入指标计算 + 快照写入

- 新增 `src/usecases/health/snapshot-rows.ts`：`buildOverviewSnapshotRows()` 纯函数，构建 11 行标准快照（7 overview 数值行 + 4 distribution 行），从 `HealthReport.persistMetrics` 一比一抽取——CLI 与 worker 两条写入路径共用同一构建逻辑。
- `RhiScanWorkerOptions` 新增 `snapshotSink` 端口（`(snapshotDate, rows) => void`）+ `metricsWindowDays`（默认 60）。
- `scanOnce()` 第 7 步：按 60 天滚动窗口过滤 signalInputs → `calculateMetrics` → 11 标准行 + `chain_states` 分布行（worker 独有，链构建产物）→ sink 落库。
- **旁路隔离**：快照失败 try-catch 吞掉（log warn），不影响信号管道——指标是旁路不是主路。
- `metricsStored` 计数加入 `RhiScanResult` 返回。
- 窗口独立的理由：链/信号采集窗口是 `windowDays + 30` 余量（链构建需要更早历史），直接复用会污染指标分子分母。
- `app.ts` 的 `createRhiScanWorker` 注入 sink = `HealthSnapshotRepository.replaceForDate`。

**实现中发现并修复的第三个 bug**：`chain_states` 行的 `snapshotDate` 初版留空（设想 sink 侧覆盖），但 `replaceForDate` 的 INSERT 用行内字段——空串插出 `snapshot_date=''` 的无日期行，按日期查询永远查不到。修复：行内日期真实填写。`/tmp/sink-test.db` 实测复现并验证修复。

### Fix B：CLI 默认库路径修正

`scripts/health-report.mjs` 默认 dbPath 从 `data/otter.db` → `data/otter-buddy.db`（与服务运行时同库）。

### Fix C：历史回填 CLI

新增 `scripts/health-backfill.mjs`（`pnpm health:backfill [--days=30] [--db=...] [--dry-run]`）：

- 逐天循环 `HealthReport.generate({ since, until, snapshotDate })`：`since` = 当日往前 60 天（与 metricsWindowDays 同口径），`until` = 当日 23:59:59（杜绝未来数据穿越）。
- 同日 DELETE+INSERT 幂等，可重跑。
- 回填不写 chain_states 行（链构建是实时管道，历史重建成本高）；当天 worker/手动扫描自然补上。
- `HealthReportOptions` 新增 `snapshotDate` 参数（原来硬编码今天，回填历史会互相覆盖）。
- 真实数据效果：本机 30 天回填产出 30 天 × 11 行 = 330 行，最新一天 93 commits / bugfix 29.03%。

### Step 2：trends 端点 + 可视化看板

**后端** `GET /api/health/trends?days=30`（1-90 钳位）：

- `series`：按日聚合的 `{date, total_commits, bugfix_count, bugfix_ratio, compliant_commits}`，比率键 ×100 转百分比点位。
- `distributions`：范围内最新一天的 change_types / skip_reasons / modules / file_hotspots / chain_states（metadata JSON 解析，坏 JSON 降级 null）。
- 序列聚合与分布解析拆为模块级纯函数（`aggregateTrendSeries` / `parseLatestDistributions`），controller 复杂度 14→10 通过 lint（complexity max 12）。

**前端**（web 引入 recharts ^2.15.4，React 生态标准图表库——技术选型自行拍板）：

- **趋势图**：ComposedChart 双 Y 轴——柱 = total_commits（日提交量），线 = bugfix_ratio（百分比）。
- **类型分布**：环形图（changeTypeDistribution，中文标签映射）。
- **模块热区**：水平条形图 TOP 8。
- **五态堆叠条**：特性链 active/stalled/regressed/zombie/orphan 按占比分宽 + 图例（总览与特性链两视图共用组件）。
- 快照缺失时显示引导空态（"点立即扫描生成第一份"）。
- 信号/特性链列表视图保持原样（列表本来就是这些视图的正确形态）。

## 验证

- 单元/集成测试：1980 passed（165 files）全量绿，其中新增：
  - `snapshot-rows.test.ts`（4 用例：11 行结构、日期一致性、JSON 合法、extraRows 追加）
  - `rhi-scan-worker.test.ts` +3（sink 注入写入 12 行、未注入跳过、sink 抛错不影响信号）
  - `rhi-api.test.ts` +3（trends 序列与分布、空库、days 钳位）
- 端到端实测（本机真实库）：
  - 回填 30 天 → 330 行快照
  - 手动扫描 → metricsStored: 12，chain_states 行正确落库（315 链：261 active / 50 stalled / 4 orphan）
  - `/api/health/trends` 返回 30 天序列 + 最新分布
- 视觉验证：Playwright 截图三视图（总览图表/信号/特性链）均正常渲染，recharts 图表含数据。

## 已知取舍

- **chunk 体积**：recharts 使 web bundle 超 500KB 警告线（既有警告，非新增阻塞）。
- **chain_states 历史缺失**：回填不含链态分布历史（实时管道产物），堆叠条只显示最新一天。
- **趋势图首日起点**：回填最早一天（如 7/30）的 60 天窗口会缺更早数据，序列前几点的 total_commits 偏小是口径现象不是 bug——比率（分母同步变小）不受影响。

## 变更清单

| 文件 | 变更 |
|------|------|
| src/usecases/health/snapshot-rows.ts | 新增：共享快照行构建 |
| src/usecases/health/rhi-scan-worker.ts | snapshotSink 端口 + persistSnapshot + chain_states 行 |
| src/usecases/health/health-report.ts | snapshotDate 参数 + 复用共享构建 |
| src/interface-adapters/http/controllers/rhi-controller.ts | trends 端点 + 两个聚合纯函数 |
| src/interface-adapters/http/router.ts | trends 路由 |
| src/app.ts | createRhiScanWorker 注入 snapshotSink |
| scripts/health-report.mjs | 默认库路径修正 |
| scripts/health-backfill.mjs | 新增：历史回填 CLI |
| web/src/pages/health/index.tsx | 可视化看板（4 图 + 空态） |
| web/src/api/client.ts | RhiTrendsDTO + getRhiTrends |
| web/package.json / package-lock.json | recharts 依赖（npm，与 CI 一致） |
| tests/*（3 文件） | 新增 10 个用例 |
