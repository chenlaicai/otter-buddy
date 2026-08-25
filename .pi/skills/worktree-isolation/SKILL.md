---
name: worktree-isolation
description: >-
  Precondition: MUST trigger BEFORE modifying or committing any git-tracked file.
  Use when: 准备提交任何 git 追踪文件（代码、文档、配置、lockfile）.
  Not for: 非 git 追踪文件（memory、.env、local config）. 功能开发 → code-implementation.
  Output: worktree + commit（按提交模板）+ PR 链接交搭档.
co_loads: []
category: technique
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
2. **创建 worktree**：`git worktree add .claude/worktrees/<name> -b <branch-name> origin/main`。失败时报告搭档，由搭档决定继续或中止。worktree 是特性开发的独立空间，特性文档（`docs/features/`）也在这里。
3. **在 worktree 内提交**：所有改动和验证在 worktree 内进行，主目录只读。生成特性 ID 前必须先跑 `date` 取当前日期，禁止凭印象标日期（#422）。按提交模板 commit，署名见 `_shared/signature-convention.md`。
4. **推送并创建 PR**：`git push -u origin <branch>` + `gh pr create`，PR 链接交给搭档。

> 红线在 SYSTEM.md "仓库安全红线" 中全局定义，本流程严格遵守。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| PR（小改动） | 搭档终审 | 搭档 |
| PR（功能开发） | 对抗审视 | 检视獭 |
| commit 失败 | 诊断修复 | 当前獭 |

**小改动**（可走简化审视，仅查 B1-B4）：
- lockfile 更新
- 纯配置值修改（版本号、环境变量默认值，不涉及逻辑变更）
- 文档订正（错别字、链接、格式，不涉及设计决策）

一切其他改动 → 走 `code-implementation` 全流程（含对抗审视）。
归属模糊时默认从严。

## 参考（索引）

- `_shared/signature-convention.md` — 步骤 3 使用
