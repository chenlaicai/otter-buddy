---
id: F20260829wxch
title: '微信通道核心：ilink 协议直连 ingress/egress + WeixinMessageChannel'
summary: 微信官方 openclaw-weixin 通道的协议直连实现（不依赖 OpenClaw 宿主）——frameworks 层 ilink API client（扫码登录/长轮询/发消息）+ 账号状态持久化 + 长轮询 ingress（游标/stale-token 暂停/backoff）+ 出站通道 WeixinMessageChannel（照飞书模式：投影+降噪+防回环+thinking）+ 入站处理器（命令复用 feishu-command-parser + partner 门禁）+ config.weixin 配置段 + npm run weixin:login CLI。全仓 2030 测试绿（新增 25）。
change_type: feature
capability_test: "n/a: 纯协议 IO（fetch 全 mock 不出网）；收发闭环验证走真扫码（部署后人工验收，issue #564）"
tags: [im, weixin, channel, ilink, long-polling, ingress, egress]
modules: [src/frameworks/weixin, src/usecases/im/weixin-message-channel.ts, src/usecases/im/weixin-gateway.ts, src/interface-adapters/weixin, src/bootstrap/platforms.ts, src/frameworks/config-service.ts, src/entities/conversation/message.ts, scripts/weixin-login.mjs]
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
from: []
---

# 微信通道核心：ilink 协议直连（issue #565）

微信官方发布 `@tencent-weixin/openclaw-weixin`（MIT，插件本体含 TS 源码），其 README 公开后端 API 协议全文并明示「二次开发者若需对接自有后端，需实现以下接口」。本特性照飞书通道的架构模式（lobby-feishu-integration / #281 broadcaster 拆分），把微信作为第三个 IM 通道接入 otter-buddy——**协议直连 `https://ilinkai.weixin.qq.com`，不引入 OpenClaw 宿主**。

协议审计记录见对话工作区 `openclaw-weixin-protocol-notes.md`（2026-08-28）；PoC 已验证直连申请二维码 200 OK（无 appid 白名单拦截）。

## 架构（与飞书通道逐层对齐）

| 层 | 微信实现 | 飞书对应物 | 说明 |
|---|---|---|---|
| 协议层 | `src/frameworks/weixin/api-client.ts` | `feishu/client.ts` | ilink/bot/* 接口封装；请求头契约（AuthorizationType=ilink_bot_token / X-WECHAT-UIN 随机 / iLink-App-Id=bot / ClientVersion 编码）；bot_agent=OtterBuddy/0.1.0 自我声明 |
| 状态层 | `account-store.ts` | （飞书无账号态） | accounts.json（bot_token）+ <id>/sync-buf.json（游标）+ context-tokens.json（对端→会话令牌） |
| ingress 循环 | `polling-channel.ts` | `long-connection-handler` | getupdates 长轮询（35s）；-14 stale→暂停 1h；连错 3 次 backoff 30s；bot 自身消息过滤（防回环） |
| 登录 | `login-flow.ts` + `scripts/weixin-login.mjs` | （飞书无登录） | get_bot_qrcode→终端二维码→get_qrcode_status 长轮询→confirmed 落 bot_token；need_verifycode 配对码流程 |
| 出站通道 | `usecases/im/weixin-message-channel.ts` | `feishu-message-channel.ts` | OutboundMessageChannel/OutboundEventChannel：projectForChannel 投影→纯文本；message.start→「正在思考...」（3s gate 同飞书 R5）；source=weixin 防回环 |
| 出站网关 | `interface-adapters/weixin/weixin-gateway-adapter.ts` | （client 兼任） | context_token 从 AccountStore 回填（协议出站凭证，入站消息携带落盘）；markdown→纯文本降噪 |
| 入站处理器 | `interface-adapters/weixin/message-processor.ts` | `feishu/message-processor.ts` | 命令复用 feishu-command-parser（/list /in /out /history /help）；partnerResolver 门禁（weixin.partnerUserId）；AgentDispatchService 派发 |
| 装配 | `bootstrap/platforms.ts` startWeixinChannels | setupFeishu | config.weixin 启用 + 已登录账号 → 每账号一条轮询 + 广播总线注册出站 |

## 协议要点（审计结论）

- **会话模型**：微信侧是「用户 ↔ bot 私聊」。connection.externalId = 对端 ilink_user_id；出站必需 context_token（入站消息携带、有时效，重启后只能等用户再发消息重建）
- **消息收发**：getupdates 长轮询（游标 get_updates_buf 断点续拉，类 Telegram Bot API）；sendmessage item_list（文本 type=1；媒体 CDN+AES-ECB 留 PR③）
- **错误语义**：errcode -14 = token stale（服务端要求重新扫码）；语音消息自带 ASR 转写 text（voice_item.text）
- **合规**：bot_agent 观测归因字段（官方许可信号）；命令门禁默认不开（partnerUserId 未配置不拦，对齐飞书降级语义）

## 关键决策

1. **协议直连而非 OpenClaw 桥接**（路线 A）：架构插槽现成、MIT 源码可平移、不养第二个 agent 框架。代价：协议无 SLA，微信侧变更需跟进（风险已在 #564 记录）
2. **MessageSource 增加 "weixin"**：入站防回环需要 source 标记（与 feishu 同语义），entities 层最小改动
3. **context_token 持久化在 frameworks 层文件存储**：不上 DB——协议 token 生命周期未知（stale 后整账号失效），文件态与 ilink 状态天然对齐，删账号即删目录
4. **命令体系复用 feishu-command-parser**：/in /out /list /history 语义通道无关（绑定的是 ManageConnection 的 conversation 会话），复制一份只会漂移
5. **媒体暂不做**（#567）：CDN+AES-ECB+silk 编解码独立成 PR；本期媒体消息入站降级为可见占位文本（消息不丢）

## 使用（部署侧）

```yaml
# config.yaml（可选——不配置则微信通道不启用）
weixin:
  stateDir: ./data/weixin      # 默认
  partnerUserId: <ilink_user_id> # 命令门禁（扫码后 CLI 会提示）
```

```bash
npm run weixin:login   # 扫码授权，token 落 data/weixin/accounts.json
npm start              # 重启后自动拉起轮询
```

## 验证

- 全仓 vitest 2030 绿（新增 25：api-client 7 / polling-channel 5 / message-channel 5 / gateway-adapter 3 / message-processor 5），fetch 全 mock 不出网
- lint / tsc 干净（新增代码零 eslint 错误）
- 真机收发闭环：**待部署后人工验收**（需真扫码，测试环境无法自动化）——验收项：扫码登录→微信发文本→otter 回复→/in 命令切会话

## 后续（另立 PR）

- #566 连接管理 UI（web/connections 扫码页 + 多账号）
- #567 媒体支持（CDN 上传/下载 + AES-128-ECB + silk 语音 + 附件管线对接）
