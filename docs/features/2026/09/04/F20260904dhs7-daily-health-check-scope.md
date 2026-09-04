---
id: F20260904dhs7
title: 每日健康检查范围约束：限定 otter-buddy 自身系统，跨对话信号先验证归属
summary: 9/4 daily-review 误报 #778（Echo agent 项目的 UX 反馈被当成 otter-buddy 问题上报），搭档定调本任务只找 otter-buddy 自身优化点。prompt 增补范围约束章节 + 「对话归属先验证」分析纪律，并修复同步缺口（DB 与 prompts/scheduled/ 文件自 #444/#545/#629/#712 四次更新以来未同步）。
change_type: prompt
capability_test: "n/a: prompt 纯文本纪律约束（范围过滤规则），行为验证靠每日任务误报率观察（#778 后是否再现同类越界），无代码可测路径"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [scheduled-task, prompt, daily-review]
modules: [prompts/scheduled/daily-health-check.md]
---

## 背景

2026-09-04 09:00 每日对话健康检查产出 issue #778（用户中断零渲染反馈）。搭档指出：该讨论发生在 Echo agent 项目对话中（私聊/群聊渲染均为 Echo 系统概念），不属于 otter-buddy 海獭系统范围，#778 已关闭。

根因：健康检查跨对话 memory 检索到的候选信号未验证对话归属即上报——检索命中不等于属于本系统。

## 改动

`prompts/scheduled/daily-health-check.md`（真相源，PR #428 确立的 git 化模板）三处增量：

1. **新增「范围约束」章节**：只找 otter-buddy 自身系统的优化点；其他项目（Echo agent 等）的对话反馈、UX 讨论、报错一律忽略；跨对话候选信号上报前验证对话归属（看引用的路径/PR/issue 是否指向 otter-buddy），无法确认归属不报
2. **数据源 1/5 增注**：检索结果按范围约束过滤归属
3. **分析纪律新增第 4 条**：「对话归属先验证再上报」，锚定 #778 教训

## 非目标

- 不改 otter-summon/其他 scheduled prompt（依赖部署机制相同，本轮只修本任务）
- 不做检索层自动过滤（memory 系统不感知「项目归属」概念，工程上先靠 prompt 层纪律）

## 同步缺口（重要发现，已就地修复）

- DB 中任务 body 与 git 真相源分裂：文件自 #444（RHI 数据源）、#545（signal 对账）、#629（飞轮口径/#600 方案 B）、#712（止损线 P0-c）四次更新后，`update-scheduled-task-body.mjs` 从未运行（同步纯手动，无 CI/钩子挂载）——9/3、9/4 两天健康检查跑的都是 8/24 版旧 prompt，#600 处置权协议与 #712 止损线检查实际未生效
- 9/4 09:10 大獭曾直接 PATCH DB 写入范围约束（绕过 git 真相源，违背 #428 决策），本 PR 落地后以脚本重同步覆盖修正
- 残余风险：手动同步模式本身（4 次 PR 4 次漏同步的实证）已在日报中向搭档暴露，加自动化（如 post-merge 钩子/CI job）待后续 issue 决策

## 验证

- `node scripts/update-scheduled-task-body.mjs --name "每日对话健康检查" --dry-run` 确认 diff 为本 PR 版本后执行同步
- 同步后 `sqlite3 data/otter-buddy.db "SELECT body FROM scheduled_tasks WHERE name='每日对话健康检查'"` 抽查含「范围约束」与「signal 对账段」

## 关联

- 关闭误报：#778（close comment 已留教训）
- 真相源决策：PR #428（prompt git 化）、issue #352（prompt 散落 DB 教训）
- 同步脚本：`scripts/update-scheduled-task-body.mjs`（F20260824dhck）
