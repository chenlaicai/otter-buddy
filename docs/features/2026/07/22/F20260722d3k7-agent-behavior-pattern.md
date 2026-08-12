---
id: F20260722d3k7
title: agent-behavior-pattern
doc_type: feature

# 记忆索引
summary: |
  AI 行为模式强化。禁止"询问是否修复"行为模式（发现问题必须直接修复，不能询问用户），
  强化开发合规规则（worktree 隔离、PR-only 交付、职责分离）。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260721cap0

# 元数据
status: design
change_type: fix
tags: [agent, skills, code-implementation, adversarial-review, behavioral-rules, compliance, worktree, pr-flow]
modules: [skills/code-implementation/, skills/adversarial-review/]

# 时间
created_at: 2026-07-22
---


# F20260722d3k7 AI 行为模式强化

## 背景 [required]

### 问题 1：询问是否修复

发现代码问题后，会说出"剩余的 Minor 问题不影响功能正确性，可以作为后续优化处理。需要我现在修复这些 Minor 问题吗"这种话。

**问题行为分析**：

| 维度 | 问题 |
|------|------|
| 责任推卸 | 把决定权推给用户，而不是直接修复 |
| 借口合理化 | 用"不影响功能正确性"来合理化不修复 |
| 效率低下 | 发现问题应该直接修复，而不是询问 |
| 决策疲劳 | 给用户增加不必要的决策负担 |

### 问题 2：合规漏洞

开发过程中存在严重合规漏洞：

1. **直接 push 到 main**：绕过代码审查，破坏分支保护
2. **跳过 worktree**：直接在 main 目录修改文件，无法隔离变更
3. **自己合入自己的 PR**：无职责分离，代码审查形同虚设
4. **PR 流程缺失**：skill 中只有 commit message 格式，没有 PR 流程规范

### 根因

**现有 skill 规则不够明确和强制**：

| Skill | 现有规则 | 缺口 |
|-------|---------|------|
| adversarial-review | 已禁止"后续优化"等逃避措辞 | 只覆盖审查阶段，不覆盖实现阶段 |
| code-implementation | 无相关规则 | 发现问题后可以询问用户是否修复 |
| code-implementation | 有 worktree 隔离规则 | 没明确"所有文件修改"包括文档 |
| code-implementation | 无 PR 流程规则 | 只有 commit message 格式 |
| code-implementation | 无职责分离规则 | 开发者可以自己合入 PR |

### 现状分析

**adversarial-review/SKILL.md 第69行**：
```
Forbidden escape phrases: "低风险", "可忽略", "不重要", "后续优化", "不阻塞"
```

**code-implementation/SKILL.md Core Principles**：
```
- Isolate before editing: Never modify files in the main directory. Create a worktree first.
```

**问题**：
- "editing" 含糊，可能被理解为"只改代码"
- 没有明确"所有文件修改"包括文档、配置等
- 没有 PR 流程规则
- 没有职责分离规则

## 用户意图锚 [required]

| ID | 用户原话 | 关键修饰语 | 架构师解读 | 来源 |
|----|---------|-----------|-----------|------|
| UA-1 | "我遇到你说《剩余的 Minor 问题不影响功能正确性，可以作为后续优化处理。需要我现在修复这些 Minor 问题吗》这种话" | Minor 问题；后续优化；询问是否修复 | 这种话是推卸责任，不应该出现 | 用户反馈 |
| UA-2 | "你优化下开发的skill" | 优化；开发的 skill | 需要修改 skill 来禁止这种行为 | 用户反馈 |
| UA-3 | "深入分析下，如何避免这种问题发生" | 深入分析；避免 | 需要根因分析和系统性修复 | 用户反馈 |
| UA-4 | "开发skill中要合规" | 合规 | 需要明确的合规规则 | 用户反馈 |
| UA-5 | "包括worktree隔离" | worktree 隔离 | 所有文件修改必须在 worktree 中 | 用户反馈 |
| UA-6 | "包括pr流程提交代码" | pr 流程 | 必须通过 PR 提交代码 | 用户反馈 |
| UA-7 | "包括不允许即是开发者又是pr合入者" | 职责分离 | 开发者不能合入自己的 PR | 用户反馈 |
| UA-8 | "包括严禁直接提交代码到main等目标分支" | 严禁直接提交 | 禁止 push 到 main/develop | 用户反馈 |

## 目标 [required]

### T1 — 禁止实现阶段的"询问是否修复"行为

在 code-implementation skill 中明确：发现代码问题必须直接修复，不能询问用户是否需要修复。

### T2 — 禁止逃避措辞

在 code-implementation skill 中新增禁止措辞列表，与 adversarial-review 保持一致。

### T3 — 补充反模式文档

在 adversarial-review/references/anti-patterns.md 中新增"Ask Whether to Fix"反模式。

### T4 — 强化 worktree 隔离规则

明确"所有文件修改"必须在 worktree 中，包括代码、文档、配置等。

### T5 — 补充 PR 流程规范

在 commit-convention.md 中补充完整的 PR 流程规范。

### T6 — 新增职责分离规则

明确开发者不能合入自己的 PR，必须由其他人审查和合入。

### T7 — 新增禁止直接 push 规则

明确禁止 `git push origin main/develop` 等直接推送操作。

## 非目标 [required]

- 不修改 adversarial-review 的审查规则（已足够完善）
- 不修改其他 skill 的行为规则
- 不改变代码审查流程（adversarial-review 已覆盖）
- 不修改分支保护配置（需要 GitHub 设置）

## 设计 [required]

### 1. code-implementation/SKILL.md 修改

**Core Principles 部分**：

```markdown
## Core Principles

- **Isolate before editing**: Never modify any files in the main directory. ALL file changes (code, docs, config) must happen in a worktree.
- **PR-only delivery**: Never push directly to main/develop/production branches. Always create a PR for review.
- **Separation of duties**: The developer who writes code cannot merge their own PR. A different person must review and merge.
- **Faithful to the plan**: Implement what the plan specifies. Do not expand scope or add unrequested features.
- **Test behavior, not internals**: Assert observable outputs and side effects. Do not assert how functions call each other.
- **No compatibility bridges**: The new design IS the current design. Do not preserve old code paths alongside new ones.
```

**设计要点**：
- 将 "Isolate before editing" 改为明确的 "ALL file changes (code, docs, config) must happen in a worktree"
- 新增 "PR-only delivery" 原则
- 新增 "Separation of duties" 原则

**Workflow Step 1 部分**：

```markdown
### 1. Prepare Environment

Before any file modification:

1. Identify the target repository location
2. Create a worktree under `.claude/worktrees/` based on latest `origin/main`
3. Verify all subsequent operations happen inside the worktree — zero modifications to main directory
4. Record context: worktree name, branch name, feature number
5. **NEVER skip worktree** — even for "small" changes, docs-only changes, or "quick fixes"
```

**设计要点**：
- 新增第 5 条：明确禁止以任何理由跳过 worktree

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

**新增 Workflow Step 7**：

```markdown
### 7. Submit via PR

After committing:

1. Push the worktree branch to remote: `git push -u origin <branch-name>`
2. Create a PR using `gh pr create`
3. Wait for review and approval from another person
4. **NEVER merge your own PR** — this is a hard rule
5. **NEVER push directly to main/develop** — always use PR flow
```

**设计要点**：
- 新增完整的 PR 提交流程
- 明确禁止自己合入 PR
- 明确禁止直接 push 到目标分支

**Behavioral Rules 部分**：

```markdown
## Behavioral Rules

- Features not in the plan are not implemented — confirm with the requester first
- Discover gaps in the plan → record them and communicate back, do not improvise
- Finding a flaw in the design → report to the plan author, do not redesign in place
- **Fix all discovered issues immediately** — do not ask "should I fix this?" or leave issues with "can optimize later"
- Forbidden escape phrases: "低风险", "可忽略", "不重要", "后续优化", "不阻塞", "Minor 问题", "不影响功能正确性"
- **NEVER push directly to main/develop/production** — always create a PR
- **NEVER merge your own PR** — a different person must review and merge
- **NEVER skip worktree** — all file changes must happen in isolated worktree
```

**设计要点**：
- 新增禁止"询问是否修复"的规则
- 新增禁止逃避措辞列表
- 新增三条合规禁止规则

### 2. commit-convention.md 修改

**新增 PR Flow 部分**：

```markdown
## PR Flow

### Mandatory Rules

1. **PR-only delivery**: All code changes must be delivered via PR, never direct push
2. **No direct push to protected branches**: `main`, `develop`, `production` are protected
3. **Separation of duties**: Developer cannot merge their own PR

### PR Workflow

```
1. Create worktree branch
2. Make changes and commit
3. Push branch: git push -u origin <branch>
4. Create PR: gh pr create
5. Wait for review
6. Another person reviews and merges
7. Clean up worktree
```

### Forbidden Actions

- `git push origin main` — direct push to main
- `git push origin develop` — direct push to develop
- Merge your own PR — violates separation of duties
- Skip worktree for "small" changes — all changes need isolation

### PR Description Template

```markdown
## Summary
- What changed and why

## Changes
- File-by-file description

## Test plan
- [ ] Verification steps

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
```

**设计要点**：
- 明确三条强制规则
- 提供完整的 PR 工作流程
- 列出禁止的操作
- 提供 PR 描述模板

### 3. adversarial-review/references/anti-patterns.md 修改

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
5. 所有文件修改（代码、文档、配置）必须在 worktree 中进行
6. 禁止直接 push 到 main/develop/production 等目标分支
7. 开发者不能合入自己的 PR，必须由其他人审查和合入
8. 禁止以任何理由跳过 worktree（"小改动"、"只改文档"、"快速修复"）
9. PR 必须包含 Summary、Changes、Test plan 三个部分
10. PR 必须等待审查和批准后才能合入

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 禁止范围 | 实现阶段 | 仅审查阶段 | 实现阶段是问题发生的地方，必须覆盖 |
| 禁止措辞 | 与 adversarial-review 一致 | 不同步 | 保持一致性，避免规则冲突 |
| 例外处理 | 记录并沟通 | 允许询问 | 例外情况应该记录并沟通，而不是询问是否修复 |
| 文档位置 | 新增反模式 | 不补充 | 反模式文档是行为规范的重要组成部分 |
| worktree 范围 | 所有文件修改 | 仅代码修改 | 文档和配置也影响项目，需要隔离 |
| PR 流程 | 强制 PR | 允许直接 push | 代码审查是质量保障的关键环节 |
| 职责分离 | 严格分离 | 允许自己合入 | 防止代码审查形同虚设 |

## 验证 [required]

### 验收标准

- [ ] `.pi/skills/code-implementation/SKILL.md` Core Principles 包含 worktree 隔离、PR-only、职责分离三条原则
- [ ] `.pi/skills/code-implementation/SKILL.md` Workflow Step 1 明确"所有文件修改"必须在 worktree 中
- [ ] `.pi/skills/code-implementation/SKILL.md` Self-Check 包含"所有发现的问题已修复"检查项
- [ ] `.pi/skills/code-implementation/SKILL.md` Workflow Step 7 包含完整的 PR 提交流程
- [ ] `.pi/skills/code-implementation/SKILL.md` Behavioral Rules 包含禁止"询问是否修复"规则和禁止逃避措辞列表
- [ ] `.pi/skills/code-implementation/SKILL.md` Behavioral Rules 包含三条合规禁止规则
- [ ] `.pi/skills/code-implementation/references/commit-convention.md` 包含 PR Flow 部分
- [ ] `.pi/skills/adversarial-review/references/anti-patterns.md` 包含"Ask Whether to Fix"反模式

### 测试设计

| 测试用例 | 验证点 |
|---------|--------|
| 发现 Minor 问题 | 直接修复，不询问用户 |
| 发现问题措辞 | 不使用禁止的逃避措辞 |
| 问题超出范围 | 记录并沟通，不询问是否修复 |
| Self-Check | 检查"所有发现的问题已修复" |
| 修改文档 | 必须在 worktree 中进行 |
| 修改配置 | 必须在 worktree 中进行 |
| 提交代码 | 必须创建 PR，不能直接 push |
| 合入 PR | 必须由其他人审查和合入 |
| 小改动 | 不能跳过 worktree |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `.pi/skills/code-implementation/SKILL.md` | 修改 | Core Principles 新增 3 条原则；Workflow Step 1 强化；Self-Check 新增检查项；新增 Step 7；Behavioral Rules 新增 6 条规则 |
| `.pi/skills/code-implementation/references/commit-convention.md` | 修改 | 新增 PR Flow 部分 |
| `.pi/skills/adversarial-review/references/anti-patterns.md` | 修改 | 新增"Ask Whether to Fix"反模式 |

## 关联 [required]

- **Skill 重构**：[F20260721cap0](../21/F20260721cap0-skill-refactor.md) — Skill 从角色手册重构为能力导向，本特性补充其行为规则
- **speak Skill**：[F20260721spea](../21/F20260721spea-speak-skill.md) — 同类 skill 设计参考
