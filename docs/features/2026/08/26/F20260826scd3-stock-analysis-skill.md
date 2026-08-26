---
id: F20260826scd3
title: PR3 stock-analysis skill — A 股个股分析能力
summary: 新建 stock-analysis skill，基于 stock_data 工具引导 LLM 完成基本面+技术面+消息面+资金面的多维分析，含免责声明。
change_type: feature
status: development
capability_test: "n/a: prompt 层 skill 定义，无代码行为；通过 lint:skills 结构校验验证"
created_at: 2026-08-26
created_in_conversation: 7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d
tags: [skills, stock, analysis, capability]
modules: [.pi/skills/stock-analysis/, prompts/skills/manifest.yaml]
---

# PR3: stock-analysis skill

## 背景

Issue #463 第三期——把「怎么看盘、怎么分析」的 know-how 沉淀成 skill。

PR1（stock-cli.py 桥脚本）和 PR2（stock_data TS 工具）已合入 main，数据获取层就绪。PR3 补齐分析层：让 LLM 知道**何时调哪个命令、数据怎么看、结论怎么出**。

## 设计

### Skill 定位

- **category**: technique（有结构化工作流）
- **触发**: 搭档要求看盘/分析个股/A 股数据/复盘/盯盘
- **排除**: 通用数据查询 → core-workflow，闲聊 → companion
- **免责**: 所有输出附「不构成投资建议」声明

### 工作流

1. 确认目标（代码+范围）
2. 数据采集（按范围调 stock_data 命令）
3. 基本面分析（overview + finance → 估值/盈利/市值）
4. 技术面分析（kline → 趋势/位置/量能/波动率）
5. 消息面分析（news → 事件/舆情 + 与技术面交叉验证）
6. 资金面分析（northflow → 外资动向）
7. 综合结论（事实层/推断层/风险提示，标注数据来源与截止时间）

### 分析框架

- **基本面**: PE/PB 行业对比、营收增速、ROE 趋势
- **技术面**: MA 排列关系、相对位置、量能趋势
- **消息面**: 公告/事件倾向 + 与价格异动交叉验证
- **资金面**: 北向资金流向关联
- **结论分层**: 事实 → 推断（标注依据）→ 风险提示

## 变更范围

| 文件 | 变更类型 |
|------|----------|
| `.pi/skills/stock-analysis/SKILL.md` | 新增 |
| `prompts/skills/manifest.yaml` | 修改（新增 stock-analysis 条目） |
| `docs/features/2026/08/26/F20260826scd3-stock-analysis-skill.md` | 新增（本文件） |

## 验证

- lint: `npm run lint:skills` 0 errors
- Skill 行数: 87 行（≤ 200 限制）
- Manifest 一致性: name/category 双向校验通过
