---
id: F20260914evdz
title: Session 弹窗事件去重终态对齐：speak 吸收 + 终态中断标记
doc_type: feature

summary: |
  F20260914rtsp（PR #916）合入后搭档仍反馈 Session 弹窗事件重复。重启后拉真实
  invoke_events 数据验证：普通工具折叠生效，但 ① speak 调用永不配对（end 被
  event-mapping 特判落 speak 事件）→ 一次发言渲染两条（假「执行中」工具行 +
  发言行）；② 终态 invoke 未配对 start 永远假转圈；③ 实时化靠 2s 轮询非事件
  驱动；④ 折叠行点开只有 JSON 截断（旧版「流式过程」面板的全文+复制体验丢失）。
  修法：speak 吸收 + invokeEnded 中断标记 + 落库后广播 invoke.event（事件驱动
  实时观察，零定时器，主界面零 re-render）+ 展开区全文找回。

causal_links:
  from:
    - F20260914rtsp   # 折叠归并母方案（invoke-event-fold.ts 即其产物）
  supersedes: []

change_type: feature
tags: [web-ui, invoke-events, session-panel, dedup, fold, sse, realtime]
modules:
  - api-contract/sse/events.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/bootstrap/clients.ts
  - web/src/lib/invoke-event-fold.ts
  - web/src/pages/conversation/SessionModal.tsx
  - web/src/pages/conversation/index.tsx
created_in_conversation: 556350b8-2b58-401d-9a57-a059265683c5
capability_test: "n/a: 纯展示层（折叠纯函数 + 弹窗渲染），行为由单元/组件测试覆盖（invoke-event-fold.test.ts / SessionModal.test.tsx 新增用例）"
intent:
  problem: "Session 弹窗事件折叠在真实数据形态下漏配对（speak 重复两条+假转圈），实时化依赖 2s 轮询（非事件驱动），折叠行点开只有 JSON 截断分列（丢失旧版全文+复制体验）"
  expected_effect: "一次 speak 只渲染 1 行发言；终态 invoke 未配对调用显示「已中断」；打开弹窗即事件驱动实时观察（无定时器，主界面零 re-render）；每条 event 点击展开参数/结果/发言/思考全文并可复制"
  verify_by:
    type: behavior_check
created_at: 2026-09-14T20:30:00+08:00
---

# 背景

搭档 9/14 20:05 指令（原话）：

> 数据层级还是按照多个invoke、然后多个event；但这个event的内容必须优化了，我今天也提过了，不要让我看到重复的内容，每一次 工具调用有开始、有结果（成功/失败），不要有三个或多个

# 真实数据验证（先查事实再动手）

拉 dev server 数据库（data/otter-buddy.db，表 invoke_events）：

- 事件类型分布：assistant_toolcall 6650 / tool_result 3316 / speak 184 / assistant_text 4 —— **toolcall ≈ result × 2**，即每次调用落库 3 条（start + result + message_end 快照），快照折叠靠 `Array.isArray(payload.content)` 判别（#916 已实现）
- 抽样我重启自己那轮 invoke（3dc69cc3）逐条核对：
  - `restart_otter`：快照丢弃 ✓ start+result 配对 1 行 ✓
  - `speak`：快照丢弃 ✓ 但 start 入队后**永无 tool_result**（end 被 event-mapping.ts:100 特判落 speak 事件）→ 假 pending 行 + 发言行 = 内容重复两条 ✗
  - `yield`：正常配对 ✓

结论：搭档看到的「重复」= 解读 ②（#916 折叠在真实数据下有 bug），非「没重启 dev server」。另发现被中断 invoke 的终态假转圈问题，一并修。

# 问题

## 问题 1：speak 调用永不配对（重复的直接来源）

落库链路：speak 的 `tool_execution_start` → assistant_toolcall{name,arguments} 入折叠队列；其 `tool_execution_end` 因 `details.__speakIntermediate === true`（tool-factory.ts:79）被归类为 speak 事件（非 tool_result）→ FIFO 队列里的 start 步永无配对结果。

渲染结果：一次发言两条——永远转圈的 speak 工具行（内容显示发言开头）+ 💬 发言行。

## 问题 2：终态 invoke 的假「执行中」

被中断/异常终止的 invoke，其未配对 start 步在折叠视图里渲染为「执行中…」转圈——但回合早已结束，永远不会再来结果。

# 方案（纯展示层，存储忠实保留）

不改 event-mapping（speak 事件形态是 F20260913ctlv 有意设计——弹窗里发言与工具调用分样式展示），改折叠纯函数：

## A. speak 吸收

`foldInvokeEvents` 处理 speak 事件时，从 `pendingCalls` 的 speak 同名队列出队一个 start 步：
- 命中 → 从 steps 移除该假工具行，发言步 `rawEventIds` 合并 `[...startIds, speakId]`（点开仍可看原始分列）
- 未命中（旧数据/异常序）→ 直通成发言步（原行为）

一次发言恰好 1 行 💬，与搭档「每一次工具调用有开始、有结果，不要有三个或多个」对齐——speak 的「开始+结果」语义由发言行承载。

## B. 终态中断标记

`foldInvokeEvents(events, { invokeEnded })` 新增可选参数：遍历结束后，invokeEnded=true 时把所有未配对 start 步标记 `interrupted: true, pending: false`。渲染层 SessionModal 传 `invokeEnded: !isRunning`：
- 中断 → 灰点 + 「已中断」
- running 未配对 → 保持转圈「执行中…」（真在跑）
- 正常配对 → 成功/失败绿/红点（原行为）

# 变更清单

| 文件 | 变更 |
|---|---|
| api-contract/sse/events.ts | 新增 invoke.event 契约（落库后广播，弹窗实时数据源） |
| src/usecases/ports/otter-tool-client.ts | appendInvokeEvent 返回落库标识（id/sequenceNum/createdAt） |
| src/bootstrap/clients.ts | 透传落库标识 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | persistInvokeEvent 落库后广播 invoke.event（fire-and-forget，失败静默） |
| web/src/lib/invoke-event-fold.ts | speak 吸收 + interrupted 标记（类型 + 规则 5 + 遍历尾处理） |
| web/src/pages/conversation/index.tsx | 常驻 SSE 加 invoke.event/start/conn 转发（buffer + listener，主界面零 setState）；invoke.start 信号；SSE 断连/恢复信号 |
| web/src/pages/conversation/SessionModal.tsx | 实时化接线替换 2s 轮询；展开区全文 + 复制按钮（FullTextBlock/CopyButton）；断连 banner |
| web/src/lib/invoke-event-fold.test.ts | +5 用例（speak 吸收 / 吸收保序 / invokeEnded 标记 / running 保持 pending / 无 start 直通） |
| web/src/pages/conversation/SessionModal.test.tsx | 主用例补 speak start 吸收断言；+1 终态「已中断」用例 |
| tests/interface-adapters/agent-invoker.test.ts | +2 广播行为用例（成功广播带 seq / 落库失败不广播不炸主流程） |
| tests/helpers/mock-send-entry.ts | appendInvokeEvent mock 返回落库标识（seq 递增） |

# 验证

- 后端：247 文件 2904 用例全过（含新增 2 广播用例）；tsc 零错；eslint 零错（2 条 no-console warning 为 cost-output-collector.ts 基线，非本次文件）
- 前端：48 文件 428 用例全过；tsc 零错；eslint 零错（index.tsx 2 条 runOrDefer warning 为基线）
- 真实数据回归：改动含展示层与广播层，落库数据不变；旧数据（含 speak 重复落库的历史 invoke）渲染即去重
- 最简实现检查：已过——广播复用既有 MessageBroadcaster 总线与 /subscribe 连接（零新连接/零新端点）；speak 吸收 8 行；实时接线复用 #916 的自动展开/滚底跟随结构，仅数据源从轮询换成事件；备选「改 event-mapping 落 tool_result」会破坏 F20260913ctlv 的发言/工具分样式设计且需迁移历史数据，不采

# 性能与主界面影响

- invoke.event 广播主界面不渲染：index.tsx handler 只 push ref buffer + 通知 listener（弹窗关着时零 setState，无 re-render）；弹窗开着时 setState 局限在 SessionModal 内部状态
- buffer 上限 400 条（防长行动期间内存增长；弹窗打开时回放后全量拉取兜底）
- IM 出站通道（feishu/weixin）会收到 invoke.event 但各自过滤不消费（只处理 entry.user/entry.speak/invoke.start）——无额外出站流量

# 对 #916 的关系

#916 的折叠骨架（快照丢弃、FIFO 配对、rawEventIds 溯源）全部保留；本特性修它的两个真实数据缺陷，属展示层行为修正。上轮搭档拍板的右栏措辞（「● 行动中 · 走秒 · 🛠 n · ctx/上限」「○ 休息中 · ctx」）不动。
