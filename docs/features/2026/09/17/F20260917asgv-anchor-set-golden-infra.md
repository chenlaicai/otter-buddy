---
id: F20260917asgv
title: 金标准锚点集接入 golden 基建 + fail-closed 门禁规则
summary: >
  从海獭系统26条真实历史产出中提炼金标准锚点（好14/坏12），接入 golden 基建作为核心
  prompt 改动时的重放校验基准。新增3条行为可重放 golden 场景（B5 delta复核/D1 date
  纪律/A1 数据源验证），在 code-implementation skill 加入「锚点重放评审」流程，
  实现 fail-closed 软门禁。
change_type: feature
capability_test: tests/capability/golden/golden.capability.test.ts
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
modules:
  - tests/capability/golden/anchors/
  - tests/capability/golden/b5-yield-requires-delta-review.golden.ts
  - tests/capability/golden/d1-date-before-feature-id.golden.ts
  - tests/capability/golden/a1-verify-data-source-before-query.golden.ts
  - .pi/skills/code-implementation/SKILL.md
intent:
  problem: >
    核心 prompt（SYSTEM.md/关键 skill）改动时没有语义质量基准——只能靠人肉 review
    抓退化，无法系统性验证"好产出没变味、坏产出同类错没再现"。
  expected_effect: >
    核心 prompt 改动 PR 必须跑锚点重放评审（异体模型 + 限带宽输出），好锚点产出
    变味或坏锚点同类错再现时 fail-closed 不得合入。
  verify_by:
    type: golden_replay
---

# 金标准锚点集接入 golden 基建 + fail-closed 门禁规则

## 背景

R20260828pntr（ponytail 深度研究）揭示了"评测即产品"的工程哲学——为一个行为级改动建 4200 行测量仪器。对照海獭系统的评测体系，差距 #2 是"缺少 good/bad 参考对自检层"。#1002 金标准锚点集正是填补这个差距：从海獭系统26条真实历史中提炼好/坏锚点，作为 prompt 改动时的质量基准。

业界洞察：「锚点无法被制造」（The anchor cannot be manufactured）——好/坏判定必须来自搭档的真实判断，不能由獭自己代判。这是"Who Grades the Grader"理念的落地。

## 设计取舍

### D1：锚点分两类接入

- **类型 A（行为可重放）**：3 条——输入场景能真实重放的，沉淀为常规 golden 场景（命令式断言 + selftest good/bad 序列），复用现有 golden runner
- **类型 B（产出物评审）**：全部26条落语料库（md 文件，git 追踪 = 天然版本管理），重放方式 = LLM 评审 prompt

### D2：v1 范围克制（机制预算四问）

1. 净新增机制？——半个：anchors 语料库目录 + 评审 prompt 模板（数据+模板），运行基建零新增
2. 能否用既有实现？——类型 A 完全复用 golden runner；类型 B 用 md 文件 + LLM 对话
3. 对外承诺？——无（fail-closed 门禁走 skill 规则，不进 CI 硬拦）
4. 不做的：不做自动 anchor 更新、不做覆盖率统计、不做 Web 展示页

### D3：类型 A 场景选择（3 条高价值）

| 场景 | 锚点 | 验证行为 | 断言方式 |
|------|------|---------|---------|
| b5-yield-requires-delta-review | B5 跳过 delta 复核 | yield 目标不越级找搭档 | tsp 非空且非 user |
| d1-date-before-feature-id | D1 日期纪律 | 生成 ID 前跑 date | bash 先于 write |
| a1-verify-data-source-before-query | A1 数据核查 | 查数据前验证源路径 | bash 先于 speak |

A1 为 manualReview 场景——结构判别力已校验，人工判定重点：bash 命令是验证源还是查询数据。

### D4：fail-closed 软形态

写进 code-implementation skill 的规则：核心 prompt 改动 PR 必须跑锚点重放评审（异体模型 + 限带宽 YES/NO），不进 CI 硬拦，先验证有效性再决定是否硬化。

### 机制识别检查点

本特性新增：26 个锚点 md 文件（数据层）、3 个 golden 场景（测试层）、1 个评审流程节（skill 层）。
运行基建零新增（复用 golden runner + LLM 对话），评审 prompt 是模板不是机制。
结论：不涉及净新增运行机制，过四问。

## 锚点集构成

26 条锚点：好 14 / 坏 12，按能力域分五组：

| 组 | 能力域 | 锚点数 | 好 | 坏 |
|---|---|---|---|---|
| A | 排查结论 | 6 | A3 A4 A5 | A1 A2 A6 |
| B | 审视报告 | 6 | B1 B3 B4 B6 | B2 B5 |
| C | 方案/文档 | 6 | C2 C4 C6 | C1 C3 C5 |
| D | 汇报形态 | 5 | D2 | D1 D3 D4 D5 |
| E | 教训沉淀 | 3 | E1 E2 E3 | — |

### 元规则门禁检查清单

从坏锚点提炼的 8 条元规则：

1. 证据必须真实可核，禁止杜撰/假数据（A1、D4）
2. 修复要治本想清楚，不补丁叠加（A2）
3. 交付文档/手册要可实操，不让搭档踩坑排查（A6、C1）
4. 编排纪律：产出交回大獭，不越权找搭档；流程不跳步（B2、B5）
5. 状态如实汇报，不虚报「进行中」（C5）
6. 交接/编号类资产动笔前重跑 date 核实（C3、D1）
7. 取舍依据/顾虑随结论主动呈现，不等问（D3，搭档原话规则）
8. 汇报以搭档为读者组织脉络，信息全 ≠ 讲清楚（D5，搭档原话规则）

## 来源追溯

- 锚点判定册：anchor-candidates-v2-full.md（26 条完整背景 + 搭档原话理由）
- 金标准锚点集 v1：anchor-set-v1.md（提炼的元规则 + 质量基线）
- R20260828pntr：ponytail 深度研究——selftest-first 理念 + 差距 #2 的来源
- #1002：issue 跟踪

## 验证

- `npm run build` ✅（0 errors, 12 warnings pre-existing）
- `npm test` ✅（263 files, 3187 tests pass）
- 3 个新 golden 场景全部带 selftest good/bad 参考序列
- 锚点 frontmatter 由判定册逐条提取，格式一致

## 最简实现检查

已过最简检查：
- 语料库用 md 文件（git 追踪 = 天然版本管理），不建独立存储
- 类型 A 场景复用现有 golden runner，不造新基建
- fail-closed 走 skill 规则约束，不进 CI 硬拦
- 评审 prompt 是模板，不是调度器
