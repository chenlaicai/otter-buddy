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
   - 开发獭：按召唤时的 name 署名，例如 `开发獭-需求名 <otter-buddy>`
2. **PR description**：末尾署名行使用 `commit-convention.md` 的 PR Description 模板，`[海獭名号]` 替换为实际名号
3. **Review report**：使用 `adversarial-review/references/report-template.md` 模板，`[海獭名号]` 替换为实际名号

## 与其他 skill 的关系

- 任务是**按方案做功能开发**（写实现、写测试）→ 同时加载 `code-implementation`（其 step 8 的对抗审视是强制环节）
- 任务是**排查问题**且结论需要提交修复 → 从 `core-workflow` 转到本 skill 再动手
- 非方案驱动的小改动（lockfile、配置、文档订正等）→ 走本 skill 最小流程即可，不强制检视獭审视，PR 直接呈搭档终审。**小改动 = 不改变运行时行为的改动**；归属模糊时按方案驱动处理——加载 `code-implementation` 走 step 8 对抗审视，默认从严，不由实现者自我分类放行
