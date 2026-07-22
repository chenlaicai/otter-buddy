---
id: F20260722c5m9
title: dev-compliance-rules
doc_type: feature

# 记忆索引
summary: |
  开发合规规则强化。明确 worktree 隔离要求（所有文件修改必须在 worktree 中）、
  PR-only 交付流程（禁止直接 push 到 main/develop）、职责分离（开发者不能合入自己的 PR）。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260721cap
    - F20260722b4k8

# 元数据
status: design
change_type: fix
tags: [agent, skills, code-implementation, compliance, worktree, pr-flow]
modules: [skills/code-implementation/]

# 时间
created_at: 2026-07-22
---


# F20260722c5m9 开发合规规则强化

## 背景 [required]

### 问题

开发过程中存在严重合规漏洞：

1. **直接 push 到 main**：绕过代码审查，破坏分支保护
2. **跳过 worktree**：直接在 main 目录修改文件，无法隔离变更
3. **自己合入自己的 PR**：无职责分离，代码审查形同虚设
4. **PR 流程缺失**：skill 中只有 commit message 格式，没有 PR 流程规范

**证据**：在 F20260722b4k8 开发过程中，直接在 main 分支上提交并 push，违反了所有合规原则。

### 根因

**现有 skill 规则不够明确和强制**：

| 规则 | 现状 | 问题 |
|------|------|------|
| worktree 隔离 | 有，但只说"editing" | 没明确"所有文件修改"包括文档 |
| PR 流程 | 无 | 只有 commit message 格式 |
| 禁止直接 push | 无 | 无明确禁令 |
| 职责分离 | 无 | 开发者可以自己合入 PR |

### 现状分析

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
| UA-1 | "开发skill中要合规" | 合规 | 需要明确的合规规则 | 用户反馈 |
| UA-2 | "包括worktree隔离" | worktree 隔离 | 所有文件修改必须在 worktree 中 | 用户反馈 |
| UA-3 | "包括pr流程提交代码" | pr 流程 | 必须通过 PR 提交代码 | 用户反馈 |
| UA-4 | "包括不允许即是开发者又是pr合入者" | 职责分离 | 开发者不能合入自己的 PR | 用户反馈 |
| UA-5 | "包括严禁直接提交代码到main等目标分支" | 严禁直接提交 | 禁止 push 到 main/develop | 用户反馈 |

## 目标 [required]

### T1 — 强化 worktree 隔离规则

明确"所有文件修改"必须在 worktree 中，包括代码、文档、配置等。

### T2 — 补充 PR 流程规范

在 commit-convention.md 中补充完整的 PR 流程规范。

### T3 — 新增职责分离规则

明确开发者不能合入自己的 PR，必须由其他人审查和合入。

### T4 — 新增禁止直接 push 规则

明确禁止 `git push origin main/develop` 等直接推送操作。

## 非目标 [required]

- 不修改其他 skill 的规则
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
- **NEVER push directly to main/develop/production** — always create a PR
- **NEVER merge your own PR** — a different person must review and merge
- **NEVER skip worktree** — all file changes must happen in isolated worktree
```

**设计要点**：
- 新增三条硬性禁止规则，与 Core Principles 呼应

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

## 硬约束 [required]

1. 所有文件修改（代码、文档、配置）必须在 worktree 中进行
2. 禁止直接 push 到 main/develop/production 等目标分支
3. 开发者不能合入自己的 PR，必须由其他人审查和合入
4. 禁止以任何理由跳过 worktree（"小改动"、"只改文档"、"快速修复"）
5. PR 必须包含 Summary、Changes、Test plan 三个部分
6. PR 必须等待审查和批准后才能合入

## 设计取舍 [required]

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| worktree 范围 | 所有文件修改 | 仅代码修改 | 文档和配置也影响项目，需要隔离 |
| PR 流程 | 强制 PR | 允许直接 push | 代码审查是质量保障的关键环节 |
| 职责分离 | 严格分离 | 允许自己合入 | 防止代码审查形同虚设 |
| 例外处理 | 无例外 | 允许紧急修复 | 合规规则不能有例外，否则会被滥用 |

## 验证 [required]

### 验收标准

- [ ] `skills/code-implementation/SKILL.md` Core Principles 包含 worktree 隔离、PR-only、职责分离三条原则
- [ ] `skills/code-implementation/SKILL.md` Workflow Step 1 明确"所有文件修改"必须在 worktree 中
- [ ] `skills/code-implementation/SKILL.md` Workflow Step 7 包含完整的 PR 提交流程
- [ ] `skills/code-implementation/SKILL.md` Behavioral Rules 包含三条禁止规则
- [ ] `skills/code-implementation/references/commit-convention.md` 包含 PR Flow 部分
- [ ] PR Flow 包含强制规则、工作流程、禁止操作、PR 模板

### 测试设计

| 测试用例 | 验证点 |
|---------|--------|
| 修改文档 | 必须在 worktree 中进行 |
| 修改配置 | 必须在 worktree 中进行 |
| 提交代码 | 必须创建 PR，不能直接 push |
| 合入 PR | 必须由其他人审查和合入 |
| 小改动 | 不能跳过 worktree |

## 改动范围 [required]

| 文件 | 操作 | 说明 |
|------|------|------|
| `skills/code-implementation/SKILL.md` | 修改 | Core Principles 新增 3 条原则；Workflow Step 1 强化；新增 Step 7；Behavioral Rules 新增 3 条规则 |
| `skills/code-implementation/references/commit-convention.md` | 修改 | 新增 PR Flow 部分 |

## 关联 [required]

- **Skill 重构**：[F20260721cap](../21/F20260721cap-skill-refactor.md) — Skill 从角色手册重构为能力导向，本特性补充其合规规则
- **禁止询问是否修复**：[F20260722b4k8](./F20260722b4k8-forbid-ask-whether-to-fix.md) — 同类行为规则补充
