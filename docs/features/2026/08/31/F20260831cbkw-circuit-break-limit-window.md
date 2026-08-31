---
id: F20260831cbkw
title: 熔断上限年龄窗口——session 证明健康后允许再次熔断
summary: |
  熔断创建的 session 若已正常存活超过阈值（默认2h），视为「已证明健康」，
  后续退化重新给一次熔断机会；上限命中时发系统通知搭档。
change_type: fix
created_in_conversation: 7df22e6e-caba-4fc9-a3ab-1e9e2a3ff02d
---

# 熔断上限年龄窗口（F20260831cbkw）

## 背景与需求

F20260818cbkr 设计了 session 级熔断上限保护：若当前 session 已由熔断创建（`isCircuitBreakCreatedSession` 查 healing_events 的 circuit_break 事件、context.newSessionId 指向当前 session），再退化时直接 abort 终态，不再熔断。

**设计意图**：防止无限 restart 循环。

**设计缺口**：8/30 墨鱼案例暴露了「上限后无恢复」的问题——

- 8/29 07:57：session `396f3bb3` 由熔断创建
- 之后正常工作 8 小时（大量新上下文）
- 8/30 08:07：新退化 → 被上限判定拦住 → 僵尸 session

8 小时正常工作后，退化根因是新上下文污染而非模型缺陷，此时应再给一次熔断机会（清空污染上下文重启），却被当「无药可救」终态了。

## 修复方案

### 核心：session 年龄窗口

在 `isCircuitBreakCreatedSession` 判定中增加时间维度：

- 熔断创建的 session 若已正常存活超过阈值（默认2h），视为「已证明健康」
- 后续退化退出上限分支、允许再次 circuit break + restart
- 阈值常量 `HEALTHY_SESSION_THRESHOLD_MS`（2h），同时暴露到 config `circuitBreaker.healthySessionThresholdMs`

### 辅助：上限命中通知

真的走到 abortTerminal 上限分支时，发系统消息告知搭档（现状是静默死，搭档 8 小时后才发现）：

```
[系统保护] 该獭连续输出退化且已达熔断上限，发言已中断。如需恢复请重启该獭。
```

## 代码变更

| 文件 | 变更 |
|------|------|
| `src/interface-adapters/agent-runtime/circuit-break-support.ts` | `isCircuitBreakCreatedSession` 增加 session 年龄窗口判定，从 deps 读取配置阈值（不再硬编码）；`isSessionCircuitBreakCreated` 传 session 对象；`maybeSecondaryCircuitBreak` 调用适配 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 接收 `healthySessionThresholdMs` 配置并透传给 `CircuitBreakSupport` |
| `src/bootstrap/platforms.ts` | 从 `appConfig.circuitBreaker.healthySessionThresholdMs` 注入配置 |
| `src/app.ts` | 将 `appConfig` 传入 `initAgentAndScheduler` |
| `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts` | `handleCircuitBreak` 上限命中分支增加 `sendSystem` 通知 + `system.message` SSE 事件（与主熔断路径对齐） |
| `src/frameworks/config-service.ts` | `circuitBreaker.healthySessionThresholdMs` 配置项（默认2h） |
| `tests/frameworks/config-service.test.ts` | 新增 `healthySessionThresholdMs` 解析测试（默认值 + 自定义值） |
| `config/config.yaml.example` | 新增 `healthySessionThresholdMs` 配置样例 |

## 测试

- 上限命中（窗口内）：session 由熔断创建且在2h窗口内再退化 → abort 终态 + 系统通知 ✓
- 窗口外允许再次熔断：session 已正常存活>2h → 允许再次熔断重启 ✓
- 边界测试：刚好在阈值边界（2h-1s → 阻塞，2h+1s → 允许）✓
- 配置生效验证：自定义阈值1h + session 存活90min → 允许再次熔断（默认2h会阻塞）✓
- 回归：现有8个熔断测试全绿 ✓
- 全量测试：2301/2301 通过 ✓
- config 解析测试：默认值 7200000ms + 自定义 3600000ms ✓

## 与 F20260818cbkr 的关系

本文档是 F20260818cbkr 的补丁——修复其设计缺口（上限后无恢复策略），不改变熔断重启的核心流程。

## 未覆盖

- P1（重试循环防复述）和 P2（可观测性）后续独立 PR
- 阈值2h 为初始值，需实际运行数据验证是否合适
