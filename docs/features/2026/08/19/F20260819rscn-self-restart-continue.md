---
id: F20260819rscn
title: self-restart-continue
doc_type: feature

summary: |
  修复海獭自重启后不继续工作的 gap：restart_otter(self) 标记 pendingRestart 后，
  SDK 不再直接执行 restart（避免打断 LLM），改为将信号透传到 agent-invoker 层，
  由 invoker 执行 restart + 递归调用 invokeConversationInner（獭在新 session 继续工作）。
  对齐已有的 circuit-breaker 重启+续跑模式。

causal_links:
  from:
    - F20260813rstrt   # restart-otter-and-scheduled-task：自重启机制
    - F20260818cbkr    # degenerate-session-reset-circuit-breaker：重启+续跑模式参考

status: implemented
change_type: feature
tags: [agent, session, restart, self-restart, continue, re-invoke]
modules:
  - src/usecases/ports/sdk-invoke-port.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
capability_test: "n/a: 纯 A 类改动（确定性逻辑，无 LLM 参与行为）"
created_at: 2026-08-19
---

# F20260819rscn: 自重启后獭继续工作

## 背景与需求

### 问题描述

F20260813rstrt 实现了海獭自重启机制（pendingRestart），但自重启后獭不继续工作：
- `pi-session-factory` 在 `session.prompt()` 返回后直接执行 restart + return
- 调用链结束 → invoke 完成 → 獭停止
- 缺少"restart 后自动 re-invoke"这一步

### 期望行为

海獭调用 `restart_otter(self)` 后：
1. 当前发言完成（不打断 LLM 生成）
2. 系统执行 restart（创建新 session）
3. **系统自动以新 session 继续 invoke**（獭在干净上下文中继续工作）

### 参考模式

`circuit-breaker`（F20260818cbkr）已有"restart + 续跑"模式：
- orchestrator 检测退化 → 设置 `_circuitBreak` 信号
- `agent-invoker.handleCircuitBreakSignal` 检测信号 → restart + 递归 `invokeConversationInner`
- 獭在新 session 中继续工作

自重启复用同一模式，触发条件不同（LLM 主动 vs 退化检测）。

## 方案设计

### 信号传递路径

```
LLM 调用 restart_otter(self)
  → tool-factory: 设置 toolContext.pendingRestart（不变）
  → pi-session-factory: 不再执行 restart，改为在 AgentRunResult 上设置 _selfRestart 信号
  → agent-invoker.createAttemptDriver: 闭包捕获 _selfRestart 信号
  → agent-invoker.invokeConversationInner: 检测信号 → handleSelfRestartSignal
  → handleSelfRestartSignal: manageSession.restartSession + 递归 invokeConversationInner
```

### 为什么用闭包而非 TurnResult

orchestrator 的 route handlers 手动构造 TurnResult（多处 return 路径），不透传未知字段。
`_circuitBreak` 能走 TurnResult 是因为 orchestrator 的 `handleCircuitBreak` 显式设置它。
自重启信号在 SDK 层产生，orchestrator 无感知——用闭包捕获比修改所有 return 路径更干净。

### handleSelfRestartSignal 设计

对齐 `handleCircuitBreakSignal`，但语义更简单：
- 不需要写 circuit_break healing 事件
- 不需要构建熔断摘要
- restart 成功 → 递归 invokeConversationInner（retryCount 归零）
- restart 失败 → 降级返回原始结果（不 re-invoke）
- re-invoke 失败 → 降级返回原始结果

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/usecases/ports/sdk-invoke-port.ts | 修改 | AgentRunResult 增加 `_selfRestart` 可选字段 |
| src/usecases/conversation/agent-turn-orchestrator/types.ts | 修改 | AttemptResult 和 TurnResult 增加 `_selfRestart` 可选字段 |
| src/frameworks/agent/pi-session-factory.ts | 修改 | pendingRestart 改为设置 `_selfRestart` 信号，不再直接执行 restart |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 修改 | createAttemptDriver 增加 onSelfRestart 回调；新增 handleSelfRestartSignal 方法 |
| tests/interface-adapters/agent-invoker-self-restart.test.ts | 新增 | 6 个测试覆盖 AT-1~AT-6 |

## 验收场景

| AT | 场景 | 操作 | 预期 |
|----|------|------|------|
| AT-1 | 自重启+续跑 | LLM 调用 restart_otter(self) → SDK 返回 _selfRestart | restart 执行 + 全新 invoke（獭继续工作） |
| AT-2 | 带 summary | _selfRestart 带 summary | summary 传入 restartSession |
| AT-3 | 无 summary | _selfRestart 无 summary | restartSession 收到 undefined summary |
| AT-4 | restart 失败 | manageSession.restartSession 抛错 | 降级返回原始结果，不 re-invoke |
| AT-5 | re-invoke 失败 | 第二次 invoke 抛错 | 降级返回原始结果 |
| AT-6 | 无信号 | SDK 不返回 _selfRestart | 行为不变（不触发 restart） |

## 证据判定

| AT | 证据状态 | 判定 |
|----|---------|------|
| AT-1 | 证明完成（单元测试通过） | ✅ |
| AT-2 | 证明完成（单元测试通过） | ✅ |
| AT-3 | 证明完成（单元测试通过） | ✅ |
| AT-4 | 证明完成（单元测试通过） | ✅ |
| AT-5 | 证明完成（单元测试通过） | ✅ |
| AT-6 | 证明完成（单元测试通过） | ✅ |

## 决策记录

- 2026-08-19：搭档报告"重启自己效果不完整、系统不会触发调用"。排查确认：pendingRestart 机制在 pi-session-factory 层执行 restart 后直接 return，缺少 re-invoke。
- 2026-08-19：技术拍板（大獭）：对齐 circuit-breaker 的 restart+续跑模式，用闭包捕获信号（比修改 orchestrator 所有 return 路径更干净）。

