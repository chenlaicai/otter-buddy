---
id: F20261010grig
title: "gitignore 补位：guard-replay-candidates 运行时产物"
summary: "PR #1368 引入守卫拦截 replay 固化自动化时，新产物 data/guard-replay-candidates-*.json 漏配 .gitignore（只盖了旧的 guard-shadow-report-*），每日任务链产出后以 untracked 文件出现在主仓 git status，被搭档在 2026-10-10 的「主目录 git 待提交文件」排查中检出。本次补一条 ignore 规则（模式对齐旧产物惯例）。"
change_type: fix
capability_test: "n/a: 单行 gitignore 规则，行为经 git check-ignore 直接验证"
intent:
  problem: "PR #1368 新增 guard replay 固化产物 data/guard-replay-candidates-<date>.json 未配 ignore，每日任务链（2026-10-10 08:34 实证）产出后污染主仓 git status——运行时数据进 git 视野，搭档需要人工甄别。"
  solution: ".gitignore 补 data/guard-replay-candidates-*（紧邻同族 guard-shadow-report-* 规则，注释注明产物语义与引入来源）。"
  expected_effect: "该产物不再出现在 git status untracked；后续每日 replay 固化产出零噪音。"
  verify_by:
    type: behavior_check
    assertions:
      - "git check-ignore data/guard-replay-candidates-2026-10-09.json 命中新规则"
      - "git status 不再列出该文件"
created_in_conversation: 9d6ffef1-c9b2-48f9-b2ac-0751090f3ebf
causal_links:
  - issue: "1368"
    note: 守卫拦截 replay 固化自动化的引入 PR——本次为其运行时产物补 ignore
tags: [gitignore, guard, replay, runtime-data]
modules:
  - .gitignore
---

# gitignore 补位：guard-replay-candidates 运行时产物

## 背景

搭档 2026-10-10 问「主目录有好几个 git 待提交文件是干啥的」——排查发现 8 个 untracked 文件分三类：

1. **issue 处理草稿 ×6**（仓根 close-*.md / comment-*.md）：9:30「每日 issue 处理」任务的獭写长评论时先落草稿再 `gh issue close --body-file`，GitHub 动作已实际执行完（四个 issue 已关、评论已发），属已消费残稿——已直接删除。根治项（临时文件应走对话工作区）另登记 matter M-f82ff252。
2. **data/guard-replay-candidates-2026-10-09.json**：#1368 的守卫 replay 固化产物，8:34 每日任务链生成，正常运行时数据——但引入时漏配 ignore，本次修复对象。
3. **data/otter-buddy（0 字节空文件）**：sqlite3 shell 双层引号嵌套断裂时把残缺参数当数据库名打开、SQLite「打开即建库」产生的垃圾（mtime 08:32:17 与 invoke_events 中该秒 sqlite3 调用吻合）——在 data/ 运行时保护区，獭删会被守卫正确拦截，由搭档手动清理。

## 改动

`.gitignore` 紧邻同族规则补一行：

```
data/guard-replay-candidates-*
```

（附注释：产物语义 + 引入来源 #1368，对齐 guard-shadow-report-* 的注释惯例）

## 非目标

- 不处理草稿残稿根治（matter M-f82ff252 跟踪）
- 不给 data/otter-buddy 空文件配 ignore（一次性垃圾，删即消失，配规则反而掩盖 sqlite3 引号问题）

## 验证

- worktree 内 `git check-ignore data/guard-replay-candidates-2026-10-09.json` 命中新规则
- 该文件从 git status untracked 消失
