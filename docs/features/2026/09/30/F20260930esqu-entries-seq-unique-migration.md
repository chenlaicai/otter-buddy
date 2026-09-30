---
id: F20260930esqu
title: "entries 表 (conversation_id, sequence_num) 唯一约束加固：普通索引升级 UNIQUE + 存量库幂等迁移"
summary: "issue #906：entries 表序号刻度只有应用层防线（createEntryAtomic 的 INSERT ... SELECT MAX+1），无数据库级最后防线。本变更新库 schema 直建 UNIQUE 索引 + 存量库幂等迁移（判存→重复检查兜底→事务内 DROP+CREATE UNIQUE），重复数据时告警跳过不阻断启动。生产库已验证 0 重复（2026-09-30 大獭实测），可直建。"
change_type: fix
capability_test: "n/a: 纯 DB 层约束加固，无 prompt/skill 行为触发语义；验证走迁移单测（entries-seq-unique-migration.test.ts 6 用例）+ 等价性守卫 + 生产副本 alpha 真启动"
created: 2026-09-30
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
intent:
  problem: "entries 表有 idx_entries_conversation_seq 普通索引但无 UNIQUE 约束——createEntryAtomic 在 SQLite 单写锁下正确，但任何绕过原子插入的写路径（直接 SQL/未来批量导入器）可静默写入重复 seq，破坏序号刻度语义（对比 turns 表退役前有 idx_turns_conversation_number 唯一约束）。"
  expected_effect: "新库直建 UNIQUE；存量库启动时自动升级；重复数据兜底告警跳过（不阻断启动）；应用层原子插入路径行为不变。"
  verify_by:
    type: behavior_check
modules:
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - tests/frameworks/db/entries-seq-unique-migration.test.ts
  - tests/frameworks/db/backfill-entry-memory-index.test.ts
  - tests/usecases/conversation/resume-interrupted-service.test.ts
causal_links:
  - "#906"
tags:
  - db
  - migration
  - conversation
---

# entries 表 (conversation_id, sequence_num) 唯一约束加固

## 问题与目标（issue #906）

**现象**：entries 表序号列有普通索引 `idx_entries_conversation_seq`（schema.ts:953）但无 UNIQUE 约束。

**风险**：`createEntryAtomic`（sqlite-entry-repository.ts:129，INSERT ... SELECT COALESCE(MAX)+1）在 SQLite 单写锁下正确，但这是应用层唯一防线——数据库层不拦重复。历史上 turns 表的对应刻度列有 `idx_turns_conversation_number` 唯一约束（后随 turn 系统退役删除），entries 取而代之后反而欠了这笔账。

**目标**：补齐数据库级最后防线，不改变任何现有合法路径行为。

## 设计取舍

### 机制识别检查点（issue 驱动未经 RA，必做）

逐项核对 troubleshooting 清单：

- 新增配置字段/枚举/开关：**否**
- 新增状态生命周期：**否**
- 新增定时任务/后台进程：**否**
- 新增信号类型/消息格式：**否**
- 新增持久化存储（表/字段/文件）：**边缘命中**——不是新表/新字段，是既有索引的属性升级（普通→UNIQUE）。表结构（列集合、类型、行数据）零变化。
- 新增决策分支（结果被记住并影响后续行为）：**否**——迁移分支是一次性启动路径，不产生被记住的运行时决策。
- 新增跨模块调用路径：**否**

**结论：命中 2 项但均为边缘形态，无净新增机制**——索引升级是既有约束的属性加固（该二元组语义上本就该唯一），迁移函数是 migration.ts 既有子迁移模式（判存→执行→日志）的实例化，无新决策语义、无新状态、无新接口。走修法决策树①（既有语义内修）：序号刻度语义自 F20260913ctlv 建表起就是「单对话单调递增无重复」，UNIQUE 约束只是把这条既有语义从应用层约定升格为数据库级保证。Modification-Class: `narrow-fix`。

### 核心设计决策

1. **新库直建 UNIQUE**（schema.ts:953 一行改动）——新库不经历中间形态。
2. **存量库幂等子迁移** `ensureEntriesConversationSeqUnique`：
   - 判存：`PRAGMA index_list('entries')` 查 unique 标志，已 UNIQUE 直接返回（新库 initSchema 后跑迁移也命中此分支，天然幂等）
   - 防御双保险：建索引前 GROUP BY HAVING 查重复，发现重复则 `logger.warn`（含定位信息：conversation_id + sequence_num + 重复数）并跳过。**不抛错阻断启动**——生产已验证 0 重复（2026-09-30，31596 行，大獭实测），这是兜底不是主路径；放行旧行为比阻断启动安全。跳过后人工清洗完毕再次重启即自愈升级（有测试锁定该闭环）
   - 执行：事务内 `DROP INDEX IF EXISTS` + `CREATE UNIQUE INDEX`（SQLite 无 ALTER INDEX；裸 exec 在 DROP 后 CREATE 前中断会丢失查询索引——同 #608 rebuildAttachmentsKindCheck 的检视发现 1 模式）
3. **rebuildEntriesWithoutTurnId（migration.ts:670）故意保持普通索引**：turn 退役重建路径若建 UNIQUE，含重复 seq 的存量库会在重建中抛错阻断 turn 退役——防御兜底被上游击穿。重建完成后由末尾的 ensureEntriesConversationSeqUnique 统一升级（migrateDatabase 内 retireTurnSystem 先于本函数执行）。此处加了代码注释防止后人「顺手统一」。

### 被否方案

- **直接在 schema.ts 改 UNIQUE、不动 migration.ts**：被否——等价性守卫虽只查表集合，但存量库永远跑不到 initSchema 的 CREATE 分支，索引永不升级，改动对生产库无效。
- **重复时抛错阻断启动**：被否——生产已验证 0 重复，抛错路径永远不该走到；真走到时（未知的数据事故现场）阻断启动会把「数据有重复」升级成「服务不可用」，放行旧行为 + 告警让人来清洗更安全。
- **CREATE UNIQUE INDEX OR REPLACE（SQLite 不支持）**：语法不存在，天然排除。

## 实现记录

| 文件 | 改动 |
|---|---|
| src/frameworks/db/schema.ts:953 | `CREATE INDEX` → `CREATE UNIQUE INDEX IF NOT EXISTS` |
| src/frameworks/db/migration.ts:191-194 | migrateDatabase 末尾追加 ensureEntriesConversationSeqUnique 调用 |
| src/frameworks/db/migration.ts:2027-2062 | 迁移函数本体（判存/兜底/事务重建） |
| src/frameworks/db/migration.ts:674-676 | rebuildEntriesWithoutTurnId 内注释（保持普通索引的意图说明） |
| tests/frameworks/db/entries-seq-unique-migration.test.ts | 新增 6 用例（见下） |
| tests/frameworks/db/backfill-entry-memory-index.test.ts | 夹具适配（见「负面向」） |
| tests/usecases/conversation/resume-interrupted-service.test.ts | 夹具适配（见「负面向」） |

### 测试覆盖（6 用例）

1. 新库：initSchema 后索引即 UNIQUE
2. 老库模拟：普通索引库跑迁移后变 UNIQUE + 重复 seq 插入被数据库拒绝（约束真实生效）
3. 老库含存量数据：迁移后数据完整（行数不变）
4. 幂等：跑两次不报错
5. 重复数据兜底：迁移跳过不抛错 + 告警日志含定位信息
6. 自愈闭环：兜底跳过后人工清洗完毕，再次启动自动补上 UNIQUE

## 验证

### 单测与守卫

- 新迁移测试：6/6 通过
- tests/frameworks/db/ 全量：279/279 通过（含 #506 等价性守卫——schema.ts 与 migration.ts 两处改一致的机制验证）
- 仓库全量：4346/4346 通过
- tsc --noEmit：0 错误；eslint：0 问题

### 生产副本真启动（db 迁移类硬规则）

1. 备份：`sqlite3 -readonly data/otter-buddy.db ".backup '~/.otter/alpha/c5289593/otter-buddy.db'"`（一致性备份含 WAL 快照，934MB / 31667 行 entries / 0 重复组）
2. 完整启动：`scripts/alpha.sh start`（worktree 构建 + 生产库副本 + 独立端口 3166）
3. 关键日志行：`[ensureEntriesConversationSeqUnique] Upgraded idx_entries_conversation_seq to UNIQUE (#906, F20260930esqu)`（level 30）
4. 服务健康：`/api/settings` 200 OK；全日志 `SqliteError` 计数 = 0
5. 迁移结果：`PRAGMA index_list('entries')` → `idx_entries_conversation_seq` unique=1；entries 行数 31672（迁移前后数据完整，行数差 5 来自 alpha 实例启动自身写入的 system 条目）
6. 幂等复验：stop → start（--quick）二次启动，迁移日志仅 1 条（判存直接返回）、无 SqliteError、索引保持 UNIQUE

### pre-existing 声明

alpha 启动日志有一条 level 50：`Patrol duty failed: scheduler-reconcile — Cannot access 'schedulerService' before initialization`（app.ts:257 闭包引用 325 行初始化变量的 TDZ 时序问题）。**pre-existing 证据**：主仓生产日志 `data/logs/otter-buddy.log` 存在同型错误（时间戳 1789518302818 ≈ 2026-09-16，早于本变更 base 1309df0f），与本次 diff 零交集（不含 app.ts）。另附 stash 基线：`git stash -u` 后两个改动测试文件 15/15 通过（证明其余失败源于本变更的约束收紧而非存量缺陷）。

### 最简实现检查

是——核心改动 3 处（schema 一行、迁移函数 36 行、调用 4 行），测试夹具适配 2 处（造数从硬编码 seq 改 MAX+1）。无多余抽象、无配置项、无新依赖。

### 负面向验收条目（本次变更破坏了什么旧契约）

1. **「同 conversation 任意 seq 重复写入」的隐性宽容被移除**：旧普通索引下任何绕过 createEntryAtomic 的写路径（直接 SQL、测试造数、未来导入器）写重复 seq 会被数据库拒绝（UNIQUE constraint failed）。全量测试扫描证实受影响的只有 2 个测试文件的造数夹具（均已改为 MAX+1 原子写法，断言零改动）；生产代码无直接 INSERT 重复 seq 的路径（全部经 createEntryAtomic/createEntriesAtomicBulk）。
2. **两个测试夹具被迫暴露真面目**：backfill-entry-memory-index.test.ts 的 insertEntry（全 conversation seq 恒 1）与 resume-interrupted-service.test.ts 的 seedInterrupted（healing 落账测试 seed 两次同 seq）——旧普通索引下这些偷懒造数合法，恰是 #906 指出的防线缺口的实证。修法为夹具适配（MAX+1，与生产原子插入同款语义），断言本体零改动。
3. 兜底跳过路径是有意保留的旧契约：重复库不升级 UNIQUE（保留旧行为），靠告警 + 人工清洗 + 重启自愈。

### Golden Gate 与锚点重放豁免声明

- Golden Gate：本变更不涉及软代码（纯 DB 层索引属性）——豁免。
- 锚点重放评审：本变更无 prompt/skill 行为触发语义——豁免。

## 风险与反对意见

- **重复数据真实存在的场景**（生产验证之外的未知库，如用户本地旧副本）：迁移跳过 + 告警，行为与升级前一致，无回归。
- **写放大**：UNIQUE 索引与原普通索引同为 B-tree，写入成本不变。
- **backup/恢复路径**：索引随库文件整体备份/恢复，无特殊处理需求。

## 关联

- issue #906（本变更关闭其主体诉求）
- 模式参考：#608 rebuildAttachmentsKindCheck（事务内 DROP+RENAME 模式）
- 等价性守卫：tests/frameworks/db/migration-equivalence.guard.test.ts（#506）
