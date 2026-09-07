---
id: F20260907usti
doc_type: feature
change_type: feature
title: "URGENT steer 注入：信号路由 URGENT+busy 分支改调 steerSession（P3a 批次 ①）"
summary: "P3a ①：signal-router 的 URGENT+busy 分支改调 agentGateway.steerSession 注入打断询问文案，成功写销账行防双投递，不可达降级 busyQueue。"
feature_id: F20260907usti
created_in_conversation: 449d8f5d-e91e-49c0-ade5-0fbd9b3d0fcb
created_at: 2026-09-07
status: active
modules:
  - conversation
  - agent-runtime
tags:
  - signal-protocol
  - invoke-loop
related_features:
  - F20260901sgpv
  - F20260907grdr
  - F20260907ylfs
supersedes: []
from: []
intent:
  problem: "URGENT 信号到 busy 獭时仍走 busyQueue 排队消化，无即时打断通道——URGENT 的「必决策」档位语义在物理层无落地"
  verify_by: "unit_test"
  expected_effect: "URGENT+busy 信号通过 steerSession 注入打断询问文案，成功即销账防双投递；不可达时降级 busyQueue"
capability_test: "n/a: 纯路由层改动（signal-router busy 分支），无 prompt/skill/协议层变更，单元测试覆盖全路径"
---

# URGENT steer 注入（P3a 批次 ①）

## 背景

P3a 打断轻量版三件套之①（③ 梯度护栏 F20260907grdr 已合入；② yield-to-self F20260907ylfs 已合入）。

信号协议 P1 阶段（F20260901sgpv），`routeTarget` 的档位矩阵定义了 URGENT+busy 应调 `steerSession`（P3），但实际实现仍走 busyQueue 排队消化——与 NORMAL 语义无差异，URGENT 的「必决策」档位在物理层空壳。

本次实现打通 URGENT+busy 的 steer 注入通道：调用 `agentGateway.steerSession`（pi-session-factory.ts 的闭包注入方法，前缀扫描匹配活跃 session）向目标獭注入打断询问文案，成功即销账防双投递，不可达时降级 busyQueue（现状语义，安全侧）。

## 变更说明

### 代码变更

| 文件 | 变更 |
|------|------|
| `src/usecases/otter/agent-gateway.ts` | `AgentGateway` 接口新增可选方法 `steerSession(otterId, text): boolean` |
| `src/usecases/conversation/signal-router.ts` | deps 新增可选 `agentGateway`；`routeTarget` 的 busy 分支加 URGENT→steer 路径；`trySteerInjection` 私有方法提取 steer+销账逻辑 |
| `src/app.ts` | SignalRouter 构造时注入 `agentGateway`（`PiSessionFactory` 实例） |
| `tests/usecases/conversation/signal-router.test.ts` | 新增 7 个测试用例覆盖 URGENT steer 全路径 |

### 核心逻辑

1. **steer 注入**：`routeTarget` 的 `busy` 分支，当 `level === "URGENT"` 时调 `trySteerInjection`
2. **文案模板**：
   ```
   【URGENT 打断询问】来自 {sender} 的急迫信号：{reason}
   建议：你可以在完成当前工具调用后选择：继续手头工作（新信号留箱，完成后处理）或转向处理（读取箱内新消息）。不需要显式回答，你的下一个行动就是答案。
   ```
3. **销账（防双投递）**：steer 成功后写 `dispatch_attempts` 行（status='completed', note='steered'）——否则 `pendingClause` 判定仍 pending，invoke 完成检查会二次路由 = 双投递
4. **降级链**：steer 不可达（返回 false）或异常 → 降级 busyQueue（安全侧，现状语义）

### 设计取舍

- **轻量版**：纯 prompt 注入，无结构化出口解析（母方案 §3 的 `{decision}` schema 归 P3b）
- **信号消费**：信号仍留消息表（UI/上下文可见），但路由语义已消费（销账行 = completed）
- **崩溃边界**：steer 失败回落 busyQueue 后进程崩溃 → busyQueue 内存态丢失，消息表信号仍在，重启补扫重新路由 = 相当于重新投递，可接受

## 验证

### 测试覆盖

| 场景 | 预期 | 测试位置 |
|------|------|----------|
| URGENT + busy → steerSession 返回 true | 返回 invoked + 写销账行（completed, steered） | `signal-router.test.ts` |
| URGENT + busy → steerSession 返回 false | 返回 queued_busy（降级 busyQueue） | `signal-router.test.ts` |
| URGENT + busy → 无 agentGateway | 返回 queued_busy（安全降级） | `signal-router.test.ts` |
| NORMAL + busy | 不调 steerSession（不误伤） | `signal-router.test.ts` |
| URGENT + busy → steerSession 抛异常 | 返回 queued_busy（安全侧） | `signal-router.test.ts` |
| URGENT + idle | 正常点火，不走 steer 路径 | `signal-router.test.ts` |
| URGENT + busy + 无 signalMeta | reason 默认值，steer 正常 | `signal-router.test.ts` |
| URGENT + busy + 销账写入异常 | 仍返回 invoked（注入成功，记账失败不阻断） | `signal-router.test.ts` |

### 自检结果

- [x] 全量 vitest：3102 passed (247 files)
- [x] eslint：0 errors
- [x] build：成功
- [x] pre-existing 问题：无（全量测试基线通过）

### 最简实现检查

已过最简检查：
1. 仓库已有实现 → `pi-session-factory.steerSession`（③落地的闭包注入方法）
2. 路由器直调 agentGateway → 不新增依赖/模块/文件
3. `AgentGateway` 接口扩展为可选方法 → 零破坏性变更
4. 销账用现有 `recordStart` + 现有 status='completed' → 不新增 repo 方法
