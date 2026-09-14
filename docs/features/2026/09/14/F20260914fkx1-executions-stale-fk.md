---
id: F20260914fkx1
title: "存量库 scheduled_task_executions 残留 FK 指向已 drop 的 messages 表：定时任务静默死亡修复（#886 后遗）"
summary: "9/13 #886 合入后服务重启，migrateDatabase 批4c drop 了 messages 表，但存量库 scheduled_task_executions 的 message_id 列仍挂 REFERENCES messages(id)。foreign_keys=ON 时 INSERT 在 prepare 阶段抛 SqliteError: no such table: main.messages，9/14 09:21 起 4 个定时任务 catch-up 全部静默失败（无 execution 行/无告警/无 healing event）。修复：migrateDatabase 补幂等迁移 rebuildExecutionsDropMessagesFk——检测 FK 指向 messages 即四步重建去 FK（#654 同模式），schema.ts 新库建表本就无此 FK。"
change_type: fix
capability_test: "n/a: 纯代码逻辑改动（DB 迁移），无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [scheduler, migration, sqlite, fk, post-merge-fix]
modules:
  - src/frameworks/db/migration.ts
  - tests/frameworks/db/migration.test.ts
created_at: 2026-09-14
---

# 存量库 scheduled_task_executions 残留 FK 清理（#886 后遗）

## 问题现象

搭档 9/14 14:24 报告：「本对话好几天没跑起来过」。本对话（每日健康检查/self-healing 两个定时任务宿主）自 9/9 后再无成功执行记录。

## 根因链（三段式，双源验证）

### 第一段：9/10~9/13 停机闸门拦截（skipped_halted）

9/9 21:44 大獭在 self-healing 巡检中刷屏自链（seq 1783），**chen 两次强制中断** → 触发用户停机闸门（userHalted，F20260903ihlt 设计：中断 = 停机，等用户显式恢复）。此后 4 天本对话定时任务全被 `skipped_halted` 拦截：

| 日期 | 健康检查 | self-healing |
|---|---|---|
| 9/10 | skipped_halted | skipped_halted |
| 9/11 | skipped_halted | skipped_halted |
| 9/12 | skipped_halted | skipped_halted |
| 9/13 | skipped_halted | skipped_halted |

（来源：scheduled_task_executions 台账，双源：API 侧 scheduler 日志 + DB 直查一致）

设计盲区：恢复动作只有「用户在本对话发消息」，无超时自愈路径——用户没回来，闸门开 4 天。**注：9/13 #886 已删除闸门机制本身，此段为历史行为，无需修复**；但「静默跳过无任何可见痕迹」的观感问题与第三段的静默死亡叠加，共同构成搭档的「没跑起来」体感。

### 第二段：9/14 换成 FK 崩溃（#886 迁移残留）

9/13 17:04 #886 合入，migrateDatabase 链新增批4c `dropLegacyMessagesTables`：DROP messages / message_events / message_segments / message_attachments / messages_fts / restart_pending_resumes 六表。

**漏网之鱼**：存量库 `scheduled_task_executions` 表的 `message_id TEXT REFERENCES messages(id)` 外键（该表建于 messages 存活期，只有走过 #654 四步重建的库才会去掉此 FK——本库 CHECK 已含 skipped，幂等条件不命中，从未重建）。

结果：`foreign_keys=ON` 时 SQLite 对含「指向已 drop 表」的 FK 的 INSERT **在 prepare 阶段直接抛** `SqliteError: no such table: main.messages`。

生产现场：9/14 09:21:38 catch-up 批量触发（健康检查/self-healing/依赖升级/客户生日 4 任务），`createExecution` 全部炸在 prepare——堆栈见 log 887782（`SqliteScheduledTaskRepository.createExecution → prepare`）。**手工复现一致**：`PRAGMA foreign_keys=ON; INSERT INTO scheduled_task_executions ...` → 同错。

### 第三段：静默死亡放大器

炸点在 `triggerTask` 的 catch 内部（claim 成功 → createExecution 抛错 → catch 记日志 rethrow → Polling tick 的 catch-up 分支再 catch 只 log）：

- 无 execution 行（INSERT 本身失败）
- 无 healing event（#516/#849 只覆盖 execution 建立后的失败路径）
- 无 consecutiveFailures 累计（claim 已成功，失败计数在 handleTaskExecutionFailure 里）
- 无任务禁用

→ 明天 09:00 还会炸，且依然零痕迹。

## 修复

### 代码（migration.ts）

新增 `rebuildExecutionsDropMessagesFk`，挂在 `dropLegacyMessagesTables` 之后执行：

- 幂等检测：`PRAGMA foreign_key_list(scheduled_task_executions)` 无 messages 引用即返回（新库/已迁移库零成本）
- 四步重建：CREATE 无 FK 新表（message_id 保留为普通列，对齐 schema.ts 新库定义）→ INSERT SELECT 全量保留 → DROP 旧表 → RENAME
- #805 FK 防护：重建在 foreign_keys=OFF 下进行，try/finally 恢复 ON
- 索引 idx_executions_task 随重建恢复

### 测试（migration.test.ts +3）

1. **现场复现**：旧形态表（FK 指向 messages + messages 已不存在）在 foreign_keys=ON 下 INSERT 炸 `no such table: main.messages`——锁定回归基线
2. **迁移后**：INSERT 恢复 + 存量数据保留 + FK 不再指向 messages + 索引在 + 二次迁移幂等
3. **全新库**：无残留 FK，迁移直接通过

自检：migration.test.ts 20/20 通过；tests/frameworks/db/ 全量 26 文件 228 测试通过；改动文件 eslint 干净。

## 关联问题（另行处理，不在本 PR）

- **catch-up 失败无痕迹**（第三段放大器）：#849（单次失败落 healing）只覆盖 execution 建立后的失败；claim 后 createExecution 前的炸点仍是盲区。开 issue 跟踪。
- **停机闸门无超时自愈**（第一段）：闸门机制已随 #886 删除，历史问题归档；若未来恢复类似机制需带超时。

## 验收

- [x] 生产库手工复现炸点
- [x] 迁移后同库 INSERT 恢复（测试 2）
- [x] 幂等（测试 2 内含）
- [x] 新库无影响（测试 3）
- [ ] 合入后服务重启，明早 09:00 定时任务恢复执行（需观察）
