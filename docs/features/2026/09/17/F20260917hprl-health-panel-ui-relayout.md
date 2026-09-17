---
id: F20260917hprl
title: 健康面板 UI 重组：总览三层结构 + 特性链进度语言（issue #1029）
summary: |
  纯前端 UI 重组（搭档 2026-09-17 目验低保真原型后拍板「开工②」）。总览页从
  「原料/语义两层平铺」（数据堆砌观感）重组为三层结构：①判断层——综合分大卡，
  归因句从角落小字升级为主标题；②维度层——五维改名大白话（修 bug 比例/架构晃动/
  交付节奏/流程纪律/告警处置）+ 一句「这量在量什么」，分数条替雷达图，点击展开
  证据层（原料数据收编下钻）；③处置层——红黄维度配建议动作，链到「警报」处置队列
  （triage 未接单数）。砍掉模块热区条形图、四张重复指标卡；环形图/热点图/四态条
  收编进对应维度证据层。特性链页四态翻译进度语言（推进中/卡住/出过回退/烂尾风险），
  异常排前、正常折叠。tab 改名：信号→警报、特性链→进行中的事。
change_type: feature
capability_test: "n/a: 纯 UI 重组（前端组件层），无 LLM 产出质量可锚定；验收走组件测试 + Playwright 真机截图 + 搭档目视终审"
intent:
  problem: "搭档反馈健康面板「除了低分，其余都看不懂指标代表什么、有什么用，像数据的堆砌」（2026-09-17）——同一批事实以三种形态重复平铺（裸数字/占比/语义分），每层都不说「所以呢」"
  expected_effect: "第一屏三秒知道「好不好+为什么」（归因句主标题）；每个维度有看得懂的名字+「这量在量什么」；点红色维度看到原料证据；红黄维度有下一步建议动作链到警报处置队列"
  verify_by:
    type: human_judge
    effect_window: 14d
    metrics: "搭档重启后目视终审（低保真原型已目验方向）；组件测试 14 例（维度展开交互/分组排序/文案映射）全绿；Playwright 真机截图 5 张（总览/D2 证据/D5 证据/警报/进行中的事+展开）"
created: 2026-09-17
created_in_conversation: a4d1f7c1-76b1-4cdd-8040-469d3c1b974b
tags: [rhi, health-dashboard, ui-relayout, web]
modules: [web/pages/health]
---

## 背景

低保真原型（设计真相源，搭档已目验方向）：`data/workspaces/a4d1f7c1-76b1-4cdd-8040-469d3c1b974b/health-panel-lofi.html`。对话脉络：搭档先看不懂总览页（「指标的堆砌」）→ 大獭逐模块审计发现「两层倒挂」（原料层与语义层平铺、同一事实讲三遍）→ 出低保真原型 → 搭档认可方向 → 先做完治本 F20260917trig（信号处置状态机，PR #1026 合入，triage 字段就绪）→ 本特性做「看得懂」这一半。

## 方案设计

### 总览页三层结构（`VerdictPanel.tsx` 新组件）

1. **判断层 `VerdictCard`**：综合分大卡——归因句（后端 `score.attribution`）从卡片角落小字升级为第一屏主标题。三秒知道「好不好 + 为什么」。
2. **维度层 `DimensionRows`**：五维大白话名（`DIMENSION_PLAIN`）+ 每维一句「这量在量什么」+ 分数条替雷达图（数值一眼可比）。点击展开**证据层**（`DimensionEvidence`）：
   - D1 修 bug 比例：健康线/归零线口径 + 近 60 天提交构成（修 bug vs 新功能）+ 近 10 天 bugfix 占比走势条（健康线上方标红）——**收编原提交类型环形图 + BugFix 比率指标卡**
   - D2 架构晃动：热区扣分口径 + `HotspotHeatBar` 热点清单——**收编原平铺热点图**
   - D3 交付节奏：四态计数（进度语言）——**收编原四态分布条**
   - D4 流程纪律：合规分子分母——**收编原总提交指标卡**
   - D5 告警处置：critical/warning open 数 + 未接单链路——**收编原 critical 指标卡**，链到「警报」页 `untriagedCount` 条未接单（F20260917trig triage 字段）
   - 默认展开红/黄中**分数最低**的维度（按分不按状态：生产实测 D1=6/D2=40 同红，D1 才是主拖累）。lazy initializer 在 score 异步为 null 时固化 null → 改 useEffect 在数据到位后设一次。
3. **处置层 `ActionList`**：红/黄维度各配建议动作（复发清单→警报、卡住/烂尾→进行中的事、未接单→警报），全绿时给「不用动作」确定感文案。

**砍掉**：模块热区条形图（「agent 58 次 commit」不回答任何健康问题）、四张重复指标卡、平铺环形图/热点图/四态条（原料全部收编进证据层，数据不丢）。**保留**：复发模式卡（#647 首屏洞察主角）、低置信折叠抽屉（#652）、趋势 sparkline（可上调整合在判断卡后）。

### 特性链页进度语言（`ChainsPanel.tsx` 新组件）

- `chain-state-meta.ts` 加 `CHAIN_STATE_PROGRESS`：active→推进中 / stalled→卡住 / regressed→出过回退 / orphan→烂尾风险（与 `CHAIN_STATE_META.label` 技术标签并存——chips/tooltip 用技术标签，进度徽章/分组用人话）。
- 顶行进度徽章（推进中 N / 出过回退 N / 烂尾风险 N）+ 异常链排最前（`sortChainsBySeverity` 同款严重度序）+ 正常推进折叠（`<details>` 式 toggle）。
- **泳道组件 `SwimlaneTimeline` 本体不重写**——只分组折叠，异常区/折叠区各渲染一次泳道。

### tab 改名

「信号」→「警报」、「特性链」→「进行中的事」（`TAB_LABELS`）。内部 key 不动（深链 `?tab=` 兼容）；「总览」「用量/效率」保留。

## 改动范围（纯前端，零后端改动）

| 文件 | 改动 |
|---|---|
| `web/src/pages/health/VerdictPanel.tsx` | 新建：总览三层（判断卡/五维行+证据层/建议动作） |
| `web/src/pages/health/ChainsPanel.tsx` | 新建：进度徽章+异常置顶+正常折叠 |
| `web/src/pages/health/score-status.ts` | 新建：`SCORE_STATUS_CONFIG` 从 index.tsx 抽出（#595 配色单一真相源） |
| `web/src/pages/health/TrendIcon.tsx` | 新建：`TrendIcon` 从 index.tsx 抽出（既有单测改指本模块） |
| `web/src/pages/health/index.tsx` | 总览 tab 换三层；chains tab 换 ChainsPanel；tab 改名；删 OverallScoreCard/ScoreRadarCard/ChainStateBar/四张指标卡/模块热区/环形图/四态条 |
| `web/src/pages/health/chain-state-meta.ts` | 加 `CHAIN_STATE_PROGRESS` 四态进度语言 |
| `web/src/pages/health/*test.tsx` | TrendIcon.test 改指新模块；新增 VerdictPanel.test（9 例）/ChainsPanel.test（5 例） |

## 验证

- 组件测试 14 例新增全绿（维度展开交互、默认展开最差、分组排序严重度序、进度语言文案映射无黑话、建议动作链）；health 目录 64 例、前端全量 481 例、后端 3588 例全绿；`tsc --noEmit` 0 错；lint 0 error（12 warnings 全 pre-existing）。
- **UI 真机自查（PR #972→#1005 硬规则）**：vite dev server（port 5199）+ Playwright 真实 Chromium 渲染，截图 5 张 + `getBoundingClientRect` 取证，存对话工作区：
  - `hp-1-overview.png` 总览三层（判断卡 top=220/h=133/w=992 可见，D1 默认展开）
  - `hp-2-overview-d2-evidence.png` D2 证据层展开（h=282 可见，热点清单收编）
  - `hp-2b-overview-d5-evidence.png` D5 证据层（未接单链路）
  - `hp-3-signals.png` 警报 tab（处置队列，低置信折叠）
  - `hp-4-chains.png` / `hp-5-chains-normal-expanded.png` 进行中的事（进度徽章 推进中 556/出过回退 3/烂尾风险 9，异常置顶，正常折叠展开）
  - 取证 JSON：`hp-verification.json`
- 最简实现检查：**已过**——三层收编复用既有组件（HotspotHeatBar/TrendSparkline/SwimlaneTimeline/RecurrenceSection）+ palette token，零新依赖；砍多于建（净删约 200 行平铺代码）。

## 设计取舍

1. **雷达图→分数条**：雷达图看不出数值、D1=4 拉成畸形但不知道凹进去为什么；条形一眼见高低，五维状态色（绿/黄/红条）保留语义。被否方案：保留雷达图加 tooltip——搭档反馈的核心就是「不知道在表达什么」，tooltip 是藏答案不是给答案。
2. **原料收编进证据层而非删除**：「数据不丢」原则（#647 同款），点开展开即可达；删掉则后续排查无处下钻。
3. **进度语言与技术标签并存**：chips/筛选/tooltip 保留 `CHAIN_STATE_META.label`（技术语义精确），面向搭档的进度徽章/分组用 `CHAIN_STATE_PROGRESS`（人话）。一份状态两份文案，单一真相源在 chain-state-meta。

## 影响范围与风险

- 仅 `web/src/pages/health/` 目录内 + 零后端改动；signals tab 的 TriageQueue、用量 tab 不动。
- 深链 `?tab=signals|chains` 的 key 未变，旧链接不失效，仅显示名变。
- 复发模式卡/低置信抽屉/趋势 sparkline/泳道组件/详情抽屉行为不变（既有测试回归全绿）。
- Golden Gate：n/a（verify_by=human_judge 纯 UI 重组，无 LLM 产出质量场景可跑）。

## 对抗审视决策史（检视獭-relay 第一轮，glm）

2 严重 + 4 建议，处置如下（无反驳条目）：

- **S1 归因句黑话+浮点+英文枚举裸奔** → 接受并修复（归属层：后端 health-score.ts）——attribution 被 JSON 落库进快照 metadata，前端翻译救不了历史快照，后端出人话版让全消费方受益。DIMENSION_PLAIN_NAMES 大白话映射 + 分数 Math.round + D3 链状态枚举翻译（CHAIN_STATE_ZH）。新增测试钉住（44 用例全绿）。「纯前端」声称随之修正：本 PR 含 1 个后端文件（≤15 行 + 测试）
- **S2 statePlainLabel 文案漂移** → 接受并修复——删手写副本，改从 CHAIN_STATE_PROGRESS（chain-state-meta 单一真相源）取值
- **R1 D5「处置率见警报页」承诺落空** → 接受——文案改为「逐条处置进度见『警报』页队列」（该页真实存在的概念）
- **R2 D1 分子分母窗口口径** → 核后无问题——证据层 60 天窗口数字与副标题明示一致，归因句 30 天窗口来自后端快照，两口径各有标注，未混用
- **R3 untriagedCount 含 low 置信** → 接受——加 `confidence !== 'low'` 过滤，与 #652 口径同源
- **R4 模块热区数据砍后无消费点** → 部分接受——模块热区（module 聚合条形图）数据为**有意砍除**：它回答「哪里热闹」而非「哪里不健康」，文件级热区（真正有健康语义的）已收编 D2 证据层。本段即边界声明，修正「数据不丢」的过宽表述
