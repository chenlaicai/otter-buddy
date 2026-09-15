---
id: F20260915ercv
title: PR 合入前同步最新 base 的 skill 条款
doc_type: feature

# 记忆索引
summary: |
  EchoAgent #1173/#1176「会师红」事故暴露流程盲点：#1173 合入 main 带入一个会挂的
  迁移测试（当时 CI 因基础设施全线红没拦住），#1176 从不含 #1173 的旧 base 拉分支修
  基础设施、自己的 PR CI 绿，合入 main 后两个各自绿的改动叠加出红。根因：skill 里
  没有任何一条要求「开工拉最新目标分支 / 合入前确认 base 未落后」。本特性在两个
  skill 注入条款：worktree-isolation 步骤 3 强化为「先 git fetch 再建 worktree」（原
  写法直接用可能过期的本地 origin/main 引用）；review-protocol 步骤 5（终审）新增
  「呈终审前确认分支 base 未落后于 origin/main，落后则 rebase 并重跑关键验证」。
  海獭仓已开 GitHub「up to date before merging」分支保护（机械拦截），本条款是
  prompt 层双保险，不求强制效果。

# 因果链路
causal_links:
  from: []
  to: []

# 元数据
change_type: prompt
capability_test: "n/a: skill 提示词条款变更，无代码路径；验证走 lint:skills（manifest 一致性）+ 人工通读两处条款上下文"
tags: [skill, worktree-isolation, review-protocol, git-workflow, stale-base, merge-conflict]
modules: [.pi/skills/worktree-isolation/SKILL.md, .pi/skills/review-protocol/SKILL.md]

# 时间
created_at: 2026-09-15
created_in_conversation: fc762a93-3ca4-41e9-a473-62ebad760505
---

# PR 合入前同步最新 base 的 skill 条款

## 背景与需求

EchoAgent 仓库 2026-09-15 的「会师红」事故（对话 fc762a93 排查）：

1. #1173（群聊身份展示）合入 main，带入一个迁移测试缺陷——但当时 CI 因基础设施问题（runner 出网 + Jest OOM）全线红，该测试的失败被淹没，没在合入门槛拦住。
2. #1176（修 CI 基础设施）从**不含 #1173 的旧 base**（`2bbe1d3b`）拉分支。它自己的 PR CI 是绿的——因为 checkout 的环境里根本没有 #1173 那个会挂的测试文件。
3. #1176 合入 main 后与 #1173 会师，两个各自绿的改动叠加，main 持续红。

**根因不是某一个獭犯错，而是流程盲点**：CI 绿只证明「这个 diff 在我 checkout 的那个 base 上能跑」，证明不了「合进当前 main 还能跑」。翻遍 `.pi/skills/`，唯一沾边的是「rebase 后允许 `--force-with-lease`」（讲 rebase 之后怎么推），**没有任何一条要求开工时拉最新目标分支、或合入前确认 base 未落后**。

## 目标

- 开工（创建 worktree）时，基于**最新**目标分支，不吃本地过期引用的亏。
- 最终检视复核通过、呈终审前，再确认一次分支 base 没落后于 origin/main；落后则 rebase 并重跑关键验证。

## 非目标

- 不改 SYSTEM.md 全局红线（R1 已够，本特性是 skill 操作层细化）。
- 不追求机械强制——GitHub「up to date before merging」分支保护已是硬闸（海獭仓已开），本条款是 prompt 层双保险与意识固化，不替代平台机制。
- 不引入 merge queue 等平台配置变更（属仓库 admin 操作，超出本特性）。

## 方案设计

两个 skill 各一处注入，都是窄改（narrow-fix），不新增机制：

### 注入点 1：worktree-isolation 步骤 3（开工拉最新）

原写法 `git worktree add ... -b <branch> origin/main` 直接用本地 `origin/main` 引用——这个引用可能是几小时甚至几天前 fetch 的。改为**先 `git fetch` 再建**，并说明为什么（开工基线过期 = 在错误的代码上写代码，后续白白冲突）。

### 注入点 2：review-protocol 步骤 5（终审前再确认）

终审步骤新增一段：呈终审前 `git fetch` + 比对分支 base 与 `origin/main` 的 commit 差，落后则 rebase（`--force-with-lease` 推，R1 #468 放行）并重跑关键验证（至少 CI 关键套件 / tsc），再呈终审。理由：审视通过证明的是「审视那一刻的 base 上没问题」，从审视到搭档拍板之间 main 可能又前进了——#1173/#1176 正是死在这个窗口。

## 影响范围

- `.pi/skills/worktree-isolation/SKILL.md`：步骤 3 一处。
- `.pi/skills/review-protocol/SKILL.md`：步骤 5（终审）一处。
- manifest 无需动（不改 name/category/next/not_for）。

## 取舍

- **为什么放 worktree-isolation 步骤 3 而非 code-implementation**：worktree-isolation 是「一切改动 git 追踪文件」的入口（含 code-implementation 底层也走它），改一处全覆盖；code-implementation 不重复写，避免双源漂移。
- **为什么终审条款放 review-protocol 而非 adversarial-review**：这是「呈终审的时机把关」，属审视循环的编排（review-protocol 职责），不是检视维度本身（adversarial-review 职责）。检视獭不需要关心 base 落不落后，编排的大獭需要。
- **为什么是「关键验证」而非「全量验证」**：rebase 后全量重跑成本高，且平台分支保护已在合并入口机械拦。prompt 层只要求重跑「能在合理成本内确认 base 前进没把本 PR 弄坏」的关键项（CI 关键套件 / tsc / 本变更相关测试），把强度留给平台机制兜底。

## 验证

- `npm run lint:skills` 0 error（manifest 一致性未破坏）。
- 人工通读两处条款，确认与上下文步骤编号、语气、红线引用一致。
