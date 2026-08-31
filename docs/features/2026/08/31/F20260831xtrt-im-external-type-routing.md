---
id: F20260831xtrt
title: IM 出站通道按 externalType 路由：微信/飞书跨通道误广播修复
summary: Connection 建连 externalType 从硬编码 "feishu" 改为可声明参数（微信 ingress 传 "weixin"），两个出站通道按 connection.externalType 过滤——微信会话不再误投飞书（invalid receive_id 噪音根除），飞书会话不进微信通道。
change_type: fix
created: 2026-08-31
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
tags: [im, weixin, feishu, broadcast, routing, externalType]
modules: [src/usecases/im/manage-connection.ts, src/usecases/im/feishu-message-channel.ts, src/usecases/im/weixin-message-channel.ts, src/interface-adapters/weixin/message-processor.ts]
---

## 背景

微信通道上线（#569/#603/#622）后，每条微信入站消息都会触发一次飞书广播失败日志：

```
Failed to broadcast to Feishu (degradation also failed)
— invalid receive_id
```

根因（2026-08-31 视觉排查时顺带定位，见工作区 troubleshoot-weixin-vision.md 发现 3）：

1. `manage-connection.ts:37` 建连时 `externalType` **硬编码 "feishu"**——微信用户首次建连（`interface-adapters/weixin/message-processor.ts:68` 经 `ensureConnection`）也被记成 feishu
2. 两个出站通道（FeishuMessageChannel / WeixinMessageChannel）注册进 broadcaster 后对**所有**会话广播，各自只靠 `message.source` 防回环，不校验连接类型
3. 结果：微信会话的每条完成消息都会被 FeishuMessageChannel 拿微信 open_id 当飞书 chat_id 投递 → 飞书 API 报 `invalid receive_id` → 日志噪音 + 无效请求；反向飞书会话也会进微信通道（靠 `requireContextToken` 缺 token 时的跳过逻辑侥幸不炸）

## 改动

1. **`manage-connection.ts`**：`createConnection` / `ensureConnection` 增加可选参数 `externalType = "feishu"`（缺省值保持既有行为，HTTP controller 手动建连不受影响）
2. **`interface-adapters/weixin/message-processor.ts`**：微信 ingress 建连显式传 `"weixin"`
3. **`feishu-message-channel.ts`**：`onMessage` 取到 connection 后校验 `externalType !== "feishu"` 则跳过（debug 日志留痕）
4. **`weixin-message-channel.ts`**：对称校验 `externalType !== "weixin"` 则跳过

## 验证

- 新增测试 6 例：createConnection 缺省/传类型、ensureConnection 透传、飞书通道跳过 weixin 连接、飞书通道不回归、微信通道跳过 feishu 连接、微信通道不回归（`bindFeishu`/`bindWeixin` mock 增加 externalType 维度）
- 受影响面 138 测试全绿（im 用例 + 双 ingress），tsc / eslint 干净
- 最简实现检查：已过——无可复用的仓库内路由机制（broadcaster 是总线模式，通道自治过滤是最小改动面）；未引入新依赖/新文件

## 已知边界与迁移

- **遗留连接**：修复前已建的微信用户连接 externalType 仍是 "feishu"（本机实测 1 条：`o9cq8003...@im.wechat`）——新校验会让这类连接**双通道都跳过**（feishu 通道校验 externalType=feishu 通过但 receive_id 无效报错会消失，因为…实际上它会通过校验继续投飞书失败）。处置：部署时手工订正 `UPDATE connections SET external_type='weixin' WHERE external_id LIKE '%@im.wechat'`，或让用户重扫码（现有 token 仍有效，不强制）。已在 PR 描述记录，合入后由大獭执行订正。
- externalType 无枚举校验（string 自由值），与既有实体定义一致——枚举收紧属于独立重构，不在本修复范围
