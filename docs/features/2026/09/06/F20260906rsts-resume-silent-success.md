---
id: F20260906rsts
title: 恢复静默成功：移除恢复流程用户可见宣告
date: 2026-09-06
summary: 搭档裁决恢复职责边界收窄为「重启后重新触发即结束」：移除开场「正在自动恢复」宣告与终态「恢复完成」汇总（#613 方案 A 推翻），成功路径全程静默；失败路径提示与 healing 台账落账保留。
change_type: fix
tags: [resume, recovery, silent-success, ux, boundary]
modules: [src/usecases/conversation/resume-interrupted-service.ts, src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts]
from: [F20260826rsme, F202609048840]
created_in_conversation: 71782d9a-32b7-4f3e-8f80-6a946b786a9d
intent:
  problem: "恢复流程的「正在自动恢复」「恢复完成：N 条中断发言已恢复」宣告在多次对话重复出现，用户观感怪异；恢复机制的职责边界模糊（是否要宣告结果、是否要为链后续负责）"
  expected_effect: "成功恢复的对话流零系统消息（恢复透明，海獭把话说完即结果）；失败路径提示保留（可手动重试）；stale skipped 静默清理；healing 台账落账不变；全量测试绿"
  verify_by:
    type: capability_test
---

## 背景与需求

搭档实测反馈（2026-09-06）：「恢复完成」文案会在几次对话中出现，观感奇怪。要求直接移除恢复完成的标记——重启后触发重跑，这个事就结束了，不要再有后续宣告。

### 决策链（同日三轮收敛）

1. #813（hop 2 失败仍标 done）：搭档裁决恢复职责边界 = 只管「进程停止时被中断的那一跳」，链后续属正常运行期故障 → 全链终态聚合判过度设计，issue close
2. 本特性：边界进一步收窄至用户可见面——成功的恢复不需要宣告（透明），失败才需要出声（可操作）
3. #613 方案 A（2026-08-31 交付的「恢复完成终态消息」）由此推翻

## 方案设计

**职责边界**：恢复 = 重新触发被中断的发言 + 失败时告知。触发成功即结束，后续链推进（yield 转手等）属正常运行期。

### 移除项（成功路径宣告）

| 移除点 | 原文案 | 位置 |
|---|---|---|
| 开场宣告 | `[系统] 服务重启导致 N 条发言中断，正在自动恢复。` | resumeConversation 开头 sendSystem |
| 终态汇总 | `[系统] 恢复完成：N 条中断发言已恢复，…` | resume() 全部完成后 sendCompletedSafe |
| 纯函数 | buildRestartResumeSystemMsg / buildRestartResumeCompletedMsg | retry-policy.ts |

### 保留项（失败可操作 + 非用户可见功能件）

| 保留点 | 理由 |
|---|---|
| buildRestartResumeFailedMsg（invoke_error / skipped_concurrent） | 失败路径，用户有操作可做（手动重试） |
| buildRestartResumeFailedInvokeMsg | 同上（F202609048840 F4） |
| buildRestartResumeTerminalMsg 的 failed 分支 | 同上 |
| buildRestartResumeMsg（注入给被恢复獭的续跑引导） | 非用户可见，链引擎 userMessageContent 驱动输入，恢复质量依赖（F20260826rsme） |
| healing 台账落账（#613 方案 B） | 非对话流，观测面 |
| 队列状态流转（done/failed/exhausted） | 内部记账，非用户可见 |

### 附带文案调整

buildRestartResumeTerminalMsg done 分支（半截消息归档 body，F3 后仅写入旧消息自身）从「恢复已完成：本条为中断前的原始发言…恢复后的内容见新发言」改为「本条发言因服务重启中断（半截内容已保留），后续内容见新发言」——去除宣告感，纯事实陈述。

## 验证结果

- 单测：resume-interrupted-service.test.ts 24 用例全绿（成功路径断言反转为「零系统消息」，#613 方案 A 用例改写为静默裁决用例）
- 全量：3043 passed (244 files)
- tsc --noEmit 0 error；eslint 0 error；lint:intent 0 error

## 影响范围

- 用户可见行为：重启恢复成功后对话流不再出现任何恢复相关系统消息
- 兼容性：无 schema 变更、无接口变更；「正在自动恢复」若在中断瞬间已发出（旧版本进程行为）属一次性窗口，不做补偿
