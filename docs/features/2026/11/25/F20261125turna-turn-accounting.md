---
id: F20261125turna
title: TurnAccounting 整 turn 聚合落账与 Durable 异常生命周期
summary: invokes 四列从「末次 attempt 终态快照」改为「整 turn 聚合增量」——预算与工作账本读到多 attempt turn 的真实总消耗，telemetry 缺口不伪造；Durable prompt 的 submit/wait/waitForIdle/usage 任一阶段抛错均 finally 清回 running 状态与当前工具调用 id，异常终态不误落 no_yield。
change_type: feature
doc_type: feature
created_at: 2026-11-25
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯 A 类账目口径与生命周期契约，由 orchestrator 级真实回调链与真实 Harness fixture 验证；不新增 LLM 自由行为"
tags: [tokens, invokes, orchestrator, durable-session, exit-classifier, budget]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/frameworks/agent/durable-session.ts
  - src/usecases/conversation/token-usage.ts
intent:
  problem: "多 attempt turn 成功落库写末次 attempt 终态快照，invokes 四列被预算闸与工作账本读取，external 日额度系统性低估；Durable prompt 异常路径不清 running 状态与当前工具调用 id，isStreaming 永久误报、动作误归属旧调用。"
  expected_effect: "成功 turn 落库为整 turn 聚合增量（预算/账本唯一口径），telemetry 缺口不伪造；submit/wait/waitForIdle/usage 任一阶段抛错后 state 回 idle、toolCallId 清空、会话可继续；unanswered/failed/error 走 api_error 不落 no_yield。"
  verify_by:
    type: behavior_check
    rollback: "纯代码 revert：无 schema/数据迁移，revert 后落库回旧口径（末次快照），无数据损失；历史行不回填、不声称已校正。"
    risk_note: "口径分界带来历史/新数据混合窗口（已知不校正）；失败终态继续不落 usage（与旧行为一致，留待后续批次）。"
---

## 背景与问题

整改方案认定的两处缺陷（整改主锚点见对话工作区方案文档 §2.7 与 PR-08 节）：

1. **H7 账目口径分裂**：orchestrator 已在 turn 边界累加各 attempt 的 token 增量（`tokenUsageDelta`），但成功落库写的是**末次 attempt 的终态快照**（`result.tokenUsage`）。多 attempt turn（首 attempt 失败/退化后重试成功）落库量只含最后一轮，invokes 四列被预算闸（`sumConversationTokenUsage`）与工作账本聚合读取，external 日额度因此系统性低估。末次快照与整 turn 总量在 SDK 侧显式分名（快照仅 SSE/诊断用），落库却混用快照。
2. **M2 异常生命周期裸奔**：Durable prompt 的 `_state = "running"` 与 `scope.currentToolCallId` 只在正常路径收尾时清理；submit/wait/waitForIdle/usage 任一阶段抛错（含 unanswered 抛错前的 wait 异常）都会让 `isStreaming` 永久误报、残留 toolCallId 把后续非工具期动作误归属到旧调用。

## 方案

- 成功收尾（`tryCompleteInvoke`）落库改写整 turn 聚合 `tokenUsageDelta`：多 attempt turn 写总和；delta 缺失（telemetry 缺口）**不落库**——四列留 null，账本 `usageGap` 显式计出，不用末次快照伪造总量。末次快照继续走 `emitInvokeEnd`（SSE/诊断），不落账。
- chain 观察链本就消费 `TurnResult.tokenUsageDelta`（不读 invokes 四列），不重复计数——本改动不动 chain。
- Durable prompt 把 submit→usage 收尾整段包进 try/finally：finally 幂等清 `_state = "idle"` 与 `scope.currentToolCallId`（正常路径已清，异常路径在此兑付）。
- 不改 invokes schema、不回填历史行（口径分界随本 PR 生效）、不夹带失败终态成本口径新设计——失败终态不落 usage（与旧行为一致，留待后续批次）。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 两 attempt turn | 首 attempt no_yield（带增量）→ 重试成功（带快照+增量） | `updateInvokeTokenUsage` 落**总和**，非末次快照 |
| 单 attempt 成功 | delta=快照 | 落库等于增量 |
| telemetry 缺口 | 有快照无 delta | 不落库（四列 null，账本 usageGap 计出） |
| submit/wait/waitForIdle/usage 抛错 | 真实 Harness fixture 逐阶段注入 | state 回 idle、isStreaming false、currentToolCallId 清空、会话可继续 prompt |
| 异常终态分类 | unanswered/failed/error fixture | api_error，不落 no_yield；真 no_yield 不受影响 |

## Verification

### 失败用例证据（bugfix）

- 旧代码红测：`evidence/tacc-turntotal-red.log`——落库收到末次快照 `{input:5,output:1}` 而非总和 `{input:45,...}`；telemetry 缺口时误落快照。
- 旧代码红测：`evidence/tacc-lifecycle-red.log`——wait/waitForIdle/usage 抛错后 `state` 停留 `'running'`。
- 修复后绿：`tests/usecases/conversation/agent-turn-orchestrator/turn-total-persist.test.ts`（2 用例）、`tests/frameworks/agent/durable-runtime.test.ts` 异常生命周期 4 用例、`tests/usecases/conversation/agent-turn-orchestrator/exit-classifier.test.ts` 异常终态 3 用例（合计 9 新用例）。

### 回归证据

- 定向回归 251 文件 / 2515 用例通过（conversation/agent/interface-adapters/db/health）。
- 全量套件 **540 文件 / 6902 用例通过**（`npx vitest run`，本机真实运行）。
- `agent-invoker.test.ts` 一处行为钉按新契约更新：SDK mock 补 `tokenUsageDelta`，断言注释改为「四列落整 turn 聚合」——这是口径分界的显式测试化。

### 最简实现检查

两处窄改（orchestrator 落库换数据源 + durable prompt 包 try/finally），不动 schema、不动 chain、不动重试/路由策略；`token-usage.ts` 的聚合函数语义未变，仅引用位置变化。

## 口径分界（发布说明）

- 历史 invokes 行不回填：本 PR 合入前的行仍是旧口径（末次快照或空），合入后成功 turn 起为整 turn 聚合。预算闸与账本对历史对话的读数存在口径混合窗口，属已知且不校正——禁止把历史数据描述成已校正。
- 回滚：纯代码 revert 即可，无 schema/数据迁移；revert 后落库回到旧口径，无数据损失。
