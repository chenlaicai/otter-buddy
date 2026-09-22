---
id: F20260922abat
title: 429 backoff 期间 abort 归因修复（#764）：auto_retry_start 观测窗回填
change_type: fix
status: implemented
created: 2026-09-22
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
summary: "#764：用户在 SDK retry backoff 睡眠期间 abort 时，retry 层显式抹 errorMessage（{...rest, stopReason:\"aborted\"}）→ err 通道拿不到底层错误 → 「因限流未能开始」归因文案主路径不可达（#752 那 20 条连发消息的原始场景）。修复：auto_retry_start 事件带完整 errorMessage 且 otter 层已订阅——agent-invoker 增 retry 观测窗（invokeId→errorMessage），AttemptDriver 增 getRetryErrorMessage 可选接口，orchestrator 在 user_abort 且无 underlyingError 时回填 api_error 归因。无需 SDK 侧改动，无新跨层协议。"
tags: [agent, abort, attribution, retry, 429]
capability_test: tests/usecases/conversation/agent-turn-orchestrator/backoff-abort-attribution.test.ts
from: [F20260903lngth]
---

# 429 backoff 期间 abort 归因修复（#764）

## 问题

用户在 429 限流 backoff 睡眠期间点 abort 时：

1. pi-coding-agent `_prepareRetry` 发 `auto_retry_start`（带完整 errorMessage）→ 进 backoff sleep
2. 用户 abort → `abortRetry()` 打断 sleep → `_retryAttempt=0` + `auto_retry_end(success:false)`
3. SDK 最终产出的 assistant message / err 通道**不含底层 errorMessage**（retry 层归一化为 aborted 形态）
4. 编排层 `classifyExit`：`isAbortOwnError(err)` 命中 abort 自身产物 → `underlyingError=undefined`
5. 「因模型服务限流（429）未能开始，中断了等待」归因文案主路径不可达——#752 那 20 条连发消息的原始场景，PR #762 修复后该场景文案保持无归因

## 修复

issue 预估「需要在 SDK 回调与编排层之间打通状态通道，跨层改动」——侦查后发现**通道是现成的**：SDK 的 `auto_retry_start` 事件带完整 errorMessage，且 otter 层早已订阅该事件（metrics recordRetry 在用）。retry 会话在成功/耗尽前不结束，观测窗时效天然覆盖 backoff 全程。

三处改动（共 ~30 行）：

1. **agent-invoker**：`retryContextByInvoke` Map（invokeId → 最近 retry errorMessage），`handleStreamEvent` 捕获 `auto_retry_start.errorMessage` 写入；turn 结束清理防泄漏
2. **AttemptDriver**：`getRetryErrorMessage?(invokeId)` 可选接口
3. **orchestrator**：`user_abort` 且 `underlyingError` 为空时查观测窗回填 `{ kind: 'api_error', errorMessage }`——归因文案「底层错误：…429…」主路径恢复可达

误归因防线：无 retry 观测窗 / 接口缺席时行为=修复前（纯主动中断简洁文案），不错报。

## 测试

`backoff-abort-attribution.test.ts`（3 用例，真实 executeTurn 驱动）：
- backoff-abort 现场：观测窗有 429 原文 → 文案含「底层错误」+ 429。**回退验证**：屏蔽回填逻辑 → 红（`expected '…搭档中断了当前发言。' to contain '底层错误'`），恢复 → 绿
- 无观测窗 → 保持纯中断简洁文案（防误归因）
- 可选接口缺席 → 不炸，按无观测窗处理

## 验证

tsc 0 错、eslint 0 error、orchestrator 域 6 文件 78 用例全过。

## 影响范围

仅 user_abort 归因文案的可达性；abort/重试/终态防护行为零变化。SDK 无改动、无版本依赖。

## 关联

- issue #764；PR #762（err 通道能拿到的部分已修）；#752（原始现象）；#763（同族 toolCallCount 竞态，PR #1113 已合）
