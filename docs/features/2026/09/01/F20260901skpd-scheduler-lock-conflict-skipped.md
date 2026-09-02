---
id: F20260901skpd
title: scheduler 锁冲突语义区分：并发冲突记 skipped 不计败
summary: 修复 #654 锁冲突误记 failed 致 3 连败 auto_deactivated 误伤——并发冲突（session 锁被活跃方持有）execution 记 skipped 不计败，真失败仍 failed 计败
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# scheduler 锁冲突语义区分：并发冲突记 skipped 不计败（#654）

## 背景与问题

F20260901schd 审视（S5）曾发现特性文档声称「Lock acquire timeout 降级 skipped」但代码零实现——PR #651 删掉了承诺面，但问题本身真实存在，拆出本 issue。

2026-09-01 09:16 实例：健康检查定时任务补触发撞上调查会话持锁（`session:<otterId>` 锁被人工调查占用，30s acquire 超时），execution 记 `failed` 并计入 `consecutiveFailures`——3 连败后任务被自动停跑（status=error），需人工恢复。

**语义错位**：锁被活跃方持有是并发冲突，不是任务本身失败。持有者一旦异常（stale），SimpleLockManager 的 steal 机制（5min 阈值）会强占；能等到 30s 超时的持有者必然是活跃的并发方（人工调查、并行任务等）——这种冲突不该消耗任务的失败配额。

## 错误分界设计（核心决策）

### 决策 1：判据 = 错误 message 前缀 + 类型化错误双信道

锁错误传播链上身份会被销毁一次（详见决策 2），无法全程依赖 instanceof。设计双信道判据：

| 信道 | 路径 | 判据 |
|------|------|------|
| 类型化（新） | 非链路径：PiSessionFactory.acquire 超时抛 `SessionLockConflictError` → orchestrator classifyExit 归为 api_error → failTerminal……**会被销毁**，见下 | instanceof |
| 字符串前缀（兜底） | 链路径：错误经 failTerminal 写进 failed 消息体 → assertNoFailedMessages 反推抛错，message 含 `[错误] Lock acquire timeout` 前缀 | `SESSION_LOCK_TIMEOUT_MESSAGE` 常量前缀匹配 |

**判据落点**：`src/entities/errors.ts`——错误在 frameworks/agent 产生、usecases/scheduler 消费，分层规则禁止 usecases import frameworks（D39 仅豁免 logger），判据常量必须放双方可达的最内层。

**Why 不改 orchestrator 的 api_error 路由**：failTerminal 把错误写进消息体是 #517 的记账设计（消息状态是唯一事实源）；在 orchestrator rethrow 锁错误会破坏这个设计（消息停在非终态、链引擎行为变化），侵入面大。scheduler 作为记账决策点，从最终错误字符串识别锁冲突即可——两条路径最终收敛到同一处 catch。

### 决策 2：锁冲突的记账位置——execution 记 skipped + rethrow

- execution record 已存在（createExecution 在 invoke 之前），置 `status='skipped'` + errorMessage 留痕
- **不调** `incrementConsecutiveFailures` → 3 连败熔断不触发 → auto_deactivated 不误伤
- **仍 rethrow**：调用方语义各异（once 任务重试、手动触发者需感知），锁冲突不算触发成功
- metrics：`recordTrigger(type, 'skipped')`——metrics port 类型早已含 skipped，零改动

### 决策 3：DB 枚举扩展——scheduled_task_executions 加 skipped 值

老库 CHECK 约束 `(running, completed, failed)` 不含 skipped，写入即抛 constraint violation。SQLite 不能 ALTER CHECK，migration 走四步重建（CREATE→INSERT→DROP→RENAME，先例 rebuildDocumentTablesDropCheck）。新库 schema.ts 同步加值。幂等：检测 sqlite_master 的表 DDL 是否已含 'skipped'。

### 覆盖范围说明

锁冲突的两个发生点都收敛到 invoke 阶段的 catch：

1. **invoke 撞锁**（createSystemMessage 之后）：execution 记 skipped
2. **restartBeforeInvoke 撞锁**（消息创建之前，catch 降级后继续 invoke 也会撞锁）：最终由 invoke 分支统一处理——无需单独分支

claim 冲突（#641 已修）不涉及 execution record（记 skipped 在 createExecution 之前），与本 PR 正交。

## 变更文件

| 文件 | 变更 |
|------|------|
| src/entities/errors.ts | +`SESSION_LOCK_TIMEOUT_MESSAGE` 常量、`SessionLockConflictError` 类、`isSessionLockConflictError()` 判据 |
| src/frameworks/agent/session-helpers.ts | SimpleLockManager 超时抛 `SessionLockConflictError`（message 不变，兼容既有断言） |
| src/entities/scheduled-task/scheduled-task.ts | ExecutionStatus 加 'skipped' |
| src/frameworks/db/schema.ts | scheduled_task_executions CHECK 加 'skipped'（新库） |
| src/frameworks/db/migration.ts | +rebuildExecutionsStatusCheck（老库四步重建，幂等） |
| src/usecases/scheduler/scheduler-service.ts | invoke catch 分支：锁冲突 → handleExecutionSkipped（skipped + 不计败）+ rethrow |
| web/src/lib/mappers.ts、web/src/pages/conversation/ExecutionHistoryModal.tsx | 前端类型加 skipped；图标 SkipForward/琥珀色标签「跳过」 |

## 验证

- 新增测试 7 个（scheduler 4 + migration 3）：
  - 类型化锁错误 → skipped、consecutiveFailures 不增
  - 链路径反推（字符串前缀）→ 同样 skipped
  - 连续 3 次锁冲突不触发 auto_deactivated（今早现场复现防护）
  - 真执行失败负对照 → 仍 failed 计败 3 连熔断（既有语义不变）
  - migration 老库重建/幂等/新库直通
- vitest 全量 197 文件 2467 测试通过；tsc 零错误；eslint 0 error（6 warning 均为 pre-existing）
- web tsc --noEmit + vite build 通过

**最简实现检查**：已过。评估过更简方案——仅改 scheduler 字符串匹配（不动 entities/frameworks），但无法覆盖类型化路径且判据散落两处；仅加类型化错误（不动 DB）则 execution 无法记 skipped（CHECK 拒收），留痕缺失。当前方案 7 文件是最小完备集。

**capability_test: n/a**（纯 A 类代码逻辑改动，无 LLM 行为变化——错误分类与记账路径全由代码决定）

## Discovered Issues

无。
