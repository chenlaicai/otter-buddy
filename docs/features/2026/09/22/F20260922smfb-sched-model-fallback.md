---
id: F20260922smfb
title: 定时任务配额终态自动降级：429 exhausted 换 fallback 模型重试一次
summary: issue #1068 修复——定时任务执行模型完全跟随 otter session 默认模型，周配额耗尽即任务团灭无逃生；scheduler 捕获 quota-exhausted 错误后 restart 执行獭换 fallback 模型重试一次（每次触发预算 1 次）
change_type: fix
capability_test: "tests/usecases/scheduler/scheduler-service.test.ts #1068 describe 块 6 用例（降级成功/重试失败不循环/瞬时不降级/非限流不降级/单模型不降级/缺注入跳过）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [scheduler, model-routing, rate-limit, quota, fallback]
modules: [src/usecases/scheduler/scheduler-service.ts, src/bootstrap/platforms.ts, tests/usecases/scheduler/scheduler-service.test.ts]
---

# 定时任务配额终态自动降级（issue #1068）

## 预注册

- **X（预期根因方向）**：定时任务执行模型跟随 otter session 默认模型（scheduled_tasks 表无模型字段），quota-exhausted 失败路径上无任何降级动作——修复应在 scheduler 失败捕获点加「restart 换模型重试一次」
- **Y（验证标准）**：scheduler-service.ts 的 invoke 失败 catch 块中无 429/quota 分支；manageSession.restartSession 支持 modelAlias 参数可直接复用
- **Z（反例方向）**：若失败错误在 scheduler 层不可识别为 quota 终态（被包装吃掉），则需改编排层错误传播而非 scheduler 加分支

**预期 vs 实际对照**：预期命中。`matchRateLimitError`（rate-limit-error.ts:58）同族正则已在编排层维护，scheduler 直接 import 复用；`restartSession(otterId, summary, modelAlias)`（manage-session.ts:210）第三参天然支持换模型。

## 问题（issue #1068）

2026-09-21 08:00「每日补丁清单回看」触发即死：kimi 周配额耗尽（403 access_terminated_error 终态），任务跟随默认模型 kimi，无降级逃生。同日 08:30 健康检查正常——restart 后 session 落 glm。聚类受害面：9/20 已有 4 个任务因 kimi 配额全死（4/4 = 100%）。

## 根因

`scheduled_tasks` 表无模型字段，执行模型完全跟随 otter session 默认模型（settings.defaultModelAlias=kimi）。kimi 为 7 天周配额（终态不可重试），轮转耗尽时所有跟随默认模型的定时任务成批死亡。scheduler 失败路径（`handleTaskExecutionFailure`）只记账/熔断，无降级动作。

## 修复方案（issue 方案 a）

在 `executeTask` 的 invoke catch 块首部插入降级分支 `tryQuotaExhaustedFallback`：

1. **判定**：`matchRateLimitError(errorMessage)?.exhausted === true` 才降级——瞬时限流（429 瞬时）可能自愈，换模型是过激反应
2. **预算**：每次触发最多降级 1 次（`MAX_QUOTA_FALLBACK_RETRIES = 1`），重试再失败走原失败路径——fallback 模型也可能同池耗尽，不循环降级
3. **动作**：`manageSession.restartSession(executorOtterId, summary, fallbackAlias)` 换模型后原样重试 invoke + assertNoFailedInvokes + completeExecution
4. **fallback 选择**：`modelPool.getModelInfos()` 第一个非默认模型——无偏好配置（机制预算最小化，验证断言只看「不团灭」不看「选最优」）
5. **降级 skip 条件**（任一命中即走原失败路径，均 warn 留痕）：非 exhausted / 预算已用 / manageSession 或 modelPool 未注入 / 执行獭不可确定 / 池中无替代模型 / restart 本身失败

**修法排序与机制识别**：本修复命中机制清单「新增决策分支」——但论证不涉净新增机制：分支结果（restart 换模型）复用既有 restartSession 机制（状态生命周期/持久化写回均为既有路径），本修复只是把「首哑决策树的人工程」在定时任务链路自动化，无新状态/存储/配置。归类修法排序①（既有语义内补缺），Modification-Class: `narrow-fix`。

**与 restartBeforeInvoke 的关系**：独立语义可叠加——restartBeforeInvoke 是「触发前保持干净上下文」，本路径是「配额死后换模型复活」；两者都 restart，不冲突。

## 失败证据固化

6 个测试用例先行固化（修复前：quota 错误直接 failed 无任何降级调用）：

| 场景 | 断言 |
|---|---|
| quota-exhausted → 降级重试成功 | restartSession 1 次（glm）、invoke 2 次、execution completed |
| 降级重试再失败 | restart 仅 1 次（不循环）、execution failed |
| 瞬时限流（非 exhausted） | 不降级、invoke 仅 1 次 |
| 非限流错误 | 不降级 |
| 单模型池（无 fallback） | 不降级 |
| manageSession 未注入 | 降级路径整体跳过 |

回归：tests/usecases/scheduler/ 6 文件 120 用例全过；tsc 干净。

## 影响范围

- 改动：`scheduler-service.ts`（+降级分支与 helper）、`platforms.ts`（装配 modelPool）、测试 6 用例
- 行为变化仅限 quota-exhausted 失败场景：原 100% 死亡 → 降级重试一次。验证断言（issue 原断言）：修复后配额耗尽窗口内定时任务失效率 <50%
- 风险：①fallback 选择无偏好（可能选中同样配紧张的模型）——预算 1 次兜底，不循环；②restart 会清执行獭上下文——定时任务场景 restartBeforeInvoke 本就常态重启，影响可接受；③降级成功后 otter config 的 modelAlias 被写回（restartSession 既有语义）——后续该獭其他任务也走 fallback 模型，属预期（配额恢复前保命）

## 关联

- issue #1068（Closes）
- 机制源头：F20260916fst4（首哑决策树——本修复是其定时任务链路版）、F20260908efmd（restartSession modelAlias 支持）、#642（429 重试判死）
- 同池问题：#1067（补丁清单任务自身去留）
