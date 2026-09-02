---
id: F20260902gbnc
title: 'bash 守卫二拦终态自动回发控制信号：恢复行动权自循环（#731）'
summary: |
  F20260831aksp 修复的半程收尾：一拦时拦截原因已透传进重试消息（LLM 一次自纠机会），
  但二拦终态后消息 aborted、发言链终止、行动权悬空，只能等用户手动拉起（2026-09-02
  当天多次实证）。本特性闭合后半程：终态前编排层插入 guard bounce——fail 过渡 +
  上限判定（healing_events 滑窗计数，10 分钟内最多 3 次）+ 回发控制信号（sendSystem
  写入对话流 + startNewMessage 新消息承载重整），被拦獭带原因继续任务而不是死掉。
  超限或台账失明时 fail-closed 升级：abort 终态 + healing high + 会话内系统消息通知
  用户。文案口径沿用 aksp 终审（四要素引导、无 restart 出口、PID 已脱敏透传）。
causal_links:
  from:
    - F20260831aksp
status: development
change_type: feature
tags: [guard-bounce, bash-safety-guard, orchestrator, action-token, healing]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - src/usecases/conversation/agent-turn-orchestrator/types.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/interface-adapters/agent-runtime/circuit-break-support.ts
capability_test: tests/interface-adapters/agent-invoker-guard-bounce.test.ts
created_in_conversation: 7370138e-632d-4292-9394-4f360c8b36bf
intent:
  problem: "bash 守卫二拦终态后消息 aborted、发言链终止、行动权悬空，獭不知道错在哪也没有机会换写法，只能等用户手动拉起（2026-09-02 实证）"
  expected_effect: "二拦终态后系统自动回发控制信号（带拦截原因+四要素引导），獭继续任务而非停摆；10 分钟窗口内最多自动回发 3 次，超限或台账失明 fail-closed 升级（healing high + 会话内通知用户）"
  verify_by:
    type: capability_test
---

# F20260902gbnc: bash 守卫二拦终态自动回发控制信号（#731）

## 背景

issue #731（2026-09-02 chen 提出）：

> 守卫拦截后发言直接失败，行动权悬空，每次都需要用户手动介入重新触发。被拦的獭不知道自己错在哪、也没有机会改写重试。……拦截应该是反馈信号，不是断头台。

F20260831aksp 修复后的拦截链路（现状）：

```
tool_execution_start (bash)
  → checkBashCommandSafety 命中 → doAbort(`bash_safety:${守卫文案}`)
  → exit-classifier → guard_abort
  → retryCount===0 且 isRetryableGuardAbort → handleAutoRetry（一拦：buildAutoRetryMsg 带因重试）
  → retryCount>0 二拦 → abortTerminal → 消息 aborted → 发言链终止 → 行动权悬空
```

二拦终态 = LLM 在拿到充分引导（一拦已透传原因+四要素）后仍复撞。此时消息 aborted，
`sendMessage.abort` 把 talkingStonePassedTo 传回 `[senderId]`（消息层事实），但
**invoker 层的 `turnResult.aggregatedTargets` 为空** → dispatch-chain 的
`processHopResults` 收敛出空 nextTargets → 链无下一跳 → 行动权悬空 → 等用户手动拉起。

当天实证：healing 台账 29 条 guard_intercept 事件（已随 PR #727 批量 resolve——那是
误报根因）；但「真拦截/自纠失败后停摆」的结构问题仍在，用户当天多次手动介入。

实现期活体样本：本 worktree 开发中，glm-flash 自己被旧守卫拦了一次（读含 e...val
字样的文件名 + sed 行号数字命中旧 eval 规则）——误拦形态真实存在，且「拦截后还能
继续干活」正是本特性要保证的。

## 目标

- **T1 回发闭环**：二拦终态后，系统自动把控制信号发回被拦的獭——携带拦截原因
  （复用守卫文案，PID 已在守卫层脱敏）+ 引导（worktree 正道 / 报告搭档），獭继续
  任务而不是死掉
- **T2 有界防护**：同一獭 10 分钟滑窗内自动回发上限 3 次（常量化 `GUARD_BOUNCE_MAX`），
  超限停止回发升级上报（healing high + 会话内系统消息通知用户）
- **T3 台账失明防护**：计数查询失败时 fail-closed（宁可升级也不无限回发），防
  「写失败 → 计数失明 → 无限自循环」

## 非目标

- 不动守卫本体（bash-safety-guard.ts，PR #727 刚合入，别翻案）
- 不做 OS 级隔离/守护进程（aksp 非目标沿用）
- 不改一拦 auto-retry 路径（aksp T2a 已闭环）
- 不引入 message 层重触发机制（见方案取舍）

## 方案设计

### 注入点决策：orchestrator 终态前路径（routeGuardAbort 分支）

任务书要求的设计决策点。三个候选：

| 候选 | 机制 | 评估 |
|------|------|------|
| **A. orchestrator routeGuardAbort 分支（选定）** | 在 `abortTerminal` 之前插入 bounce 判定：failMessage → 上限判定 → sendSystem + startNewMessage → RetryWithNewMessageSignal 上抛，executeTurn 主循环继续驱动 | 复用 RetryWithNewMessageSignal 现成机制（degenerate retry 同构，executeTurn 循环内消费）；orchestrator 天然持有 retryCount / guardReason / callbacks 全部上下文；不新增跨层信号 |
| B. agent-invoker 层 | 仿 `_circuitBreak` 信号：orchestrator 终态后上抛 `_guardBounce` 载荷，invoker 检测后重新 invokeConversation | 多一层信号协议 + invoker 重新走 buildDynamicContext（session 语义重复构建）；且 abortTerminal 已把消息置 aborted，invoker 层再拉起要处理 aborted 消息复活——状态机复杂化 |
| C. message 层重触发 | abort 时 talkingStonePassedTo 传回被拦獭自身，靠 dispatch 链重派 | talking-stone 语义是「交棒」，自交棒违反发言石协议（isValidTalkingStonePass 校验会拒）；且链引擎对自指 target 的行为未定义——危险路径 |

**选定 A**。核心论据：bounce 与 degenerate retry 在控制流上同构（旧消息收尾 + 新消息
重整 + 主循环继续），RetryWithNewMessageSignal 就是为此设计的现成通道；B/C 都在
为同一语义发明新机制。

### 回发链路（routeGuardAbort 内，`retryCount > 0` 且 bash_safety 前缀时）

```
routeGuardAbort（二拦终态判定点）
  → shouldGuardBounce 判定（独立方法降复杂度）
  → handleGuardBounce：
      1. failMessage（fail 过渡文案，非 aborted——旧消息语义是「拦截后回发」）
      2. getRecentGuardBounces 查滑窗计数（10min 窗口，healing_events 真相源）
         ├─ 超限（≥3）→ escalateGuardBounce：sendSystem 升级通知 + abortTerminal
         │   （abortTerminal 终态分支落 healing high——aksp 已有，不用重写）
         └─ 查询失败 → 同上 fail-closed（台账失明 ≠ 无限回发）
      3. recordHealingEvent（bounce 计数落账，context.bounce=true 标记，medium）
      4. executeGuardBounce：
         - sendSystem 回发消息（写入对话流：搭档可见、新消息可读）
         - startNewMessage 新消息（talkingStonePassedTo=[senderId]）
         - RetryWithNewMessageSignal 上抛 → executeTurn 主循环驱动新消息
         → 被拦獭带着原因+引导继续任务（事故 C 形态不复现）
```

### 回发消息文案（buildGuardBounceMsg）

```
[系统提醒] 你上一条发言因 bash 安全守卫拦截已中止，系统自动回发控制信号（第 N/3 次）。
{buildAutoRetryMsg 的 bash_safety 分支正文——透传守卫文案（PID 已脱敏）+ 四要素}
```

四要素口径沿用 aksp 终审：①被拦（守卫文案透传）②为什么（主进程=运行环境，无合法
场景）③正道（worktree 独立端口验证 / 服务异常报告搭档）④继续（重新分析任务，不要
重复原命令）。**不提供任何 restart 出口**。回发进度 N/3 显式告知——LLM 知道剩余
额度，用户在对话流可见回发节奏。

### 计数载体：healing_events 滑窗（写前查询）

- 计数键：`errorType=guard_intercept` 且 `context.bounce=true`，按 otterId 查
  `findRecentByOtter(otterId, 'guard_intercept', 50)` 后内存过滤窗口（10 分钟）与
  bounce 标记——复用现有 repo 方法，零 schema 变更
- **写前查询**（先查后写）：上限判定用「已落账的先前次数」，本轮落账在判定后——
  判定不依赖自己刚写的记录，无自读自写竞态
- 滑窗而非累计：限「同时失控的自循环」；十分钟前的拦截随窗口滑出，不永久占用额度
  （GB-3b 用例锁定该语义）
- 窗口内漏计的极端情形（>50 条/10min）不影响安全性：该场景早已远超 3 次上限

### 降级语义（各故障点）

| 故障点 | 行为 | 理由 |
|--------|------|------|
| 计数查询失败 | fail-closed 升级（abort + 通知） | 台账失明时计数不可信，宁可停止回发——防无限自循环 |
| 计数落账失败 | 本轮回发照常（仅日志），下轮查询兜底 | 单条漏账不影响本轮回发的正确性；下轮 fail-closed 兜底 |
| sendSystem 失败 | fallback abortTerminal | 回发消息是闭环核心，写不进对话流则回发无意义 |
| startNewMessage 失败 | fallback abortTerminal | 无新消息承载则 LLM 无处继续 |
| healing repo 未注入（降级配置） | getRecentGuardBounces 招错 → fail-closed 升级 | 不静默返回 0——降级配置下更不该无限回发 |

### 与既有 healing 语义的分层

- 框架层 medium（aksp T3，每次拦截）：统计样本，不动
- 编排层二拦终态 high（aksp T3，abortTerminal 分支）：升级告警，不动——bounce 超限
  路径走 abortTerminal 自动继承
- **新增编排层 bounce 计数 medium（本特性）**：`context.bounce=true` 与二拦终态
  high（context 无 bounce 标记）天然区分，`manage_healing_events` 按 errorType 查询
  时语义清晰

## 影响范围

| 模块 | 影响 |
|------|------|
| `orchestrator.ts` | routeGuardAbort 加 bounce 分支（shouldGuardBounce 判定）；新增 handleGuardBounce / escalateGuardBounce / executeGuardBounce 三方法 |
| `retry-policy.ts` | 新增 GUARD_BOUNCE_MAX / GUARD_BOUNCE_WINDOW_MS 常量 + buildGuardBounceMsg / buildGuardBounceFailBody / buildGuardBounceEscalationMsg 文案函数 |
| `types.ts` | TurnCallbacks 新增 getRecentGuardBounces（必选，接口变更） |
| `agent-invoker.ts` | createTurnCallbacks 接线 getRecentGuardBounces → circuitBreak.countRecentGuardBounces（无 repo 时拋错交由 fail-closed） |
| `circuit-break-support.ts` | 新增 countRecentGuardBounces（直查 healing_events，不吞错） |
| 消费方 | 二拦终态后对话流出现回发系统消息（用户可见）；healing 台账多 bounce 计数事件；行动权不再悬空 |

**行为变更说明**：bash_safety 二拦终态从「aborted + 停摆」变为「fail + 回发 + 继续」
（10 分钟内最多 3 次）。这是 #731 要求的有意变更；aborted 语义保留给超限升级。

## 风险与约束

1. **回发被无视（三连 bounce）**：10 分钟窗口 + 3 次上限兜底，超限升级 abort +
   healing high + 用户可见通知——不比现状差（现状第二次就停摆）
2. **无限自循环的理论风险**：计数查询失败时 fail-closed（不 fail-open）；落账失败
   时下轮查询兜底；写前查询消除自读自写竞态。三层防御下最坏情形 = 升级路径
3. **TurnCallbacks 接口变更（新增必选方法）**：全仓唯一实现方是 agent-invoker
   （已接线）；测试 mock 用 `as unknown as` 断言，不破坏
4. **回发消息进入 LLM 上下文的信息面**：透传守卫文案（PID 已在守卫层脱敏）——
   与一拦 auto-retry 同面，无新增泄露（aksp 风险 1 论证沿用）
5. **bounce 轮 LLM 再撞新命令形态**：每次撞都重新走一拦 auto-retry（retryCount 归
   零——新消息）→ 二拦 → bounce 计数 +1 → 3 次后升级。防线递进完整

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 注入点 | orchestrator routeGuardAbort 分支 | invoker 层 `_guardBounce` 信号 / message 层自交棒 | RetryWithNewMessageSignal 现成机制同构复用；B 层要处理 aborted 消息复活；C 违反发言石协议（详见方案设计节） |
| 计数载体 | healing_events 滑窗（写前查询） | invoker 内存计数 / otter_context | invoker 单例生命周期 ≠ 消息生命周期（服务重启计数归零 → 防护失效）；healing 是跨消息唯一真相源，且查询失败天然可感知（fail-closed 依赖此） |
| 计数窗口 | 10 分钟滑窗 | 会话累计 / 永久累计 | 限「同时失控」而非「历史总量」——十分钟前的教训不该堵死现在的自纠（误拦场景尤甚：守卫规则修正后旧拦截不该占额度） |
| 上限次数 | 3（常量 GUARD_BOUNCE_MAX） | 可配置（settings） | 三次自纠机会已足够（一拦 auto-retry + 3 次 bounce = 4 次引导）；先常量验证，有调参需求再配置化（最简实现） |
| 旧消息终态 | failed（fail 过渡文案） | aborted | bounce 语义是「拦截后回发继续」非「中止」；failed 与 auto-retry 轮的消息状态族一致，前端投影行为一致 |
| 回发消息通道 | sendSystem（消息实体）+ 新消息 userMessageContent | 只注入 userMessageContent（不写对话流） | 搭档必须可见回发节奏（N/3 进度）——只注入 LLM 上下文则回发对用户是黑盒（aksp 根因 3 同款教训） |

## 验证

| 验证项 | 方法 | 通过标准 | 结果 |
|--------|------|----------|------|
| GB-1 二拦终态自动回发 | 集成测试（AgentInvoker 全链路 mock 守卫命中） | 不 aborted；fail 过渡含「自动回发」；sendSystem 含原因+N/3 进度+四要素+无 restart；新消息创建；bounce 计数落账 | ✅ |
| GB-2 回发后自纠闭环 | 同上（第 3 次 invoke 正常完成） | 最终消息 completed；aggregatedTargets 正常交棒；LLM 输入含回发消息（事故 C 形态不复现） | ✅ |
| GB-3 超限升级 | seed 3 条窗口内 bounce 事件 | abort 终态；升级通知含「已连续 3 次」「请人工介入」「误拦」；healing high 落账；无第 4 次回发 | ✅ |
| GB-3b 滑窗语义 | seed 3 条 11 分钟前的事件 | 窗口外不计入，照常回发（第 1/3 次） | ✅ |
| GB-4 台账失明 fail-closed | mock findRecentByOtter 抛错 | abort + 升级通知；无回发轮 | ✅ |
| GB-5 dead message 防僵尸 | 断言 sdk abort 调用 | fail 后 SDK session 已 abort（F20260830fabt 接线对 bounce 轮生效） | ✅ |
| 文案四要素 + 无 restart 出口 | retry-policy 单测 | 进度/原因/不允许/worktree/不重复原命令断言；不含 restart 字样 | ✅ |
| 单元回归 | 全量 npm test | 225 文件 / 2842 用例 0 failed；tsc 零错；eslint 0 error | ✅ |
| 能力测试（软代码变更） | talking-stone-routing capability（真系统+真 LLM） | 3/3 采样成功（行动权路由行为不变量未被破坏） | ✅ |

**capability 全量说明**：本变更只改 guard_abort 终态分支的路由（bash_safety 二拦
路径），不影响正常完成/交棒路径的行为不变量；跑了最相关的 talking-stone-routing
（3/3 过）。全量 capability 套件（13 文件，真 LLM 串行约 40+ 分钟）在 CI 跑——
本 PR 无 golden gate 场景（守卫拦截行为是确定性的编排逻辑，非 LLM 行为漂移检测
对象），verify_by 标 capability_test 指向集成测试文件。

**最简实现检查**：已过——零新依赖、零新文件（除测试）；复用 RetryWithNewMessageSignal
/ sendSystem / startNewMessage / findRecentByOtter / abortTerminal 全部现成机制；
bounce 分支与 degenerate retry 控制流同构，未引入新信号协议。曾考虑「配置化上限」
（settings 读取），按「先常量后配置」原则砍掉。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts` | 修改 | routeGuardAbort bounce 分支 + shouldGuardBounce/handleGuardBounce/escalateGuardBounce/executeGuardBounce |
| `src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts` | 修改 | GUARD_BOUNCE_MAX/WINDOW_MS + 三个文案函数 |
| `src/usecases/conversation/agent-turn-orchestrator/types.ts` | 修改 | TurnCallbacks.getRecentGuardBounces |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | 回调接线（无 repo 拋错交 fail-closed） |
| `src/interface-adapters/agent-runtime/circuit-break-support.ts` | 修改 | countRecentGuardBounces |
| `tests/interface-adapters/agent-invoker-guard-bounce.test.ts` | 新增 | GB-1~GB-5 集成测试 |
| `tests/usecases/conversation/agent-turn-orchestrator/retry-policy.test.ts` | 修改 | bounce 文案与常量单测（+5） |
| `docs/features/2026/09/02/F20260902gbnc-guard-bounce-close-loop.md` | 新增 | 本文档 |

## 实现记录（2026-09-02）

按方案落地，T1-T3 全部实现：

| 方案项 | 实现结果 | 验证 |
|--------|----------|------|
| T1 回发闭环 | routeGuardAbort 终态前分支 + executeGuardBounce（sendSystem + startNewMessage + RetryWithNewMessageSignal） | GB-1/GB-2 |
| T2 有界防护 | GUARD_BOUNCE_MAX=3 + 10min 滑窗（写前查询）+ escalateGuardBounce（升级通知 + abortTerminal 继承 healing high） | GB-3/GB-3b |
| T3 台账失明防护 | getRecentGuardBounces 失败 → fail-closed 升级；无 repo 配置拋错不静默 | GB-4 |
| 文案口径 | buildGuardBounceMsg 复用 buildAutoRetryMsg 四要素 + N/3 进度；无 restart 出口断言 | retry-policy 单测 |

**测试**：全量 225 文件 / 2842 用例绿（新增 10：集成 5 + 单测 5）；tsc --noEmit
零错；eslint 0 error；talking-stone-routing capability 3/3 采样过。

**遗留裁决点（呈大獭）**：注入点决策选了 orchestrator 终态前路径（方案 A），
论证在「方案设计→注入点决策」节；B/C 候选的否决理由也在。如对选型有异议请在
审视阶段提出。
