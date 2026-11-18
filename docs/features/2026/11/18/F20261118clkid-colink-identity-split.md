---
title: 回话发送身份用安装令牌——但整轮授权校验仍会拦下回话
id: F20261118clkid
date: 2026-11-18
module: extensions
change_type: feature
status: active
summary: |
  拍板口径：CoLink 回话的**发送身份**恒为 App 安装令牌（POST /messages 用 appToken，用户令牌不用于
  正式回话）；用户身份只用于读私密。但「用哪个身份发」与「这一轮能不能发」是两件事：ctx.reply 与真正
  发送前都会执行 platform.validate——安装必须 ready 且 authorizationVersion 一致，本轮带 executionId 时
  还要校验用户执行授权。回话路径的失败码要分开看：EXPIRED（本地记录/期限/eventId 不符，或上游明确
  invalid_grant）、INVALID（execution 已非 active 或事件绑定不一致）、UNAVAILABLE（上游非 OK 且非
  invalid_grant，带状态码，不等于过期）；入口拒绝是 INSTALLATION_NOT_READY(503)，回合内版本变化是
  INSTALLATION_AUTHORIZATION_CHANGED(403)。故 #2681 delta8 的 A/B 只消解了发送身份这一半。
from:
  - id: F20261118clkpt
    note: 本次口径以 0.28 对齐后的实现与 vendored SDK 控制流为事实基础
intent:
  problem: "#2681 delta8 独立检视抓出「DM 回话授权断链」四断点，悬置成 A/B 设计拍板（A 安装令牌绑会话 / B 恢复用户令牌），跨会话挂了 14 天；0.15→0.28 对齐（#1917）把最终发送者切成安装令牌后，容易被误读成「授权问题整体消失」，而 SDK 仍在回话前后校验整轮授权"
  expected_effect: "写清两层事实：①发送身份＝安装令牌，用户令牌不用于正式回话；②回合能否完成仍受安装 ready 与用户执行授权有效性约束，失效即整轮失败（含回话）——排障时不要因为「发送用安装令牌」就排除授权问题"
  verify_by:
    type: behavior_check
    evidence:
      - "SDK 锚（vendor/app-sdk）：events/turn.mjs:47 ctx.reply 先 await platform.validate(row)；clients/platform.mjs:122-124 send 前再 validate 且用 appToken(row) POST /messages；platform.mjs:19-37 validateOne 要求安装 status==='ready' 且 authorizationVersion 一致、存在 executionId 时调 users.validateEvent；auth/user-oauth.mjs:164-177 validateEvent 抛 USER_AUTHORIZATION_EXPIRED/INVALID"
      - "扩展锚：extensions/colink-agent-app/src/mention-handler.mjs:30 回话为 ctx.reply；src/colink-tools.mjs:240-257 读路径按 channelVisibility / ctx.colink.app|user 选身份"
      - "线上状态实测（ECS 快照 2026-11-18T03:5xZ）：安装授权 scope = messages:read-public messages:receive messages:write；59 条 oauthUserExecutions scope 全部只有 messages:read-private、且均带 access token"
      - "真机日志：2026-11-18 事件 fc05087b… 全流程 EVENT_ACCEPTED→done；2026-11-16 事件 3ac142a0… 报 USER_AUTHORIZATION_UNAVAILABLE 后直接 failed（无 reply_pending/output_confirmed 阶段），与「整轮校验失败」一致，不能归因为读私密失败"
capability_test: "extensions/colink-agent-app/test/colink-tools.test.mjs"
---

# F20261118clkid：回话发送身份用安装令牌，但整轮授权校验仍会拦下回话

## 拍板

**回话的发送身份恒为 App 安装令牌**（搭档 2026-11-18：「既然是对话，那肯定是按照 app 安装身份呀」）。用户身份不用于发送正式消息，只用于读私密内容。

**但发送身份不等于整轮授权**——这是本文档第一版写错、被独立对抗检视抓出的地方（见文末「修订记录」）。

## 两层事实必须分开看

### 第一层：发送用哪个身份 —— 安装令牌

- 扩展侧回话是 `ctx.reply`（`src/mention-handler.mjs:30`）。
- SDK 侧：`ctx.reply` 暂存文本（`vendor/app-sdk/src/events/turn.mjs:47-49`），真正的写请求在 `clients/platform.mjs:122-133`：`appToken(row)` 取安装令牌，`POST /messages` 只带这一个 Bearer。
- 用户令牌选择器 `userToken`（`platform.mjs:18`）在发送链路上**没有被调用**。

### 第二层：这一轮能不能发 —— 整轮授权校验

`ctx.reply` 与 `send` 都会先跑 `platform.validate(row)`：

| 校验 | 位置 | 失败码（按真实来源分） |
| --- | --- | --- |
| 安装必须 `status='ready'` 且 `authorizationVersion` 与事件快照一致 | `clients/platform.mjs:19-23` | `INSTALLATION_AUTHORIZATION_CHANGED`(403) |
| 本轮带 `executionId` 时校验用户执行授权 | `clients/platform.mjs:24-28` → `auth/user-oauth.mjs:164-177` | 见下表 |

作用域：下面只覆盖**回话校验路径**（`platform.validate` → `users.validateEvent`），不是全 SDK 错误码穷举（page 登录等旁支不在此列）。

用户执行授权的失败码**不是同一类问题**，处置也不同：

| 失败码 | 真实触发条件（锚点） | 语义 |
| --- | --- | --- |
| `USER_AUTHORIZATION_EXPIRED` | ①本地记录缺失/形状不符（`auth/user-oauth.mjs:18-22`）；②`validateEvent` 本地校验失败：`eventId`／`userId`／`installationId`／`deadline` 与事件不符（`:167-169`）；③**任一上游请求**返回非 OK 且 `error=invalid_grant`——`read()` 是 `request()` 的共用出口（`:54-57`），包含 refresh 交换与 `GET /extensions/user-executions/:id`（`:171-173`），状态码随上游 | 授权确实不可用/过期，或平台明确判定 grant 无效 |
| `USER_AUTHORIZATION_INVALID` | execution `status !== 'active'`，**或** `userId`／`installationId`／`sourceKind`／source 字段（channelId/topicId/taskId/conversationId）与事件不一致（`:174-177`） | 两种情况：execution 已非 active，**或**事件与 execution 绑定不一致 |
| `USER_AUTHORIZATION_UNAVAILABLE` | 上游返回非 OK 且 `error≠invalid_grant`（`:50-51`），**保留上游任意状态码（4xx/5xx）** | 上游响应异常，**不等于授权过期**；具体含义要看状态码 |
| 原始 `TypeError` 等 | fetch 网络异常未做归一化（`:54-57` 只处理响应，不捕获 fetch 异常） | 网络/连接问题，按基础设施排障 |

结论：**用户执行授权失效会让整轮失败，回话发不出去**。失败点在校验，不在发送身份——所以「发送用安装令牌」不能推出「授权问题与回话无关」。

## 平台分权口径（实测）

| 授权种类 | scope | 用途 |
| --- | --- | --- |
| 安装授权（`oauthInstallations`） | `messages:read-public` `messages:receive` `messages:write` | 收事件、**发送回话**、读公共 |
| 用户执行授权（`oauthUserExecutions`） | 仅 `messages:read-private` | 读私密（话题/私聊/私密频道），并被用作整轮校验凭据 |

测量口径：2026-11-18 03:5x（UTC）在 ECS 上把线上状态文件复制成快照后用只读脚本统计——安装 3 个（2 ready / 1 reconnect_required），用户执行授权 59 条，scope 全部只有 `messages:read-private`，无缺失 access token 者。数字随时点变化，不是恒定总量。

公开契约侧同样固定：DM 读取仅 user + `read-private`，正式消息写入仅 app + `write`（`vendor/app-sdk/src/shared/public-contract.mjs:279-287`、`:339-347`、`:855`）。用户身份另有草稿通路（`messages:draft` / `POST /message-drafts`，`public-contract.mjs:349-357`），那不是"回话"，也不属于本扩展使用范围。

## 与 #2681 delta8 的 A/B 之争的关系

旧实现用「当轮用户令牌」直接发送回话，于是有 A（安装令牌绑会话）/ B（恢复用户令牌）两案。0.28 对齐（F20261118clkpt）后：

- **发送身份这一半消解了**：正式发送改用安装令牌，B 案的"用户令牌直接发送"实现不再存在；
- **另一半没有消解，也不该消解**：整轮授权校验仍要求用户执行授权有效。旧 A 案宣称的"不依赖用户二次授权"没有实现，且与平台契约（用户授权的私密读取 + 整轮校验）冲突。

所以正确表述是：**这不是本扩展能修的"断链 bug"，而是授权生命周期问题**——授权失效时整轮失败（含回话），处置方式是让用户重新授权该安装，而不是去查发送身份。

## 运维含义（排障用）

| 现象 | 含义 | 处置 |
| --- | --- | --- |
| **新事件入口**收到 `INSTALLATION_NOT_READY`(503) | 该安装当前不是 `ready`（`events/event-handler.mjs:121-122`），事件在入口就被拒，连回合都没有 | 用户重新授权该安装，或卸载 |
| **已接受回合**的回话报 `INSTALLATION_AUTHORIZATION_CHANGED`(403) | 事件被接受后，安装状态或 `authorizationVersion` 与本轮快照不一致（`clients/platform.mjs:19-23`）——典型是中途换了授权版本 | 让该轮失败重来（新事件会带新快照）；反复出现说明授权在抖动 |
| `USER_AUTHORIZATION_EXPIRED` | 授权记录缺失/期限已过（本地判定），或上游明确回 `invalid_grant`（refresh 或 execution 查询任一） | 重新授权；不要因为"发送用安装令牌"就排除授权问题 |
| `USER_AUTHORIZATION_INVALID` | **执行状态已非 active**（已完成/失效），或事件与 execution 的人/安装/sourceKind/source 不一致 | 先看 execution 状态（是不是早就结束），再看绑定字段；**不要当过期直接重授权** |
| `USER_AUTHORIZATION_UNAVAILABLE`(带上游状态码) | 上游非 OK 且非 `invalid_grant`，状态码 4xx/5xx 都可能 | **按状态码分流**：5xx 查平台侧/重试；4xx 查请求参数、execution 与授权状态。**既不一律重授权，也不一律按平台故障重试** |
| 原始 `TypeError` / 网络错误 | fetch 未被归一化 | 查网络与出网链路 |
| `installation_control` 事件后状态翻 `ready` | SDK 已自动续期安装授权 | 无需人工干预 |

真机证据（只写日志能证明的部分）：2026-11-16 17:52:13 的事件 `3ac142a0…` 报 `USER_AUTHORIZATION_UNAVAILABLE` 后直接 `failed`，**没有** `reply_pending`/`output_confirmed`/`done` 阶段——与"整轮在校验处失败"一致。按上表语义，`UNAVAILABLE` 是**上游非 OK 响应**，不是授权过期；且同一安装 `04806b83…`（installationId）在同日 17:52:34 的下一条事件就走到 `done`，更像**瞬态上游异常**而非授权失效。另有安装 `bce97c6c…` 自 2026-11-16 起停在 `reconnect_required`、无 access/refresh 令牌，属安装级失效。

## 边界

- 本文不改任何代码与运行时行为，只固定口径并留证据锚点；
- 「用户身份不用于发送正式消息」是平台契约，不是本扩展的取舍；用户身份存在草稿通路，不能据此外推"用户身份将来可以发消息"；
- 未做故障注入实测：两层事实的证据来自 vendored SDK 控制流 + 线上状态快照 + 真机日志，`USER_AUTHORIZATION_*` 对回话的具体阻断是代码路径结论（独立检视獭另用 SDK 原函数 + 内存 mock 复现过：安装 ready 但用户校验抛错时 `ctx.reply` 返回该错误且 `staged:false`）。

## 修订记录

- v1（同日，已撤回）：曾写「授权过期只影响读私密、不影响回话」。**错误**——把「发送身份是安装令牌」错误外推成「整轮授权与回话无关」（独立对抗检视第 1 轮阻断）。
- v2（同日，已撤回）：分层已改对，但错误码仍被混为一类——把 `UNAVAILABLE` 说成"上游/网络异常"、把入口拒绝与回合内失败都写成 `INSTALLATION_AUTHORIZATION_CHANGED`、并对三类 `USER_AUTHORIZATION_*` 统一开"重新授权"处方（独立对抗检视第 2 轮阻断）。
- v3（本版）：按 `auth/user-oauth.mjs` 与 `events/event-handler.mjs` 的真实分支重写错误码表与运维处置表——`EXPIRED`（记录/期限/`invalid_grant`）、`INVALID`（事件与 execution 绑定不一致）、`UNAVAILABLE`（上游非 OK，带状态码，可能是平台 500）、`INSTALLATION_NOT_READY`(503，入口) 与 `INSTALLATION_AUTHORIZATION_CHANGED`(403，回合内) 分开处置。
