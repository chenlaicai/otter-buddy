---
id: F20260817b3pr
title: tool-factory-rule-descent
doc_type: feature

summary: |
  批次 3 Part B：tool-factory 领域规则下沉到 usecases 层。
  将发言石路由校验和派工守卫逻辑从 interface-adapters 层下沉到 usecases 层，
  实现工具实现与领域规则分离。

causal_links:
  from:
    - F20260817a3rt
    - R20260817arnt

status: development
change_type: refactor
tags: [agent, architecture, tool, refactor]
modules:
  - src/usecases/conversation/talking-stone.ts
  - src/usecases/conversation/dispatch-guard.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
capability_test: "n/a: 纯代码逻辑重构（A 类），无行为变更"
---

# F20260817b3pr: tool-factory 领域规则下沉（批次 3 Part B）

设计依据：**R20260817arnt** Q2 tool-factory 领域规则下沉。

## 变更概述

将 tool-factory.ts 中的领域规则下沉到 usecases 层，实现工具实现与领域规则分离。

### 核心变更

1. **talking-stone.ts（纯函数）**
   - `resolveTalkingStoneTargets`：name->id resolve（NFC 归一化）
   - `validateAndResolve`：校验 + resolve，降低 execute 复杂度

2. **dispatch-guard.ts（状态挂 ToolContext）**
   - `checkPendingDispatches`：待派工票据的软守卫
   - `confirmDispatchesClear`：startSpeaking 提交成功后确认清除已派工票据

3. **tool-factory.ts 瘦身**
   - 删除原来的 4 个函数定义（~60 行）
   - 改为从 usecases 层导入

### 技术决策

- **为什么分离纯函数和状态操作？**
  - `talking-stone.ts` 包含纯函数，无状态依赖，可独立测试
  - `dispatch-guard.ts` 包含状态操作，依赖 ToolContext 的 pendingDispatches 字段

- **为什么保持触发时机在 tool-factory？**
  设计文档明确：触发时机（check/confirm 的调用序列）留 tool-factory，规则内容下沉。

## 实现内容

### 1. talking-stone.ts（纯函数）

**文件位置**：`src/usecases/conversation/talking-stone.ts`

**函数**：
- `resolveTalkingStoneTargets`：name->id resolve（NFC 归一化）
  - 输入：recipients（名字列表）、active（活跃参与者列表）
  - 输出：resolvedIds（解析后的 ID 列表）、invalid（无法解析的名字列表）
  - 特点：NFC 归一化、Set 去重

- `validateAndResolve`：校验 + resolve，降低 execute 复杂度
  - 输入：recipients、active、selfOtterId
  - 输出：resolvedIds、error（如果有）
  - 特点：校验空数组、自己传给自己、目标不在场

### 2. dispatch-guard.ts（状态挂 ToolContext）

**文件位置**：`src/usecases/conversation/dispatch-guard.ts`

**函数**：
- `checkPendingDispatches`：待派工票据的软守卫
  - 输入：ctx（ToolContext）、resolvedIds、recipients
  - 输出：提醒文案或 null
  - 特点：软守卫（非阻断）、二次放行

- `confirmDispatchesClear`：startSpeaking 提交成功后确认清除已派工票据
  - 输入：ctx（ToolContext）、resolvedIds
  - 特点：按"提交成功"清，非按"意图"清

### 3. tool-factory.ts 瘦身

**文件位置**：`src/interface-adapters/agent-runtime/tools/tool-factory.ts`

**变更**：
- 删除原来的 4 个函数定义（~60 行）
- 改为从 usecases 层导入：
  - `import { validateAndResolve } from "@usecases/conversation/talking-stone";`
  - `import { checkPendingDispatches, confirmDispatchesClear } from "@usecases/conversation/dispatch-guard";`

## 验收结果

- `npx tsc --noEmit` 通过
- `npx vitest run` 1231/1231 用例通过
- 无行为变更（纯代码重构）

## 改动范围

| 文件 | 操作 |
|------|------|
| src/usecases/conversation/talking-stone.ts | 新建（纯函数） |
| src/usecases/conversation/dispatch-guard.ts | 新建（状态操作） |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 删除函数定义 + 改为导入 |

## 设计依据

### R20260817arnt Q2 tool-factory 领域规则下沉

> 检视确认下沉逻辑零闭包耦合，方案维持 v1：talking-stone.ts（纯函数）、dispatch-guard.ts（状态挂 ToolContext，已验证接口可变字段支持）、访问控制与 fact 不变量归各自 usecase。触发时机（check/confirm 的调用序列）留 tool-factory，规则内容下沉。

## 后续步骤

- Part C：AgentInvoker 编排上提（已完成 PR #299）
- Part D1：controller/scheduler 切 agent-turn-port + 删旧 port
- Part D2：pi-session-factory 瘦身
- Part E：MemoryRepository 三分
- Part F：broadcaster 事件通道改造
