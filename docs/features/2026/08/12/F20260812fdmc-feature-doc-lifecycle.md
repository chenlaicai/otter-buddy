---
id: F20260812fdmc
title: feature-doc-lifecycle
doc_type: feature

summary: |
  特性文档生命周期：将特性文档接入 skill chain 作为全流程载体。
  利用 otter 已有原语（worktree + linked_resource）协调，不新增基础设施。
  各 skill 自然地读写特性文档，不强制固定时机，无角色约束。

causal_links:
  from:
    - F20260720k3m7
    - F20260728skrp

status: development
change_type: feature
tags: [skills, feature-doc, lifecycle, worktree, linked-resource, workflow]
modules:
  - .pi/skills/_shared/
  - .pi/skills/requirement-analysis/
  - .pi/skills/troubleshooting/
  - .pi/skills/code-implementation/
  - .pi/skills/adversarial-review/
  - .pi/skills/worktree-isolation/
  - .pi/skills/companion/
  - .pi/skills/core-workflow/
  - .pi/skills/otter-summon/

created_at: 2026-08-12
capability_test: "n/a: prompt/文档变更，无运行时代码，通过实际跑流程验证"
---

# F20260812fdmc 特性文档生命周期

## 背景

搭档发现：提交特性修改 PR 时，经常忘记提交特性文档。特性文档应该是贯穿特性开发生命周期的全流程载体，但当前系统中没有任何 skill 在流程中提及特性文档。

用户原话（意图锚）：

> "我发现，提交特性修改pr时，经常忘记提交特性文档。但按照研发流程，如果有需要分析、设计的，那么架构师应该会写一份特性文档；如果是bugfix这种小改动，可能大獭直接就处理提交pr，但我认为也必须具备特性文档，写清晰背景、根因分析等等。"

> "我的想法其实是，特性文档是承载一个特性开发的全流程的，包含很多内容。但目前来看，各个阶段（分析/排查/探索/讨论/设计/实现/测试/验证/审视等）都没有这个概念。而且，特性文档的内容其实算是特性开发聊天记录（各个海獭协作对话）的总结文档，是记忆数据的重要组成部分。所以，特性文档很核心。"

> "当有需要记录文档时就记录，我觉得不是某一个固定时机，写死这种要求过于约束llm了"
> "worktree是一个特性开发的独立空间，所以海獭们应该在这个空间内进行协作，以及文档也就放到这个中"

## 目标

T1: 特性文档成为特性开发的全流程载体，贯穿探索、分析、设计、实现、审视等各阶段
T2: 各 skill 自然地读写特性文档，不强制固定时机（由参与者判断何时记录）
T3: 利用 otter 已有原语（linked_resource、worktree）协调，不新增基础设施
T4: 任何参与者（大獭/小獭）都可以创建和更新特性文档，无角色约束

## 非目标

- 不创建新的 skill 或新的协调机制
- 不强制每个特性都必须有特性文档
- 不改变现有特性文档的 frontmatter 格式（已有 163 个文档兼容）
- 不改变 PR 提交流程本身

## 方案设计

### 核心思路

特性文档 = worktree 内的活文档 + linked_resource 协调。

利用 otter 系统已有的三个原语：
1. **worktree** = 特性文档的物理位置（`<worktree>/docs/features/`）
2. **linked_resource** (file 类型) = 协调点（首次写入时注册，所有参与者通过 `list_artifacts` 发现）
3. **groupId** = 特性 ID，串联同一特性的所有资源（可选）

### 具体改动

**1. 全局约定（`_shared/SKILL-TEMPLATE.md`）**

在「模板约定（全局）」中新增「特性文档」段落，所有 skill 继承：
- 位置：特性文档在 worktree 中
- 协调：首次写入时用 `create_linked_resource(type: "file", groupId: "<特性ID>")` 注册（groupId 可选）
- 时机：当有需要记录的内容时就记录（各 skill 中的写入步骤是建议性的，不是强制检查点）
- 角色：任何参与者都可以创建和更新
- 格式：参考 worktree 中的 `docs/features/` 下已有文档的 frontmatter 格式

**2. 各 skill 接入**

| Skill | 改动 |
|-------|------|
| requirement-analysis | 步骤 5「产出方案」改为写入特性文档 |
| troubleshooting | 步骤 3「形成结论」改为写入特性文档 |
| code-implementation | 新增步骤 6「文档」，追加实现要点 |
| adversarial-review | 输入表改用特性文档，文档完整性维度增强 |
| worktree-isolation | 提示 worktree 是特性文档的家 |
| companion | 产出表改为建议记录到特性文档 |
| core-workflow | 步骤 3「记录」优先写入特性文档 |
| otter-summon | systemPrompt 模板加特性文档路径 |

## 设计决策

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 时机 | 不写死，由参与者判断 | 固定阶段强制产出 | 搭档明确："写死这种要求过于约束llm了" |
| 位置 | worktree 中 | 独立管理（main 分支） | 搭档明确："worktree是一个特性开发的独立空间" |
| 协调 | linked_resource | 新增机制 | 利用已有 otter 原语，不新增基础设施 |
| 角色 | 无限制 | 大獭负责创建 | 搭档明确："特性文档跟大小獭无必然关系" |
| groupId | 可选参数 | 必选参数 | 保持灵活性，小改动不需要分组 |
| 全局约定位置 | SKILL-TEMPLATE.md | SYSTEM.md | 模板约定在 SKILL-TEMPLATE.md 中定义 |

## 影响范围

8 个 skill 文件，不影响运行时代码、现有特性文档格式、PR 提交流程。

## 风险与约束

- 风险：LLM 可能在不合适的时候创建特性文档 → 通过"由参与者判断"缓解
- 风险：特性文档内容可能质量参差 → 与现状一致，不在本次范围内解决
- 约束：特性文档格式必须符合已有 frontmatter 规范

## 验收标准

1. requirement-analysis 产出的技术方案写入特性文档
2. troubleshooting 产出的排查结论写入特性文档
3. code-implementation 追加实现要点到特性文档
4. adversarial-review 通过 list_artifacts 发现特性文档
5. 特性文档随代码一起提交到 PR

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| .pi/skills/_shared/SKILL-TEMPLATE.md | 修改 | 新增「特性文档」全局约定 |
| .pi/skills/requirement-analysis/SKILL.md | 修改 | 步骤 5 写入特性文档 |
| .pi/skills/troubleshooting/SKILL.md | 修改 | 步骤 3 写入特性文档 |
| .pi/skills/code-implementation/SKILL.md | 修改 | 新增步骤 6「文档」 |
| .pi/skills/adversarial-review/SKILL.md | 修改 | 输入表和文档完整性维度 |
| .pi/skills/worktree-isolation/SKILL.md | 修改 | 提示 worktree 是特性文档的家 |
| .pi/skills/companion/SKILL.md | 修改 | 产出表引用特性文档 |
| .pi/skills/core-workflow/SKILL.md | 修改 | 记录优先写入特性文档 |
| .pi/skills/otter-summon/SKILL.md | 修改 | systemPrompt 模板加路径 |
