---
name: worktree-isolation
description: >-
  MUST trigger BEFORE modifying any git-tracked file (code, docs, config, lockfile).
  This skill creates worktree isolation — the FIRST step before writing any file.
  If you are about to edit, create, or delete any file tracked by git, load this skill FIRST.
  Does NOT apply to non-git files (memory, .env, local config).
  Typical triggers: "提交", "commit", "push", "merge", "提个 PR".
triggers:
  phrases:
    - "提交"
    - "提个 PR"
    - "commit"
    - "push"
    - "merge"
    - "把这个改动提交了"
co_loads: []
---

# Worktree Isolation

适用于**一切会改动 git 追踪文件的任务，无论大小**——一行 lockfile、一个配置项、一篇文档的提交都算。
本 skill 只有最小流程；按方案做功能开发时，配合 code-implementation 走完整流程。

> **触发时机**：准备提交任何 git 追踪文件之前（不是修改时）
> **触发短语**：提交 | 提个 PR | commit | push | merge
> **排除**：非 git 追踪文件（memory、.env、local config）不需要此 skill
> **共加载**：无（安全红线已在 SYSTEM.md 中全局生效）

## 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 任务描述 | 必选 | 搭档或当前上下文 | 停下来问搭档 |
| 涉及的文件类型 | 可选 | 从任务描述推断 | 判断是否为 git 追踪文件，非 git 追踪文件不需要此 skill |

## 红线

安全红线在 SYSTEM.md "仓库安全红线" 中全局定义。本 skill 的最小流程严格遵守这些红线。

## 最小流程（小改动同样适用）

0. **验证环境**（条件步骤）：如果不确定当前是否在 worktree 内，执行以下验证：
   - 执行 `git rev-parse --show-toplevel` 获取 git 根目录
   - 执行 `pwd` 获取当前目录
   - 如果当前目录就是 git 根目录，说明在主目录，需要先创建 worktree
   - 如果当前目录在 `.claude/worktrees/` 下，说明已在 worktree 内，跳过 step 1
1. 基于最新 `origin/main` 在 `.claude/worktrees/` 下创建 worktree，建 feature 分支：
   - 使用 `git worktree add .claude/worktrees/<name> -b <branch-name> origin/main`
   - **失败处理**：如果 worktree 创建失败，向搭档报告失败原因，由搭档决定是否在主目录继续（记录决策后放行）或中止任务
2. 后续所有改动与验证都在 worktree 内进行，主目录保持原样
3. 按提交模板 commit（署名约定见 `_shared/signature-convention.md`）
4. `git push -u origin <branch>` + `gh pr create`，把 PR 链接交给搭档审查
5. 收尾记录：worktree 名、分支名、PR 号

## 与其他 skill 的关系

- 任务是**按方案做功能开发**（写实现、写测试）→ 配合 `code-implementation` 走完整流程
- 任务是**排查问题**且结论需要提交修复 → 从 `troubleshooting` 转到本 skill 再动手
- 非方案驱动的小改动（lockfile、配置、文档订正等）→ 走本 skill 最小流程即可，不强制检视獭审视，PR 直接呈搭档终审。**小改动 = 不改变运行时行为的改动**；归属模糊时按方案驱动处理——加载 `code-implementation` 走其对抗审视流程，默认从严，不由实现者自我分类放行

## 后续动作声明

| 产出类型 | 下一步动作 | 执行者 | 触发条件 | 不满足时处理 |
|----------|-----------|--------|----------|-------------|
| PR 创建（小改动） | 搭档终审 | 搭档 | PR 创建后 | 搭档不在场 → 记录 PR 链接到 memory，搭档回来后终审 |
| PR 创建（功能开发） | 对抗审视 | 检视獭（异体） | PR 创建后 | 搭档不在场 → 记录 PR 链接到 memory，搭档回来后决定是否审视 |
| commit 失败 | 诊断修复 | 当前獭 | commit hook 失败时 | 正常终止，向搭档报告失败原因 |

### 异体执行原则

PR 审视在多 agent 场景下由架构保证异体（大獭召唤检视獭）。
单 agent 场下降级：大獭自己写的 PR，至少等待搭档确认后才能合入。
搭档明确说"跳过审视"时，记录决策后放行。

### 弹性完成规则

worktree-isolation 的红线（worktree 隔离、禁止直接提交 main 等）不可弹性——这些是安全底线。

但小改动的流程可以弹性：
- 搭档说"直接提交吧" → 可以跳过 PR 流程，直接在 worktree 里 commit + push（但仍需搭档确认）
- 搭档说"不用建 worktree 了" → **搭档显式喊停时，记录决策后放行**。这是 SYSTEM.md "搭档优先"原则的体现——搭档优先级最高。

区分：流程步骤可以弹性，安全红线不可以。但搭档可以喊停任何流程（包括安全红线），记录决策后放行。

## Additional Resources

- **`_shared/signature-convention.md`** — 海獭署名约定（commit author、PR description、review report）
