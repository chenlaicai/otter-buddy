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
- T2: **现有全部调用路径下行为等价**（对抗审视后将"行为零变更"降级为此措辞——见审视记录的两处语义级差异）
- T3: 主文件 964 → ~720 行，edges/队列独立可测

### 范围决策

**MemoryRepository port 三分（检索/写入/队列）推迟到批次 3**：port 拆分要与 agent runtime 拆解的 port 架构统一设计（消除双 AgentInvokePort、port 位置统一），单独先行会造成二次返工。本批不动 port。

**新模块导出裸 db 函数（二轮审视明示的取舍）**：memory-edge-queries / embedding-task-queue 以 `(db, ...) => ...` 纯函数形式导出——旧代码这些 SQL 是 repo 类的 private 方法，编译期不可绕行；拆出后"防绕行"从编译期保证降级为约定（任何代码都可 import 裸函数直接操作 db，绕过 usecase 层校验）。当前全库仅 repo 一处 import。接受理由：与同目录 framework 模块风格一致、可独立测试；批次 3 port 架构统一时一并收敛。

## 验收结果

### 测试结果

- `npx eslint .` 0 error 0 warning（移除 1 条失效的 max-lines-per-function disable）
- `npx tsc --noEmit` 通过
- 全量 vitest：101 文件 / 1207 测试通过（含 tests/frameworks/db/memory + tests/usecases/memory 10 文件 125 用例——覆盖 storeEntry/deleteBySource/replace* 的联动删除语义、edges 语义、任务队列退避）

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1 唯一实现（运行时路径） | repo 内 grep 确认 DELETE FROM memory_fts 等仅出现在 cascadeDeleteSatellites；INSERT INTO memory_entries 仅出现在 insertEntryRow。**二轮审视修正：`migration.ts` rebuild 迁移路径存在历史第二份级联删除 copy（一次性补丁，不 import 运行时 repo 代码），已加交叉引用注释提示两处同步**；edges 删除的 IN 批量变体（deleteEdgesByEntryIds）与逐行变体（cascade 内）语义同族、签名不同，保留 | ✅（修正后措辞） |
| T2 行为等价 | 现有调用路径下未发现可触发差异（对抗审视逐项推演）；拆出模块 SQL/参数逐字迁移 | ✅ |
| T3 文件收敛 | 964 → 724 行；memory-edge-queries.ts（130 行）/ embedding-task-queue.ts（90 行）独立 | ✅ |

## 对抗审视记录

独立 agent 对抗审查结论：**现有调用路径下未构造出可触发的行为差异**，但"行为零变更"不严格成立，两处语义级差异（均已确认方向为改进或无触发路径，接受不改）：

1. **嵌套事务契约放宽（潜伏）**：旧手写 `BEGIN` 在外部事务内调用会抛 `cannot start a transaction within a transaction`；better-sqlite3 的 `transaction()` 在 `db.inTransaction` 时降级为 SAVEPOINT 静默成功。核查全部调用点：无任何路径在外部事务内调用 memory repo 方法，当前不可触发；若未来出现嵌套调用，savepoint 语义是期望行为。
2. **IO 类错误上抛身份（方向为修复）**：SQLite 致命错误（SQLITE_FULL/IOERR 族）自动回滚后，旧版无条件 ROLLBACK 会抛第二个错误覆盖原始错误；新版有 `inTransaction` 守卫，原始错误正确上抛。

审视确认无问题的攻击面：replaceEntryBySource 级联中 edges DELETE 确为 no-op（自环被 schema CHECK 约束排除、UPDATE 原子覆盖所有引用、新 UUID 不撞 UNIQUE）；BEGIN 默认 DEFERRED 与手写一致；双重分词为纯函数仅性能开销；拆出模块 SQL/参数逐字一致无循环依赖。

**审视发现的测试盲区（已补）**：replaceEntryBySource 的多旧行分支（审视三轮 #2 的关键防御，原零覆盖）补用例"多旧行只重定向第一行的边，其余行及其边删除"。事务回滚路径仍无直接测试（改动前后均无，等价性依赖事务包装库自身语义，接受）。

### 二轮审视记录

第二轮攻击一轮审查的盲区，结论维持"行为等价"，新增发现与跟进：

1. **【中·文档级】T1 证据声明不实（已修正）**：一轮声称"DELETE FROM memory_fts 仅出现在 cascadeDeleteSatellites"——实际 `migration.ts:429` rebuild 迁移路径还有一份历史 copy（本次 PR 之前已存在，非行为回归）。已在 migration.ts 加交叉引用注释（新增卫星表两处同步），T1 证据行措辞修正。
2. **【低·潜伏】新模块导出裸 db 函数**：防绕行从编译期降级为约定（见范围决策）。当前全库仅 repo 一处 import。
3. **prepare 开销**：better-sqlite3 无语句缓存，但新旧版在循环内逐条 prepare 的次数完全相同（等价）；将 4 条语句 hoist 到事务开头是 missed opportunity，留待后续。
4. **补测的 flaky 质疑不成立**：多旧行测试断言置换不变（无论哪行是 index=0，终态恒为"恰 1 条边指向新行"）；且测试数据恰为历史 UNIQUE 崩溃触发器（同 from 同 type 不同 to），两个方向的回归（全重定向/全删边）都会被抓住。

## 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/db/memory/sqlite-memory-repository.ts | 修改 | 去重 + 事务包装 + 委托 |
| src/frameworks/db/memory/memory-edge-queries.ts | 新增 | edges 图查询（自 repo 原样迁移） |
| src/frameworks/db/memory/embedding-task-queue.ts | 新增 | embedding 重试任务队列（原样迁移） |
| src/frameworks/db/migration.ts | 修改 | 二轮审视：级联删除历史 copy 处加交叉引用注释 |
| tests/frameworks/db/memory/memory-edges.test.ts | 修改 | 对抗审视补测：多旧行边重定向/删除分支 |
