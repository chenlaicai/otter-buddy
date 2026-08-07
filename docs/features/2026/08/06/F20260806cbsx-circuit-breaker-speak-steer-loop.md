---
id: F20260806cbsx
title: circuit-breaker-speak-steer-loop
doc_type: feature

summary: |
  修复熔断器把正常 speak 收尾逼成「异常循环」误杀、且 abort 覆盖已交付结论的事故。
  根因：speak 成功（terminate:true）后，熔断器对该次 speak 调用注入的 stale steer 结构性必然复活 agent loop；
  模型服从 steer 重复 speak → CAS 拒绝 → 错误路径无 terminate → 撞硬顶 abort → abort 路径允许覆盖 speaking 消息，结论被系统保护消息吞掉。
  修法：speak 重复调用幂等终结（terminate:true，按 DomainError kind 识别）+ 熔断器不对 speak 注入 steer + abort 路径 speaking 守卫（改走 complete）。

causal_links:
  from:
    - F20260728cbwt   # 事件驱动两档制熔断器（steer 机制引入处）
    - F20260729cbpt   # per-event 超时拆分
    - F20260805abpp   # abort 投影（已知 terminate 工具路径例外）
  to: []

status: development
change_type: fix
tags: [agent, circuit-breaker, speak, steer, incident]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/circuit-breaker-helpers.ts
  - src/frameworks/agent/tool-call-circuit-breaker.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/conversation/send-message.ts
---

# F20260806cbsx: 熔断器 steer 复活 speak 已终结回合导致误杀

## 问题背景

2026-08-06 10:36，大獭（kimi k3）在对话《上下文使用率重新进入对话就消失了》中排查问题，
用户看到「[系统保护] 检测到工具调用异常循环，已自动中断。」。

**但大獭没有失控**——它在 10:36:02 已通过 speak 成功交付完整根因结论（speak 返回
「发言已提交成功，回合结束」）。34 秒后熔断器 terminate → abort，abort body 覆盖了已交付的消息。
用户损失：答案产生了却看不到。

同日该模式共发生 **3 起**：10:36（otter=032b9bee）、10:47（otter=57008a4c）、10:58（otter=35eb4919），
均 `trigger=tool_call_limit calls=44`、调用历史尾部 speak×2~3。一般性实锤，非孤例。

### 事故时间线（首起，session `019fd4e6`，conversation `6faa560e`）

| 时刻 | 事件 |
|------|------|
| 10:28–10:35 | 41 次工具调用（grep/sed 探针式排查），烧完 `maxToolCalls=40` 额度 |
| 10:35:10 | 第 41 次调用触发 steer：「Tool call limit reached (41/40). Call speak immediately.」 |
| 10:36:02 | 大獭立即服从，调用 speak 提交完整结论 → **成功**（返回 `terminate: true`） |
| 同一秒 | 熔断器把这次 speak 计为第 42 次调用，注入 stale steer「(42/40). Call speak immediately.」 |
| 10:36:21 | 大獭服从 steer 再次 speak → CAS 拒绝：`Cannot start speaking for message with status: speaking` |
| 10:36:36 | 第 44 次 speak → 超硬顶 43 → terminate → abort → 用户看到系统保护消息 |

## 根因分析

### SDK 机制（证据链，pi-agent-core agent-loop.js）

```js
while (hasMoreToolCalls || pendingMessages.length > 0) {   // :88
  ...
  hasMoreToolCalls = !executedToolBatch.terminate;          // :125 speak 成功 → false
  ...
  pendingMessages = (await config.getSteeringMessages?.()) || [];  // :160 仅在轮末 drain
}
```

- speak 成功的 `terminate: true` **确实生效**（`hasMoreToolCalls=false`），但内层循环条件是 `||`：
  steering 队列里的 stale steer 使 `pendingMessages.length > 0` → 强制再跑一轮。
- **复活是结构性必然，非时序竞态**：steer 在 `tool_execution_start`（工具执行前）入队，
  队列只在轮末（:160）被 drain——stale steer 不可能在同轮被提前消费，必然在 speak 成功的
  同一轮末复活循环。且 drain 每次一条（one-at-a-time），无积压。
- `shouldTerminateToolBatch`（:377-379）要求整批 every terminate——speak 单独调用才生效，
  与工具描述「speak 必须单独调用」互相印证。本事故中 speak 确为单独调用，terminate 本身无问题。
- `shouldStopAfterTurn` 全仓未配置，不存在提前出口。

### 四个缺陷叠加（缺一个都不构成事故）

**D1 — 熔断器对 speak 收「steering 费」**（tool-call-circuit-breaker.ts:199,250）
`check()` 先 `callCount++` 再评估，无工具豁免；`checkToolCallLimit` 对所有调用无差别 steer。
大獭第 42 次调用正是 steer 要求的收尾动作，且成功了——但这次调用的 `tool_execution_start`
又触发一条新 steer。**熔断器对它自己要求的动作开火。**

**D2 — steer 在 tool_execution_start 发射，无结果感知**（circuit-breaker-helpers.ts:41-65）
steer 发射时不知道这次 speak 会成功；熔断器只看 `tool_execution_start`，
`tool_execution_end` 仅用于清计时器（:67-74），无任何结果反馈通道。
SDK 侧有 `clearSteeringQueue()`（agent.js:179-181）——撤回机制存在，
但熔断器没有「speak 成功 → 撤回已注入 steer」的感知点去调用它。

**D3 — 重复 speak 的错误路径诱导重试且不 terminate**（tool-factory.ts:122-124）
`startSpeaking` CAS 拒绝后，speak 工具返回 `[错误] 发言声明失败：...请重试。`——
普通文本响应，**没有 `terminate: true`**，且文案「请重试」主动诱导模型重试一个
永远不可能成功的动作（消息已 speaking）。循环由此续命，直至撞硬顶。

**D4 — abort 路径允许覆盖 speaking 消息（损害放大器）**（agent-invoker.ts:368-381, message.ts:104-106）
`_handlePostInvocation:176` 的正常路径有「speaking 优先于 abort」的序，
但 invoke 抛错走 catch → `handleInvokeError` 时**没有状态检查**：
`canAbortMessage` 允许 speaking → `sendMessage.abort` 用合成 body 覆盖已交付内容。
本条不制造 loop，但决定了 loop 复活时用户必然损失已交付的结论。
（steer 语义说明：被 steer 的工具**照常执行**——helpers 只调 `session.steer()` 注入消息，
未接 SDK 的 `beforeToolCall` 阻断信道。）

### 讽刺点

F20260728cbwt 设计签名判据时特意写明「其他工具按工具名签名，speak 刷屏等仍能抓住」——
防 speak 刷屏的设计，这次恰好把正常的 speak 收尾打成了刷屏。

### 历史溯源（该类事故第四代）

| 时间 | trigger | 性质 |
|------|---------|------|
| 07-27 | steer_timeout，history 全 `unknown` | 事件不带 toolName/args → 签名塌缩误报（cbwt 修复） |
| 07-29/30 | timeout / steer_timeout | per-event 挂死（cbpt 拆独立计时器） |
| 08-06 | **tool_call_limit ×3** | 全新模式：stale steer 复活 terminate 的回合（本文档） |

## 修复方案

三个修点，各自独立成立，合起来构成纵深三层。

### 修点 1（主修，D3）：speak 重复调用幂等终结

`send-message.ts:217` 的 CAS 拒绝 `DomainError` kind 由 `"validation"` 改为 `"conflict"`
（同文件 :304 abort 的 CAS 拒绝已用 `"conflict"`，typed 识别先例存在；
startSpeaking 仅被 speak 工具经 otter-tool-client 调用，无 HTTP 状态映射面）。
`tool-factory.ts` speak 工具 catch 块按 kind 分流：

- `conflict`（消息已 speaking/completed/aborted——本回合发言已有终态或已提交）→ 返回
  `{ ...textResponse("[系统控制信号] 本回合发言已提交，无需重复调用 speak。请停止调用任何工具。"), terminate: true }`
- 其他错误（validation 等）→ 保持现状（错误文案 + 请重试）

语义依据：`speaking` 状态意味着发言内容已落库、回合事实上已结束，
第二次 speak 的正确语义是「确认终态并终结 loop」，而不是「重试」。
**这是本事故的根本修复**——它覆盖**任意来源**的 stale steer（不只 tool_call_limit 一条），
即使 steer 存在，第二次 speak 也会优雅终结循环，invoke 正常 complete。

### 修点 2（防御，D1+D2）：熔断器不对 speak 注入 steer

`circuit-breaker-helpers.ts` 的 `tool_execution_start` 钩子：
`toolName === "speak"` 且 check 结果为 `steer` 时，跳过 steer 注入。

- 计数照走（callHistory / callCount / 元数据不变）
- `terminate` 保留（硬顶与 ignored_steer 对 speak 仍然生效，防无限 speak 失败循环）
- consecutive / sliding-window 对 speak 的检测不变（speak 刷屏仍抓得住）

语义依据：speak 是回合出口。它成功 → loop 终结，steer 失去意义且有害（复活 loop）；
它失败 → 工具错误文案已自带纠正指导，steer 是重复信息。
无论从哪条路走，对 speak 注 steer 都没有正收益。

已知边界怪相（记录不修）：跳过 steer 后 `steerStrikes` 在 evaluate 内部照计
（先于 helpers 的跳过点），speak 连续失败场景模型从未见过 steer 却可能被
`ignored_steer` terminate——理由文案对 speak 略失真，但工具错误文案已承担警告职责，
且次数有界，可接受。

### 修点 3（损害兜底，D4）：abort 路径 speaking 守卫

`agent-invoker.ts` 的 abort 路径（`handleInvokeError` 及 catch 分流）加状态检查：
进入 abort 分支时先查消息状态——

- `speaking`：发言已提交（body + 发言石已落库），**内容交付优先于中断语义**——
  改走与 `_handlePostInvocation:176` 相同的 complete 路径收尾
  （`sendMessage.complete` 从 DB 读 body/targets → `tryCloseTurn` 关回合 → 正常调度下一位），
  不发 `message.aborted`。
- 其余状态：维持现状（abort 合成 body 覆盖）。

实现上从 `_handlePostInvocation` 提取「speaking → complete + completeAgentInvocation」
共享 helper 供 catch 路径复用；abort 场景无完整 tokenUsage，result 用降级值
（body 本就来自 DB 而非 result.text，不受影响；`completeAgentInvocation:270` 自带
`abortedMessages.delete`，stale 标记清理有着落）。
签名变更面：`handleInvokeError`（:359-365）需补 `conversationId`/`startTime` 参数，
三个调用点（:159/:181/:205）作用域内均可提供。

### 明确不做的

- **不把 speak 从计数/规则中整体豁免**：speak 刷屏（如反复 validation 失败）仍需
  consecutive 规则兜底；整体豁免会开出无保护窗口。
- **不改 SDK 循环语义**（terminate 后仍投递 steering 队列）：pi 原生行为，
  且 steering 队列语义对其他场景有意义；问题在我们制造了 stale steer。
- **不采用「speak 成功的 tool_execution_end 时 clearSteeringQueue()」**（审视轮候选项）：
  能撤 stale steer，但会误清搭档在 speak 执行期间排队的人工 steer，误伤面不可控；
  修点 2 的「不对 speak 注 steer」从源头消除 stale steer，无需事后撤回。
- **不动 maxToolCalls=40 额度**：本次是误杀不是额度不足；额度调参属另一议题。

## 验证

`tests/interface-adapters/agent-invoker.test.ts` / 熔断器测试新增用例：

1. **回归本事故**：超限 → speak 成功（terminate）→ 模拟 stale steer 存在 →
   再次 speak → 断言返回 terminate:true 终态信号，loop 不再继续；
2. **speak 不触发 steer**：callCount > maxToolCalls 时 speak 调用 → 断言无 steer 注入，
   但 callCount 照计；
3. **硬顶保留**：连续 speak 失败（validation 类错误）超硬顶 → terminate 仍触发；
4. **speak 刷屏仍被抓**：consecutive 相同 speak 满阈值 → steer/terminate 路径不变；
5. 既有熔断器测试全绿（steer 对非 speak 工具行为不变）；
6. **abort 守卫**：消息 speaking 时 invoke 抛 abort → 断言走 complete、DB body 保持
   第一次 speak 的内容、无 message.aborted 事件；
7. **abort 不受影响面**：消息 streaming 时 abort → 维持合成 body 覆盖现状；
8. **既有测试同步翻红修复**：`agent-invoker.test.ts` 两条 abort 用例
   （:173-211 B-Abort-1/2、:213-244 toolCallCount）的 fixture 默认 status 为 speaking
   （:59-61），修点 3 落地后必然翻绿转红——fixture status 改 streaming
   （与 :249/:268/:304 既有写法一致），断言面不变。

## 决策史

- 2026-08-06 搭档裁决（审视轮观察 2）：abort 覆盖 speaking 消息的守卫**并入本 PR**，
  不另开 follow-up——一次消灭本事故的损害路径。

## 对抗审视记录

### 第 1 轮（2026-08-06，独立架构师 agent，焦点：根因链时序确定性 / 损害链完整性 / 修点1 识别稳健性）

**结论**：无阻断性发现，方案可交付。根因链每环经代码/日志/SDK 亲验证实；
「steer 不阻断工具执行」「stale steer 复活循环的必然性」「abort 覆盖 speaking」全部成立。

**逐条处置**（按作者处置协议四分类）：

| # | 观察 | 处置 | 理由 |
|---|------|------|------|
| 1 | D2「不可撤回」措辞不准：SDK 有 clearSteeringQueue()，真实缺口是熔断器无结果感知 | 接受并修复 | 亲验 agent.js:179-181 属实；D2 改写，被拒候选补入「明确不做的」 |
| 2 | 损害链有第四因素：abort 覆盖 speaking 消息（message.ts:104 + handleInvokeError 无状态检查），修点1/2 修 loop 不修损害放大器 | 接受并修复 | _handlePostInvocation:176 有 speaking 优先序而 catch 路径没有，亲验属实；搭档裁决并入本 PR（修点 3） |
| 3 | 修点1 前缀匹配脆弱：DomainError kind "conflict" 先例已存在（send-message.ts:304），按 kind 识别同成本更稳 | 接受并修复 | 一行改动抗文案重述；修点 1 已改为 kind 识别 |
| 4 | 必然性论证可更强 + 同日另两起同模式事故（10:47/10:58）未引用 | 接受并修复 | log 14059/14398 亲验属实；SDK 节与问题背景已补强 |
| 5 | 修点2 后 steerStrikes 对 speak 照计的边界怪相 | 记录不修 | 工具错误文案已承担警告职责，次数有界；已写入修点 2 边界说明 |

**候选方案讨论**（审视提出、作者处置）：
- 「speak 成功时 clearSteeringQueue」——拒绝，误清搭档人工 steer 风险（见「明确不做的」）；
- 「invoke 层 abort 守卫」——接受为修点 3（搭档裁决并入）；
- 「只做单修点」——修点 1/2 各自独立可防本事故，但修点 1 覆盖任意来源 stale steer、
  修点 2 消除最大来源、修点 3 兜底损害，三层纵深保留。

### 第 2 轮（2026-08-06，delta 审视：逐条验证第 1 轮处置 + 修订回归检查）

**结论**：可交付。5/5 处置如实落实无虚报；修点 1/2/3 全部代码断言亲验成立
（含 otter-tool-client 错误传递链 kind 不丢、startSpeaking 无 HTTP 暴露面、
completeAgentInvocation 参数在 catch 作用域可得）。疑似洞亲验后排除：
HTTP abort 端点对 speaking 放行——既有 :176 优先序 + 修点 3 catch 守卫双层兜住，无需改。

**逐条处置**：

| # | 观察 | 处置 | 理由 |
|---|------|------|------|
| 1 | 验证节漏列 2 条必然翻红的既有 invoker abort 测试（fixture status=speaking） | 接受并修复 | 亲验 agent-invoker.test.ts:59-61/:173-244 属实；验证节新增第 8 条预列 fixture 修法 |
| 2 | 修点 3 共享 helper 隐含 handleInvokeError 签名扩展，文档未提 | 接受并修复 | 三个调用点参数均可得；修点 3 已补签名变更面说明 |
