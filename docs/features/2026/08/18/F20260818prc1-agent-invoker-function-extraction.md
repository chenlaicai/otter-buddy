---
id: F20260818prc1
title: agent-invoker-function-extraction
doc_type: feature

summary: |
  PR-C Phase 1：从 agent-invoker.ts 抽取纯函数到 agent-turn-orchestrator/ 目录。
  event-mapping.ts（96 行）、exit-classifier.ts（72 行）、retry-policy.ts（49 行）。
  agent-invoker.ts 从 1196 行降到 1048 行，零行为变更。

causal_links:
  from:
    - F20260817a3rt
    - R20260817arnt

status: development
change_type: refactor
tags: [agent, architecture, port, refactor]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/
  - src/interface-adapters/agent-runtime/agent-invoker.ts
capability_test: "n/a: 纯代码逻辑重构（A 类），无 LLM 行为变更"
---

# F20260818prc1: agent-invoker 函数抽取（PR-C Phase 1）

设计依据：**R20260817arnt** §4 PR-C 两段式实施。本 PR 完成第一段：函数抽取（不改调用方语义）。

## 实现内容

从 `agent-invoker.ts` 抽取模块级纯函数到 `usecases/conversation/agent-turn-orchestrator/` 目录：

### 1. event-mapping.ts（96 行）

SDK 事件 → SSE 事件 / MessageEventInput 映射：

- `extractAssistantContent` - 从 message_end 事件提取 assistant 内容块
- `extractSdkEventFields` - 从 SDK 事件提取结构化字段
- `mapToSSEEvent` - SDK 事件 → SSE 事件映射
- `mapMessageEndEvent` - message_end → MessageEventInput
- `mapToMessageEventInput` - 任意事件 → MessageEventInput

### 2. exit-classifier.ts（72 行）

退出分类逻辑（状态+依赖注入函数）：

- `ExitReason` 类型定义
- `extractGuardReason` - 从 result/error 提取 guard abort 原因
- `classifyExit` - 分类退出原因（依赖 userAbortedMessages 和 getInternalAbortReason）
- `exitKindToOutcome` - ExitReason.kind → InvokeOutcome 映射

### 3. retry-policy.ts（49 行）

重试决策纯函数：

- `isRetryableGuardAbort` - 判断 guard abort 是否可重试
- `buildRetryFailBody` - 构造重试失败消息
- `buildSpeakRetryMsg` - 构建 speak 重试系统提醒
- `buildGuardAbortBody` - 构建 guard abort 消息
- `buildUserAbortBody` - 构建 user abort 消息

## 改动范围

| 文件 | 操作 |
|------|------|
| src/usecases/conversation/agent-turn-orchestrator/event-mapping.ts | 新建 |
| src/usecases/conversation/agent-turn-orchestrator/exit-classifier.ts | 新建 |
| src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts | 新建 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 改为 import 新模块 |

## 验收结果

- `npx tsc --noEmit` 通过
- `npx eslint .` 0 error（新增文件 + agent-invoker.ts）
- 全量 vitest 105 文件 / 1231 用例通过
- 行为等价：agent-invoker 测试 40 用例全部通过，无断言变更

## 行数变化

| 文件 | 变化前 | 变化后 | 差值 |
|------|--------|--------|------|
| agent-invoker.ts | 1196 | 1048 | -148 |
| event-mapping.ts | 0 | 96 | +96 |
| exit-classifier.ts | 0 | 72 | +72 |
| retry-policy.ts | 0 | 49 | +49 |
| **总计** | 1196 | 1265 | +69 |

## 后续步骤

Phase 2（状态机与终态上提）将在独立 PR 中实施：
- 创建 AgentTurnOrchestrator 类（usecase 层）
- terminal Sets + recordedAttempts 去重 + metrics 埋点
- routeByReason 递归重入改为循环 + driver.invoke
- invoker 测试改走 orchestrator

Phase 2 是全案最高风险 PR，需要：
- 每段独立 commit
- 独立对抗检视一轮
- 隔离实例真实验证
