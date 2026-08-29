---
id: R20260829hidx
title: RHI 健康指标体系——从可观测数据到健康状态与走向
summary: 在 RHI Phase 0-2 可观测数据之上建语义层：五维度健康分（质量成本/架构稳定/交付活力/流程合规/信号压力）+ 状态分级（绿/黄/红）+ 7 天趋势走向判定 + 拖累归因，自校准阈值防告警疲劳，为面板提供「系统健康吗/往哪走/哪里拖后腿」的答案，并为 Phase 3 自动处置提供触发判据。
created: 2026-08-29
created_in_conversation: 9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb
status: design
exploration_type: technical
tags: [rhi, health-index, metrics, observability]
modules:
  - src/usecases/health/
  - web/src/pages/health/
from:
  - F20260824rhib
  - F20260825hmvp
  - F20260825sgnw
  - F20260825rweb
  - F20260829hviz
---

# RHI 健康指标体系——从可观测数据到健康状态与走向

## 背景（意图锚）

搭档原话（2026-08-29）：

> 「当前你只是给我展示了一些数字，但其实我想要的是一些指标，数字堆叠是没有价值，我期望能看到各种健康指标能反映出系统的健康走向、健康状态。可观测数据 > 健康指标，所以你要更进一层来设计这个健康面板。」

（2026-08-28 前置吐槽：「一堆指标里只有严重有值，其余指标还都没值，以及，我都无法看出来当前是什么状态，感觉还是一些原始数字的列出展示。」）

**问题定性**：RHI Phase 0-2 交付的是「可观测数据」（原始计数 + 图表化展示，F20260829hviz 的四图看板解决的是数据的可读性，不是数据的语义）。搭档要的是「健康指标」——数字之上的**语义层**：能回答「系统现在健康吗」「在变好还是变坏」「哪里在拖后腿」。

## 目标

- **T1 健康状态**：给出可解释的当前健康状态判定（分维度 + 综合），替代「数字堆叠看不懂」
- **T2 健康走向**：给出每个维度及综合分的趋势判定（向好/恶化/持平），有方向语义
- **T3 拖累归因**：状态异常时能指到具体维度和主要贡献因子（哪个指标在拖后腿）
- **T4 Phase 3 判据**：健康分/维度状态为 Phase 3 自动处置提供「何时触发」的判据基础

## 非目标

- 不做自动处置本身（Phase 3 #405-#407 范围，本文只提供判据）
- 不引入 LLM 判定（全确定性计算，与信号引擎同一哲学）
- 不新增采集（只用 health_snapshots + signals 已有数据推导，采集层零改动）
- 不追求绝对阈值的「正确」——单人 + agent 开发模式无行业基线可比，采用自校准基线（见取舍）

## 方案设计

### 核心概念：三层模型

```
L1 可观测数据（已有）：bugfix_ratio、hotspot 频次、chain 五态计数、信号计数、compliance_rate
        ↓（本设计：评分函数 + 阈值分级 + 趋势判定）
L2 健康指标（新）：5 个维度健康分（0-100）+ 状态分级（绿/黄/红）+ 走向（↑/→/↓）
        ↓（加权聚合）
L3 综合健康分 + 总体状态 + 总体走向（面板顶部）
```

### 五个健康维度

| # | 维度 | 覆盖问题 | 输入（全部已有） | 评分函数（0-100） |
|---|------|---------|----------------|------------------|
| D1 | 质量成本 | 修 bug 占用的交付比例 | `overview.bugfix_ratio`（当前 27.8%） | 分段线性：`min(100, 100 × max(0, (0.4 - ratio) / 0.2))`——ratio≤20% 满分 100，线性降至 ratio=40% 归零（ratio=30% 得 50） |
| D2 | 架构稳定 | 热点集中度与失衡 | `signals` 中 hotspot 信号数 + hotspot_imbalance 是否触发 | `100 - hotspot数×10 - imbalance触发?20:0`，clamp [0,100] |
| D3 | 交付活力 | 特性链推进能力 | `chain_states` 五态分布（active/stalled/regressed/zombie/orphan 占比） | `active占比×100 - regressed占比×150 - zombie×100`，clamp |
| D4 | 流程合规 | 提交规范执行度 | `compliant_commits / total_commits`（当前 77%） | `compliance_rate × 100`（线性） |
| D5 | 信号压力 | 未处置问题积压 | open critical/warning 信号数，按活跃链数归一 | `100 - (critical密度×40 + warning密度×30)`，密度=信号数/活跃链数。**活跃链数口径**：`chain_states` 中 state∈{active, stalled} 的链数（zombie/orphan 的积压由 D3 的 zombie 占比惩罚，不重复压 D5）；活跃链数=0（冷启动/全僵尸）时 D5 显示「—」，不参与综合分加权（综合分按其余四维权重归一） |

**状态分级**（每维度独立）：`≥75 绿（健康）/ 50-74 黄（亚健康）/ <50 红（病态）`
**走向判定**（每维度 + 综合）：近 7 天均值 vs 前 7 天均值，差值 >±5 分判 ↑/↓，否则 →（持平）。趋势窗口对齐 health_snapshots 按天快照粒度。

### 综合分与拖累归因

- **综合健康分** = 五维度加权：D1×0.25 + D2×0.20 + D3×0.25 + D4×0.10 + D5×0.20（质量与交付双核心略高，合规为辅助观测）
- **总体走向** = 加权走向向量（维度走向 × 权重求和，>0.5 向好 / <-0.5 恶化 / 其间持平）
- **拖累归因**：分数最低的维度 + 该维度评分函数中扣分最大的输入项，生成一句人类可读的解释（如「架构稳定 42 分：tool-factory.ts 13 次修改是主要拖累」）——这是 T3 的直接实现

### 自校准基线（关键取舍，见下）

首次运行时前 N=14 天快照作为**基线分布**，各维度阈值不直接用经验值，而是按基线 P25/P50/P75 微调（例：若基线期 bugfix_ratio 中位数已是 30%，D1 的满分区上限从 20% 上调至 25%——避免「项目常态就被判病态」的告警疲劳）。**冷启动策略（确定性）**：Day 1-13（基线未满）统一使用经验值阈值；Day 14 基线成立即切换为自校准值，切换日在 settings 表记录一条阈值快照变更（可追溯，状态突变有据可查）；此后每 14 天滚动重算基线（用最近 14 天快照，适应项目演进）。经验值仅作冷启动初始阈值，阈值全程写入 settings 表可手调。

### 数据与接口

- **计算**：新 usecase `health-score.ts`（纯函数：输入某日 snapshot 行 + signals 聚合 → 输出维度分/状态/走向）。每日快照后追加计算并写 `health_snapshots`（metricType=`health_index`，每维度一行 + 综合一行，metricValue 存分数，metadata 存归因明细）——**不新增表**，复用既有快照管道（rhi-scan-worker 旁路写入，同 F20260829hviz snapshotSink 模式）
- **API**：`GET /api/health/score`（最新维度分 + 状态 + 走向 + 归因）+ trends 端点扩展返回 health_index 序列
- **前端**：面板顶部「综合健康分卡」（大数字 + 状态色 + 走向箭头 + 一句归因）+ 五维度雷达图（recharts 已引入，零新依赖）
- **schema 消费方声明（#379 ⑥）**：health_index 行的消费方 = score API + 面板雷达图 + Phase 3 处置触发器（判据）

## 影响范围

- rhi-scan-worker：快照后追加评分（旁路，失败不影响既有管道——沿用 snapshotSink 隔离模式）
- rhi-controller / router：+1 端点
- web health 页：顶部新增综合分卡 + 雷达图区块
- 既有四图/信号/链视图零改动

## 风险与约束

- **阈值主观性**：经验值冷启动不可避免，靠自校准 14 天收敛缓解；阈值写入 settings 可追溯可手调
- **维度耦合**：D2 hotspot 与 D5 信号压力有输入重叠（hotspot 信号计入两者）——接受：hotspot 在 D2 是「架构信号」，在 D5 是「积压信号」，语义不同
- **走向判定滞后**：7 天窗口意味着趋势确认最少 7 天数据；冷启动首日走向显示「—」（数据不足）
- **history 无 health_index 行**：合入时用回填模式补算（health:backfill 是 F20260829hviz Fix C 交付的逐日重放 CLI，按天重算既有指标——需扩展其调用链加入 health_index 旁路计算，非零改动）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 阈值来源 | 自校准（基线分布 P25/P50/P75） | 纯经验值 / 行业基线 | 单人+agent 项目无行业可比；纯经验值会有告警疲劳（常态被判病态）；自校准与 R20260826rcmm 评估基线同思路 |
| 评分粒度 | 五维度各 0-100 + 加权综合 | 单一综合分 / 多层嵌套 | 单一分不可解释（T3 失败）；嵌套过深难调试 |
| 走向算法 | 7 天均值对比（±5 分阈值） | 线性回归斜率 / EWMA | 均值对比可解释且抗单日抖动；斜率对窗口边缘敏感；EWMA 参数难讲清 |
| 存储位置 | 复用 health_snapshots（metricType=health_index） | 新表 health_scores | 快照表语义完全匹配（按日+按 metric），新表徒增迁移与回填双轨 |
| 计算时机 | 快照管道旁路（scan-worker 内） | 独立定时任务 / 请求时实时算 | 请求时算无法回溯历史走向；独立任务引入调度重复；旁路模式已被 F20260829hviz 验证 |
| 判定哲学 | 全确定性规则 | LLM 叙述性判断 | 与信号引擎同哲学；LLM 判定不可回归测试、不可解释 |

## 验证

- 单测：五维度评分函数边界（0/满分/clamp）+ 状态分级边界（74/75/49/50）+ 走向判定（差值 ±5 边界）
- 集成：mock 快照序列 → score 端点返回完整结构 + trends 含 health_index 序列
- 实测：回填 30 天 → 面板显示综合分卡 + 雷达图 + 走向，归因句指向真实热点文件
- 消费方冒烟：Phase 3 判据可从 health_index 行直接读取（模拟一个「跌破阈值→应触发」断言）

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/health/health-score.ts | 新增 | 评分纯函数 + 趋势判定 |
| src/usecases/health/rhi-scan-worker.ts | 修改 | 快照后旁路计算 health_index 行 |
| src/usecases/health/snapshot-rows.ts | 修改 | +health_index 行构建 |
| src/interface-adapters/http/controllers/rhi-controller.ts | 修改 | +score 端点；`TREND_KEYS` 扩展（+health_index 系列键，趋势序列聚合按白名单过滤，不加则 trends 不返回） |
| src/interface-adapters/http/router.ts | 修改 | 路由注册 |
| scripts/health-backfill.mjs | 修改 | 回填循环中加入 health_index 旁路计算（历史综合分/走向补算） |
| web/src/pages/health/index.tsx | 修改 | 综合分卡 + 雷达图 |
| web/src/api/client.ts | 修改 | score DTO |
| tests/usecases/health/health-score.test.ts | 新增 | 评分/分级/走向单测 |
| settings（DB） | 新增 key | 自校准阈值快照（可追溯可手调） |

## 后续动作

- 本设计过对抗审视 → 定稿 → 拆 F 文档实施（预计 1-2 个 PR）
- 与 Phase 3（#405-#407）衔接：health_index 是 #13「信号→改进闭环」的触发判据来源之一
