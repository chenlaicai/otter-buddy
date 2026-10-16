---
id: F20261016chet
title: 三麻聊天回显断链修复（#1532）
summary: 打通真人↔獭牌桌对话闭环——页面消费 chat SSE 帧（自己/他者/獭回应回显进对局日志）+ 输入条（入座可见）+ 引擎侧把獭的注入回应从「丢弃」改为广播进 chat 流；issue #1532 两半场一次修
change_type: fix
capability_test: "行为闭环四点钉：①engine chat 帧含 from/name（room-report-chat 例）②獭注入回应广播（含空白不发泡分支）③SSE chat 帧全链（api-sse 桥接例）④真机 Chrome 入座→发言→日志回显（page-visual 例）；修复前后红绿证据留 /tmp/chat-echo-red|green.txt（PR 正文引用）"
created_in_conversation: a00f8fec-1ec0-4c63-9b1d-27b5756b2fc8
intent:
  problem: "PR #1529 检视发现8：聊天链路三段缺两段——页面无 chat 消费分支且无输入面（真人发不出/看不到回显），獭注入回应文本直接丢弃（观战端无从得知）；体验=对空气说话。"
  expected_effect: "入座者可从牌局页发言，自己的话与獭的回应经 SSE chat 帧回显进对局日志（观战端同流可见），真人↔獭对话闭环。"
  verify_by:
    type: behavior_check
tags: [mahjong, chat, fix]
modules: [src/usecases/mahjong, web-mahjong]
causal_links:
  - PR #1529 检视发现8（麻将方案检视獭 2026-10-16）：聊天回显断链，建 issue #1532
  - F20261016mjsg 模块三「内嵌聊天框」：回话注入已落地，回显半场在本篇补齐
---

# 三麻聊天回显断链修复（#1532）

## 背景（issue #1532 两半场）

- **引擎半场**：`RoomService.injectPendingChat` 把真人回话注入各 otter session 后，`gateway.invoke` 的回复文本**直接丢弃**；`chat` 帧只有 `seat/text/at`，无发言主体标识
- **页面半场**：`web-mahjong` 全套（index/app/sse/api/view/style）**零 chat 引用**——无输入面、无消费分支；对局日志（`state.log`/`pushLog`）只吃动作与 `wake.speech`

两半场分属同一 issue 同一根因（对话闭环缺最后一米），一并修。

## 方案

### 引擎侧（src/usecases/mahjong/room/）

1. `RoomEvent` chat 帧扩形（room-types.ts）：`+ name: string; + from: "human" | "otter"`——传输层只管「谁说了什么」，怎么排版归视图层
2. `addChat` 广播补 `name`（入座名）与 `from: "human"`
3. `injectPendingChat`：捕获注入 invoke 的回复 → `publishOtterChat`（新文件 **room-chat.ts**，自 room-service 拆出——那边顶着 max-lines 450）：`trim` 后非空才发（≤300 字截断），座位/名字按 `otterId` 回查配置；**空白回应不发泡**（session 已注入但聊天流不留空泡）

### 页面侧（web-mahjong/）

1. `view.js` 纯函数 `formatChatLine(ev, ownSeat)`：`ownSeat` 命中显「你」、`from=otter` 带「（獭）」标记、名字缺省回退「N号位」——排版单点可测
2. `handleStreamEvent` 增 `chat` 分支：`pushLog(line, "is-chat")` + **直接 `render()`**（聊天不改视图，不能等 safeRefresh 才上屏）
3. 输入条 `#chatBar`（index.html，置 `.center` 日志下方）：`render()` 门控 `state.screen === "room" && state.seat !== null`——观战/大厅隐藏（发言必须有合法 seat）；Enter/按钮发送
4. `api.chat(roomId, seat, text)` 封装第 9 端点
5. **回显只认 SSE 帧、不做本地假回显**——断线时不会自己骗自己（sse.js 本有退避重连+看门狗）

### 不做（边界）

- 聊天历史持久化/断线补拉（issue 内标「可选」的 GET chat 历史——本篇不做，队列仍内存态）
- 表情/私聊等增强；鉴权（#1322 鉴权横切獭并行，本篇不碰 `interface-adapters/http` 鉴权面）

## 影响范围

- `src/usecases/mahjong/room/`：room-types.ts（chat 帧形）/ room-service.ts（两处广播点）/ room-chat.ts（新）
- `web-mahjong/`：index.html / style.css / js/{app,view,api}.js
- 测试 7 例新增（engine 3 / view 1 / api-sse 2 处 / page-visual 1）——全仓其余不动
- **无新端点、无路由改动**（`router.ts` 零改动——与鉴权横切獭无会师冲突面）

## 取舍

| 取舍 | 决定 | 理由 |
|---|---|---|
| 回显时机 | 只认 SSE 帧 | 本地假回显在断线窗口会与服务端状态分裂；SSE chat 帧随 `addChat` 同步广播，正常延迟毫秒级 |
| 獺回应截断 | ≤300 字 | 唤醒协议要求一句自然回应，模型偶发跑飞——聊天流是给人看的日志，不是 session 原文 |
| 空白回应 | 不广播 | `trim` 后空串发泡=聊天流噪音；session 注入已完成，不因回显失败回滚 |
| 输入条位置 | 日志正下方 | 对话与日志同域阅读动线；不占动作区（打牌主操作优先） |
| 观战端发言 | 隐藏输入 | `addChat` 要求合法 seat（服务端校验），无座发言必 400——不如不给面 |

## 验证

- **修复前（RED）**：4 文件 7 例失败（`/tmp/chat-echo-red.txt`）——engine 缺 from/name、view 缺导出、api 缺 chat、真机无 `#chatBar`
- **修复后（GREEN）**：同 4 文件 42/42（`/tmp/chat-echo-green.txt`）；mahjong+web+api 域 22 文件 398/398；tsc + eslint 0 error
- 真机例含零控制台报错断言；chat 行渲染走既有 `esc()`（XSS 面不新增）

## 产出与下一步

- PR：fix/mahjong-chat-echo → main（本篇写就时未建）
- 后续（不阻塞）：GET chat 历史断线补拉（随 issue #1532 可选项排期）；聊天队列持久化随 frames 表一并考虑
