---
id: F20260721cap0
title: capability-oriented-skills
doc_type: feature

# 记忆索引
summary: |
  将 otter-* skills 从角色手册（"你是设计獭"）重构为能力导向（"做需求分析时关注这些点"）。每个 skill 描述一种通用能力：关注什么、步骤是什么、行为规范是什么，不绑定特定角色。角色成为能力的组合而非 skill 的入口。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260716t2ab

# 元数据
status: design
change_type: feature
tags: [skills, refactoring, capability]
modules: [skills/]

# 时间
created_at: 2026-07-21
---

# F20260721cap0 能力导向 Skill 重构

## 背景 [required]

### 问题

当前 otter-* skills 以角色为中心组织：`otter-design` 定义"设计獭该做什么"，`otter-develop` 定义"开发獭该做什么"，`otter-review` 定义"审查獭该做什么"。

这导致三个问题：

| # | 问题 | 影响 |
|---|------|------|
| P-1 | 能力不可复用 | 环境准备、编码原则等能力被锁在角色 skill 里，无法被其他场景独立调用 |
| P-2 | 角色和能力耦合 | 想做一次独立的需求分析，必须加载整个"架构师角色"，带入不相关的约束 |
| P-3 | 新场景成本高 | 每加一个使用场景就要写一套角色 skill，大量重复 |

### 根因

Skill 设计以"谁来做"（角色）为入口，而非以"做什么"（能力）为入口。角色和能力混在同一个 skill 文件里。

### 现状

| Skill | 本质 | 问题 |
|-------|------|------|
| `otter-design` | 角色手册："你是设计獭" | 需求分析能力被包装在角色定义里 |
| `otter-develop` | 角色手册："你是开发獭" | 编码实现能力被包装在角色定义里 |
| `otter-review` | 角色手册："你是审查獭" | 检视能力被包装在角色定义里 |

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "skill是通用的能力，不是绑定角色" | 通用；不绑定角色 | skill 应描述能力本身，角色是能力的组合 | 对话 |
| UA-2 | "当要做需求分析时，要着重关注xxx，有什么做事步骤" | 关注点；做事步骤 | 能力 skill = 关注什么 + 怎么做 | 对话 |
| UA-3 | "当要开始写代码时，要识别清楚代码仓位置，以及不能污染主目录所以要新建worktree" | 识别仓库；worktree 隔离 | 环境准备是代码实现的前置关注点 | 对话 |

## 目标 [required]

### T1 — 能力导向的 skill 结构

将三个角色 skill 重构为三个能力 skill，每个 skill 描述：关注点、步骤、行为规范。

### T2 — 保持内容完整性

原有 skill 中的有效规则（编码原则、测试策略、检视维度等）全部保留，只是重组到能力 skill 中。

### T3 — 消除角色绑定

skill 中不出现"你是 X 獭"、"你的职责是"等角色定义。触发方式从角色入口变为能力入口。

## 非目标 [required]

- 不修改 cd-* skills（snail-shell 仓库的多角色 SOP 不在本次范围内）
- 不新增能力 skill（只重构现有的三个）
- 不改变 skills 目录的发现机制（SKILL.md frontmatter 格式不变）

## 设计 [required]

### 能力映射

| 新 Skill | 聚焦能力 | 来源 |
|----------|----------|------|
| `requirement-analysis` | 意图锚提取、模糊点识别、scope 界定、方案输出 | otter-design 的核心内容 |
| `code-implementation` | 仓库识别→worktree→编码原则→测试策略→自检→提交 | otter-develop + 环境准备 |
| `adversarial-review` | 6 维检视、独立验证、结构化报告、问题处置 | otter-review 的核心内容 |

### 角色 → 能力组合

原有角色可以通过组合能力 skill 来实现，但不再需要单独的角色 skill：

| 角色 | 能力组合 |
|------|----------|
| 设计獭 | requirement-analysis |
| 开发獭 | code-implementation |
| 审查獭 | adversarial-review |

### Skill 结构设计

遵循 Anthropic 官方 Skill 规范的渐进式披露原则：

```
skill-name/
├── SKILL.md          ← 核心内容（lean, ~1500 words），始终在触发时加载
└── references/       ← 详细参考，按需加载
    └── *.md
```

### requirement-analysis

```
requirement-analysis/
├── SKILL.md                          ← 核心：原则 + 工作流 + 行为规范
└── references/
    ├── output-template.md            ← 结构化方案输出模板
    └── intent-anchor-guide.md        ← 意图锚提取与追溯指南
```

### code-implementation

```
code-implementation/
├── SKILL.md                          ← 核心：原则 + 工作流 + 行为规范
└── references/
    ├── testing-rules.md              ← 行为契约测试范式
    ├── coding-principles.md          ← 架构约束、命名、代码质量
    └── commit-convention.md          ← Commit 消息格式规范
```

### adversarial-review

```
adversarial-review/
├── SKILL.md                          ← 核心：原则 + 工作流 + 行为规范
└── references/
    ├── review-dimensions.md          ← 6 维检视详细指南
    ├── report-template.md            ← 结构化审查报告模板
    └── anti-patterns.md              ← 审查反模式与规避方法
```

## 硬约束 [required]

1. Skill 的 SKILL.md frontmatter 格式不变（`name`、`description`），保持 skills 目录发现机制兼容
2. description 使用第三人称，包含具体触发短语（用户会说的话）
3. SKILL.md body 使用祈使句/不定式，不使用第二人称（"你应该"）
4. SKILL.md body 保持 lean（~1500 words），详细内容放 references/
5. skill 中不出现角色定义（"你是 X 獭"、"你的职责"等）
6. 原有有效规则全部保留，不丢失内容
7. 不修改 cd-* skills

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 环境准备归属 | 合并到 code-implementation | 单独拆出 environment-prep | 环境准备是代码实现的前置步骤，独立拆分增加 skill 数量但使用场景有限 |
| 角色是否保留 | 不保留角色 skill | 保留薄角色 skill 引用能力 skill | 薄角色 skill 只增加一层间接性，无实际价值 |
| 输出模板 | 保留在各能力 skill 中 | 提取到共享模板 | 每个能力的输出格式不同，共享模板反而增加耦合 |

## 验证 [required]

### 验收标准

- [ ] `skills/requirement-analysis/SKILL.md` 存在且包含关注点、步骤、行为规范
- [ ] `skills/code-implementation/SKILL.md` 存在且包含环境准备、编码、测试、提交步骤
- [ ] `skills/adversarial-review/SKILL.md` 存在且包含 6 维检视、结构化报告
- [ ] `skills/otter-design/`、`skills/otter-develop/`、`skills/otter-review/` 已删除
- [ ] 三个新 skill 中不包含角色定义（"你是 X 獭"）
- [ ] 原有有效规则未丢失（编码原则、测试策略、检视维度等）

### 测试设计

| 测试用例 | 验证点 |
|---------|--------|
| 加载 requirement-analysis skill | 内容是需求分析能力描述，不含角色绑定 |
| 加载 code-implementation skill | 包含 worktree 创建、编码原则、测试策略 |
| 加载 adversarial-review skill | 包含 6 维检视和结构化报告模板 |
| 旧 skill 路径不存在 | otter-design/develop/review 目录已删除 |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `skills/requirement-analysis/SKILL.md` | 新增 | 需求分析能力 skill 核心 |
| `skills/requirement-analysis/references/output-template.md` | 新增 | 结构化方案输出模板 |
| `skills/requirement-analysis/references/intent-anchor-guide.md` | 新增 | 意图锚提取与追溯指南 |
| `skills/code-implementation/SKILL.md` | 新增 | 代码实现能力 skill 核心 |
| `skills/code-implementation/references/testing-rules.md` | 新增 | 行为契约测试范式 |
| `skills/code-implementation/references/coding-principles.md` | 新增 | 架构约束与代码质量规则 |
| `skills/code-implementation/references/commit-convention.md` | 新增 | Commit 消息格式规范 |
| `skills/adversarial-review/SKILL.md` | 新增 | 对抗性检视能力 skill 核心 |
| `skills/adversarial-review/references/review-dimensions.md` | 新增 | 6 维检视详细指南 |
| `skills/adversarial-review/references/report-template.md` | 新增 | 结构化审查报告模板 |
| `skills/adversarial-review/references/anti-patterns.md` | 新增 | 审查反模式与规避方法 |
| `skills/otter-design/SKILL.md` | 删除 | 旧角色 skill |
| `skills/otter-develop/SKILL.md` | 删除 | 旧角色 skill |
| `skills/otter-review/SKILL.md` | 删除 | 旧角色 skill |

## 关联 [required]

- **Tool/Skill 机制**：[F20260716t2ab](../16/F20260716t2ab-tool-skill-mechanism.md) — Skill 的发现和加载机制，本特性不改变该机制
