---
id: F20260923hspx
title: 交接换世锁旁路通道：resetForHandoff 根治交接自死锁 + 合成超窗预检 + 熔断计数清零
doc_type: feature
change_type: fix
created: 2026-09-23
created_in_conversation: f4982c33-edbf-4156-913d-aaac095ff485
modules:
  - src/usecases/otter/agent-gateway.ts
  - src/usecases/otter/manage-session.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - tests/interface-adapters/unified-handoff.test.ts
summary: "9/23 实证：更新 #1130 重启后 4 獭手动重启全部失败 Lock acquire timeout（holderHeldForMs 恂 ≈120s、queueLength=0——等的是自己）。根因（根本设计缺陷）：统一交接持冻结锁期间，换世 restartSession→archiveSession→reset() 复用 invoke 池复用锁路径二次取同一把 per-otter 锁——一把锁双目的 + 不可重入 = 自死锁。修法：AgentGateway.reset 增 channel 参数，handoff 渠道走 resetForHandoff 锁旁路变体，per-otter 锁退回单目的短临界区。配套：合成后 prompt 超窗预检（省 96s 必败等待）；裸重启成功后熔断计数清零（此前只 +1 永不清且内存态，永久熔断）。"
tags: [handoff, session-lock, deadlock, circuit-breaker, synthesis]
capability_test: "n/a: 并发时序修复，回归用例固化于 tests/interface-adapters/unified-handoff.test.ts（channel='handoff' 钉死 + 裸重启清零）"
causal_links:
  from:
    - F20260923hsyn
    - F20260920uhuc
    - F20260922handoff
---

# F20260923hspx：交接换世锁旁路通道

## 事故（9/23 实证，搭档三次急讯）

时间线（`data/logs/otter-buddy.log`，pid 56177，更新 #1130 + 重启后）：

| 时间 | 獭 | 事件 |
|---|---|---|
| 14:20:20 | `106a95b6` | 合成超窗 400（正确降级机械档案） |
| 14:21:56 | `2fa4c13c` | 合成超窗 400（同上） |
| 14:22:20 | `106a95b6` | **锁等满 120s 超时**（holderHeldForMs=121s，queueLength=0） |
| 14:23:56 | `2fa4c13c` | 同上 |
| 14:24:04 | `910e8796` | 同上（持锁 179s） |
| 14:25:34 | `cbed4bb9` | 同上（synthesizePast:false 纯重启也死在这） |

**关键证据**：每次超时 `queueLength=0`（超时者是队首）、`holderHeldForMs` 恒 ≈120s——**不是等别人，交接自己等的是自己**。

## 根因（根本设计缺陷，搭档要求停止打补丁后完整分析）

机制链条：

1. 统一交接管线（`unifiedHandoff`，agent-invoker.ts:973）持**交接冻结锁**（`acquireSessionLock` → `lockManager.acquire(session:{otterId})`，SimpleLockManager 不可重入）
2. 换世 `restartSession`（manage-session.ts:216）→ `archiveSession`（:123）→ `agentGateway.reset()` → pi-session-factory `reset()` **二次取同一把锁**
3. 二次取锁排在交接自己后面；SimpleLockManager 释放直接移交队首 waiter 且 heldAt 重置（session-helpers.ts:196-201），队首 waiter 看到的持有时长从 0 重新长
4. 等满 120s（handoffMode waiter 超时）时交接恰好还在持锁 → `Lock acquire timeout` → 上抛「交接未能完成」→ 降级裸重启（零档案，獭"变傻"）

**为什么这是设计缺陷而非锁时序**：per-otter 锁服务两个目的——invoke 池复用（毫秒级短临界区）与交接冻结（分钟级长临界区）。换世是交接的子步骤却复用池复用的代码路径 → 长临界区嵌套短临界区 + 不可重入 = 自死锁。此前补丁史（steal 阈值 #599 → stale 出池 F20260912nlb896 → handoffMode 120s F20260920uhuc → 本次拟议的 heldAt 纪元/hopeless 预检）都在弥补「锁不知道谁是合法持有者」——用互斥表达生命周期状态，永远修不完。

## 修法（根本，非补丁）

**Agent reset 渠道路由**：`AgentGateway.reset(otterId, context, channel)` 增加 `channel: 'normal' | 'handoff'` 参数：

- `normal`（缺省）：常规路径，自取 invoke 池复用锁（既有行为不变）
- `handoff`：走 `resetForHandoff` 锁旁路变体（pi-session-factory 直接调 `_resetInternal`，不取锁）——Precondition：调用方已持交接冻结锁（冻结窗口保证此刻无并发 invoke 动池位），旧 invoke 若仍活着由 `_resetInternal` 的 `pool.evict` 出池托管（不 dispose，与 `markStale` 同语义，F20260912nlb896 已验证）

**链路打通**：`restartSession/restartSession→archiveSession` 透传 channel；`unifiedHandoff` 换世调 `restartSession(..., 'handoff')`。per-otter 锁退回单目的（invoke 池复用短临界区）。

**配套修复**（同 PR，独立有效）：

1. **合成后 prompt 超窗预检**（agent-invoker.ts）：`trimMessagesToBudget` 只裁历史段，`previousSummary`/§⑤ 状态盘点等固定段在大 session 可超 `SYNTHESIS_FIXED_OVERHEAD_TOKENS=10K` 预算假设（9/23 实测 546KB jsonl 裁剪后合成请求仍超 kimi-256k 窗，白等 96s 才 400）。超窗直接跳过合成走机械档案，与合成失败同语义计一次失败（既有 ≥2 熔断机制接管结构性超窗死亡链）。
2. **裸重启成功后熔断计数清零**（agent-invoker.ts `bareRestart`）：此前 `recordHandoffFailure` 只 +1、`clearHandoffFailures` 只在合成成功时调，进程重启不恢复（内存态）——该獭会被永久熔断。裸重启成功 = 换世完成 = 失败链已断，必须清零。

## 设计取舍（机制预算四问，动手前作答）

1. **这次改的是什么机制**：交接换世通道——从「复用 invoke 池复用锁路径（`_acquirePooled`/`reset()`）」改为「`resetForHandoff` 隔离通道（冻结锁保护下直接 `_resetInternal`）」
2. **它管什么**：交接期间旧 invoke 生命周期与池位原子替换的协调语义
3. **后续机制**：per-otter 锁退回单目的（invoke 池复用毫秒级短临界区）后，`handoffModeKeys`/`HANDOFF_LOCK_WAITER_TIMEOUT_MS` 成为无害冗余（留作 waiter 超时保险，不新增复杂度）
4. **退役条件**：若未来交接管线连冻结锁也不再需要（如换世完全异步化），`acquireSessionLock` 与 `resetForHandoff` 可一并退役，回归单 `reset()`——本 PR 不追求这个远期态

## 影响范围

- 行为变化：仅交接换世路径（`unifiedHandoff` 内 `restartSession`）；`dissolve-otter`/`archiveSession` 常规调用方 channel 缺省 normal，行为不变
- 接口变化：`AgentGateway.reset` 增可选第三参（向后兼容）；`AgentGateway` 增可选方法 `resetForHandoff`（未实现时降级旧行为）；`ManageSession.archiveSession/restartSession` 增可选尾参（向后兼容）
- 无破坏性变更；无 DB 迁移；无软代码改动（Golden Gate / 锚点重放 / Intent 块 n/a）

## 验证

- 全量测试 3854 通过（279 文件），含 unified-handoff 20 例（新增 2 例回归：channel='handoff' 钉死 / 裸重启失败文案）
- tsc --noEmit 0 error；eslint 0 error
- 最简实现检查：已过——`resetForHandoff` 复用 `_resetInternal` 零重复；channel 参数复用既有 `AgentGateway.reset` 签名不新增方法面（`resetForHandoff` 为可选兜底，mock 兼容）；未引入新锁/新类
- 负面向验收：本次变更**绕过**了 invoke 池复用锁对交接换世的保护——论证：交接冻结锁（acquireSessionLock）已提供同等互斥（冻结窗口拒绝新 invoke 入队），且 `_resetInternal` 的 `pool.evict` 对并发旧 invoke 采用「出池不 dispose」策略（与 markStale 同语义，F20260912nlb896 已验证安全）；绕过的保护是冗余的（双重互斥），且正是死锁根因
