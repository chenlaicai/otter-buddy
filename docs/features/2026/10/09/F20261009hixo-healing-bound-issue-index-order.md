---
id: F20261009hixo
title: healing_events bound_issue 索引抢跑修复：索引创建挪到存量库补列之后
summary: |
  #1365 把 idx_healing_events_bound_issue 索引与 CREATE TABLE 放同一 SQL 块，而存量库补列的 ALTER 在其后——存量库启动必炸 no such column。修复 = 索引创建挪到补列之后（建表→补列→建索引），并加存量库结构回归测试锁死顺序
change_type: fix
capability_test: "n/a: schema 初始化顺序修复，验证走单测（存量库结构回归）+ 真实存量库启动验证，无 LLM 参与行为"
created_at: 2026-10-09
tags: [healing, self-healing, bugfix, schema, migration]
modules: [db]
---

# healing_events bound_issue 索引抢跑修复

## 背景（生产事故）

2026-10-09 主仓从 `e351f3c5` 快进到 `4a90e98a`（含 #1365 F20261008hbbd batch_bind）后，**存量库启动必炸**：

```
Failed to start: SqliteError: no such column: bound_issue
    at createHealingEventTables (dist/src/frameworks/db/schema.js:549:8)
```

影响面：所有带 #1365 之前 `healing_events` 表的存量库，升级到 #1365 及之后版本启动即崩。新库/CI 测不出来（CREATE TABLE 一把建全），只有老库升级命中——典型"存量库盲区"。

## 根因

`src/frameworks/db/schema.ts` `createHealingEventTables` 的执行顺序错位：

1. 同一 `db.exec` 块内：`CREATE TABLE IF NOT EXISTS healing_events (... bound_issue INTEGER ...)` + 全部索引（含 `idx_healing_events_bound_issue`）
2. 块外 30 行之后：`ALTER TABLE healing_events ADD COLUMN bound_issue`（存量库补列）

对存量库，`CREATE TABLE IF NOT EXISTS` 是 no-op（列并不存在），但同块的 `CREATE INDEX ... (bound_issue)` 立即执行 → 列不存在 → 抛错 → 进程退出，**永远走不到后面的补列**。

#1365 的迁移自检只覆盖了新库路径（列在建表语句里），未用真实存量库结构验证启动——同族教训见 CTAS 迁移毁表事故（迁移路径必须用存量结构验证，不能假设新库等价）。

## 修法（narrow-fix）

把 `idx_healing_events_bound_issue` 的创建从建表 SQL 块中挪出，放到两个 `ALTER TABLE ADD COLUMN`（bound_issue / bound_at）之后，恢复正确顺序：**建表 → 补列 → 建索引**。

- 新库：CREATE TABLE 建全列 → ALTER 幂等跳过 → 建索引，行为不变
- 存量库：IF NOT EXISTS no-op → ALTER 补列 → 建索引，修复启动
- 索引创建本身是 `IF NOT EXISTS` 幂等，重复 initSchema 不受影响
- 不引入迁移框架、不动 migration.ts（其 #1271 迁移函数有同款 CREATE INDEX，但只在 ALTER 之后调用，顺序本已正确）

**机制识别检查点判定**：四问全部未命中——不新增机制/通道/状态，仅调整既有语句执行顺序，属既有语义内修。

**负面向验收**：本次变更破坏的旧契约 = 无（原行为是启动崩溃，无合法依赖方）。

## 回归锁

`tests/frameworks/db/schema.test.ts` 新增两支回归用例：

1. **存量库结构回归**：手工复刻 #1365 之前的 healing_events 表结构（无 bound_issue/bound_at 列，形状对照源 git show b810c133^，提取为 createPre1365HealingEventsTable 复用）→ 跑 initSchema → 断言不抛错、两列补齐、索引存在。
2. **半迁移形态回归**（检视发现 2 处置）：旧表 + 手动补 bound_issue 单列（事故现场半修复形态）→ 跑 initSchema → 断言 bound_at 补齐、索引存在。锁 r1-A2 不变量：补列每列独立 try/catch，防回退成单块时第二列 ALTER 被整体吞掉。

手写 DDL 靠文件首行 `lint-tests:allow-ddl` 豁免放行（被测对象就是旧 schema → 新 schema 的启动迁移本身，生产 schema 建不出旧表形态，与 migration.test.ts 同类场景；ratchet 9→10 登记于 scripts/lint-tests.mjs）。

## 验证

- **失败用例证据（bugfix 硬规则）**：修复前新增回归用例复现 `no such column: bound_issue`（与生产报错一致）；修复后 schema.test.ts 8/8 通过
- **真实存量库启动验证（隔离实例）**：worktree 独立端口 3151 + 主仓事故前的真实 DB 备份（`otter-buddy.db.bak-20261009-130451`，实测无 bound 列）→ 修复后构建启动成功：schema 初始化通过、两列自动补齐（`PRAGMA table_info` 实证）、服务正常监听并恢复业务处理，无 `Schema initialization failed`
- 用户生产库已用同等 ALTER 手动修复并验证启动（端口 3000 正常），本 PR 防止其他存量库复炸
- 对抗审视（检视獭-1390，mimo-pro）：0 严重 / 2 建议（注释失实订正 + 半迁移用例），均已本 PR 处置；另披露 schema.ts 文件头「禁止 ALTER TABLE」注释与现实矛盾，一并订正为「补列例外 + 索引不得进建表块」的正确约束描述
- lint / build 干净

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/db/schema.ts | 修改 | idx_healing_events_bound_issue 创建挪到补列之后；文件头「禁止 ALTER TABLE」订正为补列例外 + 索引顺序约束（检视披露） |
| tests/frameworks/db/schema.test.ts | 修改 | 存量库 + 半迁移两支回归用例（lint-tests:allow-ddl 豁免；注释订正检视发现 1） |
| scripts/lint-tests.mjs | 修改 | allow-ddl ratchet 上限 9→10，登记 schema.test.ts 豁免理由 |

## 关闭标准

- ✅ 存量库结构回归测试入库（修复前红、修复后绿）
- ✅ 真实存量库（事故备份）隔离实例启动验证通过
- ⏳ 修复 PR 合入
