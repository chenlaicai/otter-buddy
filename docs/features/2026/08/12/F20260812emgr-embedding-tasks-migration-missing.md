---
id: F20260812emgr
title: embedding-tasks-migration-missing
doc_type: feature

summary: |
  PR #244 新增 embedding_tasks 表但漏了 migrateDatabase 迁移，现有数据库启动 crash。
  补 ensureEmbeddingTasksTable 幂等迁移；顺带用 nohup 解耦启动脚本进程生命周期。

causal_links:
  from:
    - F20260812mrcq

status: implemented
change_type: bugfix
tags: [db, migration, startup]
modules:
  - src/frameworks/db/migration.ts
  - scripts/otter-buddy.sh
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260812emgr: embedding_tasks 表迁移缺失 + 启动脚本进程解耦

## 背景与需求

### 问题描述

PR #244（F20260812mrcq）在 `schema.ts` 的 `createMemoryTables` 中新增 `embedding_tasks` 表，用于 embedding 重试队列。但 `migrateDatabase()` 未补对应迁移。现有数据库启动时直接 crash：

```
Failed to start: SqliteError: no such table: embedding_tasks
libc++abi: terminating due to uncaught exception of type Napi::Error
```

### 根因分析

`initDatabaseAndModels` 中 `initSchema` 仅在新数据库时调用（`if (isNewDb)`），现有数据库走 `migrateDatabase()`。PR #244 只改了 `schema.ts`，没在 `migration.ts` 补 `CREATE TABLE IF NOT EXISTS`，导致存量库缺表。

附加问题：`scripts/otter-buddy.sh` 的 node 进程继承终端生命周期，关终端/IDE 会 SIGHUP 带崩服务。

### 数据实锤

- 启动日志：`SqliteError: no such table: embedding_tasks`
- `sqlite3 .tables` 确认表不存在
- `schema.ts:216` 有定义，`migration.ts` 无对应条目

## 方案设计

### 技术方案

1. 在 `migrateDatabase()` 末尾加 `ensureEmbeddingTasksTable`，用 `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` 幂等建表
2. 启动脚本 node 命令加 `nohup ... < /dev/null &`，解耦终端生命周期

### 目标

- T1: 现有数据库启动不再因缺表 crash
- T2: 新表定义与 schema.ts 一致（幂等）
- T3: 关终端/IDE 不会带崩服务

### 成功标准

启动日志无 `embedding_tasks` 报错，EmbeddingRetryWorker 正常初始化。

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 现有数据库正常启动 | `bash scripts/otter-buddy.sh start` | 启动成功，日志无 embedding_tasks 错误 |
| AT-2 | 表结构正确 | `sqlite3 data/otter-buddy.db ".schema embedding_tasks"` | 表存在，字段与 schema.ts 一致 |
| AT-3 | 重复启动幂等 | 连续两次 `start` | 第二次同样成功，无重复建表错误 |

### 能力测试映射

无（纯代码逻辑，无 LLM 行为）。

## 实现细节

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/db/migration.ts | 修改 | 新增 `ensureEmbeddingTasksTable` 函数，在 `migrateDatabase` 末尾调用 |
| scripts/otter-buddy.sh | 修改 | node 启动改用 `nohup env ... < /dev/null &` |

## 验收结果

### 测试结果

- `npm run build` 通过
- `bash scripts/otter-buddy.sh start` 启动成功
- `sqlite3 .schema embedding_tasks` 确认表已建
- EmbeddingRetryWorker `migratedExisting: 1000` 正常

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| 现有数据库正常启动 | 证明完成 | ✅ |
| 表结构正确 | 证明完成 | ✅ |
| 进程终端解耦 | 证明完成 | ✅ |
