---
name: code-implementation
description: >-
  This skill should be used when the user asks to "写代码", "实现这个功能", "开始开发",
  "编码实现", "写测试", "按方案开发", "开干", "开始写",
  or needs to implement a technical plan, write code, create tests, or submit changes.
  Covers the plan-driven development workflow: coding principles, testing strategy, and
  commit conventions. Red lines for repository safety are defined in SYSTEM.md.
triggers:
  phrases:
    - "写代码"
    - "实现这个功能"
    - "开始开发"
    - "编码实现"
    - "写测试"
    - "按方案开发"
    - "开干"
    - "开始写"
co_loads: []
---

# Code Implementation

Turn a technical plan into runnable, verifiable code changes.

> **触发短语**：写代码 | 实现这个功能 | 开始开发 | 编码实现 | 写测试
> **共加载**：无（安全红线已在 SYSTEM.md 中全局生效）

## Core Principles

- **Repo safety first**: Follow all red lines in SYSTEM.md "仓库安全红线" — worktree isolation, no direct commits to protected branches, PR-only delivery, no destructive git operations.
- **Faithful to the plan**: Implement what the plan specifies. Do not expand scope or add unrequested features.
- **Test behavior, not internals**: Assert observable outputs and side effects. Do not assert how functions call each other.
- **No compatibility bridges**: The new design IS the current design. Do not preserve old code paths alongside new ones.

## 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 技术方案 | 必选 | 搭档确认后的方案文档 | 停下来问搭档。即使是自己产出的方案，也需搭档确认后方可进入实现。禁止自行编造方案 |
| 方案编号 | 必选 | 方案文档的 ID | 从方案文档 frontmatter 读取 |
| 工作分支 | 必选 | worktree-isolation 流程产出 | 先走 worktree-isolation 创建 worktree |

## Workflow

### 1. Prepare Environment

第一步：执行 worktree-isolation 最小流程创建 worktree 隔离环境。

- 读取 `worktree-isolation` skill，执行其最小流程
- 记录上下文：worktree 名、分支名、特性编号
- 后续所有文件修改必须在 worktree 内进行，主目录只允许只读操作

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

Follow the commit message convention in `references/commit-convention.md`。署名约定见 `_shared/signature-convention.md`。

### 7. Submit via PR

After committing:

1. Push the worktree branch to remote: `git push -u origin <branch-name>`
2. Create a PR using `gh pr create`

### 8. PR 对抗审视

按 `_shared/review-protocol.md` 中的"代码 PR 审视协议"执行。

## Behavioral Rules

- Features not in the plan are not implemented — confirm with the requester first
- Discover gaps in the plan → record them and communicate back, do not improvise
- Finding a flaw in the design → report to the plan author, do not redesign in place
- **Fix all self-discovered issues within plan scope immediately** — do not ask "should I fix this?" or leave issues with "can optimize later". 检视獭报上来的发现不适用本条——走 review-protocol 的作者处置协议，带证据的反驳是合法处置
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

## 后续动作声明

| 产出类型 | 下一步动作 | 执行者 | 触发条件 | 不满足时处理 |
|----------|-----------|--------|----------|-------------|
| 代码 PR | 对抗审视 | 检视獭（异体） | PR 创建后 | 搭档不在场 → 记录 PR 链接到 memory，搭档回来后决定是否审视 |
| 排查结论（需提交修复） | worktree-isolation 流程 | 当前獭 | 结论确认后 | 正常终止，结论记录到 memory |

### 异体执行原则

PR 审视在多 agent 场景下由架构保证异体（大獭召唤检视獭）。
单 agent 场下降级：大獭自己写的 PR，至少等待搭档确认后才能合入。
搭档明确说"跳过审视"时，记录决策后放行。

### 弹性完成规则

代码实现的流程弹性有限制：
- **可以弹性的**：自检步骤（step 5）——搭档说"行了不用自检了"，记录决策后继续提交
- **不可弹性的**：PR 对抗审视（step 8）——这是安全红线，不因搭档说"行了"而跳过。搭档可以说"跳过审视"，但必须是显式决策，且记录在案

区分：搭档说"行了"（默认满意） vs 搭档说"跳过审视"（显式决策）。前者不跳过审视，后者可以。

## Additional Resources

### Reference Files

- **`references/testing-rules.md`** — Behavioral contract testing paradigm and anti-patterns
- **`references/coding-principles.md`** — Architecture constraints, naming, and code quality rules
- **`references/commit-convention.md`** — Commit message format and PR conventions
- **`_shared/signature-convention.md`** — 海獭署名约定
- **`_shared/review-protocol.md`** — 对抗审视协议（代码 PR 审视）
