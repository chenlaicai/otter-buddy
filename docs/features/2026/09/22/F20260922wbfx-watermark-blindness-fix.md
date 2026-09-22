---
id: F20260922wbfx
title: 水位失明修复：防线放弃时留痕 + no_yield 失败文案带真实死因
change_type: fix
created: 2026-09-22
created_in_conversation: 0e4ddb3d-0c01-4017-a9cc-bc07721589b5
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
summary: "9/22 事故：《issue处理》大獭 kimi-256k ctx 从 84k 涨到 268k 超 40k 交接阈值，但水位交接从未触发（watermark exceeded 日志 = 0）；18:40 SDK threshold 压缩触发但摘要失败，compaction_end(errorMessage) 无人消费；19:00 两次重试开口即截断 → no_yield 死循环，失败文案「未调用 yield」完全误导。三条防线各自静默失明。修复：①水位判定每次留痕（debug 日志带 lastCtxTokens/threshold/triggered）；②compaction_end 携带 errorMessage 时 warn 上浮；③no_yield 耗尽 + lastStopReason=length 时失败文案写明截断。修法排序①（既有机制语义内修），Modification-Class: narrow-fix。"
tags: [watermark, handoff, compaction, reliability, observability]
capability_test: tests/interface-adapters/agent-invoker-watermark-blindness.test.ts
from: [F20260920uhuc, F20260922handoff]
---

# 水位失明修复（F20260922wbfx）

## 问题（9/22 事故实证）

《issue处理》对话的大獭（kimi-256k，handoffThresholdTokens=40000）：

| 时间(CST) | 事件 | ctx_window_used |
|---|---|---|
| 15:19 | 手动重启换 kimi-256k，首轮 completed | 84,963 |
| 15:53~17:47 | 每轮 completed，ctx 单调上涨 | 97k → 228k |
| 18:40 | 搭档点重试 → aborted（4 秒） | — |
| 18:48~18:57 | 50 工具调用后 length 截断 → no_yield → 重试又截断 → failed | 261,550 |
| 19:00:14 | 自动恢复重试 → 开口即截断 → failed（5 秒） | 264,990 |
| 19:00:41 | 搭档再点 → 同样死法 | 268,430 |

**三条防线全部静默失明**：
1. **应用层水位交接**：每轮 ctx 都超 40k 阈值，但 `watermark exceeded` 日志全量为 0——判定恒 false 且无日志，断在守卫链哪一环不可知
2. **SDK threshold 压缩**：18:40 pre-prompt 检查触发了（228k > 212k 线），compaction_start→end 0.7 秒，但摘要失败（`getSummarizationFailure` fail-closed）→ `compaction_end(errorMessage)` 经 `_emit` 到达 otter 侧，但 otter 只记 metrics 不读 errorMessage——呼救被静默吞掉（`session_compact_failed` 走 extension 通道，`session.subscribe` 收不到）
3. **SDK recoverable length**：`_overflowRecoveryAttempted` 一次性布尔，18:48 用完后 19:00 静默 `return false`

失败文案「[系统] 重试后仍未调用 yield 工具」完全误导——真实死因是输出撞 token 上限截断。

## 修复（修法排序①：既有机制语义内修）

机制识别检查点：不新增配置/状态/定时任务/信号类型/持久化/决策分支/跨模块调用——`session_compact_failed` 是 SDK 已有事件的消费而非新增。全部命中①。

1. **水位判定留痕**（agent-invoker.ts `shouldTriggerWatermarkHandoff`）：每次判定 debug 日志带 `{ lastCtxTokens, threshold, triggered }`——防线放弃时可见，下次事故可直接定位断在守卫链哪一环
2. **compaction 失败上浮**（agent-invoker.ts `handleStreamEvent`）：`compaction_end` 携带 `errorMessage` 时 `logger.warn('SDK compaction failed')`——SDK 呼救有人听
3. **失败文案带真实死因**（orchestrator.ts `handleYieldRetry` + types.ts `InvokeResultShape.lastStopReason` 透传）：`lastStopReason === 'length'` 时失败文案写明「模型输出被 token 上限截断（stopReason=length）——上下文可能已接近窗口上限，建议重启獭生或换更大窗口模型」

## 未修复的残留疑点（诚实标注）

断点1 的完整根因未钉死：静态推演与复现测试均显示 no_yield 失败路径的 ctxTokens 写回链路通（`executeTurn` 正常返回 → `setLastCtxTokens` 执行），但生产日志证明 19:00 入口 `getLastCtxTokens` 返回 undefined。可能形态：写回后某路径清空了状态（`clearLastCtxTokens` 的四个调用点之一在两次 invoke 间触发），或 `result.ctxTokens` 在特定条件下为 undefined。修复1 的留痕正是为此：下次复现时日志会直接显示判定细节。**本 PR 不声称断点1 已根治，只把失明变成可见。**

## Verification（bugfix 硬规则）

失败证据固化（修复前红 → 修复后绿）：

```
修复前：Tests 2 failed | 1 passed（断点2 compaction 失败无 warn、断点3 文案误导）
修复后：Tests 3 passed（断点1 写回语义锁 + 断点2 warn 上浮 + 断点3 文案带截断）
```

- `tests/interface-adapters/agent-invoker-watermark-blindness.test.ts`（3/3）
- 全量回归：277 文件 3794 测试全绿、lint 0 error、tsc 0 错、build 成功

## 影响范围

- 水位交接：行为不变（判定逻辑未动），只是每次判定留 debug 痕
- SDK 压缩：行为不变，失败时多一条 warn 日志
- no_yield 失败：文案变化（length 截断时），前端 failed 气泡显示真实死因
- 运行时零 schema/配置变更
