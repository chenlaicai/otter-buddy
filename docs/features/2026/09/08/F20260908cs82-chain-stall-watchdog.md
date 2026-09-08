---
id: F20260908cs82
doc_type: feature
change_type: feature
capability_test: "n/a: 纯 A 类代码逻辑（确定性检测器 + Worker 轮询），无 LLM 行为依赖"
title: "编排链中断悬置告警（#822）：进程内看门狗 + RHI critical 信号"
summary: "新增 ChainStallWatchdogWorker：60s 轮询检测会话尾部中断型终态消息（30min 阈值），触发对话内系统告警 + RHI critical 信号 + 台账备注；熔断重启、搭档主动中断、429 限流终态排除在外。"
feature_id: F20260908cs82
created_in_conversation: 449d8f5d-e91e-49c0-ade5-0fbd9b3d0fcb
created_at: 2026-09-08
modules:
  - health
  - conversation
tags:
  - observability
  - signal-protocol
related_features:
  - F20260902ralt
  - F20260901sgpv
supersedes: []
from: []
intent:
  problem: "编排链中断（熔断/工具超时/服务重启）后会话悬置无告警，搭档无法感知（9/6 事故：20h 无消息无人发现）"
  expected_effect: "中断型终态消息超 30min 无人接续时，对话内系统告警 + RHI critical 信号至少一路触发"
  verify_by:
    type: behavior_check
---

# 编排链中断悬置告警（#822）

## 背景

2026-08-27 纸面交易 PR4 链中断 3 小时+无告警，靠人工发现。9/6 事故 20h 无消息。
Issue #822（母票 #695 终局批次 ③）要求：编排链中断后，30min 内可见告警。

## 与 RHI chain_stall 的分工

| 维度 | RHI chain_stall | 本看门狗 |
|---|---|---|
| 对象 | F 文档 PR 停滞（天级） | 编排链会话消息滞留（分钟级） |
| 节拍 | RhiScanWorker 1h | ChainStallWatchdogWorker 60s |
| 数据源 | git log + F 文档 | messages 表尾行 SQL |
| 信号类型 | `chain_stall` | `chain_stall_watchdog` |

两者独立，共用 RHI 信号语义框架（signal-registry 注册 + signals 表 upsert + critical 级）。

## 设计

### 新文件

- `src/usecases/health/chain-stall-watchdog.ts`：纯函数核心 `detectChainStallFromRows` + `ChainStallWatchdogWorker` 类（start/stop/inflightTick 模式对齐 RhiScanWorker）

### 挂载点

1. `src/app.ts`：装配 ChainStallWatchdogWorker（`startChainStallWatchdog` 开关，测试/CI 可关），shutdown 顺序对齐 RhiScanWorker
2. `src/usecases/health/signal-registry.ts`：新增 `chain_stall_watchdog` 信号类型（critical 级）
3. `src/usecases/health/signal-pipeline.ts`：`EXTERNALLY_MANAGED_SIGNAL_TYPES` 集合排除 watchdog 信号免被 RHI 1h auto-resolve 误关

### 判据

**中断型终态识别**（封闭集，文案来源 retry-policy.ts / orchestrator.ts / rate-limit-error.ts 单一来源）：
- `[系统保护] ...已自动中断`（各类 guard abort）
- `[系统保护] 该獭...已达熔断上限`（circuit break 终态）
- `[服务重启，发言中断]`（进程重启残留）
- `配额耗尽（429 限流终态），本轮发言已终止`（#845 严重发现 1 修复：429 限流终态尾部形态）

**排除项**（设计内行为或自动恢复路径）：
- `[搭档中断]`：用户主动停
- `自动继续执行中`：熔断重启恢复中
- `请手动重试` / `请人工介入`：已有明确人工指引

### 去重机制

- 对话内告警消息发出后成为该会话新尾行（非中断型）→ 下一轮天然 skip（幂等自带，无需去重表）
- signals 表 upsert occurrences 累加即去重（同会话同类型信号合并，无独立表）

### 信号生命周期

- 本 worker 自管 reconcile：本轮未复现的会话 → resolve 其 open signal
- signal-pipeline `EXTERNALLY_MANAGED_SIGNAL_TYPES` 排除 watchdog 信号免被 RHI auto-resolve 误关

### 三路告警（传感器分离，任一路失败不阻断其余）

1. `sendSystem` 注入对话内系统消息（搭档可见）
2. `signalRepo.upsert` 落 critical 信号到 signals 表（面板可见）
3. `dispatchAttemptRepo.appendNote` 给该会话 in_progress 台账行补备注（排查可见）

### 取舍

- 不走 URGENT steer：验收标准是「对话内系统消息 or RHI critical 信号」二者其一即可；URGENT 注入有 busyQueue/steer 打架风险（PR 里说明）

## 测试

A 类（时间可控注入）：四种场景全部通过
- AT-1：滞留触发（中断型消息 + 超阈值 → 告警）
- AT-2：有进展不触发（user/otter 活跃消息 → 无告警）
- AT-3：终态不触发（未超阈值 → 无告警）
- AT-4：重启残留排除（自动恢复消息 → 不告警）

## 变更文件

| 文件 | 变更 |
|---|---|
| `src/usecases/health/chain-stall-watchdog.ts` | 新增：检测器 + Worker |
| `src/usecases/health/signal-registry.ts` | 新增 `chain_stall_watchdog` 信号类型 |
| `src/usecases/health/signal-pipeline.ts` | `EXTERNALLY_MANAGED_SIGNAL_TYPES` 排除集合 |
| `src/app.ts` | 装配 + 启停生命周期 |
| `tests/usecases/health/chain-stall-watchdog.test.ts` | 新增：A 类四场景 + #845 修复覆盖 |
| `tests/usecases/health/signal-pipeline.test.ts` | #845 建议 2：EXTERNALLY_MANAGED 排除回归测试 |

## 验证

- [x] 已过最简检查（纯函数 + Worker 类，无额外依赖）
- [x] 测试全部通过（21/21）
