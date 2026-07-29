---
name: code-implementation
description: >-
  This skill should be used when the user asks to "写代码", "实现这个功能", "开始开发",
  "编码实现", "提交代码", "写测试", "按方案开发", "开干", "开始写",
  or needs to implement a technical plan, write code, create tests, or submit changes.
  Covers the plan-driven development workflow: coding principles, testing strategy, and
  commit conventions. For ANY repository mutation (even one-line fixes), the red lines
  in the repo-safety skill always apply — load it too.
---

# Code Implementation

Turn a technical plan into runnable, verifiable code changes.

## Core Principles

- **Repo safety first**: Follow all red lines in the `repo-safety` skill — worktree isolation, no direct commits to protected branches, PR-only delivery, no destructive git operations.
- **Faithful to the plan**: Implement what the plan specifies. Do not expand scope or add unrequested features.
- **Test behavior, not internals**: Assert observable outputs and side effects. Do not assert how functions call each other.
- **No compatibility bridges**: The new design IS the current design. Do not preserve old code paths alongside new ones.

## Workflow

### 1. Prepare Environment

Follow the `repo-safety` skill: create a worktree under `.claude/worktrees/` based on latest `origin/main`, verify all subsequent operations happen inside it, and record context (worktree name, branch name, feature number).

### 2. Confirm Understanding

Read the technical plan thoroughly. Verify:

- Which files and modules are involved
- What the core logic should do
- Whether there are breaking changes requiring special handling

Use `search_terminology` to confirm terms match the codebase. Use `search_memory` to retrieve related context and prior decisions.

If unclear, ask first. Do not guess. Do not implement features not in the plan.

### 3. Implement

Follow the plan step by step. Observe project architecture constraints (e.g., Clean Architecture layers). Match naming to project terminology. Add comments for non-obvious design intent.

### 4. Write Tests

Create tests for new or modified behaviors. See `references/testing-rules.md` for the behavioral contract testing approach.

When a test fails: diagnose root cause first — is the test wrong, or is the implementation wrong? Do not automatically revert business code.

### 5. Self-Check

Before committing:

- [ ] All tests pass
- [ ] Code conforms to project conventions
- [ ] No changes beyond plan scope
- [ ] No compatibility bridge code introduced
- [ ] Visual/spatial changes have screenshot evidence
- [ ] All discovered issues are fixed — no "minor issues" left unfixed

### 6. Commit

Follow the commit message convention in `references/commit-convention.md`.

### 7. Submit via PR

After committing:

1. Push the worktree branch to remote: `git push -u origin <branch-name>`
2. Create a PR using `gh pr create`
3. Wait for review and approval from another person

## Behavioral Rules

- Features not in the plan are not implemented — confirm with the requester first
- Discover gaps in the plan → record them and communicate back, do not improvise
- Finding a flaw in the design → report to the plan author, do not redesign in place
- **Fix all discovered issues within plan scope immediately** — do not ask "should I fix this?" or leave issues with "can optimize later"
- Every discovered issue needs a disposition: fixed immediately, or recorded (PR description + linked issue). Labeling an issue as minor or low-risk is not a disposition

### 问题处理决策树

发现问题后，按以下流程处理：

```
1. 问题在 plan 范围内？
   └─ 是 → 立即修复

2. 问题与当前变更相关（同一模块/文件/函数）？
   ├─ 相关 + 本次顺手修复数量 ≤ 5 → 顺手修复，在 PR 描述中记录
   └─ 相关 + 数量 > 5 → 记录到 PR 描述，审查者决定是否拆分 PR

3. 问题与当前变更无关？
   └─ 必须记录，不能静默丢失：
       ├─ 创建 issue（带标签：tech-debt / bug）
       └─ PR 描述中记录发现的问题和对应 issue 编号
```

**顺手修复（Opportunistic Fix）**：与当前变更有上下文关联（同一模块/文件/函数）的问题，可以直接修复，但必须在 PR 描述中记录。

**不静默丢失**：发现的问题必须有去处。PR 描述必须包含"发现的其他问题"章节，没有就写"无"。每个未修复的问题必须有对应 issue。

## Additional Resources

### Reference Files

- **`references/testing-rules.md`** — Behavioral contract testing paradigm and anti-patterns
- **`references/coding-principles.md`** — Architecture constraints, naming, and code quality rules
- **`references/commit-convention.md`** — Commit message format and PR conventions
