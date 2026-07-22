---
name: code-implementation
description: >-
  This skill should be used when the user asks to "写代码", "实现这个功能", "开始开发",
  "编码实现", "提交代码", "写测试", "按方案开发", "开干", "开始写",
  or needs to implement a technical plan, write code, create tests, or submit changes.
  Covers environment isolation (worktree), coding principles, testing strategy, and commit conventions.
---

# Code Implementation

Turn a technical plan into runnable, verifiable code changes.

## Core Principles

- **Isolate before editing**: Never modify any files in the main directory. ALL file changes (code, docs, config) must happen in a worktree.
- **PR-only delivery**: Never push directly to main/develop/production branches. Always create a PR for review.
- **Separation of duties**: The developer who writes code cannot merge their own PR. A different person must review and merge.
- **Faithful to the plan**: Implement what the plan specifies. Do not expand scope or add unrequested features.
- **Test behavior, not internals**: Assert observable outputs and side effects. Do not assert how functions call each other.
- **No compatibility bridges**: The new design IS the current design. Do not preserve old code paths alongside new ones.

## Workflow

### 1. Prepare Environment

Before any file modification:

1. Identify the target repository location
2. Create a worktree under `.claude/worktrees/` based on latest `origin/main`
3. Verify all subsequent operations happen inside the worktree — zero modifications to main directory
4. Record context: worktree name, branch name, feature number
5. **NEVER skip worktree** — even for "small" changes, docs-only changes, or "quick fixes"

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

### 6. Commit

Follow the commit message convention in `references/commit-convention.md`.

### 7. Submit via PR

After committing:

1. Push the worktree branch to remote: `git push -u origin <branch-name>`
2. Create a PR using `gh pr create`
3. Wait for review and approval from another person
4. **NEVER merge your own PR** — this is a hard rule
5. **NEVER push directly to main/develop** — always use PR flow

## Behavioral Rules

- Features not in the plan are not implemented — confirm with the requester first
- Discover gaps in the plan → record them and communicate back, do not improvise
- Finding a flaw in the design → report to the plan author, do not redesign in place
- **NEVER push directly to main/develop/production** — always create a PR
- **NEVER merge your own PR** — a different person must review and merge
- **NEVER skip worktree** — all file changes must happen in isolated worktree

## Additional Resources

### Reference Files

- **`references/testing-rules.md`** — Behavioral contract testing paradigm and anti-patterns
- **`references/coding-principles.md`** — Architecture constraints, naming, and code quality rules
- **`references/commit-convention.md`** — Commit message format and PR conventions
