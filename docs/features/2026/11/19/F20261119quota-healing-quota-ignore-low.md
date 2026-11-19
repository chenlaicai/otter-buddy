---
id: F20261119quota
title: "healing 忽略 token 正常耗尽：配额耗尽终态 severity high→low 并撤出 C3 高警队列（搭档边界拍板落地）"
summary: "搭档 2026-11-19 指令「修改healing机制、让其忽略这些token正常耗尽问题」，沿 11-17 边界拍板（token 用完跟系统无关）。#1511 回查实证该族 high 事件流周 27~60 条挤占真信号。改动：exhausted=true 终态 severity high→low、落地即 resolved（initialStatus，open 消费面机械不可见）、撤 C3 入队（context_overflow 维持）；瞬时限流 medium+open 不变；会话内告警维持；create_otter 改派提示改扫 open+resolved（24h 窗口为真过滤）。born-resolved 四问见特性文档。现存 open 事件为零，无存量清理。"
change_type: fix
capability_test: "n/a: 代码路径（非 prompt/skill 软代码），以 tests/interface-adapters/agent-invoker-circuit-retry.test.ts（severity 全 low + status 全 resolved + resolution 结构 + C3 enqueue 零调用 spy + 系统告警仍在）+ rate-limit-error.test.ts 识别语义不变 + healing-alert-registry.test.ts 队列机制不变 + 全量 vitest 6464 通过为验证载体；自然观察点：次日 8:30 日报 high 段与 open 消费面不再出现配额耗尽"
intent:
  problem: "配额耗尽（终态 429/403 quota 族）是资源侧正常事实，不是系统缺陷——但 healing 机制把它当 high 级系统问题落账：进高警队列叫醒大獭、进每日 8:30 高位统计、进 self-healing-analysis 聚合、进 regression-verify 断言数据源。#1511 回查（2026-11-19）实测 W42=6/W43=59/W44=27/W45=56/W46=7，周数十条的「正常耗尽」噪声持续挤占真信号注意力。搭档两级拍板定边界：11-17「token 用完跟系统无关，只在定时任务/新小獭触发时自动切换一次模型」+ 11-19「修改healing机制、让其忽略这些token正常耗尽问题」。"
  solution: "单一落账点收窄 + 落地终态：orchestrator.recordRateLimitHealingEvent 中 exhausted=true 分支 severity high→low 且 initialStatus=resolved（born-resolved），并整段删除 C3 healingAlertRegistry.enqueue（大獭不在场补送达通道不再消费该族）；context_overflow 的 C3 入队维持（体积超窗是注入侧终态问题，属系统信号）。born-resolved 的机制自债四问见「设计取舍（born-resolved 四问）」段。保留面：①瞬时限流（SDK 重试耗尽）维持 medium——它可能自愈、非「正常耗尽」；②会话内 sendSystem 告警维持——当前对话需要知道本轮为何终止，是现场上下文不是台账噪声；③create_otter 前置 24h 配额改派提示保留——checkModelQuotaHint 读 open 事件不筛 severity，天然兼容 low，且属搭档边界内「新小獭触发」功能；④首哑告警（小獭首 invoke 即配额死）独立机制不动——它是边界的执行路径（唤醒大獭 restart 换模型）。"
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
| 事件落地状态（exhausted） | open（进每日分析/消费即处置链） | born-resolved（initialStatus，open 消费面不可见） |
| C3 高警入队（exhausted） | enqueue（大獭补送达） | 删除（不入队） |
| context_overflow C3 入队 | enqueue | 不变（维持） |
| 会话内 sendSystem 告警 | 有 | 不变（维持） |
| create_otter 24h 改派提示 | 读 open 事件（不筛 severity） | 改扫 open+resolved 两态（24h 窗口为真过滤） |
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

## 设计取舍（born-resolved 四问）

1. **具体需要角色**：orchestrator 落账路径与每日消费链（self-healing-analysis / 8:30 消费即处置）——前者需要一个「记录但免处置」的终态表达，后者需要对资源侧正常事实机械免消费；搭档不需要（人工本可无视）。
2. **新机制失败的用户可感知后果**：born-resolved 误伤（非配额型事件被误标）→ 事件从 open 消费面消失、分析任务看不见——防线：initialStatus 仅由 recordRateLimitHealingEvent 的 exhausted 分支传值，单一调用点；误漏（应 resolved 仍 open）→ 退回初版状态（每日分析可见但已降 low），不劣于降级面。
3. **新状态出错后的后续处理**：排障需要看配额事实 → findAll(resolved)/sqlite 直查可查（resolution 注记自释）；若搭档改口径要重新消费该族 → 回滚本 PR 或改 initialStatus 传值，单点可逆。
4. **退役条件**：若 healing 事件模型引入「外部事实型」独立 status（非 open/resolved/dismissed 三态），born-resolved 分支迁移至该状态后退役。
