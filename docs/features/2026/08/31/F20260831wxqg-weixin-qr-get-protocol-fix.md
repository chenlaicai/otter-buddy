---
id: F20260831wxqg
title: 微信扫码登录 GET 协议修正：get_qrcode_status 从 POST 改 GET + query
summary: 真机验收发现扫码状态长轮询用错 HTTP 方法——POST 被网关静默吞掉（HTTP 200 + ret:1 无 status），扫码事件永远收不到。改为 GET + query 参数（对照参考实现 login-qr.ts），同时清理不存在的游标字段、超时容错为 wait。
change_type: fix
tags: [weixin, login, protocol, http-method, qr]
modules:
  - src/frameworks/weixin/api-client.ts
  - src/frameworks/weixin/login-flow.ts
  - src/frameworks/weixin/types.ts
  - tests/frameworks/weixin/api-client.test.ts
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
---

# 微信扫码登录 GET 协议修正（get_qrcode_status）

## 现象（真机验收 #566 发现）

搭档在 web 页发起扫码 → 微信扫码并打开了 bot 对话 → 页面永远停留「等待连接」，5 分钟后超时。微信侧发消息也无回复。

## 根因

`get_qrcode_status`（扫码状态长轮询）我们实现为 **POST + JSON body**（`{ qrcode, get_qrcode_status_buf?, base_info }`），但微信网关该端点只认 **GET + query 参数**：

| 请求形式 | 网关响应（实测 2026-08-31） |
|---|---|
| POST + JSON body | `{"ret":1}` —— 无 status 字段的幽灵响应 |
| GET + `?qrcode=...` | `{"ret":0,"status":"expired"}` —— 真协议行为（假码正确判 expired） |

错误来源链：8/28 PoC（weixin-poc.mjs --wait 模式）把插件 README「接口全部 POST JSON」泛化到该端点，且 PoC 当时只验证到「申请二维码成功」，**扫码确认链路从未真机跑通**——POST 幽灵响应不报错，代码把 undefined status 当 wait 无限轮询到 5 分钟超时。参考实现（openclaw-weixin@2.4.6 `src/auth/login-qr.ts` pollQRStatus）一直用 GET + query。

连带发现：`get_qrcode_status_buf` 游标字段在参考实现源码中**不存在**（README 也无），系 PoC 误引，一并清理。

## 修复

1. **api-client.ts**：`pollQrStatus` 改 GET + query（qrcode/verify_code 进 URLSearchParams）；新增私有 `get()` 复用 `buildHeaders`；**客户端超时（35s 无事件）视为 wait 继续轮询**而非抛错——参考实现对 AbortError 的处理即如此，否则长轮询超时会误杀会话
2. **login-flow.ts**：去掉 cursor 传递（协议无此字段）；`pollRound` 返回 `null` 表示继续；verify_code 直接走 GET query
3. **types.ts**：删除 `get_qrcode_status_buf` 字段
4. **api-client.test.ts**：新增 3 个回归测试——**断言 HTTP method=GET + query 编码 + 无 body**（本次事故的教训：mock 若不校验方法，POST 错误照样全绿）、verify_code 进 query、超时→wait

## 验证

- `tests/frameworks/weixin/` 34 全绿（含新增 3 回归）
- tsc --noEmit 干净
- 真机网关实测：GET + 假码 → `{"ret":0,"status":"expired"}`（协议行为正确）；POST + 假码 → `{"ret":1}`（复现幽灵响应）

## 影响范围

仅扫码登录链路（get_bot_qrcode / getupdates / sendmessage / getuploadurl 均为 POST 且与参考实现一致，其中收发消息已在 PoC 期真机验证）。修复后 web 扫码登录与 CLI（npm run weixin:login，共用 login-flow）都恢复可用。

## 教训（记入流程改进）

- **协议审计不能只对字段，还要对 HTTP 方法**：README 的「全部 POST」是概述性表述，端点级例外（本例 GET）必须以参考实现源码为准
- **mock 测试要断言 HTTP 方法与请求形状**：不校验方法的 mock 让协议级错误全绿通过——本次回归测试补上 method 断言
- **PoC 验证到哪一步就要明说哪一步**：「申请二维码成功」≠「登录链路通」，PoC 笔记未标注验证边界导致后续实现引用了未验证的假设
