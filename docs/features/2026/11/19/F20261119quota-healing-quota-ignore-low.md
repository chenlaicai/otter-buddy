---
id: F20261119quota
title: "healing 忽略 token 正常耗尽：配额耗尽终态 severity high→low 并撤出 C3 高警队列（搭档边界拍板落地）"
summary: "搭档 2026-11-19 11:39 指令「配额这件事不要海獭系统处理……修改healing机制、让其忽略这些token正常耗尽问题」，沿 11-17 边界拍板（「token 用完跟系统无关，只在定时任务/新小獭触发时自动切换一次模型，这是边界」）。#1511 回查实证该族 high 事件流周 27~60 条持续挤占真信号（超限聚合先例：26 条超龄 high 超单次推送上限 20）。改动收敛在 orchestrator 落账点：exhausted=true（终态配额耗尽）severity high→low、不再入 C3 高警队列（context_overflow 的入队维持）；瞬时限流 medium 不变；会话内 sendSystem 告警维持（现场上下文非台账噪声）；create_otter 的 24h 改派提示读 open 事件不筛 severity，边界内功能天然保留。现存 open 配额事件已为零（age-out 清扫），无存量清理项。"
change_type: fix
capability_test: "tests/interface-adapters/agent-invoker-circuit-retry.test.ts「rate_limit（配额耗尽）：healing 落账 severity:low + 系统告警 + invoke failed + 不入 C3」——真实 invoker 链路断言落账 severity=low、C3 enqueue 零调用（vi.spyOn）；rate-limit-error.test.ts 13/13 识别语义不变；healing-alert-registry.test.ts 11/11 队列机制不变；全量 vitest 6464 通过（SIGKILL fixture 需 dist 编译产物，npm run build 后 18/18）"
intent:
  problem: "配额耗尽（终态 429/403 quota 族）是资源侧正常事实，不是系统缺陷——但 healing 机制把它当 high 级系统问题落账：进高警队列叫醒大獭、进每日 8:30 高位统计、进 self-healing-analysis 聚合、进 regression-verify 断言数据源。#1511 回查（2026-11-19）实测 W42=6/W43=59/W44=27/W45=56/W46=7，周数十条的「正常耗尽」噪声持续挤占真信号注意力。搭档两级拍板定边界：11-17「token 用完跟系统无关，只在定时任务/新小獭触发时自动切换一次模型」+ 11-19「修改healing机制、让其忽略这些token正常耗尽问题」。"
  solution: "单一落账点收窄：orchestrator.recordRateLimitHealingEvent 中 exhausted=true 分支 severity high→low，并整段删除 C3 healingAlertRegistry.enqueue（大獭不在场补送达通道不再消费该族）；context_overflow 的 C3 入队维持（体积超窗是注入侧终态问题，属系统信号）。保留面：①瞬时限流（SDK 重试耗尽）维持 medium——它可能自愈、非「正常耗尽」；②会话内 sendSystem 告警维持——当前对话需要知道本轮为何终止，是现场上下文不是台账噪声；③create_otter 前置 24h 配额改派提示保留——checkModelQuotaHint 读 open 事件不筛 severity，天然兼容 low，且属搭档边界内「新小獭触发」功能；④首哑告警（小獭首 invoke 即配额死）独立机制不动——它是边界的执行路径（唤醒大獭 restart 换模型）。"
  expected_effect: "high 通道/超限聚合/大獭 C3 告警不再出现配额耗尽事件（每日 high 噪声面直接消失）；quota 事实仍可从 low 级台账查询（排障不瞎）；边界内功能（定时任务/新小獭的自动换模型、改派提示、首哑处置）零损伤。"
  verify_by:
    type: behavior_check
    assertions:
      - "tests/interface-adapters/agent-invoker-circuit-retry.test.ts：配额耗尽链路落账 severity 全为 low、无 high 残留、healingAlertRegistry.enqueue 零调用（spy 断言）、会话内系统告警仍在"
      - "全量 vitest 6464 通过（node_modules 以 symlink 复用主仓、npm run build 后 SIGKILL fixture 18/18）"
      - "运行时验证：次日 8:30 日报 high 段与 self-healing-analysis 不再出现「模型 X 配额耗尽」聚合（自然观察点，无需专用脚本）"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [healing, rate-limit, quota, partner-decision, noise-reduction, orchestrator]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/rate-limit-error.ts
  - tests/interface-adapters/agent-invoker-circuit-retry.test.ts
---

## 背景

#1511（[runtime] 模型配额耗尽终态 429 无 fallback）11-17 由搭档边界拍板关闭：「这个别管，还是我之前的结论，token 用完跟系统无关，当前依旧保持只在定时任务/新小獭触发时自动切换一次模型，这是边界，记住了。」11-19 回查实测事件流仍周数十条（W45=56），当日搭档追加固化为系统行为：「修改healing机制、让其忽略这些token正常耗尽问题」。

## 问题本质（第一性）

 healing 台账的语义是「系统不健康信号」；配额耗尽是「资源侧正常事实」。把正常事实按不健康信号记账，制造的是纯噪声：大獭被叫醒处理一个已拍板「别管」的事、每日高位统计被正常现象稀释、真信号（context_overflow、guard 拦截等）被挤占。修法不是「换个地方报警」而是让该族退出报警面，同时不损伤搭档边界内的既有功能。

## 改动

| 位置 | 改前 | 改后 |
|---|---|---|
| orchestrator.recordRateLimitHealingEvent severity | exhausted ? high : medium | exhausted ? low : medium |
| C3 高警入队（exhausted） | enqueue（大獭补送达） | 删除（不入队） |
| context_overflow C3 入队 | enqueue | 不变（维持） |
| 会话内 sendSystem 告警 | 有 | 不变（维持） |
| create_otter 24h 改派提示 | 读 open 事件（不筛 severity） | 不变（天然兼容 low） |
| 首哑告警（agent-invoker） | 独立机制 | 不变（边界执行路径） |

## 验证

- 失败用例证据（bugfix）：改前断言口径 `severity: high`（orchestrator 原文 `match.exhausted ? "high" : "medium"`）+ C3 入队——本 PR 测试以新口径锁定：severity 全 low + enqueue spy 零调用；改前代码跑该用例必红（high ≠ low、enqueue 被调）。
- 全量 vitest 6464 通过；SIGKILL durable fixture 需 dist 产物（worktree 内 `npm run build` 后 18/18）。
- 自然观察点：次日 8:30 日报 high 段不再出现配额耗尽聚合。

## 边界与不做

- 不动瞬时限流（medium）：SDK 重试耗尽可能是真异常，保留观察。
- 不做事件删除/静默档位开关：单一 severity 收窄已达成「high 通道忽略」，台账 low 记录保留排障可见性（搭档口径「忽略」按不进报警面理解；若要彻底不落账，另拍板）。
- 存量清理：open 配额事件当前为 0（age-out 机制已清扫），无迁移项。

## 检视处置 delta（初轮 🔴×2）

- **🔴1 消费链补全（落地即 resolved）**：初版仅降级 high→low + 撤 C3，open 事件仍进 self-healing-analysis `findOpen(20)` 与 8:30「消费即处置」链——未满足「不要海獭系统处理」。处置：`HealingEventInput` 新增 `initialStatus`，配额耗终态落地即 **resolved**（resolution 注记「资源侧正常事实按搭档边界拍板免处置」），open 消费面（每日分析/消费即处置/超限聚合）机械不可见；`checkModelQuotaHint`（create_otter 24h 改派提示）改扫 open+resolved 两态——边界内功能保留且不依赖 open 语义（24h 窗口是真过滤，open/resolved 不携带配额恢复语义）。测试补断言：status 全 resolved + resolution 注记在场。
- **🔴2 注释编号闸**：代码注释中的特性/issue 编号按闸剥除（语义保留、出处归特性文档与 PR）；初版注释误写改名前 ID 的漂移一并消除。
