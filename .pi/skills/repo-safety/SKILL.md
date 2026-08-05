---
name: repo-safety
description: >-
  This skill should be used for ANY task that mutates a git repository — committing,
  branching, pushing, opening a PR, editing or creating tracked files — no matter how
  small the change is. Typical triggers: "提交", "提个 PR", "commit", "push", "merge",
  "改一下", "修这个 bug", "把这个改动提交了", lockfile/配置/文档提交, 新建分支, git 操作.
  Also load it when a 排查/分析 task concludes that a fix needs to be committed.
  Covers worktree isolation, branch protection, PR-only delivery, and safe git hygiene.
---

# Repo Safety

适用于**一切会改动 git 仓库的任务，无论大小**——一行 lockfile、一个配置项、一篇文档的提交都算。
本 skill 只有红线与最小流程；按方案做功能开发时，在此之上加载 code-implementation 走完整流程。

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
6. **写前检查门（Hard Gate）**：对任何 git 追踪文件执行 `edit`/`write` 前，先判断该文件
   是否在版本控制中（`git ls-files --error-unmatch <file>`）。如果是，必须先进入 worktree
   流程。没有 worktree 就不动笔。

## 最小流程（小改动同样适用）

1. 基于最新 `origin/main` 在 `.claude/worktrees/` 下创建 worktree，建 feature 分支
2. 后续所有改动与验证都在 worktree 内进行，主目录保持原样
3. 按提交模板 commit
4. `git push -u origin <branch>` + `gh pr create`，把 PR 链接交给搭档审查
5. 收尾记录：worktree 名、分支名、PR 号

## 与其他 skill 的关系

- 任务是**按方案做功能开发**（写实现、写测试）→ 同时加载 `code-implementation`
- 任务是**排查问题**且结论需要提交修复 → 从 `core-workflow` 转到本 skill 再动手
- 子任务性质从只读变为写入（如排查中发现需要修改文件、配置任务中需要修正追踪文件）
  → 立即加载本 skill，不沿用主任务的心理框架
