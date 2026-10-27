---
id: F20261027pprd
title: "gitignore 补位：data/patches/ WIP patch 存档目录"
summary: "2026-10-23 清理 WIP worktree 前将未合入改动打包存档到主仓 data/patches/（当时已向搭档报备保留），但该目录无 .gitignore 规则，长期以 untracked 形态出现在主仓 git status。2026-10-27 搭档发起「主目录又脏了」排查（同日检出多项：SKILL.md 主目录残留、反引号事故文件「单批」、3.7GB 数据库备份残留等），本目录被定性为有意存档而非污染。本次补 ignore 规则，消除视觉噪声。"
change_type: fix
capability_test: "n/a: 单条 gitignore 规则，行为经 git check-ignore 直接验证"
intent:
  problem: "data/patches/ 是运行时存档目录（非 git 追踪内容），无 ignore 规则导致每次 git status 都显示 untracked，混入真实污染的视野，增加搭档甄别成本——2026-10-27 排查中即被当作可疑项逐项溯源后才能放行。"
  solution: ".gitignore 在 data/sessions/ 规则后补 data/patches/（同为 data/ 下运行时目录，注释注明存档语义与来源日期）。"
  expected_effect: "data/patches/ 不再出现在 git status untracked；主目录脏文件视野只剩真实异常项。"
  verify_by:
    type: behavior_check
    assertions:
      - "git check-ignore data/patches/x.patch 命中新规则"
      - "git status 不再列出 data/patches/"
created_in_conversation: f3567df1-e24b-49cd-a020-cdb39572f853
tags: [gitignore, worktree-cleanup, runtime-data]
modules:
  - .gitignore
---

# gitignore 补位：data/patches/ WIP patch 存档目录

## 背景

2026-10-23 执行 WIP worktree 清理时，对未合入的改动按惯例打了 patch 存档（目录 `data/patches/`，6 份文件约 200KB），当时的清理报告已向搭档报备「patch 存档保留」并获得默认放行。但该目录一直缺 .gitignore 规则。

2026-10-27 搭档发现主目录出现一堆文件并发起排查（对话「主目录污染」），9 项脏条目全溯源定性：

| 条目 | 定性 |
|---|---|
| `data/patches/` | **有意存档**（本次补 ignore 消除视野噪声） |
| `.pi/skills/adversarial-review/SKILL.md` 修改残留 | 真污染（修复獭先改主目录后建 worktree，顺序违规；内容已由 PR #1660 承载，主目录已 `git restore` 还原） |
| `单批`（0 字节） | 真污染（`gh issue create --body "…"` 双引号内 markdown 反引号被 shell 命令替换执行，`> 单批` 重定向创建；同事故吞掉 issue #1657 body 两段文本，已用 `--body-file` 修复） |
| `data/otter-buddy.db.bak-sweep-*`（3.7GB×2 组） | 任务收尾残留（#1051 清扫备份，任务闭环 7 天未删） |
| `data/memory.sqlite`（0 字节） | 误创建（sqlite3 打开不存在路径自动建空库） |
| `check-one.mjs`（symlink） | 残留（指向对话工作区的临时符号链接） |

本 PR 只处理其中 gitignore 补位一项；其余删除类动作因 bash 守卫保护主仓（data/ 运行时数据 + 内容树均禁獭直接删改），由搭档人工执行。

## 改动

`.gitignore` 的 `data/sessions/` 规则后追加：

```
# WIP patch archive (F20261027pprd, 2026-10-23 存档目录)
data/patches/
```

## 验证

- `git check-ignore data/patches/x.patch` 命中新规则
- `git status` 不再列出 `data/patches/`
- 本地 pre-commit 全链（build/lint/smoke:boot/arg-parse/lint:docs/lint:skills 等）通过

## 关联

- 同排查衍生的杜绝项：edit/write 工具主仓写保护盲区（bash 守卫只拦 bash 命令，edit 工具直接改主仓 git 追踪文件无拦截——本次 SKILL.md 污染根因），另立 issue 跟踪
- 先例：F20261010grig（同型 gitignore 补位）
