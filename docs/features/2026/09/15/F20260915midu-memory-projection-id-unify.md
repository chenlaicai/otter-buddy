---
id: F20260915midu
title: 记忆投影 ID 统一：投影条目主键复用 source_id，消灭双 ID（#942）
summary: 实现 #942——记忆系统是「业务真相源 + 记忆投影」两层，投影条目曾另生成 UUID 作主键、仅以 source_id 回指源实体，导致同一实体双 ID：create_linked_resource 返回的资源 ID 在 link_memory 校验（getById 直查 memory_entries）中命中不了投影条目，资源类节点永远没有边。完整修复：可统一类投影（message / linked_resource / fact / feature / research / signals-fact）主键 = source_id；chunk 类保持随机 UUID（1:N + D3 禁边）；signals-fact 因源表 INTEGER PK 碰撞豁免统一并落成文档化决策。含存量迁移（内存表重建框架，级联 edges/weights/FTS/vec/embedding_tasks 复制，幂等）。
change_type: refactor
capability_test: "n/a: 纯运行时存储层逻辑（非 prompt/skill/协议层软代码），单测锁定 ID 生成规则与迁移幂等/级联复制行为"
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
created_at: 2026-09-15
tags: [memory, data-model, migration, graph, id-unification]
modules:
  - src/usecases/memory/store-memory.ts
  - src/frameworks/db/migration.ts
  - tests/usecases/memory/store-memory.test.ts
  - tests/frameworks/db/migration.test.ts
---

# 记忆投影 ID 统一（#942）

## 背景与根因

发现现场：PR #939 开发獭过程发现——`create_linked_resource` 返回资源 ID，`link_memory` 对它建边报 entry not found。

记忆系统是「业务真相源 + 记忆投影」两层：messages(entries)/linked_resources/features/research/signals 各自是真相源，`memory_entries` 是跨域统一召回的投影层。投影条目在 `store-memory.ts` 另生成 UUID 作主键、仅在 `source_id` 字段回指源实体——**同一个实体两个 ID**。`link_memory`（create-edge.ts）按 ID 直查 memory_entries，拿源实体 ID 命中不了投影条目 → 资源/文档类节点在记忆图谱里永远没有边，「讨论 produced 资源」的关系链拼不完整。

实证（迁移前 DB）：资源 fcac2c75 的投影条目是 fd629cf3；全库 26539 条投影 `id != source_id`。

**架构决策（搭档 2026-09-15 拍板）**：记忆数据边界 = memory_entries 投影层；方向为**完整修复（ID 统一）**，不做止血小修（「小改动一时爽，长期系统只会变成一堆屎山」）。本文档即该架构决策的记录。

## 设计

### 一、为什么双 ID 是错的

投影模式（业务真相源 + 投影层）本身合理——各业务域自治换来灵活性。但投影设计时把「召回」接通了、把「关系」漏接了：search_memory 能按 ID 定位投影，link_memory 却不能。双 ID 的认知负担（「同一个东西哪把钥匙是对的」）随调用面扩大持续收税。统一后：图谱、检索、产物清单、工具层全部用同一把钥匙。

### 二、统一规则（store-memory.ts）

`execute` / `replaceBySource` 的条目主键从「恒 `crypto.randomUUID()`」收敛为：

```ts
private generateId(sourceTable: string, sourceId: string): string {
  return sourceTable === "signals" ? crypto.randomUUID() : sourceId;
}
```

- **可统一类（id = source_id）**：`messages`（消息投影）、`linked_resources`（含 fact）、`features`、`research`——生产 DB 实证四类源主键均为 TEXT UUID 格式，零冲突。
- **豁免统一类（保持随机 UUID）**：
  - **`signals`**：signals 表主键是 INTEGER AUTOINCREMENT，upsert 复用机制导致 1:N（一条信号记录 critical 次数累计投影多条 fact，生产实证 13868 条 fact 仅对应 122 个 distinct signal id）。直接统一会让「signal#126 的第 2 次投影」与「signal#5 的第 521 次投影」主键互撞（撞的还是整数文本「126」「5」，与 UUID 命名空间格格不入）。修根（投影带 critical 序号或改信号表）超出本特性边界，保持随机 UUID 并将该豁免落成文档化决策——此为有意识的边界，不是漏接。
  - **chunk 类（feature_chunk/research_chunk）**：一个文档 N 个 chunk 共享同一 source_id，主键不能直接用 source_id。候选方案「复合 ID（source_id:chunk_index）」被否：chunk 本来就禁止建边（create-edge.ts D3——sync replaceEntriesBySource 删旧建新会让边静默丢失），统一 ID 无收益反而引入新格式；且 replaceChunksBySource 每次重建全部 chunk，稳定 ID 会被立即替换。保持随机 UUID。

### 三、调用面影响（零调用方改动）

- `StoreMemory.execute` / `replaceBySource` 返回值：此前返回新 UUID，现在返回 source_id。所有调用方（bootstrap/memory.ts 各投影点、signal-pipeline.ts）都不消费返回值，零改动。
- `replaceEntryBySource`（sqlite-memory-repository.ts）的边重定向逻辑：feature/research reindex 时新条目 id == 旧条目 id（同 source_id），UPDATE memory_edges 变成 no-op——语义自动正确（边天然保留），无需改动。
- 写入幂等性变化：同 source 重复 `execute`（理论上的重试场景）此前插两条，现在撞 PRIMARY KEY 抛错。实证现状无此调用（消息只索引一次、资源创建一次），语义上「同 source 唯一投影」恰是本特性要确立的契约。

### 四、存量迁移（migration.ts：`rebuildMemoryEntriesUnifyIds`）

迁移 26539 条 `id != source_id` 的可统一类投影（chunks 与 signals-fact 不动）。

**方案选型**：SQLite 无法直接 UPDATE 被 FK 引用且被多卫星表以「字符串键、非 FK」方式引用（FTS5/vec0 虚拟表）的主键。采用**内存表重建框架**（ FOREIGN_KEYS=OFF 单事务）：

1. 快照需迁移的 (oldId → newId=source_id) 映射（仅 source_table IN messages/linked_resources/features/research）
2. `CREATE TABLE memory_entries_new`（schema 从 sqlite_master 提取原 DDL 改名，保持单一真相源）
3. `INSERT SELECT`：映射命中则 id 替换为 source_id，否则原样（chunks/signals 豁免行原样进入）
4. 卫星表逐张处理（都先 `_new` 后 swap）：
   - `memory_edges`：from/to 经映射替换，**插入前去重**（UNIQUE(from,to,type)——两条不同旧边统一后可能同键，如 feature reindex 历史脏数据产生的重复边；重复者后者丢弃）。实测：72 边 → 68 边（4 条重复丢弃）
   - `memory_weights`：key 替换
   - `memory_fts_jieba`：key 替换（FTS5 内容列原样复制，不需重建分词）
   - `memory_vec`：key 替换（无需重跑 embedding，走现成数据复制而非 retry worker——比 issue 原方案「清 vec 让 worker 补」更省事且无暗化窗口）
   - `embedding_tasks`：key 替换（12 条 pending 任务不丢）
5. DROP 旧表 → RENAME `_new` → 重建索引
6. `foreign_key_check` 兜底（失败抛错回滚）

**幂等**：`SELECT COUNT(*) WHERE id != source_id AND source_table IN (...)` == 0 即返回。重复执行零变化。

**FK 处理**：`PRAGMA foreign_keys=OFF`（better-sqlite3 在事务外设置），结束后恢复 ON 并 `foreign_key_check`。`PRAGMA defer_foreign_keys` 无法回避 UPDATE 主键的 immediate 约束（仅 defer 到 commit，仍冲突），故选重建方案。

**备份**：主库真实迁移由搭档合入后择机执行，执行前手工 `cp data/otter-buddy.db data/backups/`（data/backups/ 已有先例）。迁移函数本身幂等、失败即回滚（单事务）。

### 五、影响面评估逐类结论

| 投影类 | 源主键形态 | 统一决策 | 存量 |
|---|---|---|---|
| message（messages 表投影） | UUID 文本（指 entries.id） | 统一 | 8068 条迁移 |
| linked_resource / fact（linked_resources） | UUID 文本 | 统一 | 506 条迁移（314+192） |
| feature / research（文档 summary） | F-ID 文本 | 统一 | 562+13 条迁移 |
| feature_chunk / research_chunk | 共享文档 ID（1:N） | 不统一（随机 UUID） | 不动 |
| fact（signals 表投影） | INTEGER AUTOINCREMENT（1:N） | 不统一（豁免，见上） | 不动 |

## 验证

- 单测（store-memory.test.ts）：execute/replaceBySource 对 messages/linked_resources/features/research 返回并落库 id == source_id；signals 保持随机 UUID；replaceChunksBySource 保持随机 UUID。
- 迁移测试（migration.test.ts）：构造含 edges/weights/FTS/embedding_tasks 的小库 → 迁移后 id 统一、边重定向、卫星表键复制、幂等（二次执行零变化）。
- 生产库演练：备份副本上跑迁移，26539 → 0 条 `id != source_id`（可统一类），edges 72→68（4 重复边去重），`foreign_key_check` 通过，召回回归（FTS/vec 双路）不倒退。
- 已过最简检查：ID 生成收敛为单点函数；迁移复用内存表重建（仓库内 messages→entries 迁移同模式先例），无新依赖。
