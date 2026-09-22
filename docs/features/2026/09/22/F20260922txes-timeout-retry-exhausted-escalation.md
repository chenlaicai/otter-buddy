---
id: F20260922txes
title: 超时重试耗尽 L3 升级上报（梯度防线补全）
doc_type: feature

summary: |
  生成超时（first_byte_timeout / streaming_timeout / circuit_break:event_timeout）
  自动重试耗尽后的终态补齐 L3 升级上报：healing medium 落账（errorType=timeout_retry_exhausted）
  + 会话内用户可见提示「自动重试后仍未恢复，可手动重试」。此前 L1 自动重试（软提示）→
  L2 硬中断 梯度完整但 L3 缺失——搭档只见「[系统保护] 已自动中断」，不知是重试失败终态，
  与 bash 守卫 bounce 机制（GUARD_BOUNCE_MAX 超限升级）不对称。

causal_links:
  from:
    - F20260831aksp
    - F20260907grdr

change_type: feature
tags: [gradient-guard, timeout, healing, observability, retry]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
  - src/entities/healing/healing-event.ts
capability_test: "n/a: 系统护栏行为（非 LLM 参与行为），覆盖于 tests/usecases/conversation/agent-turn-orchestrator/retry-policy.test.ts"
created_in_conversation: 5c8cc078-3655-4e1a-ae63-70af967f92f9
---

# F20260922txes: 超时重试耗尽 L3 升级上报

## 背景

搭档在对话中观察到 `[系统保护] 生成超时（长时间无输出），已自动中断`，质疑该拦截是否符合「提示>拦截」的梯度设计原则。源码核实结论：梯度本身成立——

| 层级 | 触发 | 动作 | 锚点 |
|---|---|---|---|
| L1 软提示 | 首次 first_byte_timeout / streaming_timeout | 自动重试 + 系统提醒「请重新生成/继续完成发言」 | retry-policy.ts `buildAutoRetryMsg` |
| L2 硬中断 | retryCount>0 仍超时 | `[系统保护] 已自动中断` | orchestrator.ts:439-445 |
| ~~L3 上报~~ | — | **缺失**（本次补齐） | — |

对比 bash 守卫 bounce 机制（#731）：拦截 → 自动回发引导 → `GUARD_BOUNCE_MAX` 超限后 healing high + 会话内升级通知（`escalateGuardBounce`）。超时路径在 L2 就断了，静默中断掩盖模型/网络异常信号。

## 方案设计

在 `abortTerminal` 中新增超时重试耗尽终态的判定与升级，与既有 `isGuardBounceTerminal` / `recordGuardBounceTerminal` 模式同构：

- **判定**（`isTimeoutRetryExhaustedTerminal`）：`kind === 'guard'` + `guardReason ∈ isTimeoutGuardReason 闭集`（first_byte_timeout / streaming_timeout / circuit_break:event_timeout）+ `retryCount > 0` + `!manualRetry`。排除项：bash_safety（#731 bounce 独立升级）、degenerate（不可重试）、非超时 circuit_break trigger（如 ignored_steer）、手动重试（manualRetry=true 的 invoke 内从未发生 L1 自动重试，「自动重试后仍未恢复」将是不实陈述）。
- **升级**（`escalateTimeoutRetryExhausted`）：
  1. healing 落账：`errorType=timeout_retry_exhausted`、`severity=medium`（单次重试耗尽多为环境信号，区别于 bounce 二拦的 high 自纠失败），context 含 guardReason/retryCount/toolCallCount；写入失败 logger.error 留痕（升级机制自身失败不该无痕）；
  2. 会话内提示：`buildTimeoutRetryExhaustedMsg`——只写确证事实（重试过、仍未恢复、可手动重试），不归因服务波动/模型状态（F20260913ctlv 口径）；event_timeout 标签「单次工具调用超时」与 L2 buildGuardAbortBody 一致。
- **环境分账**：`timeout_retry_exhausted` 入 `HEALING_ENVIRONMENT_TYPES`——超时是模型/网络环境信号，漏入会被 classifyHealingErrorType 兜底归 capability，daily-review 误读为獭能力失败。

`HealingErrorType` 与 `HealingEventInput.errorType` 联合类型同步扩展 `timeout_retry_exhausted`。

### 机制预算四问（mechanism-addition 必答）

1. **谁需要**：搭档（中断消息的消费者）与 daily-review（healing 台账的读者）——前者需要知道「这是重试失败终态而非首次故障」，后者需要环境/能力分账不混读。
2. **失败后果**：机制失效（healing 写入或 sendSystem 失败）仅退回原状（只见 L2 中断文案），logger.error 留痕可追——不会比现状更差。
3. **后续机制**：无计划依赖；若未来超时率显著上升，可在 daily-review 按 errorType 聚合加阈值告警（届时另行评估，不预设）。
4. **退役条件**：若 L1 自动重试被移除（重试策略整体重构），本判定因 retryCount>0 不可达而自然死码，随重构一并删除。

## 影响范围

- 行为变化：仅超时/工具异常类自动重试耗尽的终态新增一条 healing 事件 + 一条会话内系统消息；首超时自动重试、bash bounce、degenerate 熔断路径均不受影响。
- healing 查询：新增 errorType 枚举值，`manage_healing_events` 按 errorType 过滤可直接定位。

## 验证

- `npx tsc --noEmit` 通过
- `npx vitest run tests/usecases/conversation/agent-turn-orchestrator/ tests/entities/healing/`：6 文件 79 用例全绿
- 新增用例：`isTimeoutGuardReason` 闭集边界 3 组（三超时命中 / 非超时 circuit_break 不命中 / bash_safety+degenerate+未知不命中）；`buildTimeoutRetryExhaustedMsg` 文案 4 组（三种 reason 标签 + 不归因断言）；`healing-event-classify` 全枚举覆盖清单同步 13→14（该测试正是防「新增枚举漏同步分账」的既有防线，首轮开发时被它抓住漏网，佐证检视发现 3 真实性）

## 审视处置记录（第一轮，检视獭-timeout-l3）

| # | 发现 | 处置 | 理由 |
|---|---|---|---|
| 1 | manualRetry 路径「自动重试后」陈述不实 | 接受修复：判定加 `!ctx.input.manualRetry` | 锚点核实 invoke-controller.ts:166（retryCount:1+manualRetry:true），L1 仅 retryCount===0 触发（orchestrator.ts:439）——反例成立，改了让口径更确证 |
| 2 | circuit_break:* 全集纳入超声明范围 | 接受修复：新增 `isTimeoutGuardReason` 闭集（仅三超时原因） | 锚点核实 tool-call-circuit-breaker.ts:259 存在 ignored_steer 非超时 trigger——非超时进 timeout_retry_exhausted 是枚举语义污染 |
| 3 | 新枚举漏 HEALING_ENVIRONMENT_TYPES 分账 | 接受修复：一行入环境清单 | healing-event.ts:38-42 核实兜底归 capability，恰是 #998 要防的误判；修复时 healing-event-classify.test.ts 全枚举覆盖用例立即抓到漏同步（防线有效性实证） |
| 4 | CI 红：分支落后 main | 接受：rebase 后重跑验证 | #1096 已合入 main |
| 5 | mechanism-addition 四问缺失 | 接受：特性文档补四问 | SKILL 主文 B4 列严重级，从主文 |
| 6 | 与 #1096 撞车 types.ts | 大獭仲裁：#1096 已 MERGED（11:34 前），rebase 即解，无顺序争议 | 时间序问题随 #1096 合入自然消解 |
| 7 | 文案自相矛盾（不归因却写「服务波动/排查模型服务状态」）+ event_timeout 标签与 L2 不一致 | 接受修复：去归因措辞 + 标签对齐「单次工具调用超时」 | 违反 F20260913ctlv 口径属实 |
| 8 | 两处空 catch 静默 | 部分接受：healing 写入失败 + sendSystem 失败均补 logger.error | 采纳「L3 机制自身失败不该无痕」；仍非致命不阻断终态（与 recordGuardBounceTerminal 的非致命定位一致，区别仅在留痕） |
| 9 | 核心判定零测试 | 接受修复：isTimeoutGuardReason 提为纯函数 + 3 组边界用例 | 判定逻辑提纯函数后可测；manualRetry 排除路径依赖 TerminalContext 构造，orchestrator 无既有单测基建，闭集纯函数测试已覆盖发现 2 的枚举边界，manualRetry 分支留 simple 判定注释 |
| 10 | L3 消息与 L2 abort body 近重复 | 反驳（不改） | escalateGuardBounce 双消息先例（orchestrator.ts:673-676）：L2 是中断事实陈述、L3 是升级处置通知，分层语义不同，删除任一则另一层读者受损 |

## 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| severity 定 medium 而非 high | medium | 单次重试耗尽多为临时服务波动；high 留给 bounce 二拦这类「LLM 无视引导自纠失败」的行为异常 |
| 提示文案不归因模型/网络 | 只写确证事实 + 排查建议 | 沿用 F20260913ctlv 搭档拍板口径：系统无法确证根因不写断言 |
| 挂在 abortTerminal 而非路由层 | abortTerminal | 与 isGuardBounceTerminal 同构，终态判定单点收口，路由层（routeExitReason）不增复杂度 |
