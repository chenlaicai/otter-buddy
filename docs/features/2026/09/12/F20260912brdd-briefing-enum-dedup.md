---
id: F20260912brdd
title: 决策简报六要素枚举去重：BIG_OTTER.md 与 SYSTEM.md R8 收敛为指针（#881）
summary: BIG_OTTER.md「呈搭档拍板的硬规则」段与 SYSTEM.md R8「终审简报」段各自枚举决策简报骨架六要素，同一内容两处落笔（熵增典型形态）。按 issue #881 方案：两处枚举均删除，只留硬规则 + 模板真相源指针（review-protocol/references/decision-briefing.md），枚举归模板自身单一真相源。
change_type: fix
capability_test: "n/a: 纯文档文本收敛，无行为变更（两处语义等价，枚举内容本就从模板复制）"
created_in_conversation: a344e752-8e89-469a-ad04-5a5108867fa0
tags: [prompt, entropy-reduction, documentation, decision-briefing]
intent:
  problem: "决策简报骨架六要素在 BIG_OTTER.md 与 SYSTEM.md R8 两处重复落笔——同一规则多处落笔是熵增典型形态（F20260909sentr 判据），模板更新时两处易漂移"
  expected_effect: "六要素枚举只存在于 decision-briefing.md 单一真相源；BIG_OTTER.md 与 SYSTEM.md R8 只留硬规则 + 指针"
  verify_by:
    type: static_only
    detail: "grep 两处文件无六要素枚举；decision-briefing.md 保持六要素完整"
modules:
  - prompts/identity/BIG_OTTER.md
  - .pi/SYSTEM.md
created_at: 2026-09-12
---

# 决策简报六要素枚举去重（#881）

## 背景

issue #881（PR #861 对抗审视 delta 复核建议发现 1，检宝提出）：

> BIG_OTTER.md「呈搭档拍板的硬规则」段（62-64 行）枚举了决策简报骨架六要素，SYSTEM.md R8 收敛后仍保留同名枚举——同一内容两处落笔，是 F20260909sentr 熵减判据（同一规则多处落笔 = 熵增典型形态）下应清理的重复。模板真相源在 `review-protocol/references/decision-briefing.md`。

## 目标

T1: BIG_OTTER.md 六要素枚举删除，保留硬规则 + 指针
T2: SYSTEM.md R8 括号内同名枚举同步删除（两处都收敛，否则只是换了个地方重复）

## 非目标

- ❌ 不动 decision-briefing.md 模板本身（它是真相源，枚举归它）
- ❌ 不改任何行为语义（两处枚举内容本就与模板一致，纯去重）

## 方案设计

按 #881 修复方案执行，并扩展一步：issue 只点了 BIG_OTTER.md，但 SYSTEM.md R8 括号内也有同名枚举——只删一处等于把重复换了个位置，两处同步收敛才达成「枚举归模板自身」。

- BIG_OTTER.md：删「骨架：一句话结论 → …… → 锚点」整句，保留「必须附决策简报 + 模板真相源指针 + 裸奔违规」
- SYSTEM.md R8：删「（骨架六要素：结论/背景/选项对比/獭间分歧/推荐+理由+置信度+风险/锚点）」括号段

## 影响范围

纯文本收敛，无行为变更。执行獭读到的指令语义不变（硬规则 + 指针均保留）。

## 风险与约束

- 指针断裂风险：decision-briefing.md 若被移动/删除，两处指针失效——缓解：该文件已有两处引用，移动时需全局 grep（既有惯例）

## 不兼容更新

无。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| SYSTEM.md R8 括号枚举 | 同步删除 | 按 issue 字面只删 BIG_OTTER.md | 只删一处 = 重复换位置，未达「枚举归模板自身」；两处同构（硬规则+指针）才是收敛终态 |
| 枚举保留位置 | decision-briefing.md 单一真相源 | 三处都保留 | 多处落笔 = 熵增（F20260909sentr 判据），模板更新时漂移 |

## 验证

- grep 两处文件无六要素枚举残留
- decision-briefing.md 六要素完整未动

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| prompts/identity/BIG_OTTER.md | M | 删六要素枚举句，留硬规则+指针 |
| .pi/SYSTEM.md | M | R8 删括号内六要素枚举 |
| docs/features/2026/09/12/F20260912brdd-briefing-enum-dedup.md | A | 本特性文档 |
