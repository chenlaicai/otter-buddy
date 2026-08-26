---
id: F20260826hk47
title: README 固化 git hooks 激活验证步骤（#476 收尾）
summary: 在 README「快速开始」安装依赖章节固化 hooksPath 验证步骤，防止钩子配置被环境重置后静默失效复发（#476、F20260821kgts 两次踩坑）。
change_type: docs
status: implemented
tags: [docs, git-hooks, readme, engineering-hygiene]
modules: [README.md]
created: 2026-08-26
created_in_conversation: a55fdd88-1739-4a47-a992-17f1d5739e3a
---

# README 固化 git hooks 激活验证步骤（#476 收尾）

## 背景

Issue #476（2026-08-26）：PR #473 对抗审视中发现 `core.hooksPath` 指向不存在的 `run/_` 目录，全部 git 钩子（commit-msg / pre-commit / pre-push / pre-merge-commit）静默失效。此前 F20260821kgts 也发生过绝对路径覆盖事件（5 天内两次）。

## 改动内容

README.md「快速开始 → 安装依赖」章节：

1. `npm install` 命令注释标注 prepare 脚本会自动设置 hooks 路径
2. 新增「验证 git hooks 已激活」小节：
   - 说明 prepare 脚本机制（`git config core.hooksPath .githooks`）
   - 说明静默失效风险（配置被覆盖时无任何提示，提交规范只能靠 CI 兜底）
   - 给出验证命令与预期输出（相对路径 `.githooks`）
   - 异常处置：重新执行 `npm run prepare`

## #476 核查结论（前置，非本 PR 改动）

- 主仓及全部 6 个 worktree 的 `core.hooksPath` 已为 `.githooks`（prepare 脚本在 npm install 时自愈）
- `run/_` 来源排查：仓库代码无引用、其他仓库无污染、shell 历史无记录——一次性污染，无复发机制
- 钩子实测：pre-commit 提交时实际触发、commit-msg 拦截坏消息（exit=1）、放行合规消息（exit=0）

## 验证 [required]

| 验证项 | 结果 | 备注 |
|---|---|---|
| README 渲染检查 | 通过 | sed 全文查看，标题层级（####）与上下文一致 |
| npm install && npm run check | 通过 | worktree 内完整跑通（lint + tsc + tsc-alias） |
| commit-msg 钩子 | 通过 | 本 PR 首次提交时实际拦截校验 |

## 关联

- Issue #476（本 PR 关闭）
- F20260821kgts（前次钩子失效事件，lint gates wiring）
- PR #473（#476 发现现场）
