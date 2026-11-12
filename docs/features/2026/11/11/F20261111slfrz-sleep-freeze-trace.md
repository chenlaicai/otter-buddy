---
id: F20261111slfrz
title: 睡眠冻结痕迹落账 + golden 采样防睡眠
summary: M-a8f8f080 定案收尾——invoke「偶发挂起」实为 Mac 睡眠冻结（OutputGuard 300s 预算实际 51min~11.6h 后 fire），恢复闭环已存在；本 PR 只补可观测性：超时 fire 时记录实际耗时并判 suspectedFreeze（elapsed>2×budget）落 healing 痕迹（sleep_freeze/low/环境分账）+ 自动重试提醒附空窗分钟数，golden 采样窗口持 caffeinate -i 防睡眠误判。不改任何超时预算与处置行为。
change_type: fix
created_at: 2026-11-11
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - F20261111bdiag
doc_type: feature
tags: [output-guard, healing, golden, capability, sleep-freeze, matter-a8f8f080]
modules:
  - src/frameworks/agent/output-guard.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - tests/capability/golden/golden.runner.ts
intent:
  problem: "Mac 睡眠期间进程存活但计时器冻结，唤醒瞬间 OutputGuard 超时才 fire——表现与「invoke 挂起」无法区分（M-a8f8f080 四样本实证：300s 预算实际 51min~11.6h 后 fire）。恢复闭环（guard→abort→auto-retry）本身工作正常，但冻结痕迹只在 pino 日志的 warn 行里，healing 台账与对话流不可见；golden 采样跑长链（n=3×多跳）撞睡眠高发窗时被误判为挂起（曾录得 3:1 卡点率）"
  expected_effect: "① 超时 fire 时记录实际墙钟耗时 elapsed，elapsed>2×budget 判「疑似系统睡眠冻结」并落 healing 事件（errorType=sleep_freeze，low）+ 自动重试系统提醒附空窗时长；② golden 采样窗口 darwin 平台持有 caffeinate -i 防睡眠断言，采样结束释放。未来诊断/golden 结果一眼区分「环境冻结」与「真挂起」，不再人工对日志挖两小时"
  verify_by:
    type: behavior_check
---

# 睡眠冻结痕迹落账 + golden 采样防睡眠

## 背景（M-a8f8f080 定案，2026-11-11 零配额真实数据分析）

全库 11873 invoke / 87.5 万事件扫描出 4 条「孤立长空窗」样本（52dae40b/aaf486a0/ccf89c9b/f1afe75e）。服务日志定位：OutputGuard first_byte_timeout（预算 300s）的 fire 时刻 = 空窗结束时刻（51min/109min/11.6h 后）——睡眠期间 setTimeout 冻结，唤醒瞬间走完残余预算才 fire；B 型铁证 f1afe75e 的 wait(60s) tool_result 迟到 11.6h。唤醒后 guard→abort→auto-retry 恢复闭环按设计工作（3 completed / 1 aborted，无真挂死）。

结论：**M-a8f8f080 不是缺陷**，是睡眠冻结 + 已有恢复机制正常。本 PR 只补两个可观测性/防误判缺口：

1. 冻结痕迹落账——fire 时 elapsed ≫ budget 的判定此前只存在于人脑
2. golden 采样防睡眠——凌晨跑长链采样撞睡眠曾录 3:1 卡点率（golden b5 检视链）

## 设计

### A. 睡眠冻结痕迹（OutputGuard → orchestrator → healing）

- `OutputGuard`：`onTimeout()` 计算 `timeoutElapsedMs = Date.now() - timerStartedAt`（fire 实际墙钟耗时），存入 metadata（`getMetadata()` 吐出）；warn 日志追加 `elapsedMs`；导出 `isSuspectedFreeze(budgetMs, elapsedMs) = elapsedMs > 2 * budgetMs`（睡眠冻结判定，2× 留足慢 prefill 余量）
- 类型链同步（4 处 outputGuardMetadata 形状 + ExitReason._outputGuardMetadata）：加 `timeoutElapsedMs?: number`
- `orchestrator.routeGuardAbort`：guardReason 为 `streaming_timeout`/`first_byte_timeout` 且 `isSuspectedFreeze` 命中 → 落 healing 事件（errorType=`sleep_freeze`，severity=low，description 携带空窗分钟数与预算对比且只写确证事实——「已由超时熔断接管」而非「已恢复」，避免重试耗尽时留下错误事实，suggestion 说明「睡眠是正常场景，痕迹仅用于区分挂起与冻结」）——与 recordDegenerateHealingEvent 同模式；`handleAutoRetry` 系统提醒在冻结时追加空窗说明（同样中性文案）
- 不自动重启、不改 scheduler、不告警升级——睡眠是合法状态（2026-11-11 搭档裁决，fact 8cfbbb82）

### B. golden 采样防睡眠（caffeinate）

- `golden.runner.ts`：采样 describe 的 beforeAll 里 darwin 平台 spawn `caffeinate -i`（Power Assertion 持有），afterAll kill 释放；非 darwin no-op。失败不阻断采样（warn 留痕）——防睡眠是优化不是前置条件。句柄暴露 `holderPid` 供测试按 pid 精确断言/清理（检视 P1 处置：禁止全局 pkill/pgrep 误杀其他持有方）

## 非目标

- 不给主服务加任何「无事件告警/看门狗」——睡眠期间冻结不可避免且恢复闭环已存在
- 不改 OutputGuard 预算值（300s/120s）与 per-event 熔断逻辑
- 不改 golden 断言与采样协议

## 证据分层声明

- 真实 LLM 采样：本 PR 未跑（golden gate 按 PR 描述协议由 CI 决定）；selftest 层离线校验判别力不受本改动影响
- 单测覆盖：freeze 判定 / metadata 透出 / **routeGuardAbort 落账行为（sleep-freeze-trace.test.ts：走真实 executeTurn——冻结落账+中性文案/耗尽双落/非冻结不落/无 metadata 不落）/ caffeinate helper（pid 精确生命周期 + 同步/异步失败注入 + 原始平台 descriptor 恢复）**（检视 P1/P2 处置后补齐）

## Rollback

还原 4 文件 + 测试即回滚；无 schema/配置/数据迁移。
