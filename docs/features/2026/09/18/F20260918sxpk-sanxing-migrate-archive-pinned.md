---
id: F20260918sxpk
title: 三省吾身迁移脚本补漏：归档动作摘置顶 + 补归档依赖升级日常运维
summary: F20260917swsh 的一次性迁移脚本归档动作只写 archived_at 不清 pinned，导致已归档对话残留守置顶位（生产实证 3 行）；且 9/17 拍板归档清单漏了任务被挪走的第 5 个宿主「依赖升级日常运维」。补 pinned=0 与第 5 个归档 ID，幂等测试通过。
doc_type: feature
change_type: fix
created_in_conversation: e445803a-d59e-4683-b76d-ae76df3ae636
created_at: 2026-09-18
from:
  - F20260917swsh
tags: [migration, pinned, archive, sanxing-wushen, hotfix]
modules: [scripts/migrate-sanxing-wushen.mjs]
---

# 背景

搭档 2026-09-18 重启系统后发现置顶任务列表无变化（F20260917swsh 迁移脚本未随启动自动执行，由大獭手动跑通）。跑完后复查发现两处残留：

1. **归档动作漏摘置顶**：迁移脚本 step 6 只写 `status='archived', archived_at=...`，不清 `pinned`。生产实证（2026-09-18 11:37 查询）：4ef4e922（📖 每日复盘）、a56c349e（📋 Backlog 排期）、a344e752（架构整洁和过度设计）三个已归档对话仍 pinned=1，置顶区继续展示已归档对话——搭档「置顶没变化」观感的直接原因之一。
2. **归档清单漏第 5 个宿主**：「依赖升级日常运维」（a3758263）的定时任务（依赖升级自动化）已挪入三省吾身，但该对话不在 9/17 拍板的归档名单（名单仅 4 个）。搭档 2026-09-18 复核时指出，拍板归档（对话原话「ok」）。

## 修复

`scripts/migrate-sanxing-wushen.mjs` 两处：

- step 6 归档 SQL 补 `pinned = 0`
- `ARCHIVE_CONV_IDS` 追加 `a3758263-dfac-4396-93ee-37d89efb5b0e`（依赖升级日常运维，含拍板注释）

生产库残留已先行手工修复（3 行 pinned 清零 + a3758263 归档），本 PR 让脚本与生产终态一致，保证其他环境/回滚重放正确。

## 验证

- **失败证据（修复前）**：2026-09-18 11:37 生产库查询
  `SELECT substr(id,1,8), title, status, pinned FROM conversations WHERE id IN (归档 4 ID)` →
  4ef4e922 / a56c349e / a344e752 三行 `archived | pinned=1`（置顶残留，即 bug 现场）。
- **修复后**：生产库副本幂等性测试（`cp` 快照 + `node scripts/migrate-sanxing-wushen.mjs --db <副本>`）→
  已迁移 13 步全部 `[skip]（0 行）`；`a3758263` 归档 `[ok]（1 行）` 且复验 `status=archived, pinned=0`。
- 生产终态复核：`SELECT ... WHERE pinned=1` → 5 个功能对话（三省吾身/reseach/飞书群聊/纸面交易/东北村），无归档残留。

## 已知瑕疵（不修）

- step 1 对话改名 SQL 无条件守卫（`WHERE id = ?` 不带 `AND title != ...`），重跑恒 touch 1 行（updated_at 变化）。一次性脚本、无数据破坏，不值得加守卫。

## 执行记录

- 生产迁移执行：2026-09-18 11:35（14 项 [ok]，前置备份 `data/backups/otter-buddy-pre-sanxing-20260918-1135.db`，sqlite3 .backup 在线安全备份）
- 生产残留手工修复：11:37（pinned 清零 3 行）、11:40（a3758263 归档，搭档拍板）
