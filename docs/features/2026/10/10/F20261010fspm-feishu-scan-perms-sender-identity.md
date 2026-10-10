---
id: F20261010fspm
summary: 扫码建 app 出生即声明发言人真名权限（addons）+ 删消息体名字前缀 + 兜底标签可读化——治本「扫码 app 权限缺失致发言人无名」
title: 飞书扫码权限集注入与发言人身份链修正
feature_id: F20261010fspm
created: 2026-10-10
created_in_conversation: b7ba808d-be14-4369-9b13-8f9d077c5441
change_type: feature
capability_test: tests/frameworks/feishu/feishu-qr-onboarding.test.ts
tags: [im, feishu, qr-login, registerApp, addons, sender-identity]
modules: [src/frameworks/feishu/, src/interface-adapters/feishu/]
intent:
  problem: "扫码新建 app 权限/通讯录范围缺失致发言人真名解析失败：正文拼 [b2d82e] 退化前缀污染消息体，且每人扫码都要手动补权限（治标不治本）"
  expected_effect: "新扫码 app 出生即带真名两权限（确认页显式授权）；正文永远纯文本，名字只走气泡上方 sender_name；解析失败降级可读「飞书·尾6位」"
  verify_by:
    type: behavior_check
causal_links:
  - F20260929fsqr（扫码接入本体——本特性给它的建 app 流程补权限声明）
  - F20260918imas（p2p 自动开户与显示名——旧「ID 尾部回退」形态被本特性可读化）
  - F20260826fuid（user-info-client 权限语义）
  - F20260826fpbd（搭档静态绑定——发言人域与搭档域分层的历史决策）
---

# 飞书扫码权限集注入与发言人身份链修正

## 背景（搭档实测反馈，2026-10-10）

飞书改扫码对接后首次使用暴露两个问题：

1. **`[b2d82e]` 前缀污染消息体**：web 端飞书消息正文前带一段「乱码」。排查链：open_id `ou_fd591d...b2d82e` 尾 6 位 → `message-processor.ts` 的 p2p 路径把 `resolveAssistantName()` 结果拼进消息体 `[${senderName}] ${text}` → 名字解析失败时退化成 `[b2d82e]`。
2. **名字解析失败的根因是权限缺失**：新扫码 app 的 contact API 返回 `code:0` 但 user 对象**只有 open_id/union_id 无 name**（通讯录脱敏）——API 权限（contact:contact.base:readonly）扫码模板默认带，但**用户不在应用通讯录可用范围**时飞书剥掉姓名字段。群成员 API 则是 `99991672` 未开通（im:chat.members:read）。

搭档拍板（对话原话「很好！开工！」）三件套方案：
- **A. addons 注入**：registerApp 携带增量权限声明，新 app 出生即带真名权限——治本「每人扫码都要手动补权限」
- **B. 删消息体前缀**：名字只走 sender_name 快照（气泡上方），正文永远纯文本
- **C. 兜底可读化**：解析失败降级「飞书·b2d82e」而非裸尾巴

## 设计取舍

### addons 的 additive 语义选择

SDK `AppAddons` 有两种形态（types/index.d.ts）：
- `preset: false`：弃默认模板，最小底座 + 显式声明项——更收敛但**默认模板里的 IM 消息类权限会丢**
- 不传 preset（additive）：保留默认模板底座，业务 scope 叠加

选 **additive**：扫码接入的核心能力（收发消息、长连接）由默认模板保证，我们只需叠加真名两权限。不冒险用 preset:false 重定义底座——那会让「收消息」这个基本盘依赖我们的显式声明完整度，出漏即断线。

### 发言人域与搭档域分层（沿用既有设计）

搭档明确要求：全局「搭档叫 chen」只管名册与搭档概念；飞书每条消息的发言人是独立维度，链路识别要逐发言人区分。该分层已有机制承接，本特性不新建：
- 消息级身份 = `sender_name` 快照（气泡上方 senderDisplayName）
- agent 侧渲染 = `resolveUserEntryLabel`（dispatch-chain-engine）三级标签：搭档(真名) / 访客快照名 / 可读兜底
- 删除 p2p 前缀后，agent 对多人家人的区分依赖上述链路，不再依赖正文前缀

### 旧前缀的原始设计意图与新形态

F20260918imas 引入前缀时的意图是「bot 对话内多家人消息分得清谁在说」——展示维度。但把展示信息拼进消息体是层次错位：正文被污染、解析失败退化难看、agent 上下文里的消息也不纯。sender_name 快照机制（F20260826fuid 起）才是正位——本特性完成迁移收尾。

## 机制判定（前置检查点）

本特性未经 RA 流程（对话内排查→搭档确认方案），动手前完成机制识别判定：
- 命中「修法决策树④ 新增机制」？**否**——addons 是 SDK 既有能力的启用，非新机制发明；删前缀是移除展示层次错位，兜底标签是旧回退路径的文案升级。
- 全部未命中（narrow-fix 语义内修 + 展示修正）→ `Modification-Class: narrow-fix`。
- ③ 后续机制/④ 退役条件：不适用（无新机制）。

## 变更明细

### 1. addons 权限注入（login-session-manager.ts）

`buildRegisterOptions` 增加：

```ts
addons: {
  scopes: {
    tenant: [
      "contact:contact.base:readonly", // p2p 发言人真名（通讯录基本信息）
      "im:chat.members:read",          // 群聊发言人真名（群成员读取）
    ],
  },
},
```

效果：扫码确认页显示这两项增量权限，扫码人显式授权后新 app 出生即带——不再依赖事后手动补。

### 2. 删除 p2p 消息体前缀（message-processor.ts）

`processP2pViaBot` 不再调 `resolveAssistantName` 拼 `[name] text`，直接投递 `msg.text`。`resolveAssistantName` 方法删除（唯一调用者消失）。

### 3. 兜底标签可读化（message-processor.ts）

`resolveSenderName` 解析失败（null/异常）时返回 `飞书·${尾6位}` 替代旧裸 null：

- 旧形态：气泡头空 + 正文 `[b2d82e] 消息`
- 新形态：气泡头 `飞书·b2d82e` + 正文纯消息

### 4. 测试更新

- `bot-anchored-routing.test.ts`：前缀断言改为「正文无前缀」双向断言（两条消息 body 均为纯文本）
- `message-processor.test.ts`：null/异常两用例升级为可读兜底断言（`飞书·b2d82e`），并断言正文无污染
- `feishu-qr-onboarding.test.ts`：新增 addons 断言用例（tenant scopes 含两权限、additive 语义——不传 preset:false）

## 对旧特性做了什么

- **F20260929fsqr**：不修改其文档与主体逻辑；`buildRegisterOptions` 增量补权限声明（该函数原有 D3 注释保留）
- **F20260918imas**：`resolveAssistantName` 方法删除——其「不阻塞开户」语义由 `resolveSenderName` 的兜底路径继承；「助理对话显示名」职责并入 sender_name 快照链
- **F20260826fpbd**：无改动；发言人域/搭档域分层继续由 PartnerResolver + resolveUserEntryLabel 承载

## 验证

- 全量测试 5338/5338 通过（355 文件）
- tsc --noEmit 干净
- 权限事实实测（修复前取证）：tenant_access_token 获取成功；contact API `code:0` 但无 name（脱敏）；im chat members `99991672`（未开通）——证明 addons 注入必要性
- **最简实现检查**：已过——复用 SDK addons 参数（不造权限管理轮子）、复用 sender_name 快照链（不新建身份通道）、删代码多于增代码（净 -4 行核心逻辑）

## 已知边界（不在本特性范围）

- **存量 app（csg-feishu01）**：addons 只影响新扫码；搭档已于今日手动补权限/范围，存量线不受影响
- **通讯录可用范围（addons 接不住的直接后果，易误判 bug）**：`contact:contact.base:readonly` 授权后，若用户不在 app 通讯录可用范围内，飞书仍脱敏剥掉 name 字段——**新扫码 app 首条消息可能仍走「飞书·尾6位」兜底**，需扫码人在开放平台将可用范围设为全员/圈入自己后才返真名。这是正常降级路径而非链路故障，勿重走排查
- **addons 逐级依赖与静默风险**：`im:chat.members:read` 名实来自飞书 99991672 错误信息自列的合法 scope 清单（本仓 API 实测），但 SDK AppAddons 文档明确「未知名被确认页静默丢弃」（types/index.d.ts @1.74.0）；addons 能力本身依赖飞书平台灰度前置——若新扫码 app 确认页未见增量权限项，需按此链排查而非误判为代码缺陷
- **群聊成员名解析**：本特性只声明 `im:chat.members:read` 权限；群消息路径的成员名缓存/解析逻辑是后续增量（未动 group path 代码）
