---
id: F20260825i379
title: issue #379 ②⑥ 收尾：审视维度与方案模板增补
summary: |
  落地 issue #379 的两个轻量采纳项：② 承诺面对账——adversarial-review 的正确性维度加"F 承诺对账"检查项（逐条核对 F 文档声称的功能点 vs 代码实现）；⑥ 字段消费性审查——requirement-analysis 的方案设计模板加"新增 schema 字段必须声明消费方"约束。均为 prompt 层改动，无代码变更。
change_type: prompt
status: active
capability_test: "n/a: 纯 skill 文案改动（B 类），行为变化由后续审视流程体现"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
---

# issue #379 ②⑥ 收尾：审视维度与方案模板增补

## 背景

issue #379（tutu-vessel 蒸馏候选清单）经双模型评估与搭档讨论后关闭。⑤ 版本门经评估不合入（PR #389 已关闭，决策：git log + session 日志已够用）。剩余采纳项中，② 承诺面对账和 ⑥ 字段消费性审查是轻量 prompt 层改动，本 PR 落地。

③ 检索方法论（search-why + 负例指标）并入 R20260811rclo 搜索可观测性方向，不在本 PR 范围。

## 目标

T1: 对抗审视流程能发现"F 文档声称了但代码没接线"的承诺面偏差
T2: 技术方案阶段拦截"新增 schema 字段无消费方"的设计

## 非目标

- 不做 lint 自动化对账（F 文档是自然语言，AST 级对账误报率高——issue #379 评估结论）
- 不实现 search-why / 负例指标（③ 走 R20260811rclo）

## 方案设计

### ② 承诺面对账 → adversarial-review 正确性维度

`adversarial-review/references/review-dimensions.md` 的 Correctness 维度加一条：

> **F 承诺对账（issue #379 ②）**：逐条核对特性文档声称的功能点 vs 代码实现——文档说"已实现 X"的每一条，检查代码中是否有对应符号/逻辑。承诺面跑在代码前面（文档声称了但代码没接线）时逐条列出

选 Correctness 维度而非基础维度的理由：承诺对账本质是"实现是否符合设计意图"的子问题，跟随焦点维度选择（高风险 PR 深查），不是每个 PR 必查。

### ⑥ 字段消费性审查 → requirement-analysis 方案设计模板

`requirement-analysis/SKILL.md` 的产出模板"方案设计"节加约束：

> **新增 schema 字段必须声明消费方（issue #379 ⑥）**：方案涉及新增数据库 schema 字段（尤其记忆系统）时，必须声明"哪个模块/流程读取该字段"——先存了再说、无消费方的字段在审视时会被打回

**新增 schema 字段的消费方声明**：本改动只修改 skill 文案（markdown），不新增数据库字段。

## 影响范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `.pi/skills/adversarial-review/references/review-dimensions.md` | 修改 | Correctness 维度加 F 承诺对账检查项 |
| `.pi/skills/requirement-analysis/SKILL.md` | 修改 | 方案设计模板加字段消费方约束 |
| `docs/features/2026/08/25/F20260825i379-review-dimensions-and-template-additions.md` | 新增 | 本特性文档 |

审视獭和方案作者（大獭/小獭）的行为会随 prompt 变化：审视时多一道承诺对账检查，方案设计时多一道字段消费方声明。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 承诺对账放焦点维度 vs 基础维度 | 焦点维度（Correctness 内） | 升为基础维度 B5 | 承诺对账需要读 F 文档逐条核对，每个 PR 都做成本高；跟随焦点选择更务实 |
| 检查项加在维度文件 vs SKILL.md | review-dimensions.md | SKILL.md 正文 | SKILL.md 已 278 行超 lint 建议上限，维度细节归 references 是既定模式 |

## 验证

- [ ] lint:skills 通过（skill 契约校验）
- [ ] 两处改动的措辞与各自文件既有风格一致
