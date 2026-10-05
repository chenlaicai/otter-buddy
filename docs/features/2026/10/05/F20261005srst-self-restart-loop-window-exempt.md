---
id: F20261005srst
title: 自重启防循环拦截误拦修复：时间衰减豁免 + 判据重试 + 降级可观测
summary: 9/28 搭档显式指令重启两次被拦（#1203），三件套修复——自重启 session 存活超 2h 不再拦（同构熔断健康窗口）、判据查询重试一次、降级落 healing event 不再静默
change_type: fix
capability_test: "n/a: 纯防御性拦截逻辑（mock 单测覆盖），无 LLM 行为面"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [self-restart, circuit-break, healing-events, agent-runtime, observability]
modules:
  - src/interface-adapters/agent-runtime/circuit-break-support.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
from:
  - F20260824srst
  - F20260906srst
  - F20260831cbkw
causal_links:
  - "#1203 案发时间线 DB 实证：07:27 自重启创建 session 3a8f23ee；11:51 user 指令重启；12:38/13:11/13:28 a9260c50 对话三次被拦（invoke_events tool_result 实锤报错文案）；同日 12:41 d7377cfd 对话同 session 重启成功——同输入异结果的瞬时差异无日志可归因"
created_at: "2026-10-05"
intent:
  problem: "9/28 搭档显式指令重启被防连续自重启保护拦截（#1203 两起），9/6 #811 的用户介入判据在现场失效且无日志可归因"
  expected_effect: "修复后 30 天内「用户指令重启被拦」事件=0（到期 2026-10-29 回查 healing events + 对话检索）；判据降级事件从静默变可观测（healing 台账可查）"
  verify_by:
    type: behavior_check
---

# 自重启防循环拦截误拦修复（#1203）

## 背景与案发现场

**issue**：#1203（9/28 两起）。对话 a9260c50 中，搭档 11:51 指令「ok，那你重启自己，然后继续处理其他issue」后，獭在 12:38/13:11/13:28 三次调用 restart_otter(self) 均被拦（报错「当前 session 已由自重启创建，不允许连续自重启」），被迫带污染上下文继续工作。

**DB 实证时间线**（排查 2026-10-05）：

| 时间(UTC) | 事件 | 证据 |
|---|---|---|
| 07:27 | 大獭自重启成功，session 3a8f23ee 创建 | healing_events self_restart + otter_sessions |
| 11:51 | 搭档在 a9260c50 指令重启 | entries user |
| 12:38 | restart_otter 被拦（第一次） | invoke_events tool_result |
| 12:41 | d7377cfd 对话同 session 重启成功 | invoke_events + healing_events |
| 13:11 / 13:28 | 再次被拦（第二、三次） | invoke_events tool_result |

**核心矛盾**：9/6 #811 修复引入的「用户消息介入判据」在 12:38/13:11/13:28 均应放行（最新 user entry 11:51 晚于 session 起点 07:27），却被拦；而 12:41 本对话（d7377cfd）同 session 同判据输入形态却放行。同一只獭、同一个 active session、相差 3 分钟，一拦一放——**瞬时差异**。

**归因困境**：两道防线的判据查询失败均静默降级（catch 后 return false = 无介入 = 维持拦截），服务日志无任何记录——事后无法定案。这本身就是最大的问题：判据失效不可观测。

## 根因分析

1. **判据链路无重试**：getEntries 瞬时故障（SQLite busy / 连接池）直接落入 catch → 降级拦截。
2. **降级不可观测**：catch 静默吞掉，无 healing event、无日志——9/28 现场无法归因。
3. **机械规则缺时间维度**：「session 由自重启创建 → 一律拦」没有衰减——防循环的本意是防「紧邻连环」（分钟级：重启→醒来→又重启），5 小时前的自重启产物不可能是循环。熔断防线（F20260831cbkw）早已有 2h 健康窗口先例，自重启防线漏配。

## 修复（三件套）

两道防线（tool 层 isSelfRestartLoop / invoker 层 isSessionSelfRestartCreated）同构实施：

1. **时间衰减豁免**：自重启创建的 session 存活超 2h（SELF_RESTART_LOOP_WINDOW_MS）→ 不拦。同构 F20260831cbkw 熔断健康窗口。**这层兜住判据失效类故障**：9/28 现场若在，12:38 距 07:27 已 5h，直接放行——判据查没查、成没成功都不再重要。
2. **判据查询重试**：瞬时故障退避 50ms 重试一次（2 次尝试）——SQLite busy 类抖动自愈。
3. **降级可观测**：重试耗尽仍失败 → 维持拦截（保守语义不变），但落 healing event（errorType=other, severity=low, description 含「判据失效留痕（#1203）」）+ warn 日志——下次再发生，台账可见可归因。
4. **拦截文案补替代通道**（issue 方案③）：被拦时告知「请搭档从 UI 手动重启，或新开对话重派任务」——不再只是「请通过新消息与獭交互」（9/28 现场证明用户发新消息也没用）。

## 设计取舍

- **为什么 2h**：熔断健康窗口同值先例（F20260831cbkw，8/30 墨鱼案例）；防循环威胁模型是分钟级连环，2h 余量充足。
- **为什么维持降级=拦截**：判据失效时放行有真循环风险（scheduler 场景无用户意图）；拦截的代价（搭档手动重启）远小于循环重启的资源浪费。时间衰减豁免已兜住「拦截代价高」的长间隔场景。
- **Modification-Class**：narrow-fix——既有拦截语义内加豁免条件与可观测性，无新机制（豁免窗口判据同构既有熔断健康窗口，重试与落账为既有模式的局部应用）。

## 验证

- 单测 13/13（tests/interface-adapters/agent-runtime/tools/pending-restart.test.ts）：既有 10 用例 + 新增 3 用例（豁免放行且短路判据查询 / 重试一次成功不落账 / 重试耗尽拦截+落账）。
- 既有用例时间参数修正：3 个用例从固定日期（2026-09-04）改为窗口内相对时间——固定旧日期在时间衰减豁免下会被短路，用例将退化不再测目标路径。
- tsc --noEmit 干净。
- 反向验证：修复前代码下「豁免放行」用例红（旧逻辑无窗口豁免，5h session 仍拦）——真锚。
- Golden Gate: n/a（verify_by=behavior_check 指向 issue 断言回查，无 prompt/skill/协议层软代码变更）。

## 后续动作

- issue #1203 断言回查（2026-10-29 到期）：healing events 无「用户指令重启被拦」+ 降级事件有账可查。
- 随 PR closes #1203。
