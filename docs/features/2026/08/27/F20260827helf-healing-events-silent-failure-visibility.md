---
id: F20260827he2f
title: healing-events-silent-failure-visibility
summary: |
  修复熔断重启后 healing events 未落库但健康检查链路失明的缺陷。
  根因：healingRepo.create() 抛错被 recordDegenerateHealingEvent 和 writeCircuitBreakEvent
  的 try-catch 静默吞掉，error 级别日志缺失或上下文不足，健康检查无可观测信号。
  修复：增加 probeHealingRepo 启动探针 + error 级别日志含完整上下文 + 集成测试验证真实 SQLite 落库。
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc

causal_links:
  from:
    - F20260818cbkr
    - F20260827mtbl

status: development
change_type: fix
tags: [healing, circuit-breaker, observability, diagnostics]
modules:
  - src/interface-adapters/agent-runtime/circuit-break-support.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/bootstrap/platforms.ts
capability_test: "tests/interface-adapters/agent-runtime/circuit-break-healing-persist.test.ts"
---

# F20260827helf: healing_events 熔断落库失明修复

## 背景与需求

### 问题描述

issue #508：8-26 02:33 熔断重启已发生（对话 3241317b seq 241/242），但 healing_events 当日落库 0 条。
对照组 8-24 三例均有 degenerate + circuit_break 配对落库。健康检查链路对此失明——
无法检测 healing events 写入是否正常工作。

### 根因分析

healing_events 写入链路有两层静默吞错：

**断点 1（orchestrator.ts `recordDegenerateHealingEvent`）：**
degenerate guard 触发时调用 `callbacks.recordHealingEvent()`，若 `healingRepo.create()` 抛错，
catch 块仅 `logger.warn('degenerate healing event record failed (non-fatal)')`——
warn 级别在生产日志中易被淹没，且上下文不足（缺 errorType/conversationId）。

**断点 2（circuit-break-support.ts `executeCircuitBreakRestart`）：**
restart 成功后调用 `writeCircuitBreakEvent()`，若 `healingRepo.create()` 抛错，
`.catch()` 仅 `logger.error('circuit_break event write failed...')`——
error 级别有但日志措辞误导（"marker missing"暗示只是标记丢失，实际是整个事件丢失）。

**断点 3（circuit-break-support.ts `recordHealingEvent`）：**
核心写入方法无 try-catch——错误直接向上冒泡，被断点 1/2 的 catch 吞掉。
调用方无法区分"写入成功"和"写入失败但被静默忽略"。

**系统设计因素：**
测试"半成功路径（S1）"明确覆盖了 circuit_break 事件写入失败的场景——
系统被设计为容忍 healing event 写入失败（restart 不被阻塞）。
但这种容错设计使写入失败完全不可观测。

### 数据对比

| 日期 | 熔断事件 | healing_events 落库 | 诊断信号 |
|------|---------|-------------------|---------|
| 8-24 | 3 例 | 3 对 degenerate+circuit_break | 正常 |
| 8-26 | 1 例 | 0 条 | **无任何错误日志可见** |

## 方案设计

### 技术方案

1. `CircuitBreakSupport.recordHealingEvent` 增加 try-catch + error 级别日志（含完整上下文：otterId/messageId/conversationId/errorType），捕获后重新抛出
2. `CircuitBreakSupport` 新增 `probeHealingRepo()` 健康探针——启动时调用一次，验证 DB 可达且 healing_events 表存在
3. `AgentInvoker` 暴露 `probeHealingRepo()` 公共方法，供外部健康检查调用
4. `initAgentAndScheduler` 启动时调用探针，失败仅 warn（不阻塞启动）
5. orchestrator.ts `recordDegenerateHealingEvent` warn→error 级别升级 + 完整上下文
6. 集成测试用真实 SQLite（非 mock）验证事件落库

### 目标

- T1: healing event 写入失败时有 error 级别日志 + 完整上下文，健康检查可观测
- T2: 启动探针能在服务启动时检测 healing_repo 不可达
- T3: 集成测试覆盖真实 SQLite 落库路径

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | 启动探针 | 正常 DB 启动 | probeHealingRepo 返回 true，无 error 日志 |
| AT-2 | 探针检测不可达 | DB 关闭后调用 probe | 返回 false + error 日志含 "probe failed" |
| AT-3 | degenerate 落库 | 调用 recordHealingEvent(degenerate) | DB 中有对应记录 |
| AT-4 | circuit_break 落库 | 调用 recordHealingEvent(circuit_break) | DB 中有对应记录（含 context.newSessionId） |
| AT-5 | 配对落库 | 先写 degenerate 再写 circuit_break | DB 中两条记录，errorType 配对正确 |
| AT-6 | 写入失败可观测 | DB 关闭后调用 recordHealingEvent | 抛错 + error 日志含完整上下文 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1 ~ AT-6 | tests/interface-adapters/agent-runtime/circuit-break-healing-persist.test.ts |

## 实现细节

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/interface-adapters/agent-runtime/circuit-break-support.ts | 修改 | +probeHealingRepo 探针 + recordHealingEvent try-catch + error 日志增强 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 修改 | +probeHealingRepo 公共方法 |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | 修改 | recordDegenerateHealingEvent warn→error + 完整上下文 |
| src/bootstrap/platforms.ts | 修改 | initAgentAndScheduler 启动时调用探针 |
| tests/interface-adapters/agent-runtime/circuit-break-healing-persist.test.ts | 新增 | 6 个集成测试（真实 SQLite） |

### 测试结果

- `npx vitest run tests/interface-adapters/agent-invoker-circuit-break.test.ts` → 8 passed（既有回归）
- `npx vitest run tests/interface-adapters/agent-runtime/circuit-break-healing-persist.test.ts` → 6 passed（新增集成测试）
- `npx tsc --noEmit` → exit 0

## 设计决策

- **probe 失败不阻塞启动**：healing_events 是观测增强，不是核心功能。阻塞启动会导致整个服务不可用。
- **recordHealingEvent 重新抛出错误**：调用方（orchestrator/circuit-break-support）已有 try-catch 处理，重新抛出让调用方能区分成功/失败。
- **集成测试用真实 SQLite**：mock 测试只能验证调用关系，无法验证实际 DB 落库（issue #508 的核心痛点）。
