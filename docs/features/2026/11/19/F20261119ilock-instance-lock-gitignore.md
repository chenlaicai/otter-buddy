---
title: 单实例锁运行时产物补 gitignore，不再污染 git status
id: F20261119ilock
date: 2026-11-19
module: build
change_type: fix
status: active
summary: |
  F20261118cldep（#1945）引入的单实例锁会在 <db-path> 旁创建
  `<db-path>.otter-instance.lock`（内容=持锁进程 PID，随应用启停生灭）。该运行时产物
  没进 .gitignore（既有 `*.pid.lock` 不匹配此命名），导致应用每次启动后 git status 都挂
  一条 untracked——既污染主仓状态信号（今日排查主仓 changes 时即被它干扰），也存在
  被顺手 `git add .` 误提交的风险。补全局通配 `*.otter-instance.lock`（名字跟 db 文件
  走，不锚定 data/ 路径）。
intent:
  problem: "#1945 合入单实例锁后，应用启动即在工作目录留下 otter-buddy.db.otter-instance.lock，.gitignore 无对应条目，git status 永久挂一条 untracked（2026-11-19 08:41 实证）；运行时产物混进 status 会钝化「主仓该是干净」的信号——本次主仓污染排查（两份脚本草稿）中它正是背景噪音之一"
  expected_effect: "git status 对锁文件静默（无论 db 叫什么名字、放在哪），主仓在无真实改动时回到全净状态；误提交风险消除。不改锁的创建/删除行为，纯 ignore 声明"
  verify_by:
    type: behavior_check
    evidence:
      - "git check-ignore -v data/otter-buddy.db.otter-instance.lock → 命中 .gitignore:132 *.otter-instance.lock（data/foo.db.otter-instance.lock 等任意 db 名变体同样命中，已实测）"
      - "补录后主仓 git status --short 输出为空（此前显示 `?? data/otter-buddy.db.otter-instance.lock`）"
---

# F20261119ilock：单实例锁运行时产物补 gitignore

## 现象

#1945（F20261118cldep）合入后，应用启动即创建 `data/otter-buddy.db.otter-instance.lock`
（src/bootstrap/instance-lock.ts：锁文件 = `<db-path>` + `INSTANCE_LOCK_SUFFIX`，内容为持锁
进程 PID，仅作诊断展示）。.gitignore 只有 `*.pid.lock` 一条锁类条目，不匹配这个命名——
git status 从此永久挂着一条 untracked。

## 为什么值得修

- **信号钝化**：主仓 status 的默认预期是「干净」。天天挂着一条无害 untracked，会让「出现
  changes」失去告警价值——2026-11-19 排查主仓污染（另一对话直写主仓的两份脚本草稿）时，
  这条锁文件正是混在其中的背景噪音，需要逐条甄别。
- **误提交风险**：`git add .` / `git add data/` 一把梭时会把含本机 PID 的运行时文件带进
  历史。

## 修法

.gitignore 追加一条（复用本仓「运行时产物 ignore 必须带中文说明 + 特性溯源」的既有风格）：

```gitignore
# 单实例锁运行时产物（F20261118cldep #1945 / src/bootstrap/instance-lock.ts ——
# <db-path>.otter-instance.lock 内容=持锁进程 PID，随应用启停生灭，不进 git；
# 名字跟 db 文件走，故用全局通配而非锚定 data/ 路径）
*.otter-instance.lock
```

用全局通配 `*.otter-instance.lock` 而非锚定 `data/*.otter-instance.lock`：锁名由
`<db-path>` 拼接而来（instance-lock.ts 的 `INSTANCE_LOCK_SUFFIX` 常量），db 路径可配置
（ECS 部署形态下即不在 data/），通配与生成规则同构。

## 影响面与边界

- 纯 ignore 声明：不改锁的创建/删除/探测行为，不影响 #1945 的单实例互斥语义。
- 不追溯已提交的锁文件（核查过 git 历史无此文件，无需 `git rm --cached`）。
- 若未来锁命名规则变化（如换 suffix），此条自然失效，由当次改动同步维护。
