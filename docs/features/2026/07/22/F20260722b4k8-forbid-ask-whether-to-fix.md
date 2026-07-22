---
id: F20260722b4k8
title: forbid-ask-whether-to-fix
doc_type: feature

# 记忆索引
summary: |
  禁止"询问是否修复"的行为模式。发现代码问题后，不能询问用户"需要我修复吗"或留下"Minor 问题后续优化"，
  必须直接修复。补充 code-implementation 和 adversarial-review skill 的行为规则。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260721cap

# 元数据
status: design
change_type: fix
tags: [agent, skills, code-implementation, adversarial-review, behavioral-rules]
modules: [skills/code-implementation/, skills/adversarial-review/]

# 时间
created_at: 2026-07-22
---


# F20260722b4k8 禁止"询问是否修复"行为模式

## 背景 [required]

### 问题

发现代码问题后，会说出"剩余的 Minor 问题不影响功能正确性，可以作为后续优化处理。需要我现在修复这些 Minor 问题吗"这种话。

**问题行为分析**：

| 维度 | 问题 |
|------|------|
| 责任推卸 | 把决定权推给用户，而不是直接修复 |
| 借口合理化 | 用"不影响功能正确性"来合理化不修复 |
| 效率低下 | 发现问题应该直接修复，而不是询问 |
| 决策疲劳 | 给用户增加不必要的决策负担 |

### 根因

**现有 skill 只在审查阶段禁止这种行为，实现阶段存在漏洞。**

| Skill | 现有规则 | 缺口 |
|-------|---------|------|
| adversarial-review | 已禁止"后续优化"等逃避措辞 | 只覆盖审查阶段，不覆盖实现阶段 |
| code-implementation | 无相关规则 | 发现问题后可以询问用户是否修复 |

### 现状分析

**adversarial-review/SKILL.md 第69行**：
```
Forbidden escape phrases: "低风险", "可忽略", "不重要", "后续优化", "不阻塞"
```

**adversarial-review/references/anti-patterns.md 第29行**：
```
## Let It Slide
Symptom: "Not blocking", "Can optimize later", "Low risk".
Fix: Every issue needs a disposition: "在当前 PR 修复" or "开发者回应（审查者认可）". No third option.
```

**code-implementation/SKILL.md**：无相关禁止规则。

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "我遇到你说《剩余的 Minor 问题不影响功能正确性，可以作为后续优化处理。需要我现在修复这些 Minor 问题吗》这种话" | Minor 问题；后续优化；询问是否修复 | 这种话是推卸责任，不应该出现 | 用户反馈 |
| UA-2 | "你优化下开发的skill" | 优化；开发的 skill | 需要修改 skill 来禁止这种行为 | 用户反馈 |
| UA-3 | "深入分析下，如何避免这种问题发生" | 深入分析；避免 | 需要根因分析和系统性修复 | 用户反馈 |

## 目标 [required]

### T1 — 禁止实现阶段的"询问是否修复"行为

在 code-implementation skill 中明确：发现代码问题必须直接修复，不能询问用户是否需要修复。

### T2 — 禁止逃避措辞

在 code-implementation skill 中新增禁止措辞列表，与 adversarial-review 保持一致。

### T3 — 补充反模式文档

在 adversarial-review/references/anti-patterns.md 中新增"Ask Whether to Fix"反模式。

## 非目标 [required]

- 不修改 adversarial-review 的现有规则（已足够完善）
- 不修改其他 skill 的行为规则
- 不改变代码审查流程

## 设计 [required]

### 1. code-implementation/SKILL.md 修改

**Self-Check 部分新增检查项**：

```markdown
### 5. Self-Check

Before committing:

- [ ] All tests pass
- [ ] Code conforms to project conventions
- [ ] No changes beyond plan scope
- [ ] No compatibility bridge code introduced
- [ ] Visual/spatial changes have screenshot evidence
- [ ] All discovered issues are fixed — no "minor issues" left unfixed
```

**Behavioral Rules 部分新增规则**：

```markdown
## Behavioral Rules

- Features not in the plan are not implemented — confirm with the requester first
- Discover gaps in the plan → record them and communicate back, do not improvise
- Finding a flaw in the design → report to the plan author, do not redesign in place
- **Fix all discovered issues immediately** — do not ask "should I fix this?" or leave issues with "can optimize later"
- Forbidden escape phrases: "低风险", "可忽略", "不重要", "后续优化", "不阻塞", "Minor 问题", "不影响功能正确性"
```

**设计要点**：
- 新增检查项明确要求"所有发现的问题必须修复"
- Behavioral Rules 新增明确禁止"询问是否修复"的行为
- 禁止措辞列表与 adversarial-review 保持一致，并新增"Minor 问题"和"不影响功能正确性"

### 2. adversarial-review/references/anti-patterns.md 修改

**新增反模式**：

```markdown
## Ask Whether to Fix

**Symptom**: "发现了一个 Minor 问题，需要我修复吗？" or "剩余的小问题不影响功能，可以后续优化"

**Problem**: Shifts responsibility to the user. Creates decision fatigue. Issues accumulate because "later" never comes.

**Fix**: If you found an issue, fix it. Do not ask permission. Do not categorize severity to justify deferral. The only valid reason to not fix is if the issue is outside the plan scope — in which case, record it and communicate back, not ask whether to fix.
```

**设计要点**：
- 描述问题行为的典型措辞
- 解释问题本质：推卸责任、决策疲劳、问题累积
- 给出正确做法：发现问题就修复，不问用户
- 唯一例外：问题超出计划范围时，记录并沟通，而不是询问是否修复

## 硬约束 [required]

1. 发现代码问题必须直接修复，不能询问用户是否需要修复
2. 禁止使用"低风险"、"可忽略"、"不重要"、"后续优化"、"不阻塞"、"Minor 问题"、"不影响功能正确性"等逃避措辞
3. 问题超出计划范围时，记录并沟通，而不是询问是否修复
4. Self-Check 必须包含"所有发现的问题已修复"检查项
5. Behavioral Rules 必须包含禁止"询问是否修复"的规则

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 禁止范围 | 实现阶段 | 仅审查阶段 | 实现阶段是问题发生的地方，必须覆盖 |
| 禁止措辞 | 与 adversarial-review 一致 | 不同步 | 保持一致性，避免规则冲突 |
| 例外处理 | 记录并沟通 | 允许询问 | 例外情况应该记录并沟通，而不是询问是否修复 |
| 文档位置 | 新增反模式 | 不补充 | 反模式文档是行为规范的重要组成部分 |

## 验证 [required]

### 验收标准

- [ ] `skills/code-implementation/SKILL.md` Self-Check 包含"所有发现的问题已修复"检查项
- [ ] `skills/code-implementation/SKILL.md` Behavioral Rules 包含禁止"询问是否修复"规则
- [ ] `skills/code-implementation/SKILL.md` Behavioral Rules 包含禁止逃避措辞列表
- [ ] `skills/adversarial-review/references/anti-patterns.md` 包含"Ask Whether to Fix"反模式
- [ ] 禁止措辞列表与 adversarial-review 保持一致
- [ ] 反模式文档描述问题行为、解释问题本质、给出正确做法

### 测试设计

| 测试用例 | 验证点 |
|---------|--------|
| 发现 Minor 问题 | 直接修复，不询问用户 |
| 发现问题措辞 | 不使用禁止的逃避措辞 |
| 问题超出范围 | 记录并沟通，不询问是否修复 |
| Self-Check | 检查"所有发现的问题已修复" |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `skills/code-implementation/SKILL.md` | 修改 | Self-Check 新增检查项；Behavioral Rules 新增禁止规则和禁止措辞 |
| `skills/adversarial-review/references/anti-patterns.md` | 修改 | 新增"Ask Whether to Fix"反模式 |

## 关联 [required]

- **Skill 重构**：[F20260721cap](../21/F20260721cap-skill-refactor.md) — Skill 从角色手册重构为能力导向，本特性补充其行为规则
- **speak Skill**：[F20260721speak](../21/F20260721speak-speak-skill.md) — 同类 skill 设计参考
