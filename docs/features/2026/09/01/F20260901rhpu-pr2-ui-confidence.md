---
id: F20260901rhpu
title: "健康面板重设计 PR2：总览+信号 UI 重构 + confidence 口径方案甲"
summary: "总览从统计仪表变出血点仪表——复发模式卡（bug●→fix● 时间轴）首屏主角、低置信折叠抽屉、热点热力条、趋势降 sparkline、色彩 token 统一（图表默认蓝绿橙退场）；#652 方案甲：confidence=low 不计入 critical 计数与健康分 D5，overview 单列 openSignalsByConfidence；#647 新增 post_merge_fix_density 信号（合并后修复密度，14/21/30 天分档窗口 + 高扇入排除清单可见）。"
change_type: feature
status: development
created_at: 2026-09-01
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 确定性 UI 组件与计数口径改动，无 LLM 行为涉及"
from:
  - F20260901rhdt  # PR1 数据修真（evidence_detail + confidence 数据层）
intent:
  problem: "PR1 把模式存成了结构化数据，但消费侧没跟上：countOpenBySeverity 不过滤 confidence，18 条 low 信号全额计入 critical 计数与健康分（#652 口径断层）；首屏没有像素在讲模式——趋势图拿 40% 高度放聚合统计，复发信号藏在第二个 tab 的平铺列表里；图表用默认蓝绿橙，红=需要行动的语义被 BugFix 比率线稀释。"
  why_now: "chen 已确认视觉方向（观澜 ui-redesign-visual-review.md）与信息架构（ui-redesign-info-arch.md）；#658（#645 零成本检测器）已合入提供 fix_interval 指标行。PR1 数据层已就绪，PR2 UI 是它的直接消费方。"
  verify_by: "面板打开总览：复发模式卡在首屏右上有时间轴；低置信信号折叠在抽屉；overview 的 critical 计数与折叠抽屉外的信号一致（不含 low）；图表无默认蓝绿橙。"
---

# F20260901rhpu 健康面板重设计 PR2：总览+信号 UI 重构 + confidence 口径方案甲

> 状态：已实现，待对抗审视
> 作者：开发獭-647（glm）
> 日期：2026-09-01
> 触发：Issue #647（PR2 UI 六项）+ Issue #652（confidence 消费侧口径，方案甲）
> 前身：F20260901rhdt（PR1 数据修真——evidence_detail / confidence / 链详情端点）

## 1. 背景

- **#652 口径断层**：PR1 为 chain_stall 引入置信分层（stalled ∧ 有 commit → low，实测 18/18 滞留信号全是「干完没归档」型误报），但消费侧 countOpenBySeverity 只按 severity 计数。若 PR2 做视觉折叠而计数不动，会出现「卡片折叠了、总分纹丝不动」的观感断裂。
- **#647 六项改动**（issue 正文为完整验收面）：
  1. 复发模式卡（首屏主角）：bug●→fix● 时间轴证据链，频次徽章从 evidence_detail.commits 派生，**禁用 occurrences**（扫描触发次数，随扫描频率漂移）
  2. 低置信折叠抽屉：18 条假警报折叠收纳，明细可展开（数据不丢）
  3. 热点热力条：30 天修改频次 teal→caramel
  4. 趋势图降 sparkline：首屏 40% 高度让位复发卡
  5. 色彩 token 统一：图表默认蓝绿橙退场；红色只用于「需要行动」元素
  6. 合并后修复密度信号：14/30 天窗口按规模分档（实施为 14/21/30），bugfix≥3 次或占比≥30% 触发；三条边界——高扇入排除清单可见 / 占比分母=触碰链文件的 bugfix 占链窗口内全部相关 commit 比例 / 合入时刻=FID 最后 main commit

## 2. 方案

### 2.1 #652 方案甲：后端口径先行（低置信不进主数）

| 改动点 | 文件 | 内容 |
|---|---|---|
| D5 输入过滤 | `src/usecases/health/rhi-scan-worker.ts` | `countOpenBySeverity()` 跳过 `confidence === "low"`——low 不计入 critical/warning 计数，健康分 D5 输入即为过滤后口径 |
| overview 单列 | `src/interface-adapters/http/controllers/rhi-controller.ts` | `openSignalsBySeverity` 只计 normal；新增 `openSignalsByConfidence: { normal, low }` 单列；`openSignals` 保持全量（low 仍是待核实事件） |
| 口径注释 | `src/usecases/health/health-score.ts` | D5 头注释声明置信过滤发生在源头（countOpenBySeverity），评分函数无需感知分层 |

**方案乙（low 打折计入）明确不采用**——issue #652 原文推荐方案甲（数字与视觉一致），无第三方案。

### 2.2 post_merge_fix_density 检测器（#647 第 6 项）

新文件 `src/usecases/health/post-merge-fix-density.ts`（纯函数，与信号引擎同哲学）：

- **合入时刻** = FID 最后 main commit（squash 流近似）
- **窗口分档**（链规模）：≤10 commits → 14 天 / ≤30 → 21 天 / >30 → 30 天。窗口完全过去才检测（合入当天不报——「边开发边修」不算「合入后修复」）
- **高扇入排除**：被 ≥5 条特性链触碰的文件进排除清单，不参与链级计数（app.ts 被 19 个特性碰过——这些文件上的 bugfix 归因不到单一特性）。**排除清单写入 evidence_detail.excludedHighFaninFiles（面板不黑箱）**
- **触发**：窗口内触碰链文件（排除后）的 bugfix ≥3 次，或占比 ≥30%（分母=窗口内触碰链文件的全部相关 commit）
- **显式契约**：链级密度抓「哪个特性不对劲」（排除清单后），文件级 bug_recurrence 抓「哪里在出血」（无排除）——app.ts 反复出 bug 由文件级兜底报
- 注册进 `signal-registry.ts`（第 10 类信号，severity=warning）+ `detect-signals.ts` 主流程（全量 commits 传入——合入窗口右端点是各链各自的合入时刻，不随检测窗口滑动）

### 2.3 前端 UI（观澜视觉方案 3.0/3.1/3.3/3.4 + 大獭信息架构）

新组件文件 `web/src/pages/health/recurrence.tsx`：

| 组件 | 要点 |
|---|---|
| `RecurrenceCard` | 卡头=文件路径（等宽）+ 频次徽章（caramel-600 实心，从 evidenceDetail.commits 派生）+ 定性标签（lavender 描边）；卡身=水平时间轴，BugFix=teal-500 实心圆 / 其他=caramel-500 实心圆，节点 hover 出 commit 摘要 |
| `RecurrencePanel` | 排序=频次×最近复发；首屏最多 5 张；空态「近窗口无复发模式」teal 勾（健康确定感） |
| `LowConfidenceDrawer` | otter-100 底默认折叠；展开后明细可见；徽章**描边样式**（border-caramel）而非实心——低置信信号视觉降一级 |
| `HotspotHeatBar` | 文件名等宽 + 热力条 teal→caramel 线性插值（hex 插值，不自造色值） |
| `TrendSparkline` | SVG path 一行高度（24px）；BugFix 末值百分比 + 近 N 天 commits 摘要行 |
| `SignalPostureCard` | 数字卡改造：critical/warning（高置信）/低置信待核实 三列分立 |

主页面 `index.tsx` 重组：

- 总览动线：分卡+雷达（保留）→ 信号态势卡+复发模式区（**新主角**）→ 低置信抽屉 → 热点热力条+指标卡 → sparkline + 环形图 + 链五态条（背景层）
- 信号视图：复发卡全量（主角）+ critical/warning 高置信组 + 低置信抽屉；信号分组过滤 `confidence !== 'low'`（低置信不进组）
- **色彩 token 统一**：`CHANGE_TYPE_COLORS` / `COST_OUTPUT_COLORS` / `CHAIN_STATE_LABELS.color` 全部改为 teal/otter/caramel/lavender 阶梯度；原双轴趋势图（柱=蓝 #93c5fd，线=红 #f43f5e）整体移除，由 sparkline（otter-500 描线）替代——**红色只剩 critical 计数、zombie 链、健康分红色档**等「需要行动」元素
- 模块热区条形图（默认蓝 #0ea5e9）移除，由热点热力条替代（issue D 的意图：热区要看「热」的语义，不是模块计数）

### 2.4 明确不做（任务简报边界）

- 链泳道 UI（#649，PR3）
- chainDetail 性能（#653）
- 自动归档链路（#645 已交付文案阶梯）
- rhi-scan-worker 时间/时钟相关代码（开发獭-605 在修 #605 flaky——本 PR 只动 countOpenBySeverity 计数逻辑，零触碰时间代码）

## 3. 关键改动清单

```
src/usecases/health/signal-registry.ts          # +post_merge_fix_density 注册（第 10 类信号）
src/usecases/health/post-merge-fix-density.ts   # 新：密度检测器（纯函数）
src/usecases/health/detect-signals.ts           # SignalDetail 联合类型 + 主流程接入
src/usecases/health/rhi-scan-worker.ts          # countOpenBySeverity 过滤 low（#652）
src/usecases/health/health-score.ts             # D5 口径注释（#652）
src/interface-adapters/http/controllers/rhi-controller.ts  # overview 单列 byConfidence（#652）
web/src/api/client.ts                           # RhiOverviewDTO.byConfidence + RhiSignalDTO.evidenceDetail 扩展 + snapshot_shift/post_merge_fix_density 标签
web/src/pages/health/recurrence.tsx             # 新：PR2 组件集
web/src/pages/health/index.tsx                  # 总览/信号视图重组 + 色彩 token 统一
tests/usecases/health/post-merge-fix-density.test.ts      # 新：7 用例
tests/usecases/health/rhi-scan-worker.test.ts   # +#652 D5 口径用例（真实信号集端到端）
tests/api/rhi-api.test.ts                       # +#652 overview 用例（low×2+normal×1→critical=1）
web/src/pages/health/recurrence.test.tsx        # 新：20 用例（含禁用 occurrences 断言）
```

## 4. 验证

### 测试与自检

- **#652 验收用例**（issue 原文口径）：low 信号 ×2 + normal critical ×1 → `openSignalsBySeverity.critical === 1`（rhi-api.test.ts）；D5 端到端：low×2+normal×1、活跃链 3 → D5=86.67（若未过滤=60，rhi-scan-worker.test.ts 锁定方案甲口径）
- **post_merge_fix_density 7 用例**：窗口分档边界（10/11/30/31）、次数触发、占比触发（40% <3 次）、高扇入排除+反证（阈值 99 时 5 链全触发）、排除清单可见、窗口未过不报、detectSignals 主流程端到端
- **前端 20 用例**：时间轴交替渲染（3 teal + 2 caramel 节点）、**频次徽章禁用 occurrences**（99 次扫描计数不显示，显示 3 次 BugFix）、密度卡占比+排除清单可见、低置信抽屉默认折叠/展开/描边徽章、热力条颜色映射、sparkline 渲染、色彩 token 纪律（changeTypeNodeColor/heatColor）
- 根仓 **198 files / 2469 tests 全绿**；web **37 files / 327 tests 全绿**；根仓+web `tsc --noEmit` 0 错误；eslint 0 error（web 存量 3 warning 为其他文件 react-hooks/exhaustive-deps，与本 PR 无关）
- **已过最简检查**：无新表新依赖——密度检测器复用 FeatureChain.touchFiles（内存过滤，不新增查询路径）；UI 复用 Tailwind @theme 既有 token（teal/caramel/otter/lavender 阶），sparkline 为原生 SVG path 不引图表库组件；低置信抽屉复用 signals API 既有字段，无新端点
- 无 pre-existing 失败（本分支全量跑绿）

### 视觉验证

面板总览：复发模式卡右上黄金位带时间轴；低置信 18 条折叠为单行抽屉；图表区无默认蓝绿橙。

## 5. 边界与已知限制

- **低置信抽屉的根治**仍是「文档状态自动推进」（#645 文案阶梯已交付，独立任务）——抽屉是视觉止血，长期存在
- 复发卡 commit 节点点击跳转 commit 未实现（hover tooltip 有完整信息；跳转需要 GitHub URL 组装，PR3 泳道一并做）
- 密度信号合入时刻=FID 最后 main commit 是 squash 流近似——merge commit 流（保留分支历史）下会有偏差，当前仓库是 squash 流，口径成立
- `openSignals`（全量 open 总数）仍含 low：tab 计数「总览 · N」会大于态势卡三列之和——语义为「待核实事件总数」，与「主警报数」刻意分开

## 6. 后续

- PR3（#649）：链泳道 UI 消费链详情端点；节点跳转 commit
- #653：chainDetail 性能（buildChainsOnce 每请求重建）
- issue #647 关闭条件（验收清单）已全部覆盖

关联 issue：
- https://github.com/chenlaicai/otter-buddy/issues/647
- https://github.com/chenlaicai/otter-buddy/issues/652
