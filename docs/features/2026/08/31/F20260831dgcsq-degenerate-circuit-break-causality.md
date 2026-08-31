---
id: F20260831dgcsq
title: "退化循环 P2：healing_events 因果链路可观测性"
summary: "degenerate 与 circuit_break 事件的因果链断裂修复——用 messageId 锚替代根因报告原案的事件 ID 锚（零签名变更，语义等价）。healing_events context 新增 preRetryMessageId（degenerate 事件）和 firstMessageId（circuit_break 事件），因果链可检索。"
change_type: fix
status: implemented
created_in_conversation: 7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/interface-adapters/agent-runtime/circuit-break-support.ts
  - tests/interface-adapters/agent-invoker-circuit-break.test.ts
tags:
  - degenerate
  - circuit-breaker
  - observability
  - healing-events
  - causality
from:
  - F20260818cbkr
  - F20260831dgrt
  - F20260831dgpr
related:
  - F20260831dgrt
  - F20260831cbkw
  - F20260831dgpr
---

# 退化循环 P2：healing_events 因果链路可观测性

## 背景

### 问题：因果链断裂

degenerate 事件与 circuit_break 事件之间的因果链不可检索——重试会创建新消息改变 messageId，无法从事件串出「同一退化链」。

### 问题现场

根因报告（`degenerate-loop-root-cause-report.md` P2 节 182-189 行）描述：healing_events 中 degenerate(retry=0, messageId=A) → degenerate(retry=1, messageId=B) → circuit_break 之间缺少关联锚点。

### 根因

`preRetryMessageId` 早已在 TurnInput 里（orchestrator.ts:140 填充）、`CircuitBreakInfo.firstMessageId` 也已流到熔断层，**只是都没进 healing 事件的 context**。

## 方案

### 设计决策：messageId 锚 vs 事件 ID 锚

根因报告原案（retryMessageId/triggerDegenerateEventId）需 `recordHealingEvent` 返回事件 ID（`void → string` 签名扩散）+ 跨 turn 状态传递。

**本案（messageId 锚）**：零签名变更，语义等价（事件本就带 messageId），两个字段落地即可贯通因果链。

检索方式：`findByConversation` + messageId 匹配（repo 接口已确认可用）。

### 最简实现检查

已过最简检查：原案需 recordHealingEvent void→string 签名变更 + 跨 turn 状态传递 + 事件 ID 查找——两字段补入 context 是最小变更，不改任何接口签名。

## 因果链语义（P1 路由下的实际链路形态）

P1（#623）合入后，退化路由分为三条路径，因果链形态各异：

### 链路 1：首退直接熔断（primary 路径）

```
degenerate(retry=0, messageId=A) → circuit_break(failedMessageId=A, firstMessageId=A)
```

非熔断创建 session 或超出 2h 窗口 → 首次退化直接熔断。`firstMessageId = preRetryMessageId ?? messageId`，因 retryCount=0 故 `preRetryMessageId` 为空，`firstMessageId = A`。单段链。

### 链路 2：保留路径 retry 自愈

```
degenerate(retry=0, messageId=A) ←[preRetryMessageId]← degenerate(retry=1, messageId=B)
```

熔断创建 session 且在 2h 窗口内 → 首次退化走 handleDegenerateRetry（内部 restart，不产生 circuit_break 事件）→ 重试成功。因果链止于 degenerate 对，无 circuit_break 收尾。

### 链路 3：保留路径 retry 再退化 → 上限 abort

```
degenerate(retry=0, messageId=A) ←[preRetryMessageId]← degenerate(retry=1, messageId=B) → 上限 abort
```

与链路 2 相同起点，但 retry=1 再退化 → handleCircuitBreak → isSessionCircuitBreakCreated=true（session 已由熔断创建）→ 上限 abort 终态（orchestrator.ts:397-434）。**无 circuit_break 事件**——abort 是终态，不走熔断。

### 链路 4：二级预检熔断 + 后续退化

```
degenerate(retry=0, A) + degenerate(retry=0, B) → [maybeSecondaryCircuitBreak restart] → circuit_break(failedMessageId=B, firstMessageId=A)
```

同一 session 内跨 turn 累积 ≥2 次退化 → 二级预检触发 restart → `writeCircuitBreakEvent` 写入 circuit_break 事件。`firstMessageId` = 窗口内最老的退化事件 messageId（DESC 排序末尾），`failedMessageId` = 窗口内最新的退化事件 messageId（DESC 排序头部）。

### 链路 5：fail-open 异常降级

```
degenerate(retry=0, A) ←[preRetryMessageId]← degenerate(retry=1, B) → circuit_break(failedMessageId=B, firstMessageId=A)
```

保留路径中 `isSessionCircuitBreakCreated` 抛错 → fail-open 回退到直接熔断 → `handleCircuitBreak` → `executeCircuitBreakRestart` → circuit_break 事件。全链闭合，仅异常降级场景。

### 检索方式

1. 从任意 degenerate 事件出发，按 `messageId` 或 `preRetryMessageId` 匹配关联事件
2. 从 circuit_break 事件出发，按 `firstMessageId` 回溯首条 degenerate 事件
3. `findByConversation(conversationId)` + 字段匹配

## 变更文件

| 文件 | 变更 |
|------|------|
| `orchestrator.ts:345` `recordDegenerateHealingEvent` | context 新增 `preRetryMessageId: ctx.input.preRetryMessageId`（仅 retry>0 时存在，条件展开） |
| `circuit-break-support.ts:423` `writeCircuitBreakEvent` | Pick 类型增加 `'firstMessageId'`；context 新增 `firstMessageId: info.firstMessageId` |
| `circuit-break-support.ts:238` secondary 路径调用点 | `failedMessageId: inWindow.latestMessageId`（窗口内最新事件）；`firstMessageId: inWindow.firstMessageId`（窗口内最老事件） |
| `circuit-break-support.ts:297` `countDegenerateInTurnWindow` | 返回值增加 `latestMessageId`；`firstMessageId` 取 `inWindow[inWindow.length-1]`（DESC 排序末尾 = 最老） |
| `tests/.../agent-invoker-circuit-break.test.ts` | 新增 preRetryMessageId 因果链锁定测试；AT-1/窗口外 firstMessageId 精确值断言；AT-4/叠加场景区分时间戳 |

### 三处调用点说明

1. **primary 路径（:187/196）**：`executeCircuitBreakRestart` 传入完整 `CircuitBreakInfo`，`firstMessageId` 已携带（:454 构造时 `ctx.input.preRetryMessageId ?? ctx.input.messageId`），Pick 类型扩展后自动进入 context
2. **secondary 路径（:238）**：`maybeSecondaryCircuitBreak` 传入 `{ otterId, conversationId, failedMessageId: inWindow.latestMessageId, firstMessageId: inWindow.firstMessageId }`——`failedMessageId` = 窗口内最新退化事件（触发熔断的那条），`firstMessageId` = 窗口内最老退化事件（因果链首锚）。二者区分场景：`failedMessageId` 用于 healing_events.messageId 定位触发消息，`firstMessageId` 用于因果链回溯

## 验证

- 测试通过：`tests/interface-adapters/agent-invoker-circuit-break.test.ts`（16 个测试）
- 测试通过：`tests/interface-adapters/agent-runtime/circuit-break-healing-persist.test.ts`（6 个测试）
- 全量测试：待 CI 验证

## 偏离根因报告原案记录

原案 retryMessageId/triggerDegenerateEventId 需 recordHealingEvent 返回事件 ID（void → string 签名扩散）+ 跨 turn 状态传递。本案 messageId 锚零签名变更，语义等价——事件本就带 messageId，用 preRetryMessageId 和 firstMessageId 两个 context 字段即可串联。

## PR 审视 delta 处置记录

### 第一轮审视发现（检视獭-因果链路，4 严重 + 1 建议）

**严重 1（secondary 路径 firstMessageId 语义错误）→ 已修**
- `findRecentByOtter` 是 DESC 排序，`inWindow[0]` 是窗口内**最新**事件而非首条
- 修复：`countDegenerateInTurnWindow` 返回 `latestMessageId`（DESC 头部 = 最新）+ `firstMessageId`（DESC 末尾 = 最老）；secondary 调用点 `failedMessageId: inWindow.latestMessageId`，`firstMessageId: inWindow.firstMessageId`

**严重 2（文档因果链与 P1 运行时不符）→ 已修**
- 文档原描绘 `retry=1 → circuit_break` 常规链路，实际保留路径 retry=1 再退化走**上限 abort**（无 circuit_break 事件）
- 修复：文档因果链节改写为 5 条实际链路形态（首退直接熔断 / 保留路径自愈 / 保留路径 abort / 二级预检 / fail-open）

**严重 3（测试锁定不足）→ 已修**
- `preRetryMessageId` 全测试目录零断言 → 新增「preRetryMessageId 因果链锁定」测试（retry=0 无锚 / retry=1 对齐首条 degenerate 的 messageId）
- `firstMessageId` 两处仅 `toBeTruthy()` → AT-1 改为精确值 `toBe("msg-1")`；窗口外熔断同理

**严重 4（特性编号双 ID）→ 已修**
- commit message / PR title 统一为 `F20260831dgcsq`（与文档/产物 groupId 一致）
- frontmatter `issue: 616` 移除（#616 是 P0 PR 编号，非 issue）

**建议 1（frontmatter from 缺根因报告）→ 已修**
- `from` 和 `related` 补入 `F20260831dgpr`（根因报告）
