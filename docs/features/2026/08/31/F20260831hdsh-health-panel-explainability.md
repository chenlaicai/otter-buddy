---
id: F20260831hdsh
title: 健康面板可解释性：D2 校准 + 评分说明 + 链/信号人话化
status: development
change_type: feature
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
created_at: 2026-08-31
tags: [rhi, health-index, scoring, explainability, ui]
modules:
  - src/usecases/health/health-score.ts
  - src/interface-adapters/http/controllers/rhi-controller.ts
  - web/src/api/client.ts
  - web/src/pages/health/index.tsx
related_issues: [630]
capability_test: "n/a: 纯 A 类代码改动（公式校准+DTO补料+UI组件），无 LLM 行为涉及"
summary: D2 架构稳定分段饱和校准 + 五维雷达/综合分评分「?」公式说明 + 特性链 docTitle/stateReason + 信号 signalTypeLabel 补料与人话化
---

# 健康面板可解释性：D2 校准 + 评分说明 + 链/信号人话化

## 背景

搭档 8/31 反馈三连：
1. D2 架构稳定分 0——线性公式 ×10 导致 10 个热区即归零，20 个热区与 100 个无区分度
2. 评分计算逻辑界面上不可见（雷达图无公式说明）
3. 信号/特性链两页只有编号天书，看不懂代表什么

## 变更说明

### 1. D2 公式校准

**旧公式**：`100 - hotspotCount×10 - imbalance?20:0`（clamp 0-100）

**新公式**：`100 - min(60, hotspotCount×4) - imbalance?20:0`（clamp 0-100）

| 热区数 | 旧分 | 新分 | 说明 |
|--------|------|------|------|
| 0 | 100 | 100 | 无热区满分 |
| 5 | 50 | 80 | 前5每个扣4 |
| 10 | 0 | 60 | 不再归零 |
| 20 | 0 | 40 | 目标区间40-50 |
| 100 | 0 | 40 | 封顶60，与20个无区分度 |

设计意图：分段饱和，每个热区扣4分，总扣封顶60。20个热区落在40-50区间。

### 2. DTO 补料

- `/health/chains` 响应新增 `docTitle`（特性文档标题，orphan 链为 null）和 `stateReason`（五态人话解释）
- `/health/signals` 响应新增 `signalTypeLabel`（信号类型中文标签）

### 3. 前端可解释性

- **雷达图「?」**：点击展开五维评分公式 + 数据来源 + 状态分级说明
- **综合分卡「?」**：点击展开综合分加权公式
- **信号说明卡**：页头增加信号系统说明 + 8 种类型标签展示
- **特性链人话化**：主列显示文档标题（编号降为次要），每条链展示 `stateReason`

## 影响范围

- `health-score.ts`：`scoreD2` 函数 + 头注释维度口径段
- `rhi-controller.ts`：chains/signals 响应结构扩展
- `web/src/api/client.ts`：RhiChainDTO + RhiSignalDTO 类型扩展
- `web/src/pages/health/index.tsx`：雷达/综合分/信号/特性链 UI 增强

## 验证

- D2 分段函数单测覆盖 0/5/10/20/100 热区边界
- 后端全量测试绿（192 files / 2369 tests）
- tsc --noEmit 通过（后端 + 前端）
- 已过最简检查：公式改动为单行，DTO 补料为字段追加，无过度建设
