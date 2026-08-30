---
id: F20260830hdbh
title: 健康面板综合分卡与五维雷达图
summary: issue #595 PR2（面板展示）：健康面板总览顶部新增综合健康分大卡（大数字+状态色+走向箭头+归因句+五维迷你条）与五维雷达图（recharts RadarChart），消费 PR1 的 GET /api/health/score。纯展示层，零后端改动。
change_type: feature
status: implemented
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
modules:
  - web
from:
  - F20260829hscx
references:
  - "https://github.com/chenlaicai/otter-buddy/issues/595"
capability_test: "tests/api/rhi-api.test.ts（score 端点 3 个新增用例）；视觉验证：Playwright 截图 /tmp/health-dashboard-pr2.png（真实数据 66.8 黄 + 雷达五角）"
---

# 健康面板综合分卡与五维雷达图

## 背景

issue #595 的 PR1（#597，已合入）交付了评分引擎与 `GET /api/health/score` 端点，但面板没有消费入口——搭档原话「面板展示很关键啊，否则我看什么」。PR2 把语义层的产出呈现给人。

## 目标

- 总览顶部一眼回答「系统健康吗 / 往哪走 / 哪里拖后腿」
- 五维分数可视化（雷达图）+ 每维走向
- 无数据/空态不阻塞页面（available:false 时显示引导文案）

## 非目标

- 后端任何改动（评分公式、API 结构零变更）
- 走向的历史曲线图（trend 序列仅箭头呈现，曲线属后续校准批次）
- 自动处置建议（Phase 3 范围）

## 方案设计

### 数据流

`api/client.ts` 新增 `RhiScoreDTO`（dimensions/trend/attribution）+ `getRhiScore()`，页面 `refresh()` 与既有五个请求并行拉取。

### 组件

| 组件 | 内容 |
|---|---|
| `OverallScoreCard`（2/5 宽） | `Math.round(overall)` 大数字 + 状态色卡（绿≥75/黄 50-74/红<50，`SCORE_STATUS_CONFIG` 与后端 statusFromScore 对齐）+ overall 走向箭头 + 归因句 + 五维迷你分数条（hover 显示维度归因） |
| `ScoreRadarCard`（3/5 宽） | recharts `RadarChart`，domain [0,100]，五维角标 + 底部每维走向箭头行 |

- 走向箭头：up=绿↑ / down=红↓ / flat=灰— / null（不足 8 数据点）= 浅灰—
- 无数据维度（score=null）雷达以 0 呈现，Tooltip 标注「无数据」
- 空态：`available:false` 时显示「扫描后生成」引导卡

### 状态色映射

```
SCORE_STATUS_CONFIG: green=健康/amber-600 bg-emerald-50, yellow=观察/amber, red=告警/rose
```

与后端 `statusFromScore`（≥75/50-74/<50）及既有 CHAIN_STATE_LABELS 色系一致。

## 影响范围

| 文件 | 变更 |
|---|---|
| `web/src/api/client.ts` | +RhiScoreDTO/RhiScoreDimensionDTO/getRhiScore |
| `web/src/pages/health/index.tsx` | +OverallScoreCard/ScoreRadarCard/TrendIcon/SCORE_STATUS_CONFIG，refresh 加载 score |
| `tests/api/rhi-api.test.ts` | +score describe 3 用例（空态/正常/cost_output 隔离） |

## 取舍

- **雷达图零新依赖**：recharts 2.15.4 自带 RadarChart（项目已用 recharts 画趋势/饼图），不引入图表库
- **趋势仅箭头不做曲线**：judgeTrend 返回方向而非序列，曲线化需 trends 端点扩展（#595 校准批次已列）
- **无数据维度画 0 而非缺角**：recharts 雷达不支持 null 角，0+Tooltip 标注是最低歧义方案

## 验证

- 后端全量 2215/2215 绿（含 score 端点 3 个新增 API 用例）；前端 287/287 绿；web `tsc --noEmit` + `vite build` 通过
- **真实数据视觉验证**（Playwright + 本地服务）：综合健康分卡渲染成功，大数字 67、状态黄、归因句「架构稳定 0 分：src/app.ts 等 20 个热区文件…」；五维雷达渲染成功（截图 /tmp/health-dashboard-pr2.png）
- **主仓服务升级**：发现生产 dist 是 8/29 旧构建（不含评分引擎），重建后触发扫描，health_index 行落库，score API 返回真实数据
- 最简实现检查：已过——纯展示层 3 文件（client DTO + 2 组件 + 测试），无更简路径（RadarChart 为既有依赖）

## 改动范围

见「影响范围」表。
