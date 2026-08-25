---
id: F20260825cmhg
title: commit-msg 钩子类型白名单与 commit-convention.md 对齐
summary: |
  Issue #427（tech-debt）：commit-convention.md Type Tags 列出六种类型，但 commit-msg 钩子
  正则白名单只有三种（Feature Update/BugFix/New Feature），Design/Refactor 类提交被拒收，
  PR #420 被迫降级用 Feature Update。方案：钩子白名单补录 Design|Refactor（改钩子方向，
  搭档拍板），错误提示文案同步。
change_type: bugfix
status: active
capability_test: "n/a: 纯 shell/正则改动，无 LLM 参与行为"
created_in_conversation: 376077f2-7ebb-442b-943e-c7ce547f4f8a
---

# commit-msg 钩子类型白名单与 commit-convention.md 对齐

## 背景与需求

### 问题描述

`.pi/skills/code-implementation/references/commit-convention.md` 的 Type Tags 表列出六种类型（New Feature / Feature Update / BugFix / Refactor / Design），但 `.githooks/commit-msg` 的正则白名单只有三种——按文档写 `[Design]` 或 `[Refactor]` 的 commit 被钩子拒收。

实际咬人记录：PR #420（纯文档变更）按文档写 `[Design]` 被拦，被迫降级 `[Feature Update]`；历史 #159 曾以 `[Refactor]` 入库（当时钩子尚未收紧）。类型标签失真损害提交历史可检索性——钩子注释明言模板的目的就是「让变更类型在提交历史中可检索」。

来源：Issue #427 ← PR #420 对抗审视（reviewer-420 建议发现 1）。

### 方案选择

两个候选（issue 内列出）：①改钩子（白名单补录，与文档对齐）；②改文档（删 Design/Refactor，与钩子对齐）。

**搭档拍板：①改钩子**。理由：文档语义更完整——纯文档（Design）与重构（Refactor）是真实存在的变更类型（各有历史实例），砍成三类是语义损失；方向 ② 只是把文档迁就缺陷。

## 方案设计

`.githooks/commit-msg` 三处改动，类型白名单抽为 `const types` 变量（消除 f/r 两条正则的重复字面量）：

1. f 正则（F 前缀必带类型）：`Feature Update|BugFix|New Feature` → `+ types +`
2. r 正则（R 前缀类型可省略）：同上
3. 错误提示模板行：补 `Refactor|Design`

新增一行注释锚定决策：`// 类型白名单与 commit-convention.md Type Tags 对齐（补录 Design/Refactor，#427）`。

### 不改的东西（边界）

- CI PR 标题校验（ci.yml `Check PR title format`）**不动**——它只校验 ID 和模块格式，不校验类型标签，与本修复无冲突（已核实）
- commit-convention.md 文档不动——它本来就是对的，本次以它为真相源
- 类型语义（何时用哪种）不在本次范围，维持文档既有定义

## 影响范围

- 单文件：`.githooks/commit-msg`（+4/-3 行）
- 行为变化：`[Design]`/`[Refactor]` 类型 commit 从被拒 → 被接受；既有三种类型行为不变
- CI：PR 标题校验不受影响；存量提交不受影响（钩子只管新 commit）

## 验证

钩子脚本实测（6 用例全过）：

- [x] `[F...][Design] 中文标题` → PASS（新增类型）
- [x] `[F...][Refactor] 中文标题` → PASS（新增类型）
- [x] `[F...][Feature Update] / [BugFix] 中文标题` → PASS（既有类型不回归）
- [x] `[F...][BugFix][Incompatible] 中文标题` → PASS（Incompatible 后缀）
- [x] `[R...][research] 中文标题` → PASS（R 前缀类型可省略）
- [x] `[F...][WrongType] 中文标题` → REJECTED（白名单外类型仍被拒）

## Discovered Issues

无。

## 决策史

- 2026-08-25：初始实现（大獭，glm）。方向 ①（改钩子）由搭档拍板；白名单抽 `const types` 消除双正则重复；CI 标题校验核实无类型检查、不需联动
