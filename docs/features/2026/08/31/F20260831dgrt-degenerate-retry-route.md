---
id: F20260831dgrt
title: "退化循环 P1 修复：首次退化路由变更（直接熔断）"
summary: "首次退化直接熔断替代无效重试（87.5% 重试退化走向熔断），仅在 2h 窗口内熔断创建的 session 保留重试路径。"
feature_id: F20260831dgrt
change_type: fix
status: implemented
created_in_conversation: 7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d
date: 2026-08-31
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
tags:
  - degenerate
  - circuit-breaker
  - retry
  - routing
  - orchestrator
from:
  - F20260818cbkr
  - F20260831cbkw
related:
  - F20260818cbkr
---

# 退化循环 P1 修复：首次退化路由变更（直接熔断）

## 背景

DB 数据（8/19-8/30）：16 个 `retry>0` 退化事件中 14 个走向熔断（87.5%）。`handleDegenerateRetry` 的重试注入后，退化输出+系统提醒仍在上下文中，LLM 复述再退化，重试沦为无效中间步骤（每轮 8-14 分钟 LLM 执行）。8/21 阈值调优后重试退化 5 倍放大。

## 方案

### 路由变更（orchestrator.ts routeGuardAbort）

| 场景 | 旧行为 | 新行为 |
|------|--------|--------|
| 首次退化（retryCount=0）+ session 非熔断创建 | handleDegenerateRetry（重试） | **handleCircuitBreak（直接熔断）** |
| 首次退化 + session 由熔断创建且在2h窗口内 | handleDegenerateRetry | handleDegenerateRetry（保留） |
| 首次退化 + session 由熔断创建但超2h窗口 | handleDegenerateRetry | **handleCircuitBreak（直接熔断）** |
| retryCount>0 的再退化 | handleCircuitBreak | handleCircuitBreak（不变） |

### 路由决策逻辑

```typescript
// routeGuardAbort 中 degenerate_output + retryCount===0 分支
const isCircuitBreakSession = await ctx.callbacks.isSessionCircuitBreakCreated(otterId);

if (isCircuitBreakSession) {
  // 保留路径：熔断创建的 session 在2h窗口内——重试是上限保护下唯一的自愈机会
  return handleDegenerateRetry(ctx);
}

// 首次退化直接熔断（跳过无效重试，自愈更快更省）
return handleCircuitBreak(ctx);
```

### 重试文案增强

保留路径的 `handleDegenerateRetry` retryMsg 强化「忽略上文」语义：

```
[系统提醒] 忽略上面的消息，从本提醒开始重新组织输出。
你之前的消息出现了重复循环，已中断。
请忽略上文已检测为退化的内容，直接调用 speak 工具输出一次简短结论。
```

## 与 P0 的衔接

- P0（F20260831cbkw，PR #616）：`isSessionCircuitBreakCreated` 增加2h窗口判定——熔断创建的 session 正常存活超2h视为「已证明健康」，允许重新熔断
- P1 复用同一判定：路由层查询 `isSessionCircuitBreakCreated`，true=保留重试路径，false=直接熔断
- `handleCircuitBreak` 内部的上限判定逻辑不变（P0 刚合入，delta 稳定）

## 验证

- [x] 首退直接熔断：session 非熔断创建 → 无重试消息、一次 restart、系统熔断通知
- [x] 窗口内保留重试：session 由熔断创建（2h内）→ 走重试路径 → 重试再退化 → 上限 abort
- [x] 窗口外直接熔断：熔断创建但已超窗 → 首退直接熔断
- [x] 文案断言：重试提醒包含「忽略」语义
- [x] 现有熔断测试回归全绿 + 全量2303测试通过
- [x] 最简实现检查：已过——路由变更仅在 orchestrator.ts 增加 isSessionCircuitBreakCreated 查询分支，无新文件/新依赖
