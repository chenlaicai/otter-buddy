---
id: F20261026onlc
title: embedding 幽灵清理脚本在线模式——SQLite 在线备份（含 WAL）+ 并发安全论证
summary: 'cleanup-embedding-ghosts.mjs 新增 --online（配合 --apply）：不停机清理幽灵任务。备份从 copyFileSync 换为 better-sqlite3 db.backup()（SQLite 在线备份 API，含 WAL 已提交数据——cp 主 DB 在线会丢 WAL 内容），busy_timeout 15s 等待主服务写锁。并发安全经读码论证：markTaskDone=DELETE / markTaskAttemptFailed=UPDATE，被删任务的运行中回写命中 0 行不复活；enqueueRetry 前置校验与删除条件互斥不边删边插；NOT EXISTS 保证有效任务不受影响。2026-10-26 生产在线实跑：删 1880 条幽灵、1349 条有效任务原样、备份 integrity_check ok、服务零重启。'
change_type: fix
capability_test: "n/a: 运维脚本（A 类），无 LLM 参与行为"
modules: [memory, scripts]
created_at: 2026-10-26
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  - F20261026emct（#1634 治本修复引入本清理脚本，停机模式；本特性在其上加在线模式）
related_issues: []
---

# embedding 幽灵清理脚本：在线模式

## 背景

2026-10-26 治本修复（F20261026emct，#1634）合入部署后，生产库残留 1880 条幽灵任务
（entry 已删除，1194 pending + 686 dead）。原脚本安全前提是停机运行：备份用
copyFileSync 只复制主 DB，在线运行会丢 WAL 中已提交数据；并发语义未论证。
搭档明确「不想重启」，授权在线处理。

## 改动

- `scripts/cleanup-embedding-ghosts.mjs` 新增 `--online`（配合 `--apply`）：
  - 备份：`db.backup()`（SQLite 在线备份 API，含 WAL）替代 `copyFileSync`；
    缺省无 `--online` 保持停机模式（cp 足够且更简单）
  - `busy_timeout = 15000`（apply 统一设置）：与主服务写锁短暂互斥时等待
- 缺省 dry-run 不变；删除 SQL（NOT EXISTS 真定义口径）不变

## 并发安全论证（在线模式的核心，非测试替代）

依据 src/frameworks/db/memory/embedding-task-queue.ts（F20261026emct 合入后版本）：
1. `markTaskDone` = DELETE WHERE entry_id（:88）、`markTaskAttemptFailed` = UPDATE（:97）
   ——被删任务的运行中回写命中 0 行，**不会复活**
2. `enqueueRetry` 前置校验 entry 不存在即 no-op（:26），与删除条件（entry 不存在）互斥
   ——**不会边删边插**新幽灵
3. claim 后行被删 → content='' → entry-deleted 分支 UPDATE 0 行，安全
4. NOT EXISTS 删除条件保证 entry 存活的有效任务绝不在范围内

## 验证

- 新增集成测试（WAL 真实场景）：源连接保持打开（模拟主服务在线）+ checkpoint 后
  再写入使 e2 仅存在于 WAL；断言在线备份含 WAL-only 行（cp 会丢）、孤儿删除、
  有效任务与 memory_entries 不受影响。3/3 通过
- 生产实跑（2026-10-26，搭档授权）：dry-run → --apply 等价逻辑在线执行，
  删 1880 条幽灵、1349 条有效任务原样保留、ghost=0；备份 2.36GB
  integrity_check=ok（memory_entries 58543 完整）；/health 200 全程零重启
  （生产执行用工作区一次性脚本，本 PR 将同等能力沉淀进仓内脚本）

## 影响范围

仅运维脚本与其测试；主服务代码零改动。缺省（停机）模式行为不变。

## 设计取舍（机制识别与预算）

机制识别检查点：本改动给清理脚本新增 `--online` 运行模式（SQLite 在线备份 API），
属修法决策树④新增机制，故 commit 声明 `mechanism-addition` 并接受重对抗门审视。
四问：①必要性——不停机清理是搭档明确诉求，停机前提本身源于备份方式缺陷而非
业务必须；②最小实现——仅换备份 API + busy_timeout，删除 SQL 与 dry-run 语义不动，
不引入锁管理/运维接口等更大机制；③维护成本——一个 CLI flag + 一段并发安全注释，
无新模块无新配置；④可回退性——不带 `--online` 行为与合入前完全一致，回退即删 flag。
