---
id: F20260914rtsp
title: 獭实时状态面板与 Session 弹窗事件体验升级
doc_type: feature

summary: |
  F20260913ctlv（时间线 + invoke 实体 + Session 弹窗）上线后的展示层迭代。
  搭档 9/14 提出三点：①右栏实时状态免点开可见关键信息（运行状态/模型/上下文）；
  ②双层结构保留；③Session 弹窗无实时渲染 + 事件内容重复。排查另发现两个实锤
  （运行中耗时秒数不走、ctx 占用恒 null）。方案：右栏卡片信息升级 + 运行中状态
  心跳驱动 + Session 弹窗 running invoke 实时尾随 + invoke_events 展示模型折叠。

causal_links:
  from:
    - F20260913ctlv   # 时间线/invoke 实体/Session 弹窗母方案
  supersedes: []

change_type: feature
tags: [web-ui, realtime, invoke-events, session-panel, right-panel, dedup, sse]
modules:
  - src/usecases/conversation/agent-turn-orchestrator/event-mapping.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/frameworks/db/conversation/sqlite-invoke-repository.ts
  - web/src/lib/invoke-tracker.ts
  - web/src/pages/conversation/RightPanel.tsx
  - web/src/pages/conversation/SessionModal.tsx
created_in_conversation: 556350b8-2b58-401d-9a57-a059265683c5
capability_test: "n/a: 纯展示层（右栏卡片 + Session 弹窗渲染），行为由组件测试覆盖（RightPanel.test.tsx / SessionModal.test.tsx 新增用例）"
intent:
  problem: "右侧栏獭状态信息密度不足（无上下文占用/模型运行时确认/耗时走秒），Session 弹窗打开后无实时渲染且事件按原始流分列存在 start/end 双记内容重复"
  expected_effect: "右栏不点开即见运行状态+模型+ctx 占用+走秒耗时；Session 弹窗 running invoke 实时尾随新事件；事件按模型折叠视图展示（调用→结果一行）"
  verify_by:
    type: behavior_check
---

# F20260914rtsp: 獭实时状态面板与 Session 弹窗事件体验升级

## 背景

搭档 9/14 原话（意图锚）：
> 我期望右侧栏的 海獭执行状态 这些信息能够展示得更好点。我提几点
> 1.实时状态渲染。我期望说我不用点开，我就能看到海獭的当前状态、关键信息，比如说 运行中/休息中，所用模型，当前所用上下文
> 2.第二层信息，海獭面板现在主要分为上下两个区域，上层点击就是弹出 海獭信息面板，下层则有session等几个按钮，我觉得挺好的
> 3.session界面点开时则不太友好，因为没有实时渲染事件；以及，现在事件展示还是有点奇怪，我记得pi原生event有start/end等，比如调用一次工具，可能会有多个event，然后以前版本好像就留一个start和一个end？还是怎么样的，我忘记了，但现在我看着内容有重复就很难受
> 更多的可以你来思考，不局限于这些

前置：F20260913ctlv 已落地 entries/invoke/invoke_events 数据模型与右栏/弹窗初版。
本次不改数据模型骨架，只做数据补齐与展示层升级。

## 排查结论（实锤，file:line 以 worktree 当前 main 为准）

| # | 问题 | 根因 | 锚点 |
|---|------|------|------|
| P1 | 运行中耗时秒数不走（「行动中 · 45s」定格） | 无任何定时器驱动 re-render；fmtInvokeElapsed 用 Date.now() 但没人触发 | web/src/pages/conversation/RightPanel.tsx:254（invoke-state-line）、web/src/lib/invoke-tracker.ts:100 |
| P2 | 「当前所用上下文」无数据 | entries.context_tokens 恒写 null（send-entry.ts:166 等 8 处）；右栏无 ctx 展示 | src/usecases/conversation/send-entry.ts:166,261,305,361,382 |
| P3 | Session 弹窗无实时渲染 | 打开时一次拉取，无轮询/无 SSE 订阅；invoke_events 不广播 SSE（F20260913ctlv D5 决策：只落库） | web/src/pages/conversation/SessionModal.tsx:31-37 |
| P4 | 事件内容重复 | mapToInvokeEventInput 把 tool_execution_start（快照）与 tool_execution_end（结果）各落一条 assistant_toolcall/tool_result + message_end 快照再落一条 assistant_toolcall——同一次工具调用最多出现 3 次 | src/usecases/conversation/agent-turn-orchestrator/event-mapping.ts:94-107 |
| P5 | 历史回看 ctx 缺失 | invokes 表无 ctx 字段；listInvokes 无法带出历史 ctx | src/frameworks/db/conversation/sqlite-invoke-repository.ts |

## 目标

- T1: 右栏卡片免点开信息升级——运行状态（行动中/休息中）+ 模型 + ctx 占用（x/上限）+ 运行中走秒耗时，全部一眼可见
- T2: Session 弹窗实时化——running invoke 打开时新事件实时尾随（不用重开）
- T3: 事件展示去重折叠——同一次工具调用按「调用 → 结果」折叠为一行（可展开原始分列），speak/思考渲染区分
- T4: Session 弹窗自动展开最新 invoke（打开即看当前/最近行动，不用手点）

## 非目标

- 不改 invoke 生命周期与信号路由语义（F20260913ctlv 定稿）
- 不改 invoke_events 落库内容（原始流忠实存储保留——展示层折叠，不销毁证据）
- 不做中间栏/时间线改动
- 不做 invoke_events 的 SSE 全量广播（实时化用拉取式增量，见 D2）
- 榜样级「思考中/调用工具中」文案，本版不做（依赖 P4 折叠态预判，留后续）

## 方案设计

### A. 右栏卡片升级（T1）

现状卡片结构保留（搭档认可的双层结构）：头像+名+模型 badge 行 / 身份行 / invoke 状态行 / 操作行。

改动：
1. **invoke 状态行增强**（RightPanel.tsx OtterParticipantCard）：
   - running：`● 行动中 · 2m13s · 🛠 8 · ⬛ 45.2k/200k`（ctx 占用短格式，k 为单位）
   - 终态：`休息中 · 上轮 1m02s · 🛠 5`（用「休息中」替代现在的「已完成」措辞，呼应搭档「运行中/休息中」用语）
2. **ctx 数据链路**（新增 SSE 事件 invoke.tick）：
   - 事件源：agent-invoker.handleStreamEvent 收到 message_end 时，从 e.message.usage 提取 `{input, output, cacheRead, cacheWrite}`，算 ctxUsed = input+output+cacheRead+cacheWrite（与 F20260808ctxw ctxTokens 同口径）
   - 端口定义已有数据源：pi-agent-core AssistantMessage.usage: Usage（pi-ai/dist/types.d.ts），Pi 已在 message_end 事件携带完整 usage——无需 SDK 侧改动，纯消费
   - 广播：`invoke.tick {invokeId, otterId, ctxTokens, ctxMax, modelAlias, toolCallCount}`——toolCallCount 顺带实时化（现在右栏运行中显示 '—'）
   - 消费：web invoke-tracker applyInvokeTick 扩展状态；刷新恢复靠 listInvokes 补（见 B）
   - 频率：message_end 粒度（每次 LLM 往返一次），无需节流
3. **走秒驱动**：右栏容器级 1s setInterval（有任一 running 时激活），setNow(t) 驱动 fmtInvokeElapsed 重算。interval 挂 RightPanel 顶层而非每卡片，避免 N 獭 N 定时器
4. **ctxMax 来源**：invoke.tick 携带（模型注册表 ctx 上限，后端 getCtxMax(modelAlias)；拿不到则不显示分母）

### B. ctx 落库与历史恢复（T1+P5）

invokes 表加列 `ctx_tokens INTEGER`（最近一次 LLM 往返的上下文占用）：
- 写入时机：invoke.tick 发射时同步 update invokes set ctx_tokens（每 LLM 往返一次 UPDATE，频率可接受）
- 消费方声明：①右栏刷新恢复（listInvokes 返回 ctxTokens → applyInvokeTick 预填）②Session 弹窗 invoke 行摘要展示
- 现值 entry.context_tokens 字段维持 null（不复活，避免双写口径分裂）——历史遗留字段，退役判定另起

### C. Session 弹窗实时化（T2+T4）

1. **自动展开**：invokes 加载完成（或已有缓存）后，自动展开第一行（running 优先，否则最新一条）
2. **running invoke 实时尾随**（拉取式增量，不引 SSE）：
   - 展开的 invoke 若 status==='running'：2s 间隔轮询 getInvokeEvents(invokeId)，按事件 id 去重 append
   - 轮询期间锁定自动滚动到底部（用户上滚则暂停跟随，滚到底部恢复）
   - invoke 终态（下次轮询发现 status 变化 or invoke.end 全局事件）→ 停轮询
   - 节流防御：invoke_events 单 invoke 数量大时（>500 条）轮询带 before 分页参数只拉增量
3. **弹窗打开期间新 invoke 开始**：右栏 streaming 状态变化或轮询发现列表变化 → 重新拉 invoke 列表（轻量，仅发生时）

### D. 事件展示折叠模型（T3+P4）

**存储不动，展示层折叠**——invoke_events 原始流是忠实记录（排查/审计价值），重复是展示问题不是存储问题。SessionModal 渲染前做纯函数归并：

```ts
// web/src/lib/invoke-event-fold.ts（新建）
type FoldedStep =
  | { kind: 'call'; toolCallId: string; name: string; args; result?: unknown; isError?: boolean; durationMs?: number; tsStart; tsEnd }
  | { kind: 'think'; text: string; ts }                    // assistant_text（纯文本块）
  | { kind: 'speak'; body: string; ts }
  | { kind: 'error'; message: string; ts }

function foldInvokeEvents(events: InvokeEventDTO[]): FoldedStep[]
```

归并规则：
1. `assistant_toolcall`（tool_execution_start 落库）以 payload.name+arguments 为身份，与后续 `tool_result`（tool_execution_end）按事件顺序配对——同 name 串行配对（工具串行执行，顺序配对即正确）
2. message_end 落库的 assistant_toolcall（快照，无 toolCallId）——被 1 消费后丢弃（它只是 LLM 侧请求块的复述）
3. message_end 的 assistant_text——think 步（LLM 思考文本）
4. speak 事件直通
5. 无法配对的孤儿（result 无 start）：以 result 独立成 call 步（容错）
6. 折叠视图每个 call 步可展开看原始分列（保留溯源能力）

渲染：一行 = 图标 + 工具名 + 参数摘要（truncate）+ 耗时 + 状态点（成功绿/失败红/进行中黄呼吸）+ 展开箭头。think 步灰字斜体折叠为一行，点开看全文。speak 步 otter 色高亮。

### E. 其他小修（不立项，随本 PR 带走）

- SessionModal 头部加该獭模型 badge（invoke.tick 的 modelAlias 或 otter.modelAlias）
- invoke 行摘要加 ctx 短格式（B 落库后自然可得）

## 影响范围

- SSE 契约：新增 invoke.tick 事件（api-contract/sse/events.ts + web 类型）
- invokes 表：加列 ctx_tokens（migration，向后兼容 ALTER ADD）
- 前端：RightPanel / SessionModal / invoke-tracker / 新 invoke-event-fold.ts
- 后端：agent-invoker（tick 发射 + ctx 提取）、event-mapping（不变）、invoke-repository（ctx_tokens 读写）

## 风险与约束

| 风险 | 缓解 |
|------|------|
| invoke.tick 事件遗漏 usage（SDK 版本差异） | 提取失败则不发射（右栏显示 '—'，不报错）；防御性解析 |
| 2s 轮询对后端压力 | 单 invoke 增量分页；弹窗关闭即停；同会话多弹窗不并存（单 modal） |
| 折叠归并把不同信息挤一行 | call 步展开可见原始分列；折叠是默认视图不是唯一视图 |
| ctx_tokens 每 LLM 往返一次 UPDATE | SQLite 单行 UPDATE 开销可忽略（invokes 按 id 主键） |
| message_end 快照配对依赖串行假设 | pi 工具串行执行为默认（ToolExecutionMode sequential）；parallel 模式下按 name 配对退化仍正确（同名并发在 otter 工具面不存在） |

## 不兼容更新

- [Incompatible] SSE 新增 invoke.tick 事件（旧前端忽略未知事件，无破坏）
- [Incompatible] invokes 表新增 ctx_tokens 列（ALTER ADD，默认 NULL，无数据迁移）

## 设计取舍

| # | 取舍 | 决策 | 替代方案 | 理由 |
|---|------|------|---------|------|
| D1 | 上下文占用实时化通道 | 新增 invoke.tick SSE（message_end 粒度） | ①写入 entries.context_tokens ②前端从 token bar 估算 | ①高频写 entry 表、历史 entry 语义混淆；②不准。tick 是事件不是状态，与 invoke.start/end 同族，成本最低 |
| D2 | Session 弹窗实时化 | 2s 拉取式增量轮询 | invoke_events 逐事件 SSE 广播 | ctlv D5 已拍板流式过程不进 SSE（聊天室纯净性）；弹窗是单消费者场景，轮询够用且零契约变更 |
| D3 | 事件去重 | 展示层纯函数折叠，存储不动 | 落库侧去重（只存 start+end 合并条） | 原始流是忠实记录（排查价值）；搭档记忆中「以前只留 start 和 end」正是落库侧去重的老路径，ctlv 已明确忠实原始流（D5 拍板选项 A）——重复是展示问题，折叠归并保留展开溯源 |
| D4 | 走秒驱动 | 右栏容器级 1s interval | 每卡片独立 interval | N 獭 N 定时器无意义；容器级单定时器 + 无 running 时停 |
| D5 | ctx 历史恢复 | invokes.ctx_tokens 落库 | 不落库（刷新丢失） | 刷新恢复是 ctlv test17 已有的验收面；每 LLM 往返一次 UPDATE 成本可忽略 |
| D6 | 自动展开最新 invoke | 默认展开第一行 | 保持手点 | 弹窗核心场景是「看这獭现在在干嘛」；点开还要再点一次是多余交互 |
| D7 | toolCallCount 运行中显示 | invoke.tick 顺带携带 | 前端本地累加 tool_execution SSE | 流式事件不进 SSE（D5 约束）；tick 顺带零成本 |

**机制预算四问**（识别检查点命中：新增 SSE 事件类型 + 新增 schema 字段）：

**invoke.tick 事件**：
① 谁需要——右栏獭状态面板（ctx 占用/工具计数实时化）；搭档明确要「不用点开就能看到当前上下文」
② 失败后果——右栏 ctx 显示 '—'（陈旧值兜底），无用户可见错误
③ 后续机制——tick 携带字段扩展（如 thinking level）需同步 SSE 契约与前端类型；失败路径：usage 缺失时不发射
④ 退役条件——invoke 状态投影整体重做（如未来 invoke 状态走 WebSocket 推送）时随 invoke.start/end 一并迁移

**invokes.ctx_tokens 列**：
① 谁需要——右栏刷新恢复 + Session 弹窗 invoke 行摘要
② 失败后果——刷新后 ctx 显示 '—'（null 兜底）
③ 后续机制——UPDATE 失败静默降级（warn 日志）；字段消费方只有展示层
④ 退役条件——ctx 语义升级为完整窗口曲线（数组化）时改列或加表

**重对抗门结论**：自审判定——本方案是 ctlv 已确立机制的展示层补全（tick 与 start/end 同族、ctx_tokens 是 D5 终态字段的运行中版），非净新增决策机制；四问已答，落库侧零结构变更。呈检视獭复核（审视轮追加门控三问）。

## 验证

| 编号 | 场景 | 预期 |
|------|------|------|
| AT-1 | 獭 running，右栏免点开 | 状态行显示：● 行动中 · 走秒耗时 · 🛠 计数 · ⬛ ctx/上限 |
| AT-2 | 耗时走秒 | running 期间每秒 +1s，无卡顿；终态定格 |
| AT-3 | 无 running 獭 | 定时器停；状态行显示「休息中」 |
| AT-4 | message_end 携带 usage | invoke.tick 发射，右栏 ctx 更新；usage 缺失时不发射不报错 |
| AT-5 | 刷新页面 | running invoke 状态 + ctx + toolCallCount 从 listInvokes 恢复 |
| AT-6 | Session 弹窗自动展开 | 打开即展开最新 invoke（running 优先） |
| AT-7 | running invoke 实时尾随 | 弹窗开着，新事件 2s 内出现；自动滚动跟随；上滚暂停跟随 |
| AT-8 | 事件折叠视图 | 同一次工具调用显示一行（名称+摘要+耗时+状态）；点开可见原始分列 |
| AT-9 | 折叠容错 | 孤儿 result 独立成步；message_end 快照被消费不重复 |
| AT-10 | 弹窗关闭 | 轮询停止，无内存泄漏（unmount 清理） |

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| api-contract/sse/events.ts | 改 | 新增 invoke.tick 事件类型 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 改 | handleStreamEvent 消费 message_end 提取 usage → 发射 invoke.tick + ctx_tokens 落库 |
| src/frameworks/db/schema.ts + migration | 改 | invokes 加列 ctx_tokens |
| src/frameworks/db/conversation/sqlite-invoke-repository.ts | 改 | ctx_tokens 读写 + DTO 带出 |
| web/src/lib/invoke-tracker.ts | 改 | applyInvokeTick + ctx/modelAlias/toolCallCount 字段扩展 |
| web/src/lib/invoke-event-fold.ts | 新建 | 折叠归并纯函数 |
| web/src/pages/conversation/RightPanel.tsx | 改 | 状态行升级 + 1s 走秒容器定时器 |
| web/src/pages/conversation/SessionModal.tsx | 改 | 自动展开 + 轮询尾随 + 折叠视图渲染 |
| web/src/pages/conversation/index.tsx | 改 | invoke.tick SSE 订阅接线 |
| tests（web 组件 + 后端单测） | 改 | AT 用例覆盖 |
