---
id: F20261009smex
title: 存量库形态冒烟门 + DDL 同块引用静态门（#1390 事故防线）
summary: |
  第二次 P0 启动事故（#1390）的防复发方案：smoke:boot 扩展存量库形态冒烟
  （#1365 前 schema 快照 + initDatabaseAndModels 真实启动路径回放），
  并新增 lint:schema 静态门拦截「索引引用列不在同块 CREATE TABLE 且无块外补列先于索引」
  的 #1365 形态。两道互补：冒烟覆盖快照回放，静态门覆盖规则本身。
change_type: feature
capability_test: "n/a: 纯工程链路变更（测试 + lint 脚本），验证方式=冒烟门本身（fail-closed 已验证：坏形态必炸，好形态全绿）"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
doc_type: feature
created_at: 2026-10-09
tags: [smoke, lint, schema, incident-prevention, p0]
modules: [db, scripts, tests]
intent:
  problem: "smoke:boot 只验证全新库形态，存量库（线上真实形态）无冒烟门；DDL 顺序约束无静态门，#1365 形态（索引在补列前）CI 全绿可合入"
  expected_effect: "存量库形态冒烟门 fail-closed 验证通过（#1365 坏形态必炸 no such column）；lint:schema 静态门拦截索引引用列不在同块 CREATE TABLE 且无块外补列先于索引的违规形态"
  verify_by:
    type: behavior_check
---

# 存量库形态冒烟门 + DDL 同块引用静态门（#1390 事故防线）

## 背景：两次 P0 事故的共同模式

| | 9/29 第一次（#1202） | 10/9 第二次（#1390） |
|---|---|---|
| 现象 | pull 后 npm start 失败 | 升级后重启失败 |
| 直接根因 | lint 挂在启动链上，lint warning 拦死启动 | #1365 把索引与 CREATE TABLE 同块，存量库 IF NOT EXISTS no-op 后索引抢跑，no such column |
| 为什么 CI 绿 | 每个 PR 单独 lint 绿，组合态 lint 债 CI 防不住 | CI/冒烟/单测全部用全新库（mkdtemp 空目录），新库 CREATE TABLE 一把建全，永远走不到存量库 ALTER 路径 |
| **共同模式** | **验证环境的形态 ≠ 线上形态：防线绿 ≠ 线上能起** | 同左 |

上次方案（F20260929boot：lint 挪出启动链 + smoke:boot）**没有失效、执行到位**——本次 lint 侧没出任何问题，它管的那层守住了。盲区在 smoke:boot 只验证全新库（tests/app/build-app.test.ts:30 用 fs.mkdtempSync），而线上 100% 是存量库。文档自己预言过这个洞：「若未来出现编译过但启动挂的新模式（如 DB migration 回归），冒烟测试应扩展覆盖」——预言命中，但当时没做。

## 方案

两道互补防线：

### A. 存量库形态冒烟门（tests/app/build-app-existing-db.test.ts）

**设计**：先跑 initSchema 建全新库（保证所有表/索引/列与生产 schema 一致），再删掉 healing_events 的补列（bound_issue/bound_at）回退到 #1365 前形态，最后跑 initDatabaseAndModels 完整启动路径（initSchema + migrateDatabase），验证「旧 schema → 新 schema」补列 + 建索引后系统能完成 DB 启动层装配。

**为什么不用「最小快照」**：最小快照只建 conversations + healing_events，但 initSchema 的 CREATE INDEX idx_conversations_status ON conversations(status) 要求 status 列存在——最小快照缺列即炸，与 #1365 同型问题（快照本身成了事故源）。「全新库建全 → 定向回退」保证快照是真实存量库形态，非人工拼凑。

**fail-closed 验证**：用 #1365 坏形态（索引塞回建表块）跑一次，必炸 `no such column: bound_issue`；好形态 4/4 绿。

**挂载点**：scripts/smoke-boot.sh 在全新库冒烟后追加存量库冒烟，fail-close 自检（测试文件不存在即 exit 1）。

### B. DDL 同块引用静态门（scripts/lint-schema-ddl.mjs）

**规则**：对 src/frameworks/db/schema.ts / migration.ts 的每个 CREATE INDEX 语句，其引用的列必须满足其一——
- A) 同块 CREATE TABLE 定义了该列（全新库场景）；
- B) 同文件存在 ALTER TABLE 补列语句且位置在索引块之前（存量库场景，补列先于索引执行）。

两者都不满足 = 违规（#1365 形态：索引在补列之前，存量库必炸）。

**豁免**：块内显式注释 `lint-schema:allow-index-before-column`（须附理由）——migration.ts 的表重建场景（RENAME 后建索引，列由旧表继承）全部走此豁免，共 8 处。

**为什么是静态门而不是只靠冒烟**：冒烟覆盖「快照形态回放」，静态门覆盖「规则本身」——快照可能滞后于 schema 演进，静态门不依赖快照新鲜度，两道互补。

**挂载点**：package.json check 链追加 `lint:schema`（build → lint → lint:schema → smoke:boot）。

## 改动范围

- `scripts/lint-schema-ddl.mjs`（新增，~80 行）
- `tests/app/build-app-existing-db.test.ts`（新增，~140 行）
- `scripts/smoke-boot.sh`（追加存量库冒烟段，+12 行）
- `package.json`（check 链追加 lint:schema，+1 行；scripts 追加 lint:schema，+1 行）
- `src/frameworks/db/migration.ts`（8 处豁免标记注释，+8 行）

## 验证

- **全新库冒烟**：build-app.test.ts 7/7 绿（既有）
- **存量库冒烟**：build-app-existing-db.test.ts 4/4 绿（新增）
- **fail-closed**：#1365 坏形态必炸 `no such column: bound_issue`（实测）
- **lint:schema**：clean main 0 违规；migration.ts 8 处豁免标记后 OK
- **check 链**：build + lint + lint:schema + smoke:boot 全绿（exit=0）
- **无方案外变更**：diff 仅上述 5 个文件

## 设计取舍

**机制预算四问**（本特性命中「新增机制」检查点）：

1. **机制解决什么根因**：验证形态与线上形态不一致——全新库绿 ≠ 存量库能起。根因是结构（快照形态单一），不是某条测试用例。
2. **最小实现是什么**：A 只加存量库冒烟（~140 行测试），B 只加静态门（~80 行脚本）——不引入迁移框架、不改 schema.ts 结构、不动既有测试。
3. **后续机制是什么**：快照维护成本 = schema 大版本变更时同步回退目标表（当前仅 healing_events 一张表有补列）；静态门豁免标记 ratchet（新增豁免须附理由，review 核对）。
4. **退役条件**：schema.ts 的 ALTER 补列全部迁移到独立迁移框架（如 drizzle/atlas）后，静态门可退役——冒烟门仍保留（形态一致性是永恒问题）。

**最简实现检查**：已过。A 复用 initSchema 建快照（不手写 DDL 快照），B 复用 lint-tests.mjs 的独立脚本风格（不引入新框架），快照只回退有补列的表（不做 44 张全量快照）。

**负面向验收条目**：本次变更破坏了什么旧契约 / 绕过了什么既有保护——无。纯增量：新增测试 + 新增 lint 脚本 + 追加注释，不改任何既有行为。

## 事故教训（实施侧）

- **「拼接写法绕 lint」系误判** + cwd 漂主仓假验证——教训：验证命令必须显式 cd
- **整文件重写 schema.test.ts 丢列名引入假绿**——教训：优先 edit 定点修改，整文件重写后必须 diff origin/main 逐行核对
- **断言收紧 .toThrow(/FOREIGN KEY constraint failed/)** 防同类假绿

## 关联

- 事故复盘：本对话（a23f0f4a）2026-10-09，搭档拍板 A+B
- 事故修复：F20261009hixo（#1390，索引挪到补列后 + 回归锁）
- 上次防线：F20260929boot（#1202，lint 挪出启动链 + smoke:boot）
- 根因 PR：#1365（F20261008hbbd，healing batch_bind 功能引入索引抢跑）
