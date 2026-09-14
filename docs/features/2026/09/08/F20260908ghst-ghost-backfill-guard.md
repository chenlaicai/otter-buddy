---
id: F20260908ghst
title: "agent-invoker backfill 堵漏：dissolved 獭拒绝补建 domain session + S2 事故存量清理（closes #753）"
summary: "S2 事故遗留闭环：agent-invoker 的 domain session backfill 兜底（F20260805rsto）不查 otter 状态，任何触达 dissolved 獭的 invoke 路径都会产生幽灵 otter_sessions 行（实证 12 条 active 行）。修复：backfill 前查 otter status，非 active 拒绝建行 + warn 留痕。配套一次性清理脚本：12 条幽灵行标 archived（保留考古），会话 31767a2b 的 617 条 failed 热循环消息物理删除。"
change_type: fix
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 303b94d4-b3ad-4de4-9ee4-2b54da95f9a2
tags: [agent-invoker, session, backfill, data-cleanup, s2-incident]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - tests/interface-adapters/agent-invoker.test.ts
  - scripts/cleanup-ghost-sessions-753.mjs
created_at: 2026-09-08
---

# agent-invoker backfill 堵漏 + S2 事故存量清理（closes #753）

## 背景

Issue #753（S2 事故遗留，#749 的 test plan 未闭环项）：

1. **幽灵 otter_sessions 行源头未修**：`agent-invoker.ts` 的 domain session backfill 兜底（F20260805rsto，意图是「有 agent 会话 ⟹ 有 active domain session」）在 invoke 时对**任何 otter** 补建行——包括 dissolved 獭。PR #749 修的是路由器不再点火 dissolved，但 backfill 是独立入口，S2 事故（9/2「No session or config found」42 秒热循环）期间给 dissolved 獭（6b1042ae 等）建行。
2. **614 条 failed 消息**（实为 617 条）：会话 31767a2b《mac touch bar》热循环产物，污染 memory 检索与统计口径。

## 修复

### 1. 源头堵漏（agent-invoker.ts buildDynamicContext）

backfill 分支加 otter 状态前置检查：

```typescript
const otter = await this.queryOtter.getById(otterId).catch(() => null);
if (otter && otter.status !== 'active') {
  this.logger.warn('Skip domain session backfill for non-active otter', { action: 'session_backfill_rejected', ... });
} else {
  // 原 backfill 逻辑
}
```

设计取舍：
- **不抛错**：dissolved 獭 invoke 本身是上游异常（路由器层 #749 已拦），本层拒绝补账 + warn 留痕即可，让后续路径因无 session 自然暴露问题，不在这里新增失败模式
- **`otter === null`（查询失败/獭不存在）时放行原逻辑**：宁可补账不误拦——backfill 的原始意图（F20260805rsto 修 restart 静默空操作）优先；查不到獭信息是瞬时故障，不该改变兜底语义
- 每次 invoke 本来就要查 `queryOtter.getById`（下方 otterType 查询），无额外读放大顾虑（一次额外查询，毫秒级）

### 2. 存量清理（scripts/cleanup-ghost-sessions-753.mjs）

一次性运维脚本（dry-run 默认 + --apply + 自动备份 + 单事务）：

- **A 类**：dissolved 獭的 12 条 active session 幽灵行 → 标 `archived`（archive_reason='ghost_cleanup_753'）。不物理删除——保留事故考古价值，archived 即脱离 active 视野
- **B 类**：会话 31767a2b 的 617 条 failed 消息 → 物理删除（级联 segments/events）。保留 76 条 completed 消息维持对话脉络

dry-run 实测输出：12 条幽灵行（9/2 S2 事故时段集中产生，含 issue 指认的 6b1042ae/检视獭-Swift 行）+ 617 条 failed 消息。

## 测试

`tests/interface-adapters/agent-invoker.test.ts` 新增 2 条：

1. **backfill 兜底**：active 獭无 session 时 createSession 被调用（原行为不回归）
2. **backfill 堵漏**：dissolved 獭 invoke 时 createSession **不被调用**，主流程不中断（#753 核心断言）

## 验证

- 新增测试 2/2 通过；`tests/interface-adapters/` 全量回归 40 文件 403 测试全绿
- `tsc --noEmit` 0 error，eslint 0 error
- 清理脚本 dry-run 实测：12 条幽灵行 + 617 条 failed 消息识别正确
- 最简检查：状态检查复用既有 queryOtter 端口，零新依赖；清理脚本对齐 cleanup-memory-pollution.mjs 既有模式
- **--apply 执行留给搭档**（数据写操作，跑前确认服务已停或接受备份回滚方案）

## Discovered Issues

无。（617 条 failed 消息的 memory 索引残留 2 条，由 memory FTS 重建自然消化，不单独处理）
