---
id: F20260824ndfg
title: degenerate-detector-3-5kb-negative-fixtures
doc_type: feature

summary: |
  补充 DegenerateDetector 3-5KB 区间阴性夹具测试（Issue #346 tech-debt 闭环）。
  F20260820d338 将 minBlockLength 5000→3000 后，3-5KB 块首次暴露于
  distinct-ratio 机制但无阴性覆盖。实测 7 类夹具 distinct ratio 全部 = 1.000，
  确认无假阳性风险，阈值无需回调。

causal_links:
  from:
    - F20260820d338
  references:
    - "#346"
    - "#338"

status: development
change_type: feature-update
tags: [agent, degenerate, test, negative-fixture, issue-fix, tech-debt]
modules:
  - tests/frameworks/agent/degenerate-detector.test.ts
capability_test: "n/a: 纯测试补充（+285/-28 行，零实现改动），无 LLM 行为依赖"
created_in_conversation: 0a56b7f8-cf7f-42e0-aa34-33eddde61511
---

# F20260824ndfg: DegenerateDetector 3-5KB 区间阴性夹具

## 背景

### 问题描述

F20260820d338（PR #342）将 DegenerateDetector 的 `minBlockLength` 从 5000 降至 3000，
使 distinct-ratio 机制（机制 B）更早介入。但当时的阴性安全边际验证只基于
**110 个 ≥5KB 合法块**（最低 distinct ratio 0.838）——**3-5KB 区间的合法输出
零覆盖**，新阈值在该区间是否存在假阳性风险未经测试。F20260820d338 文档的
Discovered Issues 第 1 条即为此已知局限，Issue #346 建档跟踪。

### 假阳性风险的理论来源

kimi-分析獭-v2 在 #346 指出：3KB 块只有 30 个 100 字符分段，**样本量小、
ratio 方差大**（每 ±1 个 distinct 分段移动 ratio ±0.033，约为阈值的 11%），
理论上假阳性风险比 5KB+ 区间更高。风险集中在机制 B（distinct-ratio），
机制 A（maxWindowRepeats=20）不受块长影响。

## 实现内容

纯测试变更（`tests/frameworks/agent/degenerate-detector.test.ts`），
零实现改动。新增 13 个测试：

### 1. 阴性夹具（7 类，全部档位 ≥3000 字符）

| # | 夹具类型 | 场景特征 | 尺寸档（实测） |
|---|---------|---------|--------------|
| 1 | 伪随机文本 | 边界扫描 | 3000-5000，6 档 |
| 2 | markdown 表格 | 行结构重复、字段各异 | 3158/3608/4050 |
| 3 | 编号 checklist | bullet 前缀重复 + 8 条内容池复用 | 3107/3670/4194 |
| 4 | 固定宽度日志 | 格式 token 相同、仅数值变化 | ~4.3-5.1KB |
| 5 | JSON 数组 | key 集合逐字重复、value 各异 | ~3.2-4.8KB |
| 6 | 中文段落 | 过渡词/主语/谓语小池组合 | ~3-4.5KB |
| 7 | 混合报告 | 段落+表格+清单（最接近真实小獭输出） | 3.5-5KB |

覆盖 #346 点名的三类高危形态：伪随机边界、结构化表格、含局部重复结构的清单。

### 2. distinctRatioOf() ratio 护栏断言

测试内复制机制 B 分段逻辑（100 字符非重叠分段，与实现同参数），
7 类阴性夹具全部断言 `ratio > 0.5`——"安全边际 3.3 倍"的核心结论从
PR 描述/注释下沉为可回归验证的断言，防止未来夹具参数微调后贴阈值飞行。

### 3. 阳性对照（灵敏度保留验证）

- 3KB 精确重复 → repeat_window 触发（机制 A 在新阈值下不漏报）
- 3.2KB 近似重复（6 变体池）→ 37 字符/块流式喂入中途触发 distinct_ratio，
  触发点实测 fed=3034（首次跨过 minBlockLength 的 add 块）——覆盖
  OutputGuard 运行时真实路径（流式增量、首次命中即介入）

### 4. 阈值语义边界（3KB/5KB 双点）

每行恰好 100 字符（含换行）按 n 个逐字模板**确定性轮转**——分段与行
完全对齐，ratio = n/行数：

| 用例 | ratio | 判定 |
|-----|-------|------|
| 30 行 × 8 模板 | 8/30 ≈ 0.27 | 触发（≤ 0.3） |
| 30 行 × 12 模板 | 12/30 = 0.40 | 不触发 |
| 50 行 × 15 模板 | 15/50 = **0.300 恰好压阈值等值点** | 触发（验证 ≤ 语义） |
| 50 行 × 16 模板 | 16/50 = 0.32 | 不触发 |

语义结论：**机制 B 的判定语义是"≥3KB 输出中逐字重复分段超 70% 才算退化"**
——真实合法输出哪怕高度模板化（字段各异）也远达不到；逐字重复才是退化信号。

## 核心结论

1. **3-5KB 区间 7 类阴性夹具 distinct ratio 全部 = 1.000**（25 个样本），
   阈值 0.3 的安全边际约 3.3 倍，与 ≥5KB 历史实测最低 0.838 一致
2. **minBlockLength=3000 无假阳性风险，无需回调**——回应 #346 评论中
   kimi-分析獭-v2 的升级担忧（"若触发假阳性需讨论是否调回 4000"）
3. kimi-分析獭-v2 建议的三类用例全部覆盖

## 对抗审视记录

检视獭-412 对 PR #412 进行对抗审视（第一轮），发现 2 严重 + 3 建议，
全部处置闭环：

1. **严重 1（夹具空转）**：初版 tableText 最小档 2780、checklistText 最小档
   2885 字符低于 minBlockLength，机制 B 不介入、断言恒真；且断言下限
   （2780/2880）恰等于实测值——检视判定为"放宽断言迁就样本"。修复：
   档位提升至 3158/3107（57 行/118 条），断言下限统一收紧 `>= 3000`
   并注明设计意图
2. **严重 2（特性文档缺失）**：搭档裁决纯测试 PR 豁免后，终审时搭档
   显式要求补充——即本文档
3. **建议 3/4/5（全部采纳）**：ratio 护栏断言、5KB 边界双点、流式阳性
   分别见上文"实现内容"第 2/3/4 节
4. **额外自查**：初版注释 `12/30 ≈ 0.33` 系算术错误（实为 0.40，判定不变），
   已订正；alignedPoolText 由随机抽取改为确定性轮转

## 验证

### 测试覆盖

- DegenerateDetector 单文件：22/22 通过（原 9 + 新 13）
- tests/frameworks/agent 全量：176/176 通过（无回归）

### CI 状态

- CI check：pass（rebase 到 main 6751bdd3 后 1m46s）
- Lint：0 errors
- Build：通过

## 影响范围

### 直接影响

- 3-5KB 区间阴性覆盖从 0 → 7 类夹具 25 个样本
- "阈值安全边际 3.3 倍"成为可回归断言（ratio > 0.5 护栏）
- 机制 B 阈值语义（≤ 判定、70% 逐字重复线）有 3KB/5KB 双点锁定

### 无影响

- DegenerateDetector 实现零改动（本 PR 硬边界）
- 运行时行为不变

## Discovered Issues

无新发现。初版发现并已在 PR 内闭环：夹具空转（严重 1）、注释算术错误。
