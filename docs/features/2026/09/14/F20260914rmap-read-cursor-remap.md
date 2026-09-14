---
id: F20260914rmap
title: ctlv 迁移读游标重映射修复：无重叠路径漏调游标重映射致全量虚假未读
doc_type: feature

summary: |
  搭档 9/14 报告「系统升级后每个对话都有未读消息数量」。排查实锤：
  F20260913ctlv 批4c（messages→entries）迁移对每对话 entries 整体重编号
  1..N（为 yield 合成行腾独立序号），但无重叠路径（existingInConv.length===0）
  漏调 remapReadCursors——读游标（conversation_user_read_state.last_read_message_seq、
  conversation_participants.last_read_seq）滞留旧 messages seq 空间，
  而未读统计已切到 entries 序号空间，旧游标之后的老条目全部被误判未读。
  生产实测 151 对话 / 2052 条虚假未读（其中 2050 条为迁移前已读老条目）。
  修复：①迁移函数无重叠路径补游标重映射（按旧前缀末条消息 id 精确定位新序号）；
  ②一次性运维脚本按迁移前备份库重映射存量游标（MAX 防回退迁移后新进度）。

causal_links:
  from:
    - F20260913ctlv   # 母档：entries 切换 + 游标语义；本档修复其迁移缺陷

change_type: fix
tags: [db, migration, read-cursor, unread, data-fix, ctlv]
modules:
  - src/frameworks/db/migration.ts
  - scripts/fix-read-cursor-remap.mjs
  - tests/frameworks/db/messages-to-entries-migration.test.ts
created_in_conversation: e1826531-4856-4dfc-a2aa-f04b14670118
created_at: 2026-09-14
---

# F20260914rmap：ctlv 迁移读游标重映射修复

## 1. 问题现象

搭档 2026-09-14 报告：系统更新升级（含数据迁移）后，左侧栏每个对话都显示
「未读消息」数量——不正常。

## 2. 排查过程与根因

### 数据取证（主库只读查询）

- `settings.messages_to_entries_migrated = done`，时间 2026-09-13 09:17:08（ctlv 批4c）
- 151 个非 archived 对话全部带未读，合计 2052 条；
  其中 **2050 条 created_at 早于迁移时刻**（早已读过），真新消息仅 2 条
- 抽样对话 52bfdd91：游标 380 / entries 最大 seq 641 / yield 合成条目 259 /
  误报未读 121——数字互相印证「seq 空间右移 ≈ yield 合成行数量」

### 根因链

1. ctlv 批4c 迁移（`migrateMessagesToEntries`）对每对话把 otter 消息的
   tsp 合成独立 yield entry（`messageToEntryRows`），为让序号单调无空洞，
   全对话 entries **重编号 1..N**（无重叠路径 `insertNoOverlap`：按迁移行序
   顺次编号，**不沿用旧 sequence_num**）
2. 重叠路径有配套的 `remapReadCursors`（`makeConversationMigrator` 内
   `existingInConv.length > 0` 分支）；**无重叠路径漏调**——而存量库几乎
   全部走无重叠路径（ctlv 之前 entries 表基本为空）
3. 读游标仍存旧 messages seq 值，未读统计已按 entries 序号比较
   （`sqlite-conversation-repository.ts` 侧栏 SQL：`sequence_num > last_read_message_seq`）
   → 旧前缀之后的老条目全部误判未读

设计偏差佐证：ctlv 特性文档「旧表映射关系」写明 `sequence_num` **直接映射**，
实现为 yield 合成改为整体重编号，但未同步设计游标配套——实现与设计偏差未被测试
捕获（现有测试只覆盖重叠路径的游标重映射）。

## 3. 修复方案

### 3.1 代码防御（migration.ts）

无重叠路径补 `remapReadCursorsNoOverlap(db, conversationId, msgs)`：

- **按消息 id 定位锚点，不按 seq 值查找**：旧游标语义 =「已读旧 messages 前
  K 条」。若按「新 seq ≤ 旧游标值」找锚点，yield 合成行会占据序号把锚点吸到
  合成行上（本档测试曾捕获此错误实现：期望 4 实得 3）。正确做法：旧前缀
  末条消息 id → 该 entry（base 行与消息同 id）的新序号
- 旧前缀零行（游标值异常）保持原值不动，不臆测
- `conversation_participants.last_read_seq`（otter 读游标）同规则处理
- 顺带：`collectPendingRows` 从迁移事务函数抽出（lint max-statements）

### 3.2 存量数据修复（scripts/fix-read-cursor-remap.mjs）

迁移已经跑完且标 done（幂等键短路），代码修复不会追溯存量数据，需一次性脚本：

- 原理：entry id 沿用旧 message id（ctlv 不变量）→ 从**迁移前备份库**
  （`data/backups/otter-buddy-pre-migration-20260913.db`）找到旧游标所指
  消息 id → 查主库 entries 得新序号
- `newCursor = MAX(当前游标, 映射值)`：不回退迁移后用户新推进的进度
- 安全设计沿用 #753 脚本惯例：默认 dry-run / `--apply` 才写 / 执行前
  better-sqlite3 backup API 自动备份 / 单事务 / 前置防呆（备份库须有
  messages 表、主库迁移标记须为 done）/ 异常行告警跳过

### 3.3 修法排序声明

走修法排序①（既有机制语义内修：补上迁移本应有的配套步骤），
Modification-Class: `narrow-fix`。无净新增机制（重映射函数是 ctlv 设计
本应覆盖的路径补全；运维脚本为一次性数据修复，不入运行时）。

## 4. 验证

- 单测：`messages-to-entries-migration.test.ts` 新增「无重叠对话游标按旧前缀
  映射」用例（tsp 合成 yield 右移 seq 空间的关键形态），8/8 过；
  db 层全量 26 文件 228 用例全绿
- `npx tsc --noEmit` / `npm run lint` 通过
- 脚本 dry-run：162 游标行，需更新 160，未读预估 2052 → 14
- 脚本 `--apply` 演练（主库副本）：未读 2052 → 14；抽查 52bfdd91 游标
  380→641（=最大 seq）、未读归零；剩余 14 条未读的最早时间 2026-09-12
  （用户真未读过的旧消息+迁移后新消息，符合预期）
- 演练产物已清理，生产库未动——**执行 `--apply` 待搭档批准**

## 5. 影响范围

- 迁移函数变更只影响「未来再跑该迁移的库」（幂等键已 done 的生产库不受影响）；
  新库（无 messages 表）短路跳过，不受影响
- 数据修复只 UPDATE `conversation_user_read_state` /
  `conversation_participants` 的游标值，单行更新幂等（MAX 语义）
- 未读语义不变：仍按 entries 序号 > 游标统计 speak/system
