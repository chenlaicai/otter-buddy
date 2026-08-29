---
id: F20260829mx5w
title: RHI 信号采集缺陷修复：chain_stall 孤儿文档 + hotspot 测试文件
summary: 修复 chain_stall 信号对从未有 commit 的 draft/proposed 文档误报 critical，以及 hotspot 检测混入测试文件导致信号稀释的问题。
change_type: fix
created_in_conversation: fe63e059-635f-4387-9dcd-5b685a58e6e8
created_at: 2026-08-29T09:50:00+08:00
status: development
modules: [health]
tags: [rhi, signal-detection, bugfix]
---

# RHI 信号采集缺陷修复

## 背景

观察期 121 条 open 信号（#449 评估实测）发现两类采集缺陷：

1. **chain_stall 孤儿文档误报**：70 条 chain_stall 中 50 条（71%）evidence 显示「滞留 **null** 天」
   - 根因：stallDays 计算对从未有关联 commit 的 F 文档返回 null，仍触发 critical 信号
   - 证据：F20260812fdmc 在 git log 无任何匹配 commit（从未开工）却报 critical；F20260803emlo 末次关联 commit 三周前（真实中途停滞）——两者语义完全不同

2. **hotspot 混入测试文件**：40 条 hotspot 中 11 条为 tests/ 文件
   - 根因：测试文件随功能代码联动修改是正常节奏，不应计入源码热点

## 修复方案

### Fix 1: chain_stall 孤儿文档过滤

**修改文件**: `src/usecases/health/detect-signals.ts`

- 新增 `DOC_NEVER_STARTED_STATUSES` 常量（draft, proposed）
- `detectChainStall` 函数中过滤掉 `commitCount === 0` 且文档状态为 draft/proposed 的链
- 对于仍有链的 doc-only 链（如 development 状态但无 commit），用 `createdAt` 替代 `daysSinceLastCommit`

**语义说明**：
- draft/proposed 文档从未有 commit 是常态（项目初始化、文档规划阶段），不应触发 critical 信号
- development/design 状态文档从未有 commit 仍值得关注（可能是启动后遗忘），但证据应基于 createdAt 而非显示 "null 天"

### Fix 2: hotspot 测试文件排除

**修改文件**: `src/usecases/health/detect-signals.ts`

- 新增 `isTestFile` 判定函数，匹配 `tests/`、`__tests__/`、`*.test.*`、`*.spec.*` 路径模式
- `detectHotspot` 函数中跳过测试文件的计数

**语义说明**：测试文件随功能修改联动更新是正常节奏，与源码热点语义不同；混入热点会稀释信号质量

## 测试覆盖

| 场景 | 测试用例 | 预期 |
|------|---------|------|
| chain_stall | draft 文档从未有 commit 不触发 | signal 不存在 |
| chain_stall | development 文档从未有 commit 仍触发 | evidence 含 createdAt 天数（非 "null 天"） |
| hotspot | 测试文件不进入热点检测 | signal 不存在 |
| hotspot | 源码文件仍正常检测 | filePath = src/core.ts |

## 验证

- `npm run test` 全部通过（176/177，排除预存在的 rhi-scan-worker 用例）
- 新增 4 个测试用例覆盖上述场景

## 变更范围

| 文件 | 变更类型 |
|------|---------|
| `src/usecases/health/detect-signals.ts` | 修复 chain_stall 过滤 + hotspot 排除 |
| `tests/usecases/health/detect-signals.test.ts` | 新增 4 个测试用例 |
| `docs/features/2026/08/29/F202608298slt-rhi-signal-collection-fix.md` | 特性文档（本文件） |

## 顺带核实

- **signal_events 表**：已确认表存在，0 条记录 = 未实现写入（非 bug）。Phase 3 会使用此表，本 PR 不实现。
