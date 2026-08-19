---
id: F20260819sndr
title: fix-sender-name-after-restart
doc_type: feature

# 记忆索引
summary: |
  修复熔断重启后发送者名显示为 "Otter" 而非实际海獭名称的问题。
  根因：speak.intermediate SSE 事件未携带 otterName 字段，前端兜底逻辑缺失。
  方案：后端 emitSpeakIntermediate 事件新增 otterId + otterName 字段，
  前端三处 handler 解构 otterName 并作为 sn 兜底值。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260818sgmt   # speak-yield-split-completion（speak.intermediate 事件契约）
    - F20260819spyd   # speak+yield 双工具拆分

# 元数据
status: locked
change_type: fix
tags: [sse, sender-name, circuit-breaker, restart, frontend, bugfix]
modules: [src/interface-adapters/agent-runtime/agent-invoker.ts, web/src/pages/conversation/index.tsx]

# 时间
created_at: 2026-08-19
---

# F20260819sndr — 修复熔断重启后发送者名显示错误

## 状态

- [x] design
- [x] development
- [x] review
- [ ] merge

## 概述

熔断重启后，前端在展示 `speak.intermediate` 实时发言时，发送者名显示为默认值 "Otter" 而非实际海獭名称。根因是 `speak.intermediate` SSE 事件仅携带 `messageId` 和 `body`，未传递 `otterName`，前端也缺乏对应的兜底逻辑。

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | 熔断重启后发送者名显示 Otter | Issue 标题 | 熔断重启后、发送者名、Otter | 熔断重启场景下，前端实时发言气泡的发送者名未正确显示为海獭名称，而是回退到默认值。 |

## [design-time] 问题分析

### 现象

熔断重启后，前端通过 `speak.intermediate` SSE 事件接收实时发言时，消息气泡的发送者名（`sn` 字段）显示为 "Otter" 而非实际海獭名称。

### 根因链

1. F20260819spyd 引入 `speak.intermediate` 事件用于前端实时展示海獭发言（无需等 yield 交棒）
2. 该事件仅携带 `messageId` 和 `body`，未携带 `otterName`
3. 前端创建消息时使用默认发送者名 "Otter"
4. `speak.intermediate` handler 更新消息内容时未更新 `sn` 字段
5. 熔断重启后，消息重新创建，`sn` 始终为默认值

### 影响范围

所有通过 `speak.intermediate` 展示实时发言的场景均受影响，包括：
- 常驻通道（第一处 handler）
- 单 otter 会话（第二处 handler）
- 多 otter 会话（第三处 handler）

## [design-time] 方案设计

### 推荐方案：SSE 事件携带 otterName + 前端兜底

**后端变更**：

`emitSpeakIntermediate` 方法提取 `otterName` 并注入事件数据：

```typescript
private emitSpeakIntermediate(
  e: AgentStreamEvent,
  messageId: string,
  otterId: string,
  otterName: string | undefined,
  emitEvent: (event: SSEEvent) => void,
): void {
  const details = (e.result as { details?: Record<string, unknown> } | undefined)?.details;
  if (details?.__speakIntermediate === true) {
    emitEvent({
      event: "speak.intermediate",
      data: { messageId, body: String(details.body ?? ""), otterId, otterName: otterName ?? otterId }
    });
  }
}
```

`createAttemptDriver` 新增 `otterName` 参数，在 `tool_execution_end` 事件处理中传递给 `emitSpeakIntermediate`。

**前端变更**：

三处 `speak.intermediate` handler 统一解构 `otterName` 并作为 `sn` 兜底：

```typescript
const { messageId, body, otterName } = data as { messageId: string; body: string; otterName?: string }
// ...
sn: m.sn || otterName || ''
```

**兜底策略**：`m.sn || otterName || ''`
- 优先使用已有 `sn`（消息创建时已设置）
- 其次使用事件携带的 `otterName`
- 最终兜底到空串（避免显示无意义的 UUID）

### 不兼容更新

无。此变更扩展 SSE 事件契约（新增字段），前端向后兼容（`otterName` 为可选字段）。

## 行为条目

| ID | 触发条件 | 预期行为 | 来源 |
|----|---------|---------|------|
| B-1 | 海獭通过 speak 工具发言，前端接收 `speak.intermediate` 事件 | 消息气泡显示正确的海獭名称 | UA-1 |
| B-2 | 熔断重启后，海獭重新发言 | 发送者名正确恢复，不显示 "Otter" | UA-1 |
| B-3 | `otterName` 未定义（极端场景） | 兜底到空串，不显示 UUID | 边界条件 |

## 验收标准

| ID | 验收条件 | 验证方法 |
|----|---------|---------|
| AC-1 | 海獭发言时，前端消息气泡显示正确的海獭名称 | 触发海獭发言，检查前端显示 |
| AC-2 | 熔断重启后，发送者名正确恢复 | 触发熔断重启，检查发送者名 |
| AC-3 | `speak.intermediate` 事件包含 `otterId` 和 `otterName` 字段 | 检查 SSE 事件数据 |

## 决策记录

| 决策 | 理由 | 替代方案 | 决策模式 |
|------|------|---------|---------|
| otterName 在 emitSpeakIntermediate 内查询而非 ToolContext | 复用 resolve 阶段已查询的 participant 数据，零额外查询 | ToolContext 加字段（需 async 化 buildCustomTools） | 技术事实，自主决策 |
| 前端兜底用空串而非 UUID | UUID 作为发送者名对用户无意义 | 显示 UUID（技术正确但用户体验差） | 技术事实，自主决策 |
| 三处 handler 统一使用解构风格 | 类型安全、风格一致、减少认知负担 | 保持 Record<string, unknown> 强转（类型不安全） | 技术事实，自主决策 |
