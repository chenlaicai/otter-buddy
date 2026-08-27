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
- `npx eslint`（四个改动文件）→ 0 error 0 warning
- **生产库副本演练（AT-4 前置证据）**：拷贝生产库（含 WAL）至隔离路径，跑 `migrateDatabase` + `reconcileOrphans` + 幂等复跑。结果：两表补建成功；3 条 streaming 孤儿全部置 failed；3 个孤儿 turn 全部关闭；恢复队列登记 3 条 pending（attempts=1）；streaming 残留归零；二次执行不报错。

### 证据判定
| 需求 | 证据状态 | 判定 |
|------|---------|------|
| T1（补表） | 测试通过 + 生产库副本演练通过 | ✅ |
| T2（隔离降级） | 测试通过 + 副本演练清理未中断 | ✅ |
| T3（盲区覆盖） | 新增 3 个用例覆盖缺表老库场景 | ✅ |
| T4（生产收敛） | 副本演练通过；生产部署重启后复验会话状态 | ❓（待部署） |

## 对抗审视记录

### 自检（2026-08-27，PR #505 提交后一轮）

| 检查项 | 结论 |
|--------|------|
| migration.ts 新增 DDL 与 schema.ts 逐列/逐索引机械比对 | 完全一致 |
| bootstrap 执行顺序：migrateDatabase（app.ts:163）先于 reconcileOrphans（app.ts:165） | 正确，补表必先于清理 |
| 全库缺表排查：initSchema 全部建表函数 vs 生产库 sqlite_master | 仅缺本 PR 两表，无其他漏网 |
| claimResume 事务原子性：抛错即回滚，不会出现"半登记"状态 | 无风险 |
| causal_links 上游文档存在性（rsme/mwrd/evaf） | 三者均存在 |
| CI 首跑失败：migration.ts 468 行超 max-lines 450 | 修复：文件级 eslint-disable + 理由注释（schema.ts 先例） |
| frontmatter 元数据 | 移除误填的 created_in_conversation（本工作非产自该对话） |

### 遗留观察项（非本 PR 范围）

- **同型缺陷第三次发生**（evaf→rhib→本次），约定只存在于 migration.ts 注释里。根治手段（如 initSchema/migrateDatabase 单一来源生成、或 lint 校验 initSchema 新表必须同步登记 migrateDatabase）值得独立立项。
- **隔日续写语义**：副本演练确认 3 条 8-26 的孤儿消息在部署后会被自动恢复（恢复队列已登记）。F20260826rsme 设计无中断时效窗口，隔天旧发言会被续写。是否加时效上限待产品判断。

## 设计决策

- **补表放 migrateDatabase 而非手动改生产库**：迁移路径修复让所有存量库（含隔离验证实例）自动补建，一次修复全覆盖；生产库随版本部署重启时自动收敛。
- **逐条隔离而非整体 try/catch 掉登记阶段**：单条消息的登记异常（如该条参与者查询失败）只影响该条，其余消息的自动恢复资格不受株连。
