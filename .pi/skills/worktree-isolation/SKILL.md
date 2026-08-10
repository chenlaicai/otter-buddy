---
name: worktree-isolation
description: >-
  This skill manages worktree creation and git commit workflow for git-tracked files.
  MUST trigger BEFORE modifying or committing any git-tracked file.
triggers:
  phrases:
    - "改配置"
    - "更新文档"
    - "提交"
    - "提个 PR"
    - "commit"
    - "push"
    - "merge"
    - "把这个改动提交了"
co_loads: []
---

# Worktree Isolation

一切改动 git 追踪文件的提交操作，必须在 worktree 中完成。

## 触发

**触发条件**：准备提交任何 git 追踪文件（代码、文档、配置、lockfile）时。

**排除**：非 git 追踪文件（memory、.env、local config）。功能开发 → `code-implementation`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 任务描述 | 是 | 停下来问搭档 |
| 涉及文件类型 | 否 | 推断是否为 git 追踪文件 |

## 工作流

1. **验证环境**：`git rev-parse --show-toplevel` + `pwd`，确认是否已在 `.claude/worktrees/` 下。已在则跳到 step 2。
2. **创建 worktree**：`git worktree add .claude/worktrees/<name> -b <branch-name> origin/main`。失败时报告搭档，由搭档决定继续或中止。
3. **在 worktree 内提交**：所有改动和验证在 worktree 内进行，主目录只读。按提交模板 commit，署名见 `_shared/signature-convention.md`。
4. **推送并创建 PR**：`git push -u origin <branch>` + `gh pr create`，PR 链接交给搭档。

> 红线在 SYSTEM.md "仓库安全红线" 中全局定义，本流程严格遵守。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| PR（小改动） | 搭档终审 | 搭档 |
| PR（功能开发） | 对抗审视 | 检视獭 |
| commit 失败 | 诊断修复 | 当前獭 |

**小改动** = 不改变运行时行为的改动（lockfile、配置、文档订正）。归属模糊时走 `code-implementation` 对抗审视，默认从严。

## 参考

- `_shared/signature-convention.md` — 海獭署名约定
