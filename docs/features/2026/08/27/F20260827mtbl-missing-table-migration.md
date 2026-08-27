---
id: F20260827mtbl
title: missing-table-migration
summary: |
  修复存量库缺 signal_events / restart_pending_resumes 两表导致重启清理夭折、会话永久"运行中"的缺陷。
  根因：两张表的建表只写进 initSchema（仅新库执行），漏了 migrateDatabase 老库升级路径；reconcileOrphans 的恢复登记抛错又把 failInFlightMessages 核心清理整体带崩。
  修复：migration.ts 补建两表（幂等 ensure，同 ensureRhiTables 先例）+ reconcile 恢复登记逐条 try/catch 隔离降级 fail+notice。

causal_links:
  from:
    - F20260826rsme
    - F20260826mwrd
    - F20260821evaf

status: development
change_type: fix
tags: [database, migration, reconcile, restart-recovery]
modules:
  - src/frameworks/db/migration.ts
  - src/usecases/conversation/reconcile-orphans.ts
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d
---

# F20260827mtbl: 存量库缺表迁移补丁 + reconcile 异常隔离

## 背景与需求

### 问题描述

用户更新系统后重启服务，Web 端 3 个会话（「股神😎」「500-501-502」「ui建小獭优化」）永久显示"运行中"（`activityStatus=processing`），点击中断无效。这 3 条消息实际是 2026-08-26 11:10~11:14 中断的 `streaming` 残留，跨多次重启无人清理。

### 根因分析

缺陷是三层叠加：

**缺陷 1（根因）：新表只进 initSchema，漏了 migrateDatabase。**
`signal_events`（F20260826mwrd）与 `restart_pending_resumes`（F20260826rsme）的建表语句只加进 `schema.ts` 的 `initSchema`，而 `initSchema` 仅在**新建数据库**时执行（`bootstrap/database.ts` 的 `isNewDb` 分支）。存量库升级走 `migrateDatabase`，该文件里没有这两张表——违反了 migration.ts 已确立的约定（`ensureRhiTables` 注释明言"initSchema 仅新库执行，老库升级路径必须在此补建（否则 server 集成后写入直接 no such table）"）。这不是新问题：F20260821evaf（embedding_meta）、F20260824rhib（RHI 表）都踩过同一坑并修过，本次是同一约定再次未被遵守。

**缺陷 2（放大器）：reconcileOrphans 无异常隔离。**
`reconcileOrphans` 的 try/catch 包住整个流程，循环里的 `claimResume` 查缺表抛 `SqliteError: no such table: restart_pending_resumes` 后，外层 catch 直接放弃——后面的 `failInFlightMessages`（把 streaming 孤儿置 failed 的核心清理）与 `closeOrphanedTurns` 永远执行不到。自动恢复是增强功能，其故障不应带崩核心清理。

**缺陷 3（测试盲区）：测试全部走 initSchema 新库。**
`createTestDb()` 系 fixtures 一律建全新库，"缺表老库"的升级场景在测试面里不存在，缺陷 1 因此不可见。

### 数据实锤

- 生产库 `sqlite_master` 实测：无 `signal_events`、无 `restart_pending_resumes`，其余 34 表齐全
- 日志（2026-08-27 08:03:57 / 08:04:10）：`Failed to reconcile orphans` 与 `Resume interrupted messages failed`，err 均为 `no such table: restart_pending_resumes`，stack 落在 `claimResume`；同报错 2026-08-26 16:10 已出现（bug 早于当日系统更新）
- `messages` 表 3 条 `streaming` 状态残留（created_at 为 8-26 11:10~11:14），`listConversationsWithMeta` 的 activityStatus 推导规则"存在 streaming/speaking 消息 → processing"因此永久命中
- 附带影响：halt 工具（`halt_otter`/`query_signals`）落账同样查 `signal_events`，在存量库上一样会抛 no such table

## 方案设计

### 技术方案

1. `migrateDatabase` 尾部追加 `ensureSignalEventsTable` + `ensureRestartPendingResumesTable`（DDL 与 schema.ts 同构，`CREATE TABLE IF NOT EXISTS` 幂等；采用 `ensureEmbeddingMetaTable` 的"只在真正补建时打日志"模式，日志可作老库升级发生的证据）
2. `reconcileOrphans` 的恢复登记循环体逐条 try/catch：claim 链路任何异常只降级该条为现状 fail+notice 路径（不进 `skipNoticeIds`），warn 记录后继续；外层 catch 保留作最终兜底

### 目标

- T1: 存量库启动后两张表自动补建，halt/自动恢复功能可用
- T2: 恢复登记链路故障不再中断孤儿清理，streaming 消息必达 failed 终态
- T3: 缺表老库场景有测试覆盖（盲区补上）

## 验收标准

### 验收场景
| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 存量库补表 | initSchema 后 DROP 两表模拟老库，跑 migrateDatabase | 两表存在且可按 claimResume/signal 语义读写 |
| AT-2 | 补表幂等 | 已有表的库连续跑两次 migrateDatabase | 不抛错 |
| AT-3 | 登记失败降级 | DROP restart_pending_resumes 后跑 reconcileOrphans | 消息到 failed + notice，turn 关闭，不残留 streaming |
| AT-4 | 生产修复 | 主库部署新版重启 | 3 条孤儿消息置 failed（或入恢复队列），会话不再显示"运行中" |

### 能力测试映射
| 验收场景 | 能力测试文件 |
|---------|-------------|
| 全部 | n/a（A 类纯代码逻辑，单测覆盖） |

## 实现细节

### 改动范围
| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/db/migration.ts | 修改 | 追加 ensureSignalEventsTable / ensureRestartPendingResumesTable 并在 migrateDatabase 调用 |
| src/usecases/conversation/reconcile-orphans.ts | 修改 | 恢复登记循环体逐条 try/catch 隔离，异常降级 fail+notice |
| tests/frameworks/db/migration.test.ts | 修改 | 老库缺两表补建 + 幂等用例 |
| tests/usecases/conversation/reconcile-orphans-resume.test.ts | 修改 | 缺表降级用例（复现生产现场） |

### 测试结果

- `npx vitest run tests/frameworks/db/migration.test.ts tests/usecases/conversation/reconcile-orphans-resume.test.ts` → 21 passed
- `npx vitest run tests/usecases/conversation/resume-interrupted-service.test.ts tests/frameworks/db/schema.test.ts` → 11 passed（相邻面回归）
- `npx tsc --noEmit` → exit 0

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1/T2/T3 | 测试通过 + 行为符合预期 | ✅ |
| T4（生产） | 待合并部署后复验 | ❓ |

## 设计决策

- **补表放 migrateDatabase 而非手动改生产库**：迁移路径修复让所有存量库（含隔离验证实例）自动补建，一次修复全覆盖；生产库随版本部署重启时自动收敛。
- **逐条隔离而非整体 try/catch 掉登记阶段**：单条消息的登记异常（如该条参与者查询失败）只影响该条，其余消息的自动恢复资格不受株连。
