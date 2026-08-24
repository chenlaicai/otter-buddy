---
id: F20260824pcpym
title: post-merge-cleanup 收尾清理 skill
summary: |
  新增 post-merge-cleanup skill，覆盖 PR 合入后的资源回收：worktree、本地分支、远程分支、源头 issue、产物状态、检视獭。
  支持单 PR 清理和批量扫尾模式，每步 check-then-act 保证幂等，仅"确认 PR 合入"为强制步骤。
change_type: feature
status: active
capability_test: "n/a: 纯 skill/prompt 定义，无 LLM 参与行为变更"
created_in_conversation: b7ca473c-4033-4e29-a098-7a3f05e02852
tags:
  - skills
  - cleanup
  - post-merge
  - worktree
  - git-hygiene
modules:
  - .pi/skills/post-merge-cleanup/
  - prompts/skills/manifest.yaml
---

# post-merge-cleanup 收尾清理 skill

## 背景与需求

### 问题描述

搭档发现：当他说"已合入"时，海獭们基本只清理 worktree，但本地分支、GitHub 远程分支、源头 issue 经常被遗漏。

现场数据：
- 42 个 worktree 堆在磁盘（大量对应已合入 PR）
- 63+ 本地 feature/fix 分支未删
- GitHub repo 的 `delete_branch_on_merge = false`，远程分支不自动删
- 源头 issue 关闭靠缘分，没有系统性规则

### 根因分析

现有 skill 链到"呈搭档终审"就断了：
- `worktree-isolation`：到 PR 创建为止
- `code-implementation`：到呈搭档终审为止
- `review-protocol`：到终审通过为止

没有任何 skill 定义"已合入"后的清理流程，搭档说"已合入"时海獭行为完全靠临场判断。

## 设计方案

### 设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 独立 skill vs code-implementation 子步骤 | 独立 skill | 生命周期不同（创建 vs 清理），可能跨 session |
| 触发方式 | 搭档显式触发（关键词匹配） | 无 webhook 能力，轮询不现实；搭档可能需要先验证功能再清理 |
| 清理顺序 | worktree → 本地分支 → 远程分支 → issue → 产物 → 检视獭 | 分支被 worktree checkout 时无法删除，必须先删 worktree |
| 失败策略 | 仅"确认 PR 合入"强制，其余容忍失败 | 清理未合入的 PR = 不可逆数据丢失；其余残留只占资源不破坏 |
| dirty worktree 处理 | 不自动删除，报告搭档 | 可能有未提交的重要改动 |

### 群策过程

经 mimo（工程实现评估）和 kimi（UX 与流程设计评估）讨论后形成方案：

**mimo 的工程贡献**：
- worktree lock 文件是最常见的工程故障（进程被 kill 后残留），必须先清理
- `.git/worktrees/` 元数据目录可能残留，remove 后要二次检查
- 建议加定期自动扫描定时任务（后续迭代）

**kimi 的 UX 贡献**：
- 触发词不只有"已合入"，还需覆盖"合了""收拾一下""善后"等口语
- `Fixes #N` 可安全关 issue，`Related to #N` 只加评论不关
- 首次执行时问搭档远程分支删除策略，记录到 memory 后续默认

### 工作流

#### 单 PR 清理（9 步）

1. **定位 PR**：从对话上下文找 PR 编号，找不到则问搭档
2. **验证合入状态**：`gh pr view` → MERGED 继续，OPEN/CLOSED 报告搭档终止
3. **清理 worktree**：清 lock → 检 dirty → remove → 清元数据残留
4. **删除本地分支**：先查存在性，存在则 `-D` 强制删除
5. **删除远程分支**：先 `ls-remote`，存在则 `push --delete`，失败不阻塞
6. **关闭源头 issue**：解析 PR description 中的 `Fixes #N` / `Closes #N`，区分 Fixes（关闭）和 Related（只评论）
7. **更新产物状态**：worktree + PR 类型资源 → archived
8. **解散检视獭**：最后执行，确认清理完成再解散
9. **汇报**：结构化清理报告

#### 批量扫尾模式

搭档说"清理一下过期分支/堆积"时触发：
1. 扫描 worktree + 本地分支
2. 关联 PR 状态（merged/closed/open）
3. 分类呈现清单，等搭档确认
4. 确认后逐项执行清理

### 安全边界（不自动清理的场景）

- worktree 有未提交变更（dirty state）→ 报告搭档
- PR 被 revert → 报告搭档
- `Related to #N` → 只加评论不关 issue
- 保护分支（main/develop/production）→ 永远不删
- 多 PR 共享分支 → 跳过

## 影响范围

| 文件 | 变更类型 |
|------|---------|
| `.pi/skills/post-merge-cleanup/SKILL.md` | 新增 |
| `prompts/skills/manifest.yaml` | 修改（新增条目 + next 指针更新） |

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-24 | 初版：单 PR 清理 + 批量扫尾模式 |
