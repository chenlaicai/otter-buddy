---
id: F20260901hpui
title: "健康面板总览+信号重设计：复发模式卡、低置信折叠、合并后修复密度（含 #652 口径修复）"
summary: "健康面板重设计 PR2（Issue #647 + #652）：总览从统计仪表重组为出血点仪表——复发模式卡（bug●→fix● 交替时间轴，频次从 evidence_detail.commits 派生）为首屏主角；confidence=low 信号折叠收纳且不进 critical/健康分计数（口径单一真相源 signal-counts.ts，overview 与 D5 同源）；热点热力条 teal→caramel；趋势降 sparkline 可展开；图表默认蓝绿橙全面退场换 otter token；新检测器 post_merge_fix_density（合入后窗口期 bugfix ≥3 次或占比 ≥30% = 特性不对劲，高扇入文件 ≥10 特性触碰进排除清单且面板可见）。"
change_type: feature
status: implemented
substatus: active
created_at: 2026-09-01
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
capability_test: "n/a: 纯 UI 渲染与确定性检测器（无 LLM 行为）；检测器边界由 2574 后端单测覆盖，UI 组件由 16 个 vitest 组件测试覆盖（复发卡交替渲染/抽屉默认折叠/sparkline 数据完整性）"
tags: [health, web, ui-redesign, signals, post-merge]
modules: [web/src/pages/health, src/usecases/health, src/interface-adapters/http/controllers]
intent:
  problem: "面板是「会计报表」不是「洞察仪表」（观澜视觉诊断）：首屏全为聚合统计，复发模式等高价值信号露出度为零；18 条 chain_stall 假警报与真警报等权呈现且全额计入 critical 计数与健康分（#652 口径断层——视觉折叠后总分纹丝不动）；图表库默认色与品牌 token 割裂，警示红被中性指标稀释；特性合入后的「余震期」（哪个特性不对劲）完全没有信号覆盖。"
  why_now: "五期工程 PR2（合议定稿 Issue D 分期）。#650 已落 evidence_detail/confidence 数据形态、#658 已落检测器注入模式——数据与接入模式就绪，本特性是 UI 主菜兼口径收口。"
  expected_effect: "搭档扫一眼先看到问题（复发卡/热力条）再看到全景（sparkline/环形图）；面板数字与视觉折叠一致（low 不推高 critical 与健康分）；「特性合入后反复修」有了专属信号且排除清单不黑箱。"
---

## 方案

### 第 0 项：#652 口径修复（后端数字先对齐，UI 才有干净地基）

方案甲定稿：confidence=low 不计入 critical/warning 计数与健康分。

- 新建 `src/usecases/health/signal-counts.ts`：`aggregateOpenSignalCounts()` 为口径单一真相源。
  - `bySeverity` 只统计 normal 置信；`byConfidence` 单列 `{ normal, low }`。
  - COALESCE 语义：confidence 为 null/undefined/未知值的存量信号一律按 normal（字段缺失不丢计数）。
- 消费方两处同源（防口径断层复发）：
  - `rhi-controller.overview`：`openSignalsBySeverity` / `openSignalsByConfidence`（新字段）。
  - `rhi-scan-worker.countOpenBySeverity`：health_index D5「信号压力」维度输入。
- 单测锚定 issue 验收原文场景：low critical ×2 + normal critical ×1 → critical 计数 = 1（signal-counts.test.ts + rhi-api.test.ts 双覆盖）。

### 第 1 项：复发模式卡（首屏主角）

- 数据质量保证点（后端）：`detect-signals.ts` 的 `collectDetailCommits`——全类型 commit 序列
  时间升序重排 + sha 去重（防窗口滑动残留重复节点致徽章虚高）+ 每扫描整体重算（非 append）。
  频次徽章从 `detail.commits.length` 派生，**严禁 occurrences**（扫描触发次数随扫描频率漂移，合议明令）。
  （初版曾实现 signal-evidence.ts 序列化模块，对抗审视判为未接线死码——排序职责移至前端
  RecurrenceSection，模块已删除。）
- 前端 `RecurrenceCard.tsx`：卡头（文件路径等宽 + caramel-600 频次徽章「N 次/30 天」+ lavender「设计问题嫌疑」描边标签）
  + 水平时间轴（节点按日期线性映射区间；bug=caramel-600 实心 / feat=teal-500 实心 / 其他=otter-300 空心，
  bug●→fix● 交替节奏画出来而非列出来——验收项「交替 changeType 渲染」）。
- 空态给确定感：「✓ 近 30 天无复发模式」（teal）。

### 第 2 项：低置信折叠抽屉

- `LowConfidenceDrawer`：默认收起（验收项），otter-100 底单行；展开可见明细（数据不丢）。
- 信号条目徽章用描边样式（outline caramel）而非实心——低置信在视觉语法上降一级，不透支警示色信用。
- 总览与信号 tab 双入口；抽屉数据源 = overview 新字段 `openSignalsByConfidence.low`（口径同源）。

### 第 3 项：热点热力条

- `HotspotHeat.tsx`：消费 trends.distributions.file_hotspots（既有数据，零后端改动）。
- teal→caramel 色阶线性插值映射修改频次，条宽按频次归一，附色阶图例。

### 第 4 项：趋势图降 sparkline

- 原 220px ComposedChart 降为 48px 一行高度（首屏 40% 高度让位复发卡）。
- 数据不丢：点击展开回 220px 完整趋势（柱=提交数 + 线=BugFix 比率）。
- 卡头常驻小字「近 30 天 N commits（自 MM/DD 起）」——x 轴从数据实际起点，消灭假空白。
- 新增 `?tab=` 深链参数（刷新/截图/分享指定视图，非法值回退 overview）。

### 第 5 项：色彩 token 统一

- 新建 `web/src/pages/health/palette.ts`：otter/teal/caramel/lavender token 常量（globals.css @theme 同值）
  + 纪律注释三条（默认色退场/红色只许「需要行动」/跨图表色义锁定）。
- 全部图表默认蓝绿橙退场：趋势柱 `#93c5fd`→otter-200、BugFix 线 `#f43f5e`→caramel-500（中性指标禁警示红）、
  环形图→change_type 语义映射、模块热区 `#0ea5e9`→otter-300、cost 图三色→token、雷达 `#0d9488`→teal-500。
- 链五态：zombie 从 rose 红降为 otter-300（失活不是紧急态）、orphan 用 lavender。

### 第 6 项：合并后修复密度（新检测器，PR2 的灵魂信号）

- 新建 `post-merge-fix-density.ts` + SIGNAL_REGISTRY 注册 `post_merge_fix_density`（severity=warning——
  「不对劲」是待查证不是定罪）。
- 规则：合入后窗口期内（小修 14 天/大特性 30 天）触碰链文件的 bugfix ≥3 次 **或** 占比 ≥30%。
  - 分档依据（2026-09-01 实测 137 条链，squash 流）：链 commit 数 p50=p75=p90=1、max=3——按 commit 数分档
    无区分度；链触碰文件数有真梯度（p50=2/p75=6/max=41），故按 `touchFiles > 6` 划大特性档。
  - 合入时刻 = FID 最后 main commit（squash 流近似）；合入早于窗口开启的特性不属「合并后」范畴（老特性
    近期被碰是热点/复发问题，由文件级 bug_recurrence 兜底）。
  - 占比分母 = 链窗口内全部 commit（含无 FID 的 bugfix）；分子 = 触碰链文件的 bugfix（commit 粒度计 1 次）。
  - 最小分母保护 `RATIO_MIN_DENOMINATOR=5`：分母 <5 时占比支不启用（合入后仅 1 条 bugfix → 100% 触发是荒谬的）。
- 排除清单三层边界（缺一不可）：
  1. 高扇入文件（被 ≥10 个特性触碰）自动进排除清单。阈值实测：30/60 天窗口分布一致（app.ts×22、
     platforms×18、router×11、client.ts×11…），≥10 恰好圈住 12 个基础设施枢纽（总 615 文件）。
  2. 清单可见不黑箱：检测器 evidence 内嵌摘要；`computeFanInExclusions()` 随 GET /api/health/chains
     常驻透出（`fanInExcludedFiles` 字段），前端特性链 tab 常驻展示（验收项）。
  3. 显式分工契约（写成文件头注释）：链级密度抓「哪个特性不对劲」（排除清单后），文件级 bug_recurrence
     抓「哪里在出血」（无排除）——核心文件恰是震中时由文件级兜底，两者互补互不替代。
- 前端：信号类型标签「合并后修复密度」，信号 tab 正常分组展示。

## 本次变更对旧特性做了什么

- 对 F20260901rhdt（#650 数据形态）：只消费不改——evidence_detail/confidence 的生产逻辑零改动。
- 对 F20260901rhdet（#658 检测器）：沿用其「检测器纯函数 + SIGNAL_REGISTRY 注册 + worker 注入」模式；
  post_merge_fix_density 为平行新增，不触碰 #658 的四个检测器。
- 对 F20260829hviz（可视化看板）：趋势图降级为 sparkline、环形图/热区条换色板——布局语义变化但数据源不变。
- 对 #595 健康分卡：D5 输入口径变化（low 不再计入 critical）——分数会因 18 条假警报退出而回升，这是修复不是回归。
- overview 响应新增 `openSignalsByConfidence`、chains 响应新增 `fanInExcludedFiles`（向后兼容，新增字段）。

## 影响

- 文件：
  - 后端：signal-counts.ts / post-merge-fix-density.ts（新）、signal-registry.ts、
    detect-signals.ts、rhi-scan-worker.ts、rhi-controller.ts
  - 前端：palette.ts / RecurrenceCard.tsx / HotspotHeat.tsx（新）、index.tsx、api/client.ts
  - 测试：signal-counts.test.ts、post-merge-fix-density.test.ts、
    rhi-api.test.ts（扩充）、RecurrenceCard.test.tsx、TrendSparkline.test.tsx（新）
- 兼容性：overview/chains 只增字段；存量信号无 confidence 按 normal 计（COALESCE 语义）；
  UI 侧 confidence 字段缺失的信号不进抽屉、维持原展示。

## 验证

- 后端：2579 tests / 207 files 全绿（含新增用例：#652 口径验收原文场景、检测器边界
  「恰好 3 次/恰好 30%/窗口边界 14/30 天/排除清单命中/evidence 透出清单/合入时刻窗外/doc-only 跳过」，
  以及审视修复后的「合入前 bugfix 不计入/占比分母只数合入后 commit」截断回归）。
- 前端：331 tests 全绿（含组件测试：频次徽章派生自 commits.length 非 occurrences（occurrences=99
  fixture 断言防回归）、时间轴交替 changeType、抽屉默认折叠/展开明细不丢、sparkline 48px→220px
  数据完整、热力条渲染、FreqBadge 双口径、FanInExcludedList DOM 断言、复发卡频次排序）。
- 双侧 `npx tsc --noEmit` + lint 0 error（5+3 个 warning 全部为既有代码）。
- `vite build` 通过。
- 截图证据（mock fixture 驱动的设计态渲染，数据形态 1:1 对齐 schema）：
  - `screenshots/pr2-overview-firstscreen.png`：首屏全景——复发卡 3 张（时间轴 bug/feat 交替）+
    低置信抽屉收起态 + 信号态势四卡（警报 5 / 低置信 18 分列）+ 热力条 + sparkline + 五态堆叠条。
  - `screenshots/pr2-overview-drawer-open.png`：抽屉展开态（18 条 low 明细，描边徽章）。
  - `screenshots/pr2-signals-tab.png`：信号 tab——critical 3 条 / warning 2 条（含 post_merge_fix_density
    evidence 内嵌排除清单摘要）/ 低置信抽屉收起。
  - `screenshots/pr2-chains-fanin.png`：特性链 tab——高扇入排除清单常驻可见（app.ts×22 等 12 枢纽）。
- **最简实现检查（必答）**：
  - sparkline 展开方式：useState 切高度（48↔220px）而非路由/弹窗——一行状态完成，最简。
  - 分档阈值实现：常量比较 `touchFiles.size > 6` 而非配置系统——首版实测校准后硬编码 + 注释锚点，
    未来有调参需求再提升为 DetectOptions。
  - 排除清单透出：挂在既有 chains 端点（`computeFanInExclusions(chains)` 纯函数）而非新端点——零新增采集。
  - 复发卡序列化：复用 #650 已落的 evidence_detail，后端只做读取层转换（100 行内），未重复检测逻辑。
  - 已过最简检查：每项均采用仓库已有实现/最小新代码路径，无方案外依赖。

## Discovered Issues

- 实现过程中发现并当场修正：mock 截图链路缺 cost-output 端点导致 Promise.all 全拒——属于截图工具
  fixture 问题，非产品代码问题；检测器占比支最小分母保护为测试驱动出的真实边界，已纳入实现与文档。

## 对抗审视处置（2026-09-01，检视獭烛幽 vs 实现者绘境，1 严重 + 6 建议全修）

- **严重 1（正确性）**：密度检测器分子/分母未按合入时刻截断——滚动窗口 `[now-N天, now]` 使
  合入前 commit 计入统计，「合并后」语义被稀释（分子可被合入前 bugfix 凑满误触发、分母被合入前
  commit 稀释）、evidence 文案与统计事实不符，且原测试把偏差锁进预期行为。修复：
  `effectiveStart = max(lastCommitAt, windowStart)` 统一过滤（post-merge-fix-density.ts
  detectChainFixDensity），修正 3 条夹具时间线 + 新增 2 条截断回归用例（合入前 3 条碰链 bugfix
  不触发；占比分母不含合入前填料，evidence 断言 2/5=40%）。
- **建议 2（死码）**：signal-evidence.ts（71 行）+ 其测试全删——serializeRecurrenceCards 零调用，
  文档承诺的频次排序只在死模块里。排序落到前端 RecurrenceSection（commitCount 降序、最后节点
  日期次之，2 条组件测试锁定）；RecurrenceCard.tsx:5 失实注释改指真实保证点（detect-signals.ts
  的升序重排 + sha 去重）。
- **建议 3（双真相源）**：检测器排除清单从 30 天 commit 流独立计算改为调 computeFanInExclusions(chains)，
  与 chains 端点恒等（单一真相源）；私有 collectFanInExclusions 删除，注释记录漂移风险原因。
  代价：排除集从 30 天扇入放宽为 60 天扇入（多排除个别 30-59 天前的枢纽文件），对「枢纽」语义无损。
- **建议 4（issue 侧留痕）**：gh issue comment #647 补记占比支最小分母 5 的偏离、动机
  （2/3=67% 荒谬触发）与特性文档锚点——issue 是合议决策 record of truth。
- **建议 5（频次口径收口）**：index.tsx signals tab 残留 occurrences 徽章（rose）替换为 FreqBadge
  组件——bug_recurrence 走 evidenceDetail.commits.length（与复发卡同源同数），其余信号类型保留
  occurrences（对非复发类是合理计数）；装饰性 rose 退场，复发徽章改 caramel 系。
- **建议 6（DOM 断言缺口）**：排除清单抽为 FanInExcludedList 组件（index.tsx import 时挂载 #root
  有副作用不可直接测），补 2 条组件测试：非空渲染文件名+×N 计数、空数组不渲染。
- **建议 7（labels 一致性）**：后端 SIGNAL_TYPE_LABELS 恢复 review_debt 条目（10 项对齐前端，
  未发射类型保留对齐）；palette.ts 删 CHAIN_STATE_COLORS 死导出（orphan 色值与活映射矛盾），
  留注释指向活映射 index.tsx CHAIN_STATE_LABELS。
