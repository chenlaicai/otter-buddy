---
id: F20260916rkct
title: 修复迁移卫星表 CTAS 重建丢结构导致服务启动崩溃
doc_type: feature

summary: |
  修复 F20260915midu 迁移 remapKeyedTable 用 CREATE TABLE AS SELECT 复制卫星表导致表结构全毁的缺陷。
  根因：CTAS 只拷数据不拷约束——embedding_tasks 丢 PRIMARY KEY 后 enqueueRetry 的 ON CONFLICT 启动即炸，
  FTS5/vec0 虚拟表退化为普通表检索全废（2026-09-16 生产现场，localhost:3000 起不来）。
  修复：卫星表换键改为原地 DELETE+INSERT，只触及换键行，表结构零改动。

causal_links:
  from:
    - F20260915midu   # 引入 CTAS 换键复制的迁移

status: implemented
change_type: fix
tags: [db, migration, sqlite, memory]
modules:
  - src/frameworks/db/migration.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260916rkct: 修复迁移卫星表 CTAS 重建丢结构导致服务启动崩溃

## 背景与需求

### 问题描述

2026-09-16 早 `scripts/otter-buddy.sh start` 后 localhost:3000 打不开。服务进程启动即退出，
端口从未监听；PID 文件残留死进程号。

### 根因分析

启动日志最后一行有效输出为 `Migrating 3 existing dark entries to retry queue`，
随后 `Failed to start: SqliteError: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`
（main.ts:62，进程 exit 1）。

崩溃链：

1. F20260915midu（#942）迁移 `rebuildMemoryEntriesUnifyIds` 首次在生产库触发，重建 9181 条 memory_entries；
2. 卫星表换键走 `remapKeyedTable`，其实现 `CREATE TABLE x_new AS SELECT ...`（CTAS）
   **只拷数据不拷结构**：
   - `embedding_tasks`：`entry_id TEXT PRIMARY KEY` 丢失 → 无唯一约束；
   - `memory_weights`：PK/FK 全丢；
   - `memory_fts_jieba`：FTS5 虚拟表退化为普通表 → 中文全文检索废；
   - `memory_vec`：vec0 虚拟表退化为普通表 → 向量召回废；
3. bootstrap 继续执行存量暗化条目迁移（bootstrap/memory.ts:156），
   `enqueueRetry` 的 `INSERT ... ON CONFLICT(entry_id)`（embedding-task-queue.ts:20）
   因唯一约束缺失抛 SqliteError → main() catch → exit 1。

另外实证：vec0 虚拟表 `ALTER TABLE RENAME` **不跟随 shadow 表**（shadow 保持
`memory_vec_new_*` 命名），即使给 CTAS 补上约束 DDL，四步重建对 vec0 依然行不通。

### 数据实锤

生产库 `sqlite_master` 取证（迁移后）：

```sql
CREATE TABLE "embedding_tasks"( entry_id TEXT, attempts INT, ... );   -- 无 PRIMARY KEY
CREATE TABLE "memory_fts_jieba"( memory_entry_id, content );          -- 应为 USING fts5(...)
CREATE TABLE "memory_vec"( memory_entry_id, embedding );              -- 应为 USING vec0(...)
```

行数据完好（四表均无重复键），结构全毁。生产库已手工按 schema.ts 权威 DDL 重建四表并回填
（FTS5/vec0 原样插回，vec0 shadow 表手工改名对齐），`foreign_key_check` 0 违规，服务恢复。

**测试为何没拦住**：既有迁移测试只断言数据不断言结构；且测试库未加载 sqlite-vec，
memory_vec 不存在，remap 对 vec 路径直接跳过——两个盲区叠加，全绿通过。

## 方案设计

### 技术方案

卫星表换键从「CTAS 重建 + swap」改为**原地 DELETE+INSERT**：按 idMap 分批
`SELECT ... WHERE key IN (...)`（500/批防超 SQLITE_MAX_VARIABLE_NUMBER），
逐行 DELETE 旧键 + INSERT 新键。只触及换键行（9181），表结构零改动，
天然兼容普通表 / FTS5 / vec0。

新键与存量行撞主键时 INSERT 抛出、事务回滚——与迁移既有 occupied 预检同哲学：
提前炸不留半状态库（备份可回放）。

附带收益：不再全表复制 memory_vec 的 32k × 4KB 向量 blob（约 132MB）。

swapRebuiltTables 中为旧重建方案兜底的
`CREATE INDEX IF NOT EXISTS idx_embedding_tasks_status_retry` 一并移除
（embedding_tasks 不再被 drop，索引由 schema 初始化保证）。

### 目标

- T1: 迁移后四张卫星表结构与 schema.ts 权威 DDL 一致（PK / 虚拟表形态不丢）
- T2: 迁移后 enqueueRetry 的 ON CONFLICT 写入路径可用（生产崩溃点）
- T3: 迁移后 FTS5 MATCH / vec0 KNN 功能可用
- T4: 数据行为与旧实现等价（键跟随、幂等），既有测试不回归

### 成功标准

新增回归测试覆盖 T1-T3（含加载 sqlite-vec 的 vec0 路径），既有 F20260915midu
迁移测试 31 项全绿。

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | T1/T2 | 双 ID 存量库跑 migrateDatabase，查 sqlite_master + 试 ON CONFLICT 写入 | embedding_tasks/memory_weights 保留 PRIMARY KEY，ON CONFLICT 不炸 |
| AT-2 | T3 | 同上，FTS5 MATCH 查询；加载 vec 的库 KNN 查询 | fts_jieba 仍是 fts5 虚拟表且 MATCH 命中；memory_vec 仍是 vec0 且 KNN 返回换键后新 id |
| AT-3 | T4 | 跑既有 F20260915midu 迁移测试套件 | 31 项全绿 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1~3 | n/a（A 类纯代码逻辑，单测覆盖） |

## 实现细节

### 代码修改

- `remapKeyedTable`：签名 `remap: (id) => string` → `idMap: Map<string, string>`；
  实现由 CTAS 重建改为分批 SELECT + 逐行 DELETE/INSERT 原地换键；
- 4 个调用点改传 idMap（remap 函数仍由 rebuildEntriesAndEdges 使用）；
- `swapRebuiltTables` 移除 embedding_tasks 索引兜底行；
- 头注「级联表处理」段更新为新机制与生产现场根因。

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/db/migration.ts | 修改 | remapKeyedTable 原地换键化 + 注释更新 |
| tests/frameworks/db/migration.test.ts | 修改 | 新增 2 个回归测试（结构保持 + vec0 KNN） |

## 验收结果

### 测试结果

- `npx vitest run tests/frameworks/db/migration.test.ts`：31 passed（含 2 新增回归）
- `npx vitest run tests/frameworks/db/`：27 文件 256 passed
- `npx tsc --noEmit`：无错误
- 生产库手工修复后：`scripts/otter-buddy.sh start` 成功，localhost:3000 / /api/settings 均 200，
  日志越过原崩溃点（EmbeddingRetryWorker started）

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 结构不丢 | 回归测试断言 sqlite_master DDL 含 PRIMARY KEY / fts5 / vec0 | ✅ |
| T2 ON CONFLICT 可用 | 回归测试功能探针 + 生产服务恢复 | ✅ |
| T3 FTS/vec 可用 | 回归测试 MATCH/KNN 探针 + 生产库手工验证（48 hits / KNN d=0 自匹配） | ✅ |
| T4 行为等价 | 既有 31 项迁移测试全绿 | ✅ |

## 设计决策

- **原地换键优于修复 CTAS 重建**：给 CTAS 补约束 DDL 仍救不了 vec0（RENAME 不跟随
  shadow 表），且全表复制大 blob 浪费。原地 DELETE+INSERT 只触及换键行，对三种
  表形态（普通/FTS5/vec0）统一成立。
- **撞键即炸**：新键与存量行冲突时不做 OR REPLACE 静默合并——与迁移既有
  occupied 预检同哲学，异常数据宁可回滚也不留半状态库。
