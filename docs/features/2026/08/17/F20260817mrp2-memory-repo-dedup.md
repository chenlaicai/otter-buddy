---
id: F20260817mrp2
title: memory-repo-dedup
doc_type: feature

summary: |
  sqlite-memory-repository 内部去重重构：级联删除 ×4、完整插入 ×3、FTS 检索 SQL ×2
  收敛为唯一实现（cascadeDeleteSatellites / insertEntryRow / searchFtsJiebaRows），
  8 处手写 BEGIN/COMMIT 换 db.transaction 包装，edges 图查询与 embedding 任务队列
  拆为独立模块。行为零变更，MemoryRepository port 不动。

causal_links:
  from:
    - F20260814qswp

status: implemented
change_type: refactor
tags: [memory, database, refactor]
modules:
  - src/frameworks/db/memory/sqlite-memory-repository.ts
  - src/frameworks/db/memory/memory-edge-queries.ts
  - src/frameworks/db/memory/embedding-task-queue.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260817mrp2: memory repo 级联/插入/检索去重

## 背景与需求

### 问题描述

架构检视（F20260814qswp 批次规划）发现 sqlite-memory-repository.ts（964 行）存在三类机械重复：

1. **级联删除 6 条 DELETE 逐字重复 4 次**（deleteBySource / replaceEntryBySource / replaceEntriesBySource / deleteBySourceAndType）：fts + fts_jieba + vec? + weights + embedding_tasks + edges。历史上每次加卫星表都被迫改 4 处（F20260812mrcq Part 1、F20260813mren 的注释可证）；讽刺的是 `deleteEdgesByEntryIds` 批量版已存在却未被这些路径复用。
2. **完整插入四联逐字重复 3 次**（storeEntry / replaceEntryBySource / replaceEntriesBySource）：entries + fts + fts_jieba + weights。
3. **searchFTS 与 searchFTSWithHighlight 的 SQL 逐字相同**（仅返回类型不同，`me.*` 本就含 content）。
4. 8 处手写 `BEGIN/COMMIT/ROLLBACK`（约 80 行噪音），而 better-sqlite3 的 `db.transaction()` 是更可靠的等价物。

### 根因分析

repo 承载了 5 种正交职责（entry CRUD / FTS+vec 检索 / 权重 / embedding 任务队列 / edges 图），新增卫星表时"逐处补丁"模式没有收敛点——重复不是一次性偷懒，是缺少唯一写入/删除路径的结构性症状。

## 方案设计

- `cascadeDeleteSatellites(rowId)`：6 条级联 DELETE 的唯一实现，4 个删除路径全部改调。replaceEntryBySource 中边的重定向/删除在级联前已完成，其 edges DELETE 为无害 no-op（注释说明）。
- `insertEntryRow(entry)`：完整插入四联的唯一实现，3 个写入路径改调。
- `searchFtsJiebaRows(query, filters)`：jieba FTS 检索 SQL 唯一实现，searchFTS/searchFTSWithHighlight 仅做结果映射。
- `runInTx(fn)`：`db.transaction(fn)()` 包装，替换 8 处手写事务。
- edges 查询拆至 `memory-edge-queries.ts`（7 个函数），embedding 任务队列拆至 `embedding-task-queue.ts`（4 个函数）——repo 方法变一行委托，port 接口与调用方零改动。

### 目标

- T1: 卫星表级联删除/完整插入各只有一份实现——新增卫星表只改一处
- T2: 行为零变更（既有 125 个 memory 相关测试全绿）
- T3: 主文件 964 → ~720 行，edges/队列独立可测

### 范围决策

**MemoryRepository port 三分（检索/写入/队列）推迟到批次 3**：port 拆分要与 agent runtime 拆解的 port 架构统一设计（消除双 AgentInvokePort、port 位置统一），单独先行会造成二次返工。本批不动 port。

## 验收结果

### 测试结果

- `npx eslint .` 0 error 0 warning（移除 1 条失效的 max-lines-per-function disable）
- `npx tsc --noEmit` 通过
- 全量 vitest：101 文件 / 1207 测试通过（含 tests/frameworks/db/memory + tests/usecases/memory 10 文件 125 用例——覆盖 storeEntry/deleteBySource/replace* 的联动删除语义、edges 语义、任务队列退避）

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 唯一实现 | grep 确认 DELETE FROM memory_fts 等仅出现在 cascadeDeleteSatellites；INSERT INTO memory_entries 仅出现在 insertEntryRow | ✅ |
| T2 行为零变更 | 全量测试通过；重构为纯方法提取+委托，无 SQL 变更 | ✅ |
| T3 文件收敛 | 964 → 724 行；memory-edge-queries.ts（130 行）/ embedding-task-queue.ts（90 行）独立 | ✅ |

## 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/db/memory/sqlite-memory-repository.ts | 修改 | 去重 + 事务包装 + 委托 |
| src/frameworks/db/memory/memory-edge-queries.ts | 新增 | edges 图查询（自 repo 原样迁移） |
| src/frameworks/db/memory/embedding-task-queue.ts | 新增 | embedding 重试任务队列（原样迁移） |
