---
id: F20260819qzrq
title: agent-turn-port
doc_type: feature

summary: |
  PR-D1：controller/scheduler/recruiting 切 agent-turn-port + 删旧 port。
  批次 3 agent-runtime 重构（F20260817a3rt）的 D1 步骤。

causal_links:
  from:
    - F20260817a3rt

status: development
change_type: refactor
tags: [agent, architecture, port, refactor]
modules:
  - src/usecases/ports/
  - src/interface-adapters/agent-runtime/
  - src/bootstrap/
  - src/usecases/scheduler/
  - src/usecases/recruiting/
  - src/usecases/conversation/
capability_test: "n/a: 纯类型替换 + adapter 删除（A 类），零行为变更"
---

# F20260819qzrq: controller/scheduler/recruiting 切 agent-turn-port + 删旧 port

父特性：**F20260817a3rt**（agent-runtime-refactor 批次 3 主档）。

## 实现内容

删除旧 `AgentInvokePort`（含 `AgentInvokePortAdapter` 多余包装层），新建 `AgentTurnPort`（usecases 层端口），AgentInvoker 直接 `implements AgentTurnPort`。

1. **新建 `src/usecases/ports/agent-turn-port.ts`**：定义 `AgentTurnPort` 接口（`invokeConversation` + `abort`）和 `AgentTurnResult` 类型（扩展旧 `AgentInvokeResult`，增加 `duration`/`tokenUsage`，与 orchestrator 对齐）。
2. **删除 `src/usecases/ports/agent-invoke-port.ts`**：旧 port 接口 + `AgentInvokePortAdapter` 包装类。PR-A 的注释已预言此文件在 D1 删除。
3. **`AgentInvoker implements AgentTurnPort`**：删除内部 `ConversationInvokeResult`（改用 `AgentTurnResult`），添加 `implements AgentTurnPort` 声明。
4. **消费方类型替换**：`scheduler-service.ts`、`process-inbound-recruit.ts`、`agent-dispatch-service.ts` 的 `AgentInvokePort` → `AgentTurnPort`。
5. **bootstrap 去包装**：`platforms.ts` 删除 `AgentInvokePortAdapter` import 和实例化，AgentInvoker 直传 SchedulerService。
6. **测试同步**：3 个测试文件（scheduler-service/scheduler-metric-integration/process-inbound-recruit）mock 类型替换 + 补 `abort: vi.fn()` 和 `duration: 0`。

## 验收结果

- `npx tsc --noEmit` 通过；106 测试文件 / 1246 用例全通过
- CI 通过
- 纯类型替换 + adapter 删除，零行为变更

## 对抗审视记录（三轮）

一轮：发现 1 严重（B4 特性编号错误 F20260814qswp → F20260817a3rt）+ 2 建议（scheduler mock 不完整、字段名 agentInvokePort 残留）。二轮：建议 #2 修复遗漏（scheduler-metric-integration.test.ts 的 createMockAgentInvoke 未补 abort/duration）补修。三轮：全部验证通过。字段名残留建 follow-up issue #305。

## 改动范围

| 文件 | 操作 |
|------|------|
| src/usecases/ports/agent-turn-port.ts | 新增（AgentTurnPort + AgentTurnResult） |
| src/usecases/ports/agent-invoke-port.ts | 删除 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | implements AgentTurnPort + 删除 ConversationInvokeResult |
| src/usecases/scheduler/scheduler-service.ts | AgentInvokePort → AgentTurnPort |
| src/usecases/recruiting/process-inbound-recruit.ts | 同上 |
| src/usecases/conversation/agent-dispatch-service.ts | 同上 |
| src/bootstrap/platforms.ts | 删除 AgentInvokePortAdapter，AgentInvoker 直传 |
| tests/usecases/scheduler/scheduler-service.test.ts | mock 类型替换 + 补 abort/duration |
| tests/usecases/scheduler/scheduler-metric-integration.test.ts | 同上 |
| tests/usecases/recruiting/process-inbound-recruit.test.ts | 同上 |

## Discovered Issues

- #305 — agentInvokePort 字段名对齐为 agentTurnPort（纯命名一致性，零行为变化）
