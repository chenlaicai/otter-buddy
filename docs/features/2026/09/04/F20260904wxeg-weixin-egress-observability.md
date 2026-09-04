---
id: F20260904wxeg
title: 微信出站 sendmessage 全量观测日志
summary: 微信出站全黑洞排查（ret=0 假成功但微信侧不投递）中暴露的观测盲区——sendTextMessage 无成功日志，排查只能靠「无错误日志」反推（#213 教训重演）。本特性给出站 sendmessage 补全量观测：入参摘要（clientId/textLength/hasContextToken）+ 响应留痕（ret/errcode/errmsg/elapsedMs）+ 传输层异常显式记错；同时补 errcode 通道校验（relay-claw F137 实证 sendmessage 失败可能走 errcode 而非 ret，仅查 ret 会静默放行）。
change_type: fix
capability_test: "n/a: 纯观测日志 + 防御校验，行为不变（既有 77 tests frameworks/weixin 全绿）"
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
tags: [weixin, egress, observability, errcode]
modules: [src/frameworks/weixin/api-client.ts, src/frameworks/weixin/types.ts, src/bootstrap/platforms.ts]
---

## 背景

2026-09-04 微信出站全黑洞排查（详见当日本对话）：入站正常、getconfig 正常、sendmessage 一律 `200 + ret=0`，但微信侧零投递（连 typing 都不显示）。协议已逐字段对照官方 openclaw-weixin@2.4.6 无差异。

排查中搭档质疑方法论：「日志没有错误」只能证明没抛错，不能证明执行过——`sendTextMessage` 无成功日志，「发了」与「压根没走到发送」在日志里同形态。该质疑成立（11:21 `/in` 命令回复是否发出无法定论）。

历史教训链：
- #213（检视后硬规则）：处置完检视意见必须回检——本次是它的观测版：**结论必须锚定证据，反推不算数**
- relay-claw F137 BUG-2：sendmessage 假成功（200 OK 不投递）；其修复含「errcode 通道」——`data.errcode ?? data.ret` 联合判错。我们的实现只查 `ret`，errcode≠0 但 ret 缺失时会静默放行

## 方案设计

三层补强，全部在 `api-client.sendTextMessage`（出站唯一出口）：

1. **传输层**：fetch 抛错（超时/DNS/5xx）显式 `logger.error` 后 rethrow——此前抛错直接上浮，polling 层 catch 会记，但缺出站上下文（clientId/token 有无/耗时）
2. **成功留痕**：每次 sendmessage 成功返回后 `logger.info` 全量摘要（toUserId/clientId/textLength/hasContextToken/ret/errcode/errmsg/elapsedMs）——消灭「发了没走到说不清」盲区
3. **errcode 校验**：`errcode !== undefined && errcode !== 0` 时抛错（与 ret 校验并列）——堵 F137 实证过的静默放行通道

`WeixinApiClient` 构造器加可选 `logger` 依赖（不破坏既有调用方；login-session-manager 的实例不传，静默降级）。装配点 `platforms.ts` 注入。

## 取舍

- 日志级别 info（不是 debug）：出站是低频关键路径（每条回复一次），info 不构成噪音；排查场景需要默认可见
- 不记 text 全文：记 textLength——隐私最小化 + 摘要够用（全文在 DB 消息里有）
- logger 设为可选而非必填：避免为纯观测改动扩大改动面（两处 new 点，一处注入一处不动）

## 验证

- `tsc --noEmit` 0 错误
- `tests/frameworks/weixin/` 9 files / 77 tests 全绿（行为无变化）
- 真机验证：部署后搭档发 `/list`，日志应出现 `weixin sendmessage response` 一条，无论投递成功与否先钉死「发没发」

## 后续

- 若真机确认「发了 ret=0 但不投递」：问题定位收敛到 iLink 服务端侧，客户端排查线关闭
- typing（sendTyping）与媒体（sendMessageItems）的观测留待本特性验证后按需补——先钉住文本主路径
