---
id: F20260826scd4
title: 港股命令与操作参考层 — stock-cli.py 扩展 + stock-analysis skill 升级
summary: 新增港股日线和估值命令（hkline/hvaluation），skill 结论层新增可执行操作参考。
change_type: feature
status: development
capability_test: "n/a: 代码变更（stock-cli.py 扩展）+ prompt 层 skill 定义；通过单测+lint 验证"
created_at: 2026-08-26
created_in_conversation: 7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d
tags: [skills, stock, hk, actionable-advice, capability]
modules: [scripts/stock-cli.py, src/interface-adapters/agent-runtime/tools/stock-tools.ts, .pi/skills/stock-analysis/]
---

# 港股命令与操作参考层

## 背景

小米（01810.HK）实战分析暴露两个缺口：
1. stock-cli.py 仅支持 A 股（六位码），港股需手动调 akshare
2. skill 结论层是纯数据呈现，搭档期望有可执行的操作建议

## 设计

### Part A：港股命令

| 命令 | akshare 函数 | 说明 |
|------|-------------|------|
| `hkline <code>` | `stock_hk_daily(symbol)` | 新浪源日线，返回全量(~2000根)，本地裁 days 窗口 |
| `hvaluation <code>` | `stock_hk_valuation_baidu` | PE-TTM + PB 三年百分位（最核心的估值信号） |

港股代码格式：`^\d{5}$`（如 01810），不复用 A 股六位码校验。

财务明细暂缺（港股财务接口不可用），输出如实标注。

### Part B：操作参考层

综合结论从三层改四层，新增**操作参考层**：
- 每条建议必须含：触发条件 + 动作 + 止损位
- 按风险偏好分层（稳健/激进）
- 价位必须来自本次分析的实际数字
- 禁止空泛表述（「建议关注」「需谨慎」不算操作参考）

## 变更范围

| 文件 | 变更类型 |
|------|----------|
| `scripts/stock-cli.py` | 修改（+hkline, +hvalidation） |
| `scripts/README-stock-cli.md` | 修改（补港股命令文档） |
| `src/interface-adapters/agent-runtime/tools/stock-tools.ts` | 修改（+hkline/hvalidation 枚举，code 校验放宽） |
| `.pi/skills/stock-analysis/SKILL.md` | 修改（港股支持 + 操作参考层） |
| `tests/interface-adapters/agent-runtime/stock-tools.test.ts` | 修改（+4 项港股测试） |
| `docs/features/2026/08/26/F20260826scd4-stock-hk-and-action-advice.md` | 新增（本文件） |

## 验证

- hkline 01810: 收盘 27.76 ✅（与实战数据一致）
- hvaluation 01810: PE 19.29, 分位 22.5% ✅（与实战数据一致）
- 单测: 15 passed（原 11 + 新增 4 项港股测试）
- lint: 0 errors
