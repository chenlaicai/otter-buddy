---
id: F20261110cfrec
title: content_filter 失败自动换模型与即时升级
summary: 将内容过滤从普通 api_error 静默终态拆出，首次失败复用交接与模型池换备用模型续跑一次；仍失败或无备用模型时立即落 high、通知并唤醒大獭。
change_type: bugfix
capability_test: "n/a: 确定性错误分类与恢复编排，由公开 AgentInvoker/Orchestrator 行为测试验证，不评估模型内容能力"
intent:
  problem: "content_filter 被当作普通 api_error 直接终态，无分类事件、换模型恢复或编排者通知，对话可静默到过夜"
  expected_effect: "首次过滤在一个恢复链内换模型续跑；恢复不成时立即可见且大獭获得原任务上下文，不再依赖上下文满后的被动重启"
  verify_by:
    type: behavior_check
created_at: 2026-11-10
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - F20260807rtry
  - F20260916fst4
  - F20260920uhuc
tags: [invoke, recovery, content-filter, model-fallback, healing]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/content-filter-error.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/bootstrap/platforms.ts
---

# content_filter 失败自动换模型与即时升级

## 根因

`classifyExit` 将 provider 抛出的 `Unhandled stop reason: content_filter` 归为普通 `api_error`；`handleApiError` 只识别限流和超窗，其余直接 `failTerminal`。因此没有独立 healing 类型、没有换模型恢复，也没有把行动权或处置任务交给大獭。

## 恢复契约

1. orchestrator 只从错误文本识别 `content_filter`，记录独立 `content_filter/high` 事件，并在既有 failed 终态结果上携带恢复信号。
2. AgentInvoker 在首次失败时从现有 ModelPool 选择一个不同模型，复用统一交接保留机械前情并换模型，然后用原任务全新 invoke 一次。
3. 统一交接失败时复用既有裸换模型保底；恢复通知写失败不阻断续跑。
4. 无备用模型、换世失败或续跑仍过滤时，立即写入高警队列、发送 system entry，并通过既有 dispatch 链唤醒在场大獭。通知携带原任务，引导改派/换段，不自动重复同一内容。
5. 每次过滤最多换一次模型；第二次过滤只升级，不循环。

## 对原 issue 方案的有意收窄

不新增“手动重试标记超过 2h 再升级”的定时器或存储。终态升级改为立即执行，复用现有 high healing、alert registry 和 dispatch 链，时效严格强于 2h，且不新增调度状态面。

不放宽内容过滤，也不自动改写敏感文本。是否改派、换段或由搭档调整内容保留给编排者。

## Verification

### 失败用例证据（bugfix）

复现命令：

```bash
npx vitest run tests/interface-adapters/agent-invoker-circuit-retry.test.ts -t 'content_filter 首次失败' --reporter=verbose
```

修复前：1 failed；模型调用实收 1 次而非 2 次，未发生备用模型重启，直接落普通失败终态。

修复后：同一公开 AgentInvoker 测试通过，观察到 `glm → kimi` 换世、第二次调用完成及 `content_filter/high` 落账。另两条公开链路覆盖无备用模型立即通知、换模型后仍过滤时总共两次调用后通知且不循环。纯函数用例覆盖大小写、结构化错误码与普通 500/429/currentInvokeId 不误判。

### 仓库检查

- `npx tsc --noEmit` 与目标 ESLint：通过。
- `npm run check`：通过（build、全量 ESLint、schema、双形态 smoke、脚本/端口/OtterBar 探针）。
- 目标恢复、终态通知、防自 dispatch 与错误识别：4 files / 26 tests passed。
- `npm test -- --reporter=dot`：457 files / 5869 tests passed。
- `lint:docs`、`lint:tests`、`lint:intent`、`lint:date-bombs`、`lint:criteria`：通过；intent 仅存量 warning。
- 全量首跑曾发现 healing 全枚举清单未加入新类型；已补 `content_filter` 环境分账并重跑全量通过，未跳过该失败。

## 对抗审查处置

首轮独立审查打回后补齐：

- 备用模型续跑只有 invoke=completed 才视为恢复成功；普通 500/no_yield/timeout 等 failed 结果同样进入升级出口。二次 content_filter 由嵌套出口已通知，外层不重复通知。
- 终态 system entry 与 dispatch 分通道隔离故障；entry 写失败仍主动唤醒。
- dispatch 排除刚失败的大獭自身，只交给其他在场大獭，避免原敏感任务跨链自循环。
- 通知文案不再无依据声称已落账/已唤醒或裸重启也已交接。
- 回归补 ModelPool→ManageSession→第二次调用观察到新模型，以及两段 token delta 合并。
