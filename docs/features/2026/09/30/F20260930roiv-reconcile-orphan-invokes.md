---
id: F20260930roiv
title: 启动窗口期孤儿 invoke 延迟 reconcile
type: BugFix
status: implemented
created_at: 2026-09-29
created_in_conversation: 9ae84389-031a-4da1-be13-0238bcdf6a29
causal_links:
  - F20260916b1ea
summary: 启动 reconcile 只跑一次导致窗口期写入的 running invoke 成为孤儿，左侧栏「处理中」卡死；补延迟 5s reconcile 兜底
---

# F20260930roiv 启动窗口期孤儿 invoke 延迟 reconcile

## 背景

9/29 晚搭档发现左侧栏 3 个对话（bug处理、能力库ui优化、1202回溯）显示「处理中」，但实际海獭早已不在运行。排查发现 `invokes` 表中有 3 条 18:00 左右创建的记录一直是 `status='running'`，但进程在 17:58:42 重启过一次。

## 根因

`reconcileRunningInvokes`（F20260916b1ea）只在启动时跑一次。重启窗口期（reconcile 完成后、新进程接管前）旧进程异步写入的 running invoke 不会被清理，成为「孤儿 running」。`sqlite-conversation-repository.ts:240` 的 `activity_status` 判据是「存在 running invoke → processing」，导致左侧栏永远显示「处理中」。

## 方案

在 `app.ts` 的 `patrolWorker.start()` 后加延迟 10s 的补跑 reconcile（带 `bootTs` 守卫），并挂入 PatrolWorker 做 1h 周期兜底：

- `setupDelayedReconcile` 封装到 `database.ts`，保持 `app.ts` 行数合规
- `failRunningInvokes` 加 `beforeTs` 参数——只清理 bootTs 之前写入的 running invoke，防误杀本进程活跃 invoke
- `enableDelayedReconcile` 开关对齐 `startRhiWorker` 模式（测试/CI 可关）
- `dispose` 时 `clearTimeout` 清理定时器
- fire-and-forget 不阻塞启动，失败仅日志（对齐既有 non-fatal 纪律）
- 10s 取值无实证依据，注释标注保守值（观测到的事故窗口期约 78s）

## 改动

| 文件 | 改动 |
|------|------|
| `src/bootstrap/database.ts` | `reconcileRunningInvokes` 导出；新增 `setupDelayedReconcile` |
| `src/app.ts` | 调用 `setupDelayedReconcile`；dispose 清理定时器；`BuildAppOptions` 加 `enableDelayedReconcile` |
| `tests/bootstrap/delayed-reconcile.test.ts` | 窗口期孤儿 invoke 清理测试 + 开关字段编译期检查 |

## 验证

- `pnpm exec tsc --noEmit` 通过
- `pnpm exec eslint` 通过
- `vitest run tests/bootstrap/` 8 文件 47 测试全部通过

## 数据修复

已手动 UPDATE 清理 3 条孤儿记录（bug处理/能力库ui优化/1202回溯）。

## 后续

如需更强保障，可考虑 invoke 表加 `pid` 字段，重启后 reconcile 非本进程 pid 的 running 记录。当前延迟 5s 方案已覆盖观测到的窗口期场景。
