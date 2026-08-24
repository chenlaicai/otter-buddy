---
id: F20260821i336
title: orchestration-dispatch-guard
doc_type: feature

# 记忆索引
summary: |
  编排对话软守卫 + 派工台账落库，解决大獭"顺手自己干"问题。
  当大獭在有未派工小獭时调用 write/edit/bash，通过 session.steer() 注入提醒（二次放行）。
  新增派工台账持久化（使用 manageContext），大獭汇报前可核对实际派工记录，消灭状态虚报。

# 因果链路
causal_links:
  from:
    - "#335": 大獭无管理者角色认知——prompt 修正后，机制层仍有成本不对称
    - "#334": 检视流程链断点——常驻规则自相矛盾 + 编排者文件无流程职责

# 元数据
status: draft
change_type: feature
tags: [agent, orchestration, dispatch, guard, ledger, mechanism]
modules:
  - src/usecases/conversation/dispatch-guard.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/tool-builder.ts
  - src/usecases/ports/agent-tools.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/bootstrap/clients.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
capability_test: "tests/usecases/conversation/dispatch-guard.test.ts"
---

# 编排对话软守卫 + 派工台账

> **特性编号**：F20260821i336
> **变更类型**：New Feature
> **状态**：开发中
> **创建日期**：2026-08-21
> **创建对话**：4a2ee938-d631-4f97-a463-e107e204561c

---

## 1. 背景

### 1.1 问题来源

2026-08-19 全量对话审计发现，#335 修复大獭"管理者角色"的 prompt 认知后，机制层仍有成本不对称：

- 同 turn 自己改一个文件 = 1 次工具调用
- 派工 = search_memory → create_otter → yield → 等产出 → 可能返工

错误认知每次都走最省力路径落地。同时派工状态只存在于对话上下文中，没有结构化台账，"从未完成的排查"被汇报成"进行中"（8/19《issue处理》#309/#306 实例）。

### 1.2 当前缺失

| 维度 | 当前状态 | 期望状态 |
|------|---------|---------|
| 编排守卫 | 无 | 调用 write/edit/bash 时提醒 |
| 派工台账 | 无结构化记录 | 持久化记录，可查询核对 |
| 状态虚报 | 存在 | 消灭 |

---

## 2. 目标

### 2.1 主要目标

1. **编排对话软守卫**：当会话中存在已 create 过小獭时，大獭调用 write/edit/bash 触发软提醒，把"顺手自己干"从零摩擦变成显式决策
2. **派工台账落库**：dispatch 记录持久化，注入大獭上下文或提供查询工具，消灭状态虚报

### 2.2 非目标

1. 降低派工成本不对称（可选，本 PR 不包含）
2. 修改 prompt 层规则（主手段仍是 #335 的 prompt 修正）

---

## 3. 方案设计

### 3.1 编排对话软守卫

**触发条件**：
- 大獭调用 write/edit/bash 工具
- `pendingDispatches` 不为空（有创建但未 yield 的小獭）
- 本轮未提醒过（`orchestrationWarningShown` 标志）

**实现位置**：
- `dispatch-guard.ts`：新增 `checkOrchestrationGuard` 函数
- `circuit-breaker-helpers.ts`：在 `tool_execution_start` 事件中注入编排守卫检查
- `pi-session-factory.ts`：传递编排守卫函数到 `attachGuards`

**提醒机制**：
- 使用 `session.steer()` 注入提醒文案
- 二次放行：首次提醒后设置 `orchestrationWarningShown`，后续调用放行

**提醒文案示例**：
```
[编排守卫] 当前还有 1 只小獭未获行动权：小獭1。
你正在直接使用 write（自己动手）。
如果确实需要自己做，再次调用即可放行；
否则请先通过 yield 把行动权派给 小獭1。
```

### 3.2 派工台账

**存储方式**：使用 `manageContext` 存储派工记录（不新增 DB 表）

**记录格式**：
```json
{
  "id": "dispatch_1234567890_abc123",
  "conversationId": "conv-1",
  "otterId": "otter-1",
  "otterName": "小獭1",
  "task": "任务描述",
  "status": "pending",
  "createdAt": "2026-08-21T09:00:00Z",
  "updatedAt": "2026-08-21T09:00:00Z"
}
```

**状态流转**：
- `pending` → `in_progress`：小獭 yield 回来时
- `in_progress` → `completed`：小獭完成任务时
- `in_progress` → `failed`：小獭任务失败时

**查询工具**：`query_dispatch_ledger`
- 可按状态过滤
- 可按小獭 ID 过滤
- 返回所有派工记录列表

---

## 4. 影响范围

### 4.1 修改文件

| 文件 | 修改内容 |
|------|---------|
| `dispatch-guard.ts` | 新增 `checkOrchestrationGuard` 函数 |
| `circuit-breaker-helpers.ts` | 在 `tool_execution_start` 事件中注入编排守卫检查 |
| `pi-session-factory.ts` | 传递编排守卫函数到 `attachGuards` |
| `tool-builder.ts` | 初始化 `orchestrationWarningShown` 标志 |
| `agent-tools.ts` | `ToolContext` 新增 `orchestrationWarningShown` 字段 |
| `otter-tool-client.ts` | 新增 `dispatch` 接口 |
| `clients.ts` | 实现 `dispatch` 属性 |
| `tool-factory.ts` | 新增 `query_dispatch_ledger` 工具 |

### 4.2 新增文件

| 文件 | 内容 |
|------|------|
| `tests/usecases/conversation/dispatch-guard.test.ts` | 14 个单元测试用例 |

### 4.3 兼容性

- 向后兼容：新增功能，不影响现有行为
- 无破坏性变更

---

## 5. 取舍

### 5.1 存储方式选择

**选择**：使用 `manageContext` 存储派工记录

**替代方案**：新增 `dispatch_records` DB 表

**理由**：
- `manageContext` 是现有的上下文存储机制，复用它避免新增 DB 表
- 派工记录是临时性的（随 otter 生命周期），适合用 context 存储
- 简化实现，减少维护成本

**风险**：
- context 是 per-otter 的，查询所有派工记录需要遍历所有 otter
- 如果 otter 被解散，其派工记录也会丢失

**缓解**：
- 查询时遍历所有活跃参与者，确保不遗漏
- 派工记录的生命周期与 otter 一致，符合业务语义

### 5.2 提醒机制选择

**选择**：使用 `session.steer()` 注入提醒

**替代方案**：
- 在工具层直接返回错误
- 使用系统消息提醒

**理由**：
- `session.steer()` 是 SDK 提供的机制，用于在工具执行前注入提醒
- 非阻断式提醒，允许 LLM 自主决策
- 与熔断器的 steer 机制一致

---

## 6. 验证

### 6.1 单元测试

新增 14 个单元测试用例：

- `checkOrchestrationGuard`：9 个测试用例
  - write/edit/bash 工具触发提醒
  - read/speak 工具不触发提醒
  - 无未派工小獭不触发提醒
  - 二次放行机制
  - 多个小獭列出所有名字
  - pendingDispatches 未注入时不触发提醒

- `checkPendingDispatches`：3 个测试用例
  - 所有小獭已派工时不提醒
  - 有未派工小獭时提醒
  - 二次放行机制

- `confirmDispatchesClear`：2 个测试用例
  - 清除已派工的票据
  - pendingDispatches 未注入时不报错

### 6.2 集成测试

现有测试全部通过（1365 个测试用例）

### 6.3 CI 验证

CI 通过：✅

---

## 7. 关联

- **#335**：大獭无管理者角色认知——prompt 修正
- **#334**：检视流程链断点——常驻规则自相矛盾
- **#336**：本 issue
