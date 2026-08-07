---
name: code-implementation
description: >-
  This skill should be used when the user asks to "写代码", "实现这个功能", "开始开发",
  "编码实现", "提交代码", "写测试", "按方案开发", "开干", "开始写",
  or needs to implement a technical plan, write code, create tests, or submit changes.
  Covers the plan-driven development workflow: coding principles, testing strategy, and
  commit conventions. For ANY repository mutation (even one-line fixes), the red lines
  in the repo-safety skill always apply — load it too.
triggers:
  phrases:
    - "写代码"
    - "实现这个功能"
    - "开始开发"
    - "编码实现"
    - "提交代码"
    - "写测试"
    - "按方案开发"
    - "开干"
    - "开始写"
co_loads:
  - repo-safety
---

# Code Implementation

Turn a technical plan into runnable, verifiable code changes.

> **触发短语**：写代码 | 实现这个功能 | 开始开发 | 编码实现 | 提交代码 | 写测试
> **共加载**：repo-safety（仓库变更时必加载）

## Core Principles

- **Repo safety first**: Follow all red lines in the `repo-safety` skill — worktree isolation, no direct commits to protected branches, PR-only delivery, no destructive git operations.
- **Faithful to the plan**: Implement what the plan specifies. Do not expand scope or add unrequested features.
- **Test behavior, not internals**: Assert observable outputs and side effects. Do not assert how functions call each other.
- **No compatibility bridges**: The new design IS the current design. Do not preserve old code paths alongside new ones.

## 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 技术方案 | 必选 | 搭档确认后的方案文档 | 停下来问搭档。即使是自己产出的方案，也需搭档确认后方可进入实现。禁止自行编造方案 |
| 方案编号 | 必选 | 方案文档的 ID | 从方案文档 frontmatter 读取 |
| 工作分支 | 必选 | repo-safety 流程产出 | 先走 repo-safety 创建 worktree |

## Workflow

### 1. Prepare Environment

第一步：执行 repo-safety 最小流程创建 worktree 隔离环境。

- 读取 `repo-safety` skill，执行其最小流程
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

Follow the commit message convention in `references/commit-convention.md`.

### 7. Submit via PR

After committing:

1. Push the worktree branch to remote: `git push -u origin <branch-name>`
2. Create a PR using `gh pr create`

### 8. PR 对抗审视

PR 创建（或 push 更新）后，交付不算完成——必须经独立审视：

1. 召唤检视獭（见 `otter-summon` skill）。小獭只有 read 权限、且 cwd 是主仓（相对路径会解析到主仓旧代码），systemPrompt 中必须：
   - 要求其先 read `adversarial-review` skill 再动手
   - 附上审视对象：`gh pr diff` 全文（大 PR 可落盘成文件后给绝对路径；落盘到仓库外如 /tmp，勿写入 worktree 污染 git status）
   - 附上 worktree 的绝对路径——静态核验（对照测试文件、周边代码）必须以 worktree 内文件为准；主仓是 PR 合入前的旧代码
   - 附上本次测试与构建的运行结果（标注为实现者自报），供其静态核验
2. 收到审视报告后，先校验报告合规性（含"本轮焦点"声明、发现分级、file:line 引用）——不合规直接打回重做，不合规报告不进入处置流程。然后按 `adversarial-review/references/author-response-protocol.md` 的**作者处置协议**逐条回应：接受并修复 / 反驳（必须附证据，空驳回等同未处置）/ 部分接受 / 呈搭档裁决。不照单全收，也不空口驳回。反驳在对话内直接发给原检视獭，证据交换不消耗审视轮次。
3. 修复后更新 PR，重新走审视（systemPrompt 不可更新：在消息中把新 diff 发给检视獭，或 dissolve 后重建）。第 2 轮起是 **delta 审视**——重建材料：8.1 全部材料 + 上轮发现清单 + 你的逐条处置 + 修复 diff（轮次结构与检视者职责定义见 `adversarial-review/references/review-loop.md`）
4. 审视循环按收敛判据运转（`adversarial-review/references/review-loop.md`）：不设轮数上限，自然终止于"修复验证全部通过 + 无阻断回归"；对立僵局 / 移动靶 / 僵尸循环任一信号 → 停止循环，呈搭档裁决。搭档作为决策者随时可加开检视轮或直接拍板
5. 审视通过 → 呈搭档终审，交付才算完成

审视者必须独立于实现者——自己写自己审等于没审。搭档明确表示"跳过审视/不用审"时，记录该决策后放行。

## Behavioral Rules

- Features not in the plan are not implemented — confirm with the requester first
- Discover gaps in the plan → record them and communicate back, do not improvise
- Finding a flaw in the design → report to the plan author, do not redesign in place
- **Fix all self-discovered issues within plan scope immediately** — do not ask "should I fix this?" or leave issues with "can optimize later". 检视獭报上来的发现不适用本条——走 step 8 的作者处置协议，带证据的反驳是合法处置
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
| 排查结论（需提交修复） | repo-safety 流程 | 当前獭 | 结论确认后 | 正常终止，结论记录到 memory |

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
