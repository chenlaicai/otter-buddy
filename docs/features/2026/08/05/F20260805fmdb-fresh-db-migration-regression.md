---
id: F20260805fmdb
title: fresh-db-migration-regression
doc_type: feature

summary: |
  修复全新数据库无法启动的回归：F20260805codx 把 initSchema 与 migrateDatabase 做成互斥分支
  （新库只跑 initSchema），但 initSchema 不含历史补丁列（如 agent_sessions.session_file），
  随后 migrateExistingData 读 session_file 直接抛 SqliteError，新装机/全新数据目录必崩。
  由 F20260806tstr 的 build-app 测试（首个真实启动全新 DB 的测试）捕获。
  修法：migrateDatabase（本身幂等）在新库路径也执行，恢复 codx 之前的无条件迁移语义。

causal_links:
  from:
    - F20260805codx   # 引入回归的提交（互斥分支）
    - F20260806tstr   # 测试体系重构（其 build-app 测试捕获本 bug）
  to: []

status: implemented
change_type: fix
tags: [database, migration, fresh-install, regression, sqlite]
modules:
  - src/bootstrap/database.ts
---

# F20260805fmdb: 全新数据库迁移回归修复

## 根因

F20260805codx 重构 `initDatabaseAndModels` 时改为：

```ts
if (isNewDb) { initSchema(db); } else { migrateDatabase(db); }  // 互斥！
if (isNewDb) { migrateExistingData(db, ...); }                  // 读 session_file
```

`session_file` 列由 `migrateDatabase` 以 ALTER TABLE 补丁形式添加，**不在** `initSchema` 的
建表语句里。新库路径跳过 migrateDatabase → `migrateExistingData` 查询
`agent_sessions.session_file` → `SqliteError: no such column: session_file` → 启动失败。

存量库不受影响（列早已加上），所以该回归只有"全新安装/全新数据目录"才触发——
生产一直没换数据目录因此未暴露。codx 前的旧 main.ts 是无条件 `initSchema → migrateDatabase`，
本修复恢复该语义。

## 修复

`src/bootstrap/database.ts`：migrateDatabase 移出 else 分支，新库路径在 initSchema 后同样执行。
migrateDatabase 本身幂等（PRAGMA 检查列存在性 + CREATE TABLE IF NOT EXISTS），重复执行安全。

## 捕获过程（测试价值的实证）

`tests/app/build-app.test.ts` 是史上第一个用**全新临时 DB** 真实启动完整系统的测试，
首次运行即触发本 bug。这正是测试体系重构（A/B 分层）主张的：真实启动能发现
mock 体系结构性不可见的缺陷。

## 验证

- build-app 测试（全新 DB 真实启动）4/4 绿
- 生产冒烟：全新 /tmp DB + 真配置启动，health 200
- 全量 `npm test` 85 文件 / 1045 用例无回归
