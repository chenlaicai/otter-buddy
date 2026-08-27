---
id: F20260827mgux
title: initSchema 幂等复用根治新表漏登——誊抄消灭与老库等价性守卫（#506）
summary: |
  新表漏登 migrateDatabase 已四次发生（第四次：search_query_logs 被埋点吞错静默丢数据），
  根因是「同构 DDL 两处誊抄」。实现：bootstrap 无条件跑幂等 initSchema 消灭誊抄机会，
  删除 migration.ts 中 6 个誊抄 ensure 函数及 1 段内联 CREATE（净 -200 行），
  新增表级等价性守卫测试防退化（8/5 基线夹具），第 4 案随机制自动修复。
change_type: refactor
status: implemented
created_in_conversation: 02e892ea-b291-4108-bacf-0d6148790511
tags: [database, migration, idempotent-schema, guard-test, single-source-of-truth]
modules:
  - src/bootstrap/database.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - tests/frameworks/db/
from: ["#506"]
---

# F20260827mgux: initSchema/migrateDatabase 漏登机制性根治

> 状态：**已实现**（本文档由设计稿升级为实现记录）。关联 issue：[#506](https://github.com/…)

## 背景

搭档（chen，issue #506 原文）：

> 「新表建表只写进 `initSchema`、漏了 `migrateDatabase` 老库升级路径」这一同型缺陷已经**第三次发生**……约定只存在于 `migration.ts` 的注释里，对写新特性的人没有任何强制力。

历史三案 + 本次核查新发现一案：

| 次序 | 特性 | 缺表 | 后果 | 发现方式 |
|------|------|------|------|----------|
| 1 | F20260821evaf | `embedding_meta` | `getEmbeddingMeta` 抛 no such table，版本锚静默失效 10 天 | 事后排查 |
| 2 | F20260824rhib | `health_snapshots` / `signals` | server 集成后写入直接 no such table | 集成即爆 |
| 3 | F20260826mwrd + rsme | `signal_events` / `restart_pending_resumes` | halt 落账炸裂；孤儿跨重启永久残留（#505 修复） | 事后排查 |
| **4（新发现）** | F20260826rcmm（PR #482，8/26） | **`search_query_logs`** | 埋点 INSERT 抛 no such table，被 `clients.ts:39` 的 `.catch(() => undefined)` 静默吞掉——**未爆雷但评估埋点数据在存量库上静默丢失** | 本次方案核查（机械比对两文件 CREATE TABLE 集合） |

第 4 案证明 issue 的判断成立：这不是个别疏忽，是结构必然——只要誊抄模式存在，漏登会继续发生，且 fire-and-forget 类消费方会让它**静默无声**。

### 结构根因（代码事实）

1. **两条建库路径分叉于 8/5**：F20260805codx（PR #155）把「无条件 initSchema」改成 `if (isNewDb) initSchema else migrateDatabase` 互斥分支。此后老库只依赖 `migrateDatabase` 的手工 `ensureXxxTable` 补建。
2. **ensure 函数 = 手工誊抄**：migration.ts 里 6 个 `ensureXxx` 函数（signal_events:129 / restart_pending_resumes:162 / RHI 两表:186 / embedding_tasks:281 / embedding_meta:299 / memory_edges:318）的 DDL 与 schema.ts 同构（PR #505 审视时做过逐列机械比对确认一致），另有 `migrateMessageSegments` 内 1 段 message_segments 的 CREATE 与 `migrateDatabase` 函数体内 otter_configs 的 CREATE（后者非 schema.ts 誊抄，见核心改动 1）。新增表 = schema.ts 写 DDL + migration.ts 誊抄一份，漏一处不报错、不测出（fixtures 全走 `createTestDb()` = initSchema + migrateDatabase 的**新库**路径，「缺表老库」永远测不到）。
3. **initSchema 本身就是幂等的**：全部 DDL 使用 `IF NOT EXISTS`（schema.ts:9 注释「幂等，可重复调用」）。这是本方案成立的物理基础——**它对已有表的库重复执行是安全的**。

### 关键事实：风险集界定（本次核查）

用 6acac0ee（8/5 分叉点）的 schema.ts 表集合作基线（28 张），比对当前表集合：

- 8/5 后新增 9 张表：`embedding_meta`、`embedding_tasks`、`health_snapshots`、`signals`、`memory_edges`、`message_segments`、`signal_events`、`restart_pending_resumes`、`search_query_logs`
- 其中 8 张已在 migration.ts 补登（三次救火补齐），**仅 `search_query_logs` 漏登**（第 4 案）
- 8/5 前 28 张基线表无需补登（互斥分支引入前 initSchema 无条件跑，任何更老的库都拥有它们）

## 目标

- **T1**：消灭「新表需要两处登记」的结构本身——新增表只写 schema.ts 一处，老库自动获得，不存在「登记 migrateDatabase」这个可遗忘的动作
- **T2**：建立守卫不变量「任何能启动的老库，跑完 bootstrap 升级路径后，表集合与全新库等价」，且该不变量有测试常驻拦截（防未来有人把机制改回去）
- **T3**：顺带消除存量重复——migration.ts 中 6 个同构誊抄 ensure 函数 + `migrateMessageSegments` 内 1 段 CREATE（合计 7 个删除目标，约 150 行重复 DDL）删除，search_query_logs 漏登随机制自动修复

## 非目标

1. **列级漏登守卫**（新列只在 schema.ts CREATE TABLE 里加、漏 migration ADD COLUMN）：结构性风险同源（两处改），但历史无事故、守卫需列级比对复杂度高——列为二期增强，本文档只设计表级
2. 不引入独立迁移框架（drizzle/knex 等）——#386 已有先例决策「不引入迁移框架，保持 initSchema 幂等设计」，本方案延续
3. 不改动 `migrateExistingData` 的 `if (isNewDb)` 分支（新库种子迁移语义，与漏登问题无关）
4. 不处理历史遗留的 ALTER/数据迁移补丁（`rebuildDocumentTablesDropCheck` 等）——它们是「真迁移」，不在誊抄之列

## 方案设计

### 候选对比（issue 提出三个方向，逐一评估）

| 候选 | 机制 | 优点 | 缺点 | 判断 |
|------|------|------|------|------|
| **A. 幂等复用**（本方案主体） | bootstrap 删 `isNewDb` 分支，无条件跑 initSchema，migrateDatabase 只留真迁移 | 消灭机会本身：新表只写一处，「漏登」物理上不可能再发生；删 150 行重复 | initSchema 对老库执行需逐项复核安全性（已复核，见下）；失去「逐表补建日志」 | ✅ 推荐 |
| B. 守卫测试（issue 候选 1） | 模拟老库跑 migrateDatabase，断言表集合等价 | 不动生产代码，纯增测试 | 不消灭誊抄，只在他漏登后变红；**issue 原始表述有技术缺陷**：「DROP 全部表再跑 migrateDatabase」会炸——`PRAGMA table_info(不存在表)` 返回空 → 判断列缺失 → `ALTER TABLE` 抛 no such table | ✅ 作为 A 的配套（防退化），夹具需重设计（见下） |
| C. lint/CI 静态比对（issue 候选 3） | 脚本比对两文件 CREATE TABLE 集合 | 实现最简单 | 只守卫「誊抄模式」——A 落地后 migration.ts 不再有新表 DDL，比对对象消失；且比不出 DDL 内容漂移（同构誊抄逐列漂移它看不见） | ❌ 不投入（A 落地后无对象） |
| D. 单一真相源生成（issue 候选 2） | 表 DDL 定义一份，两处生成 | 理论上最优 | 本项目不需要「生成」——**A 就是它的最简形态**：schema.ts 的 `createXxxTables(db)` 函数已是单一真相源，migrateDatabase 的 ensure 誊抄本来就该直接复用这些函数；而「复用」的最彻底形态就是直接跑整个 initSchema | 并入 A |

> A 与 D 的关系：issue 候选 2 说「表 DDL 只定义一份，initSchema 与 migrateDatabase 都从同一份定义生成」。核查发现不需要生成器——initSchema 是 21 个幂等 `createXxxTables(db)` 函数的编排，`migrateDatabase` 的 `ensureXxxTable` 是同函数的手工内联誊抄。删除誊抄、无条件调用编排本身，即达成单一真相源，且比「生成」少一个构建步骤。

### 核心改动 1：bootstrap 无条件执行 initSchema

`src/bootstrap/database.ts` 现状（isNewDb 分支）：

```ts
if (isNewDb) {
  logger.info("New database detected, running schema initialization");
  initSchema(db, logger);
}
migrateDatabase(db, logger);   // 注释：migrateDatabase 幂等，新库也必须跑到最新结构
migrateMessageSegments(db, logger);
```

改为：

```ts
initSchema(db, logger);        // 幂等（全 IF NOT EXISTS）：新库建全表，老库补缺失表
migrateDatabase(db, logger);   // 真·迁移：ALTER 补丁列、一次性 rebuild、数据搬移
migrateMessageSegments(db, logger);
```

`migrateDatabase` 保持「历史补丁」纯语义（ALTER ADD COLUMN、表重建、数据迁移）。**删除目标共 7 个：6 个 `ensureXxx` 誊抄函数 + `migrateMessageSegments` 内的 CREATE 段**（数据搬移段保留）；**otter_configs 的 CREATE（migration.ts:41）保留不动**——该表不在 schema.ts 中（历史原因），不是誊抄，详见下方说明：

- `ensureSignalEventsTable`、`ensureRestartPendingResumesTable`、`ensureRhiTables`、`ensureEmbeddingTasksTable`、`ensureEmbeddingMetaTable`、`ensureMemoryEdgesTable`（以上 6 个 ensure 补建职责由 initSchema 接管）
- `migrateMessageSegments` 内 message_segments 的 CREATE 段可删（initSchema 已建），数据搬移段保留
- `otter_configs` 的 CREATE（migration.ts:41）特殊：该表不在 schema.ts 中（历史原因），**保留原样**并在其上补注释「此表未纳入 schema.ts，仅此一处定义」（后续可考虑迁入 schema.ts，非本方案范围）

另显式声明：`migrateExistingData` 的 `if (isNewDb)` 分支**不受本方案影响、保持原样**——它是新库种子数据迁移（数据语义），与 schema 建表路径无关，本方案只删 initSchema 前面的同款分支。

**安全性逐项复核（initSchema 对老库执行）**——这是本方案最大的风险点，逐条过了一遍 schema.ts 全部 785 行：

| initSchema 内容 | 对老库执行的行为 | 安全性 |
|---|---|---|
| 34 张表 `CREATE (VIRTUAL) TABLE IF NOT EXISTS` | 已存在跳过，缺失补建 | ✅ 正是期望行为 |
| 各表 `CREATE INDEX IF NOT EXISTS` | 老库缺的索引被补上 | ✅ 良性（索引仅影响性能，老库缺索引本就是隐患） |
| `DROP TRIGGER IF EXISTS messages_fts_*`（F20260828htar） | 幂等卸载历史触发器 | ✅ 已有行为（老库当前路径也跑不到，但 IF EXISTS 幂等） |
| `ALTER healing_events ADD COLUMN introduced_by_pr` + try/catch | 列已存在静默跳过 | ✅ 原样保留（schema.ts:743 既有模式） |
| `CREATE VIRTUAL TABLE memory_vec` + try/catch（sqlite-vec 不可用降级） | 沿用既有降级 | ✅ |
| `BEGIN/COMMIT` 事务包裹 | 独立事务，先于 migrateDatabase 执行，无嵌套 | ✅ |

**行为差异说明（诚实列出）**：老库当前路径（migrateDatabase-only）与无条件 initSchema 后的差异 = 老库会额外获得 ① 缺失表的补建（期望内）② 缺失索引的补建（增强）③ `memory_fts` 废弃残留表不会被 DROP（保持既有「不主动 DROP」策略，无变化）。

### 核心改动 2：补建差集日志（保留「老库升级」可观测性）

#505 审视产物「只在真正补建时打日志，让日志可作为老库升级证据」的诉求，在删除 ensure 后由 initSchema 承接：initSchema 执行前后各查一次 `sqlite_master` 表集合，差集非空时输出：

```
logger.info(`Schema init: ${created.length} tables created on existing database`, { created: [...] })
```

新库时差集=全部表，日志与现状等价；老库无缺表时差集为空，不打扰。

### 核心改动 3：表级等价性守卫测试（防退化）

不变量：**任何 8/5 基线形态的老库，跑完 bootstrap 升级序列后，表集合 ⊇ initSchema 管理的全部表**。

夹具构造（重设计版，规避 issue 原始表述的 DROP-全部缺陷）：

```ts
// 1. 内存库跑 initSchema + migrateDatabase（全量新库）
// 2. DROP「8/5 基线之外」的表——基线名单固化在 tests/fixtures/baseline-2026-08-05-tables.ts
//    （28 张表名常量。名单由 git show 6acac0ee 的 schema.ts 提取）
//    【实现注意】文件顶部须加注释：「此名单是 8/5 分叉点的历史快照，不需要也不应该更新——
//    名单语义 = 历史不可变，新表永远落在 DROP 差集中」，防止未来读者误当过期快照维护
// 3. 得到「8/5 基线老库」——模拟最老的、能启动的存量库形态
// 4. 跑完整 bootstrap 升级序列（initSchema + migrateDatabase + migrateMessageSegments）
// 5. 断言：sqlite_master 表集合 ⊇ initSchema 建表全集
//    （全集从新库步骤 1 的 sqlite_master 快照取得，不硬编码——新表加入自动纳入断言）
```

防护的退化场景：未来有人把 bootstrap 改回 `if (isNewDb)` 分支且新表只进 schema.ts → 夹具库缺表且无人补建 → 步骤 5 断言红。

为什么基线名单硬编码不会成为新的「漏改」点：名单只在「修改历史」时才需要变（不可能），新增表不需要动它——DROP 的是「新库表集合 − 基线名单」，新表自动落在 DROP 集合里。

### search_query_logs（第 4 案）的修复路径

- 本方案落地即自动修复（initSchema 无条件跑，存量库补建该表）——**无需单独补 ensure**
- 窗口期考虑：方案 PR 合入前，若有部署动作在老库上跑新代码（#482 已合 main），埋点 INSERT 仍静默失败。评估：埋点是评估期数据收集（fire-and-forget 设计本来就容忍丢失），窗口期损失可接受；若搭档要求先堵，可在 #505 同款 ensure 先补一行（临时，随本方案删除）

## 影响范围

- `src/bootstrap/database.ts`：isNewDb 分支删除（~6 行改动）
- `src/frameworks/db/schema.ts`：initSchema 加差集日志（~10 行）
- `src/frameworks/db/migration.ts`：删 6 个 ensure 誊抄函数 + migrateDatabase 内 6 处调用 + `migrateMessageSegments` 的 CREATE 段（净 -150 行左右）
- `tests/frameworks/db/migration.test.ts`：删除 ensureXxx 相关 describe 块（夹具测试改为依赖 initSchema 补建）
- `tests/fixtures/baseline-2026-08-05-tables.ts`：新增基线名单
- `tests/frameworks/db/migration-equivalence.guard.test.ts`：新增守卫测试
- **不影响**：任何消费方（repository 层）、任何 ALTER/数据迁移补丁、createTestDb 工厂（它已经是 initSchema+migrateDatabase 序列，与 bootstrap 新序列天然一致）

## 风险与约束

1. **列级漏登不设防**（一期）——同源风险的列级形态（新列漏 ADD COLUMN）仍靠纪律。缓解：守卫测试二期增强为列级比对（PRAGMA table_info 逐表断言新库=升级库）。此处如实声明覆盖边界。
2. **initSchema 语义演进的长效约束**：本方案后 initSchema 承担「新库建表 + 老库补建」双职责，新增「破坏性 schema 变更」（改列类型/删列）时**不能**只改 initSchema 的 CREATE（老库表已存在不会重建）——必须同时写 migration 补丁。这一约束需写入 schema.ts 顶部注释（替代现在写在 migration.ts 注释里、被证明无效的约定——但注意：注释依然是约定，真正的强制力在守卫测试的不变量）。
3. **幂等键依赖不受影响**：migrateDatabase 的 settings 幂等键（`messages_fts_stripped_rebuild` 等）与 initSchema 无交集。
4. **性能**：34 表 IF NOT EXISTS + 两次 sqlite_master 查询，SSD 上 <100ms，启动路径可忽略。

## 不兼容更新

无破坏性变更。存量库升级后仅「多出缺失表/索引」，无表删除、无列变更。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 根治机制 | 无条件幂等 initSchema（候选 A/D 合并） | lint 静态比对（C）；只加守卫测试（B 单用） | A 消灭机会本身，B 只报警不根治，C 在 A 后无对象；历史三案+新一案证明「提醒类」机制（注释/lint）挡不住结构必然 |
| 守卫夹具 | 8/5 基线名单 + DROP 差集模拟老库 | issue 原表述「DROP 全部表」 | DROP 全表后 migrateDatabase 的 ALTER 路径抛 no such table（PRAGMA 对不存在表返回空 → 误判列缺失），夹具必须保留基线表 |
| 基线名单硬编码 | 是（28 表名，永不漂移） | 动态从 git 历史提取 | 测试不依赖 git 环境；名单语义=「历史不可变」，无漂移场景 |
| otter_configs 处理 | 保留在 migration.ts + 注释 | 迁入 schema.ts | 该表不在 schema.ts 是历史遗留；迁入是行为变更（老库会被补建此表——实际上目前 migrateDatabase 每次都 CREATE IF NOT EXISTS 等价于补建），为控制本 PR 爆炸半径不动，留待后续 |
| 列级守卫 | 二期 | 一期含列级比对 | 表级是历史全部事故形态；列级比对需逐表列快照维护，一期引入拉长交付 |

## 验证

1. **守卫测试自证**：在实现分支上临时把 database.ts 改回 isNewDb 分支 + 在 schema.ts 加一张假表 → 守卫测试必须红 → 还原后绿（证明守卫真的能拦住它要拦的退化）
2. **第 4 案回归**：守卫夹具老库（基线 28 表，无 search_query_logs）跑升级序列 → 断言 search_query_logs 存在且可 INSERT
3. **全量测试**：`npx vitest run` 全绿（重点 migration.test.ts 删除块后无悬空引用）
4. **双库启动冒烟**：新库路径（删文件冷启动）与老库路径（用本仓 data/ 实际库副本跑 dev server）均正常启动，日志出现差集补建行
5. **tsc + eslint**：0 error（migration.ts 删代码后 max-lines eslint-disable 注释可顺带清理）

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/bootstrap/database.ts | 修改 | 删 isNewDb 分支，initSchema 无条件执行 |
| src/frameworks/db/schema.ts | 修改 | initSchema 差集日志；顶部注释更新为双职责约束声明 |
| src/frameworks/db/migration.ts | 修改 | 删 6 个 ensure 誊抄函数及调用；migrateMessageSegments 去 CREATE 段；otter_configs 加注释 |
| tests/fixtures/baseline-2026-08-05-tables.ts | 新增 | 8/5 基线 28 表名单 |
| tests/frameworks/db/migration-equivalence.guard.test.ts | 新增 | 表级等价性守卫 |
| tests/frameworks/db/migration.test.ts | 修改 | 删 ensureXxx describe 块 |

## 对抗审视记录

### 第一轮（2026-08-27，磨石，mimo 异体）

**焦点**：方案地基声明核验（785 行幂等性抽查）、第 4 次漏登声明核验、ensure 函数数量。
**地基核验结论**：幂等性逐项抽查成立；第 4 次漏登（search_query_logs）grep 实锤成立。

| 发现 | 分级 | 处置（决策树） | 理由 |
|------|------|----------------|------|
| 1. 「8 个 ensure 函数」计数错误（实际 6 ensure + 1 内联 CREATE + 1 保留项） | 严重（事实错误） | 接受并修订：全文统一为「6 ensure + 1 CREATE 段 = 7 个删除目标」，带行号 | grep 复核确认 6 个（:129/:162/:186/:281/:299/:318）；影响范围节原文与背景节自相矛盾，事实错误必须修 |
| 2. otter_configs 保留决定应前置 | 建议 | 接受：删除清单开头改为「共 7 个删除目标 + otter_configs 保留」边界声明 | 读者不需读到最后才理解边界，改了更好 |
| 3. 基线名单文件需「历史快照勿更新」注释 | 建议 | 接受：写入夹具代码注释块【实现注意】 | 防未来读者误当过期快照维护 |
| 4. migrateExistingData 的 isNewDb 条件未显式声明 | 建议 | 接受：核心改动 1 末尾补显式声明（不受影响、保持原样） | 消除读者疑问，声明成本低 |

> 处置小结：4/4 接受，无反驳项。严重发现源于初稿计数粗心（把 otter_configs 和 message_segments 内联 CREATE 误计入 ensure 函数数），暴露的事实表述风险已在修订中根治。

## 实现记录

> 设计稿正文（背景/目标/非目标/方案设计/候选对比/核心改动/风险）见下方原稿，已全部落地。
> 本节记录实现与设计的差异、验证结果与审视留痕。

## 与设计的差异

零方案偏差，以下为实现细节补充：

1. **夹具构造的表名清单过滤**（设计未预见的实现细节）：sqlite_master 里 FTS5 虚拟表的影子表
   （`memory_fts_jieba_data/config/...`）不能单独 DROP（SqliteError），`sqlite_sequence`（AUTOINCREMENT
   伴生）同样不可 DROP——夹具的 `listTableNames` 排除这两类（虚拟表名前缀匹配 + sqlite_ 内部表）。
2. **migration.ts 无用 eslint-disable 清理**（设计验证节预设项）：删 150 行后 `max-lines` 与
   `max-lines-per-function` 的 disable 成为 unused directive（lint warning），已移除并留恢复指引注释；
   `max-statements` disable 保留（仍需要）。
3. **守卫自证的具体退化模拟**：临时把升级序列改回「跳过 initSchema」（等价于改回 isNewDb 分支且新表
   只进 schema.ts）→ 第一个断言精确变红（缺失表被列出）；恢复后绿。

## 实现清单（对设计「改动范围」表的逐项落实）

| 文件 | 操作 | 实现说明 |
|------|------|--------|
| src/bootstrap/database.ts | ✅ | 删 isNewDb 分支，initSchema 无条件执行（含 #506 根因注释）；migrateExistingData 的 isNewDb 条件未动（设计显式声明） |
| src/frameworks/db/schema.ts | ✅ | initSchema 差集日志（tablesBefore 快照 + 补建列表）；顶部注释更新为双职责约束声明 |
| src/frameworks/db/migration.ts | ✅ | 删 6 个 ensure 誊抄函数及调用（净 -207 行）；migrateMessageSegments 去 CREATE 段（数据搬移保留）；otter_configs 加「仅此一处定义」注释；unused eslint-disable 清理 |
| tests/fixtures/baseline-2026-08-05-tables.ts | ✅ 新增 | 28 表基线名单（git show 6acac0ee 提取，与独立复核一致），顶部「历史快照勿更新」实现注意 |
| tests/frameworks/db/migration-equivalence.guard.test.ts | ✅ 新增 | 3 用例：等价性断言（全集动态取得不硬编码）/ 第 4 案回归（search_query_logs 补建可 INSERT）/ 幂等 |
| tests/frameworks/db/migration.test.ts | ✅ | embedding_meta、signal_events+restart_pending_resumes 两个 describe 块改为 initSchema 补建语义（补建职责移交后验证新机制），其余补丁测试不动 |

## 验证结果（设计验证节逐项执行）

1. **守卫自证** ✅：临时退化（升级路径跳过 initSchema）→ 断言红（缺失表精确列出）；恢复 → 绿
2. **第 4 案回归** ✅：守卫夹具老库升级后 search_query_logs 存在且可 INSERT（测试 + 真实库冒烟双重验证）
3. **全量测试** ✅：155 文件 / 1857 用例全绿（含新增 3 守卫用例；migration.test.ts 改造后无悬空引用）
4. **双库启动冒烟** ✅：新库路径 = 全部测试的 createTestDb；老库路径 = 本仓真实 data/otter-buddy.db（290MB
   含 WAL 清理）副本跑新升级序列——补建差集 `[search_query_logs]`，差集日志正确输出，等价性缺失为空，
   第 4 案 INSERT 成功，无任何报错
5. **tsc + eslint** ✅：0 error；migration.ts 清理后自身零警告（余 3 warning 为存量 React Hook）

## 效果

- **净删约 200 行誊抄 DDL**，新表从此只写 schema.ts 一处，「漏登 migrateDatabase」物理上不可能再发生
- 存量库（含本仓生产库）下次启动自动补建 search_query_logs，埋点数据停止丢失
- 守卫测试常驻拦截「把机制改回去」的退化，且全集动态取得——未来新增表自动纳入断言，无需维护

---

# 附：设计阶段待拍板点（已由搭档 8/27 拍板，存档）

1. **根治机制选型**：拍板采用候选 A（无条件幂等 initSchema）+ B（守卫测试）组合
2. **search_query_logs 窗口期**：拍板等本方案落地自动修复（埋点容忍丢失）
3. **列级守卫是否立项二期**：未拍板，留待后续评估（本方案只覆盖表级）
