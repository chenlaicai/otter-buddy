---
id: F20260826fuid
title: feishu-user-identity
doc_type: feature
summary: |
  飞书群聊多人识别：消息入库时把发送者 open_id 经通讯录 API 换成姓名，
  快照进 senderName（层 1，对齐 PR #392 单一真相源架构），贯通 agent 历史
  渲染与 Web 前端显示。配套交付飞书用户手册（含完整 API 权限清单）。
  背景：群聊链路修复后发现海獭只 能区分"不同人"（open_id 唯一）但显示匿名 ID，
  且当前发言者被误标「搭档」。根因：im.message.receive_v1 事件不携带姓名，
  user 消息 senderName 历来为空串。
causal_links:
  from:
    - F20260729im
status: development
change_type: feature
tags: [feishu, im, identity, user-guide]
modules:
  - src/usecases/im/feishu-user-info-gateway.ts
  - src/frameworks/feishu/user-info-client.ts
  - src/interface-adapters/feishu/message-processor.ts
  - src/usecases/conversation/send-message.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/frameworks/db/conversation/conversation-repository-mixins.ts
  - src/bootstrap/platforms.ts
  - web/src/pages/conversation/display-name.ts
  - web/src/pages/conversation/MessageList.tsx
  - docs/user-guide/feishu-setup.md
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# F20260826fuid: 飞书群聊多人识别 — sender 姓名快照贯通

## 背景与需求

搭档在飞书建群拉机器人入群（群聊链路已修复，见排查结论 fact 51d595ce），随后提出：群里多个人说话，海獭能否识别是谁。

排查现状（代码证据）：
- `dispatch-chain-engine.ts` 历史渲染：`m.senderId === senderId ? partnerLabel : (names.get(m.senderId) ?? m.senderId)`——当前发言者标「搭档」，其他 user 发言者显示裸 open_id
- `send-message.ts:142`：user 消息 senderName 历来空串（显示名交层 3 前端）
- 前端 `MessageList.tsx:398`：user 消息统一显示全局 userDisplayName
- 飞书 `im.message.receive_v1` 事件只带 open_id，不带姓名

需求：走正路——开 `contact:contact.base:readonly` 权限，open_id → 姓名快照入库，agent 历史与 Web 前端贯通显示真实姓名。同时交付飞书用户手册（含权限清单）。

## 方案设计

三层贯通，全部对齐「sender name 单一真相源」（PR #392）分层架构：

### D1 — 姓名解析（新增）
- `FeishuUserInfoGateway`（usecases 端口）+ `FeishuUserInfoClient`（frameworks 实现）
- 调 `GET /open-apis/contact/v3/users/{open_id}`，需权限 `contact:contact.base:readonly`
- 进程内缓存 10min TTL；仅缓存正结果（权限开通后自动恢复，无需重启）
- API 失败返回 null + warn 日志，**永不阻塞消息主链路**

### D2 — 快照入库
- `SendMessageInput` 新增 `senderDisplayName?: string | null`
- `send()`：`senderType === "user"` 时快照 `input.senderDisplayName?.trim() ?? ""`
- `FeishuMessageProcessor` 注入可选 `feishuUserInfo`，存消息前解析姓名
- 无 migration：messages.sender_name 列已存在（PR #392 铺好的路）

### D3 — 渲染贯通
- **agent 历史**（`dispatch-chain-engine.ts`）：user 消息 `senderName?.trim() || (senderId === 当前sender ? partnerLabel : 裸ID)`——其他 user 发言者无快照时保留裸 ID，**不冒充「搭档」**（身份误解防线）
- **Web 前端**（`display-name.ts` + `MessageList.tsx`）：user 消息优先快照名（DTO `sn` 字段，`toMessageDTO` 已透传非空 senderName），无快照回退全局名——单聊体验不变
- **未读查询**：`getUnreadMessages` mixin 的 SELECT 补上 `m.sender_name`

### D4 — 用户手册（docs/user-guide/feishu-setup.md）
完整权限清单（从代码 API 调用盘点推导）：
- `im:message`（必选——只开 p2p 子集是群聊不通的常见根因）
- `contact:contact.base:readonly`（推荐——本特性的多人识别依赖）
- `im:chat:readonly`（可选预留）
含配置步骤、命令表、群聊要点、FAQ。`config.yaml.example` 使用说明同步更新。

## 非目标

- 历史消息姓名回填（新消息生效即可，FAQ 已注明）
- 群成员列表缓存/预热（首次发言时逐个解析，缓存 10min）
- otter/system 消息的 senderName 变更（已有各自路径）

## 验证

- 后端 1657 测试全过（新增 17：dispatch-chain-engine 快照渲染 5 + message-processor 注入 5 + 既有回归）
- 前端 190 测试全过（新增 display-name 4）
- tsc --noEmit / eslint 全绿

## 影响范围

- 飞书消息入库链路（新增可选依赖，未注入时行为与之前完全一致）
- agent 上下文渲染（user 消息标签可能从「搭档」变为实际姓名——预期变化）
- Web 端 user 消息显示（同上，无快照时不变）

## 取舍

- **失败静默降级**（null 快照）优于报错重试：消息必达优先，姓名是增强信息
- **裸 ID 而非「搭档」**：其他 user 发言者身份未知时，宁可难看不可说谎——海獭把陌生人当搭档的风险大于显示一串 ID 的难看
- **仅缓存正结果**：负结果缓存会在权限补开后继续命中 null，正结果缓存 + TTL 兼顾限流与恢复速度
