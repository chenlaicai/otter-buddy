---
id: F20260724cwgn
title: refresh-streaming-resume
doc_type: feature

summary: |
  刷新页面后消息状态误报"已完成"修复：前端 LocalMessage 透传 status 并按真实状态渲染，
  进行中的消息轮询续看；删除 SSE 断开时从未生效的 abort 死代码。
  确立"前端是后端状态的投影"原则：发言生命周期由后端状态机管理，刷新≠停止。

causal_links:
  from:
    - F20260723mk75

status: draft
change_type: bugfix
tags: [streaming, sse, refresh, message-status, polling, frontend]
modules:
  - src/interface-adapters/http/
  - web/src/lib/
  - web/src/pages/conversation/

created_at: 2026-07-24
---

# F20260724cwgn 刷新页面消息状态误报修复

## 术语定义

| 术语 | 定义 |
|------|------|
| **投影** | 前端是后端状态机（streaming → speaking → completed）的只读投影，不含自有生命周期 |
| **轮询续看** | 刷新后历史中存在进行中消息时，前端每 2s 静默拉取 listMessages 直到全部终态 |
| **upsert** | SSE 事件落列表按 messageId 更新或追加，避免与轮询快照双写产生重复 |

## 背景

用户报告：大獭发言中刷新页面，消息显示"已完成"；再次刷新，流式过程内容还在增长。

### 根因 1：前端投影有损且撒谎（核心）

服务端 DTO 携带 `status`，但 `mapMessageDTO` 丢弃该字段；历史渲染的流式过程标题硬编码
"已完成 · {duration}"（MessageList.tsx）。进行中的消息因此被误标为已完成。

### 根因 2：SSE 断开时的 abort 是从未生效的死代码

`sendMessage` 的 onAbort 回调调用 `agentInvoker.abort(oid, "")`：空 messageId 使 sessionKey
退化为 `otterId`，而 session 注册键为 `otterId:messageId`，查找必然 miss。
该代码的存在暗示"刷新应中止发言"的设计意图，但这是因果倒置——
前端是展示层，后端发言是否继续不该由展示层事件驱动（决策：方向 A，刷新后继续生成，类 ChatGPT）。

### 根因 3（现象放大器）：speaking 状态可继续追加事件

`canAppendEvent` 允许 streaming/speaking（F20260723mk75 两阶段提交设计），
历史查询是 DB 实时快照，故两次刷新之间内容持续增长——这是合法行为，只是前端没有"进行中"概念。

## 变更

1. **后端**：删除 `message-controller.ts` 中失效的 onAbort abort 调用；`sse-streamer.ts` 的
   `onAbort` 改为可选参数。显式 abort 端点（`POST /messages/:id/abort`）保留。
2. **前端 status 透传**：`LocalMessage` 新增 `status` 字段，`mapMessageDTO` 映射 DTO status。
3. **按真实状态渲染**：流式过程标题按 status 显示 进行中（呼吸点动画）/ 失败 / 已中断 / 已完成·耗时；
   streaming 中正文为空时显示"正在回复..."占位；ctx 缺失时不渲染 token 条。
4. **轮询续看**：`allMessages` 中存在 streaming/speaking 的 otter 消息时，每 2s 静默刷新
   listMessages（失败不 toast，下轮重试），全部终态后自动停止。
5. **轮询快照合并（mergeMessages）**：不用快照整体替换本地列表——过期快照不回退本地已终态的
   消息（响应发出于 complete 之前、到达于之后）；保留未上服务器的 tmp 乐观消息。
6. **渲染期去重**：MessageList 渲染历史列表时过滤 streamingMap 中存在的 id（实时视图优先），
   对"轮询带回 streaming 消息 + 同 id message.start"的所有竞态交错稳健；
   SSE 落列表（complete/failed/aborted/error）按 id upsert。
7. **进行中消息保留停止能力**：历史列表中的 streaming/speaking 消息渲染停止按钮
   （复用 `api.abortMessage`），刷新后用户仍可中止发言。
8. **孤儿消息 reconcile**：服务启动时将遗留 streaming/speaking 消息标记为 failed
   （`failInFlightMessages`，重启后不存在活跃 agent，消息不可能再到达终态）——
   这是轮询"全部终态后停止"前提的熔断保障；speaking 消息保留已有 speak body。

## 对抗检视记录（PR #87）

首轮实现经对抗性评审发现三个严重问题并全部修复：
- S1：轮询将 message.start 移走的消息重新加回历史 → 双重渲染（改为渲染期去重，变更 6）
- S2：孤儿 streaming 消息使轮询永不停止且无法进入终态（启动 reconcile，变更 8）
- S3：刷新后用户失去停止能力（历史消息停止按钮，变更 7）
另有 M1（过期快照回退闪烁）、M2（tmp 消息被擦除）由合并式更新（变更 5）解决；
A1（断开测试空转）改写为真实 cancel response body 的回归测试（对旧代码验证失败）。

第二轮复检新发现的轻微问题中，三个随本 PR 修复：
- N1：轮询活跃期间发新消息，tmp 乐观消息与服务端真实消息双重渲染——
  mergeMessages 丢弃快照中已存在等价内容（同 st/si/content）的 tmp 副本
- N2：abort 端点不校验消息状态，终态消息 abort 会留 stale abortedOtters 标记污染下次
  invoke 错误分类——端点增加 canAbortMessage 校验，终态返回 409
- N3：live 会话 SSE 中途断开轮询永不启动（S2 的对偶）——onError 时 refreshMessages
  播种进行中消息，轮询 effect 自动接管
- N4：流式气泡固定沉底导致视觉时序倒置——**统一渲染通道**：message.start 即将进行中
  消息按创建顺序插入 allMessages（append 位置即正确时序，upsert 兼容轮询快照），SSE 事件
  就地更新，complete/failed/aborted upsert 原位替换；删除 streamingMap 渲染通道与
  StreamingMessage 组件，实时与轮询共用同一渲染路径（进行中头部"正在回复..."、
  流式过程默认展开、停止按钮）；streamingMap 状态随之移除，SSE 闭包内改用
  liveMeta/liveEventsMap 两个局部 Map

第三轮终审遗留修复：
- M4：stopStream 乐观置 aborted 后轮询停止，abort 失败/409 时消息永久卡在"已中断"——
  abort 请求 settle 后拉取快照，该消息以服务端为权威收敛（其余消息走常规合并），
  所有路径（abort 生效/丢失/已终态）均可收敛
- M7：统一通道后实时流式期间轮询常开，快照 events 因持久化滞后瞬态更少——
  mergeMessages 双方进行中时保留 events 更长的一方
- N6：删除只写不读的 sseCtrlRef（dead code）
- N7：无 messageId 的 error 消息会被 merge 丢弃——改 err- 前缀并在 merge 中保留本地孤儿消息
- 记录在案的瞬态（≤2s 自收敛，不处理）：M5 message.start append 顺序因 getById 竞态
  瞬态偏离 DB sequence；M6 tmp 用户消息无 turnId 导致分隔线瞬态错位；
  N5 StreamingProcess 完成后保持展开（可视为有意）

第四轮检视修复：
- F1：M4 收敛仍依赖 resync 那一次 listMessages 成功，失败即永久卡死——stopStream 改用
  GET /messages/:id 单点拉取，失败时把乐观 aborted 回退为进行中让轮询接管
  （生效/丢失/已终态/拉取失败四路径均收敛）
- F2a：limit=100 窗口外的进行中消息被 merge 丢弃 → 轮询停止、状态永不更新——
  mergeMessages 保留窗口外的进行中消息，轮询时对其按 id 定点拉取收敛；
  窗口外终态消息允许丢弃（与整页重载的窗口语义一致）
- F3：abortedOtters 按 otterId 键控，同一 otter 并发 invoke 时 abort 标记跨消息串扰
  （该 aborted 的变 failed、该 failed 的变 aborted）——改为按 messageId 键控
  （abortedMessages），四个使用点均有 messageId 可用
- F7：发送失败的 tmp 幻影消息被 merge 永久保留——发送失败时移除 tmp 消息

第四轮遗留项全部清零（"遗留=不做"）：
- F4：启动 reconcile 新增 closeOrphanedTurns——无进行中消息的 open turn 一律关闭，
  恢复"open = 有进行中发言"不变量
- F5：reconcile 对 speaking 半截 body 加中断标记前缀（不再被当作完整发言）；
  getUnreadMessages 排除 streaming/speaking 半成品（真实 SQL 测试锁定）
- F6：tmp 去重改多重集匹配（连发相同内容各抵一条，不误判）
- F8：web 引入 vitest；消息流纯函数提取至 web/src/lib/message-stream.ts
  （isInFlight/isTerminal/upsertMessage/insertBySeq/mergeMessages），16 个单测覆盖
  M1/M2/M5/M7/N1/N7/F2a/F6 全部合并规则
- F9：reconcile 抽为 usecases 层 reconcileOrphans()，try/catch 失败不阻断启动
- M5（瞬态根治）：message.start SSE 携带 seq，占位消息 insertBySeq 按服务端 sequence
  插入，并发 otter start 乱序到达立即归位（不再依赖轮询收敛）；
  顺带对齐 SSE 契约（otterName/body/turnId 补入 SSEEventMap，消除 5 个存量 tsc 错误）
- M6（瞬态根治）：message.complete 时为同 turn 的 tmp 用户消息补戳 turnId，
  分隔线立即出现在正确位置（第五轮收尾：仅在恰好一条未戳 tmp 时补戳，
  多条并发 tmp 到达顺序未必等于发送顺序，留给轮询快照纠正，消除跨连接错戳）
- N5：StreamingProcess 按 status remount，完成后自动折叠，行为统一
  （第五轮收尾：remount key 改为 inFlight 布尔，streaming→speaking 不再 remount，
  进行中的手动折叠状态不受轮询打扰）

## 边界分析与处理决策

### closeOrphanedTurns 的 NOT IN NULL 理论边界（第五轮发现，决策：不加防御代码）

`closeOrphanedTurns` 使用 `id NOT IN (SELECT DISTINCT turn_id ...)`。SQL 三值逻辑下，
子查询结果若含 NULL，`NOT IN` 对任何行都不为 TRUE → 一个 turn 都关不掉（保守失败方向）。

**触发条件**：`messages.turn_id` 为 NULL 的进行中消息。当前 schema `turn_id NOT NULL`，
仅远古手工 `ALTER TABLE` 迁移的老库可能有 NULL 历史行——故称"理论边界"。

**决策依据（不加防御）**：
1. 调用顺序保证子查询恒为空：`reconcileOrphans` 先执行 `failInFlightMessages` 将所有
   streaming/speaking 置 failed，`closeOrphanedTurns` 执行时子查询不可能有结果，
   `NOT IN (空集)` 恒 TRUE，行为完全确定。
2. 失败方向无害：即使触发，后果仅是某些 open turn 未关闭——正是 F4 修复前的现状，
   且已验证孤儿 open turn 会被下一条消息自愈（ensureActiveTurn 复用 + tryCloseTurn），
   无消费者出错。
3. 失败是"少做"而非"做错"，不产生错误数据。

如需彻底堵死，可在子查询加 `AND turn_id IS NOT NULL`（一行），但按上述分析无实际收益。

### M6 多条并发 tmp 不补戳（决策：正确性让位于自愈）

快速连发两条消息时存在两个独立 SSE 连接，complete 到达顺序未必等于 tmp 发送顺序，
盲戳可能把 tmp1 错戳 turn2 的 turnId。决策：仅恰好一条未戳 tmp 时补戳；
多条时不戳（分隔线瞬态缺失），≤2s 轮询快照用真实 DTO 替换 tmp 后自然正确。

### 窗口外终态消息允许被 merge 丢弃（决策：与窗口语义一致）

listMessages 只拉最近 100 条。终态消息掉出窗口后被 merge 丢弃、从 UI 消失——
与整页重载的行为一致（重载也看不到第 101 条之外的），不算数据丢失。
进行中消息不在此列（保留 + 定点拉取收敛，F2a），因为其状态必须跟踪到终态。

### reconcile 失败不阻断启动（决策：可用性优先）

reconcileOrphans try/catch 吞错（error 日志带堆栈）。理由：reconcile 是兜底修复，
其失败不应让服务起不来；孤儿残留等同于本功能引入前的行为，不引入新风险。

## 兼容性

- API：`POST /messages/:id/abort` 对终态消息从 202 改为 409（此前调用无实际效果，属错误用法显式化）；
  `message.start` SSE 事件新增 `seq` 字段（可选，向后兼容）；DTO 本已携带 status（前端此前未消费）。
- Agent 上下文：getUnreadMessages 不再包含 streaming/speaking 半成品消息（半成品本不该被读到）。
- 持久化：无 schema 变更；启动 reconcile 一次性将历史孤儿消息置为 failed、孤儿 turn 关闭（数据修复）。
- 重启语义：启动即 reconcile 意味着"重启 = 所有进行中发言中断"（进程消失必然如此，只是显式化）。

## 后续可选

- SSE 断流恢复（resume endpoint）替代轮询。
- speak complete 时持久化 token 用量（updateTokenUsage 当前无调用方，pre-existing）。
