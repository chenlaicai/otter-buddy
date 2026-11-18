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
  发送前都会执行 platform.validate —— 安装必须 ready 且 authorizationVersion 一致（否则
  INSTALLATION_AUTHORIZATION_CHANGED），本轮带 executionId 时还要 users.validateEvent 校验用户执行
  授权（失效即 USER_AUTHORIZATION_EXPIRED/INVALID/UNAVAILABLE）。因此用户授权失效会让整轮失败、
  回话发不出去；#2681 delta8 的 A/B 只消解了发送身份这一半，授权生命周期仍是 SDK 契约内的真实依赖。
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

| 校验 | 位置 | 失败码 |
| --- | --- | --- |
| 安装必须 `status='ready'` 且 `authorizationVersion` 与事件快照一致 | `clients/platform.mjs:19-23` | `INSTALLATION_AUTHORIZATION_CHANGED`(403) |
| 本轮带 `executionId` 时校验用户执行授权（人、事件、安装、source 一致性、deadline） | `clients/platform.mjs:24-28` → `auth/user-oauth.mjs:164-177` | `USER_AUTHORIZATION_EXPIRED` / `USER_AUTHORIZATION_INVALID`；上游/网络异常为 `USER_AUTHORIZATION_UNAVAILABLE` |

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
| 安装 `status=reconnect_required`、无 access/refresh 令牌 | 该安装整体不可用：事件接收与回话都会在校验处失败（`INSTALLATION_AUTHORIZATION_CHANGED`） | 用户重新授权该安装，或卸载 |
| `USER_AUTHORIZATION_EXPIRED/INVALID/UNAVAILABLE` | 本轮用户执行授权不可用 → **整轮失败，回话发不出去** | 重新授权；不要因为"发送用安装令牌"就排除授权问题 |
| `installation_control` 事件后状态翻 `ready` | SDK 已自动续期安装授权 | 无需人工干预 |

真机一例：2026-11-16 事件 `3ac142a0…` 报 `USER_AUTHORIZATION_UNAVAILABLE` 后直接 `failed`，没有 `reply_pending`/`done` 阶段——与"整轮校验失败"一致；同日另一事件 `04806b83…` 在 11-18 收到 `installation_control` 后自动续成 `ready`。

## 边界

- 本文不改任何代码与运行时行为，只固定口径并留证据锚点；
- 「用户身份不用于发送正式消息」是平台契约，不是本扩展的取舍；用户身份存在草稿通路，不能据此外推"用户身份将来可以发消息"；
- 未做故障注入实测：两层事实的证据来自 vendored SDK 控制流 + 线上状态快照 + 真机日志，`USER_AUTHORIZATION_*` 对回话的具体阻断是代码路径结论（独立检视獭另用 SDK 原函数 + 内存 mock 复现过：安装 ready 但用户校验抛错时 `ctx.reply` 返回该错误且 `staged:false`）。

## 修订记录

- v1（同日，已撤回）：曾写「授权过期只影响读私密、不影响回话」。**错误**——把「发送身份是安装令牌」错误外推成「整轮授权与回话无关」。由独立对抗检视抓出（阻断 1/2），本版按 SDK 控制流改正，并把结论从"A/B 已消解"收窄为「发送身份之争消解、授权校验依赖仍在」。
