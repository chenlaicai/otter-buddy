---
id: F20260915mfbk
title: 模型限流降级器：配额型 429 自动切 fallback 模型，重置后回切
summary: 解决 #843——配额型 429（code 1310，周/月上限）下定时任务绑定单一模型 = 当天全灭。orchestrator 检出 exhausted 时登记降级（ModelFallbackService），invoke 路径 resolve 到 fallback 替身，resetHint 到点自动回切；链耗尽维持 #543 的 high healing 可见性。
change_type: feature
capability_test: "n/a: 降级器为运行时服务，行为由 12 个新单测锁定（登记/解析/回切/清扫/resetHint 解析）；orchestrator 接线由 tsc 装配校验 + 全量回归覆盖"
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
created_at: 2026-09-15
intent:
  problem: "配额型 429 下定时任务绑定单一模型当天全灭（9-08 现场 daily-review 无产出、self-healing 需人工干预），无自动降级路径"
  expected_effect: "exhausted 429 后下一次 invoke 起自动用 fallback 模型执行（healing 留痕降级事实），重置时间到自动回切原模型；瞬时 429 行为完全不变"
  verify_by:
    type: behavior_check
tags: [scheduler, rate-limit, model-fallback, daily-review]
modules:
  - src/usecases/scheduler/model-fallback-service.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/bootstrap/platforms.ts
  - src/app.ts
  - tests/usecases/scheduler/model-fallback-service.test.ts
---

# 模型限流降级器（#843）

## 背景

2026-09-08 GLM 周配额耗尽（code 1310，重置以天计）：09:00 健康检查失败致当日无 daily-review issue；self-healing 需人工「再来」+ 手动改 kimi 才恢复。#543 已做告警层（healing 落账 + C3 高警队列），#886 重构移除了限流熔断分支——执行层的自动降级是缺口。9-14 本对话再次实证（glm 5 小时窗 1308 + 呆等恢复）。

## 方案

**核心：ModelFallbackService（内存态降级叠加层）**

- **登记**（register）：orchestrator `handleApiError` 检出 exhausted 429 时调用。fallback 链按序取第一个 ≠ 当前且池内的别名；链耗尽返回 null（healing 已落 high 保持可见性，本次 failTerminal 不静默）。重复登记幂等。
- **解析**（resolve）：pi-session-factory 两处模型解析点消费——「当前生效别名 == 被降级别名」时返回替身；**用户手动换模型（显式别名 ≠ 被降级别名）不干预**（手动决策 > 自动兜底）。
- **回切**：resetHint（东八区中文时间）解析出 resetAt，内存定时器到点 revert（漂移上限 24h）+ 启动 sweepExpired 兜底。解析失败回退 1h 后重试回切。
- **生命周期**：内存态，重启即回原模型（最坏 = 回到无降级现状，不引入持久一致性负担）。**不改 otter_configs**——那是用户意图的持久真相源，降级是 resolve 时合成的叠加层。

**Fallback 链**：`kimi → mimo → glm → glm-flash`（DEFAULT_FALLBACK_CHAIN 常量，后续可接配置）。Why kimi 在前：issue 现场 #543 恢复路径用的就是 kimi；glm-flash 是多模态 Flash 放最后。

**瞬时 429（code 1308）行为零变化**：register 仅在 `match.exhausted` 分支调用，瞬时型仍走 SDK 内置重试 + #543 medium 告警。

## 设计取舍记录

- **Why 不重试本次执行**：failTerminal 已落账 + 降级登记后下一次触发自然用新模型——避免「重试循环 × 降级切换」的状态机复杂度；定时任务天然有下一次触发窗口（这正是定时场景比交互场景好做 fallback 的原因）。
- **Why resolve 在 factory 而非 orchestrator**：模型解析的唯一真相点在 pi-session-factory（池化会话创建处），orchestrator 只管错误分类与登记——单一职责。
- **Why 内存态不落库**：跨重启保持降级会引入「降级状态 vs 用户改配置」的一致性问题（用户在降级期间改了模型别名，恢复时旧降级覆盖新意图）。内存态最坏情况 = 重启后第一次触发再次 429 再登记一次，代价可接受。

## 验证

- #926 检视处置后：严重 1（1308 误判 exhausted）修复——SHORT_WINDOW 复核（「N 小时」粒度且无周/月词 → 改判瞬时），transient 池补「N 小时使用上限」识别保持 medium 告警路径；建议 2/3 修复——过去 resetAt 钳 1 分钟（降级不形同虚设）+ 启动 sweepExpired 装配调用（platforms.ts）
- 新增 13 单测（tests/usecases/scheduler/model-fallback-service.test.ts）：register 3（链取值/链耗尽/幂等）+ resolve 4（显式命中/默认命中/手动换模型不干预/未降级）+ revert 3（幂等/定时回切/清扫兜底）+ resetHint 2（中文解析/缺失回退）
- 全量 2955/2955 pass（含 orchestrator/factory 全部既有用例零回归），tsc 0 error，eslint 0 error
- 装配链（platforms.ts / app.ts）tsc 编译校验通过——modelFallback 单例贯穿 createAgentGateway → initAgentAndScheduler → AgentInvoker → orchestrator
- 最简实现检查：已过——单文件服务类（~150 行）+ 三处消费点各 1-3 行 + 装配透传，无新依赖无新表

## 边界与已知限制

- 降级只救「下一次触发」，本次失败的 invoke 不重试（设计取舍，见上）；
- fallback 链是全局常量，未接 scheduled_tasks.fallbackModelAlias（issue 方案 3 的任务级配置）——当前 4 模型池全局链已覆盖现场需求，任务级配置留待真实需求出现（YAGNI）；
- kimi 当前禁用中（chen 2026-09-14 指令「没额度」）——链会自动跳过池内不可用模型吗？hasModel 只查池注册不查配额，配额耗尽的 kimi 在链上仍会被选中。**已知限制**：若 kimi 也配额耗尽，其 429 会再触发一次降级登记（glm→kimi 后 kimi exhausted → kimi→mimo），级联降级自然发生——这其实是正确行为，不是 bug。

## 关联

- closes #843
- 地基：#543（429 告警层：分类器 matchRateLimitError / healing 分级 / C3 队列复用）
- 姊妹：#764（429 abort 归因）、#914（scheduler catch-up healing）
