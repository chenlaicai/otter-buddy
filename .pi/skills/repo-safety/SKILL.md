---
name: repo-safety
description: >-
  This skill should be used for ANY task that mutates a git repository — committing,
  branching, pushing, opening a PR, editing or creating tracked files — no matter how
  small the change is. Typical triggers: "提交", "提个 PR", "commit", "push", "merge",
  "改一下", "修这个 bug", "把这个改动提交了", lockfile/配置/文档提交, 新建分支, git 操作.
  Also load it when a 排查/分析 task concludes that a fix needs to be committed.
  Covers worktree isolation, branch protection, PR-only delivery, and safe git hygiene.
triggers:
  phrases:
    - "提交"
    - "提个 PR"
    - "commit"
    - "push"
    - "merge"
    - "改一下"
    - "修这个 bug"
    - "把这个改动提交了"
co_loads:
  - code-implementation
---

# Repo Safety

适用于**一切会改动 git 仓库的任务，无论大小**——一行 lockfile、一个配置项、一篇文档的提交都算。
本 skill 只有红线与最小流程；按方案做功能开发时，在此之上加载 code-implementation 走完整流程。

> **触发短语**：提交 | 提个 PR | commit | push | merge | 改一下
> **共加载**：code-implementation（功能开发时共加载）

## 输入契约

本 skill 需要以下输入才能开始工作：

| 输入 | 必选/可选 | 来源 | 缺失时处理 |
|------|----------|------|-----------|
| 要提交的改动 | 必选 | 当前工作区 | 检查 git status，无改动则不执行 |
| 改动类型 | 必选 | 当前 skill 上下文 | 判断是小改动还是功能开发，决定是否加载 code-implementation |

## 红线

1. **主目录零改动**：所有文件修改（代码、文档、配置）必须发生在 worktree 里。
   主目录只允许只读操作：`git status` / `git log` / `git diff`、读文件。
2. **禁止直接提交到 main**（及 develop / 生产分支）：一律先建 feature 分支。
3. **PR-only 交付**：不直接 push 到受保护分支；改动以 PR 交付，由他人审查合入。
   写代码的人不合自己的 PR。
4. **禁止破坏性 git 操作**：`git branch -D`、`git reset --hard`、`git push --force`、
   `git checkout -- <file>`、`git clean -f` 等会丢弃工作的操作，一律先征得搭档同意。
5. **commit message 一次写对**：提交前先读仓库的提交模板（`.githooks/commit-msg`，
   或 code-implementation 的 references/commit-convention.md），不靠反复试错碰格式。

## 最小流程（小改动同样适用）

1. 基于最新 `origin/main` 在 `.claude/worktrees/` 下创建 worktree，建 feature 分支
2. 后续所有改动与验证都在 worktree 内进行，主目录保持原样
3. 按提交模板 commit
4. `git push -u origin <branch>` + `gh pr create`，把 PR 链接交给搭档审查
5. 收尾记录：worktree 名、分支名、PR 号

## 海獭署名约定

无论大獭还是小獭，在以下三处署名以标识责任主体。

### 身份获取规则

- **大獭**（Claude Code 主进程）：身份为"大獭"，从 MEMORY.md 或用户指令中确认
- **子 agent**（检视獭、开发獭等）：身份由父 agent 在启动时通过 prompt 显式指定，格式示例："你是检视獭，对 PR #N 进行对抗检视"
- **缺失身份时**：子 agent 不得自行猜测，必须向父 agent 确认后再执行署名操作

### 署名位置

1. **Commit author**：用 `--author` 参数指定当前海獭身份，格式 `名号 <otter-buddy>`
   - 大獭：`git commit --author="大獭 <otter-buddy>"`
   - 开发獭：按召唤时的 name 署名，例如 `开发獭-需求名 <otter-buddy>`（连字符是名号的一部分，非邮箱格式）
2. **PR description**：末尾署名行使用 `commit-convention.md` 的 PR Description 模板，`[海獭名号]` 替换为实际名号
3. **Review report**：使用 `adversarial-review/SKILL.md` 的"产出模板"章节，`[海獭名号]` 替换为实际名号

## 与其他 skill 的关系

- 任务是**按方案做功能开发**（写实现、写测试）→ 同时加载 `code-implementation`（其 step 8 的对抗审视是强制环节）
- 任务是**排查问题**且结论需要提交修复 → 从 `core-workflow` 转到本 skill 再动手
- 非方案驱动的小改动（lockfile、配置、文档订正等）→ 走本 skill 最小流程即可，不强制检视獭审视，PR 直接呈搭档终审。**小改动 = 不改变运行时行为的改动**；归属模糊时按方案驱动处理——加载 `code-implementation` 走 step 8 对抗审视，默认从严，不由实现者自我分类放行

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
