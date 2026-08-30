---
id: F20260830wxmd
title: '微信通道媒体支持：CDN 上传/下载 + AES-128-ECB + SILK 语音'
summary: 微信通道第三期（issue #567）——出站媒体（附件经 getuploadurl + AES-ECB 加密 + CDN PUT 后按 image/file/video item 发送）+ 入站媒体（CDNMedia 引用下载解密入附件管线，对接多模态注入，语音 SILK→WAV 转码 silk-wasm）。协议平移自 openclaw-weixin cdn/media（MIT），分层照飞书多模态 Phase 2（port WeixinMediaGateway + 实现 WeixinMediaClient）。全仓 2157 测试绿（新增 27）。
change_type: feature
capability_test: "tests/frameworks/weixin/cdn-client.test.ts"
tags: [im, weixin, media, cdn, aes-ecb, silk, attachments, multimodal]
modules: [src/frameworks/weixin/cdn, src/frameworks/weixin/media-client.ts, src/frameworks/weixin/silk-transcode.ts, src/usecases/im/weixin-media-gateway.ts, src/usecases/im/weixin-message-channel.ts, src/usecases/im/weixin-gateway.ts, src/interface-adapters/weixin, src/bootstrap/platforms.ts]
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
from: [F20260829wxch, F20260827mmdu]
---

# 微信通道媒体支持（issue #567）

微信通道三件套收官：PR① 通道核心（#569）、PR② 连接管理 UI（#586）之后的媒体支持。微信 ilink 协议的媒体走 CDN：出站「本地文件 → AES-128-ECB 加密 → getuploadurl 申请 → CDN PUT 密文 → 拿下载参数拼发送 item」；入站「CDNMedia 引用（encrypt_query_param + aes_key）→ CDN GET 密文 → AES 解密 → 附件管线」。语音入站为 SILK 编码，silk-wasm 解码转 WAV 后入库。协议实现平移自 `@tencent-weixin/openclaw-weixin@2.4.6`（MIT）的 src/cdn + src/media，架构对接照飞书多模态 Phase 2（F20260827mmdu）的附件管线。

## 变更

### 1. 协议层扩展（frameworks/weixin）

- **types.ts**：CDNMedia 结构（encrypt_query_param/aes_key/encrypt_type/full_url）落到各 item 类型（image_item.media 等）；getuploadurl 请求/响应 + WeixinUploadMediaType 枚举 + WeixinUploadedMedia 产物类型
- **api-client.ts**：`getUploadUrl()`（filekey/media_type/rawsize/md5/filesize/aeskey）+ `sendMessageItems()`（结构化 item 逐个独立请求，协议语义）
- **cdn/aes-ecb.ts**：AES-128-ECB 加解密 + PKCS7 补齐大小（Node crypto 原生，PKCS7 默认）
- **cdn/cdn-url.ts**：上传/下载 URL 拼接（upload_full_url/full_url 服务端直出优先，缺省拼 CDN base）
- **cdn/cdn-client.ts**：`WeixinCdnClient`——上传管线（md5 → 随机 filekey/aeskey → getuploadurl → 加密 → PUT；4xx 不重试/5xx 重试 ≤3）+ 下载解密（full_url 优先 → GET → 解密 → 100MB 上限）+ `parseCdnAesKey`（协议在野两种 key 编码：base64(raw16) 图片 / base64(hex32) 文件语音视频）
- **silk-transcode.ts**：SILK → WAV（silk-wasm 动态 import，失败返回 null 由调用方降级存原始 SILK）
- **media-client.ts**：`WeixinMediaClient implements WeixinMediaGateway`——协议 item → 下载解密 → {fileName, mimeType, buffer}；图片 key 优先级（image_item.aeskey hex > media.aes_key）、语音转码降级、文件名保留 + MIME 后缀映射

### 2. 出站媒体（usecases + interface-adapters）

- **WeixinGateway port** 增 `replyMedia(toUserId, {filePath, fileName, mimeType, caption})`
- **WeixinGatewayAdapter.replyMedia**：读文件 → CDN 上传 → 按 MIME 路由 item（image/* → IMAGE / video/* → VIDEO / 其余 FILE）→ caption 文本在前媒体在后逐 item 发送；aes_key 用 base64(hex) 编码（与文件类入站同编码）
- **WeixinMessageChannel**：出站消息带附件时先发投影文本（占位 + Web 链接兜底），再逐个附件 `replyMedia`（attachmentRepo 查实体拿 filePath）；单项失败不阻塞其余（占位已在文本里可见）

### 3. 入站媒体（interface-adapters/weixin/message-processor）

- process 签名扩展 `raw.item_list`（polling-channel 本就透传 raw，零改动）
- 媒体项走「WeixinMediaGateway 下载解密 → AttachmentUploadService 入库（探嗅/resize/去重复用）→ attachmentIds 随 sendMessage 入库 + injection 载荷随 agent dispatch」——与飞书 processMedia 同语义：单项失败单项降级提示（消息不丢）、管线未装配降级可见文本、>2 图整组拒绝附件保留正文
- **分层**：processor 只依赖 usecases 的 `WeixinMediaGateway` port（照 FeishuResourceGateway 模式）；实现 WeixinMediaClient 在 frameworks，platforms.ts 装配注入

### 4. 装配（bootstrap/platforms.ts）

startWeixinAccount：CDN 客户端注入 gateway（出站上传）+ WeixinMediaClient + attachmentUpload/attachmentInjection 注入 processor（与飞书同块装配）；WeixinMessageChannel 增传 repos.attachment。

### 5. 依赖

新增 `silk-wasm@^3.7.1`（SILK 编解码，wasm 动态加载）。无其他新依赖——AES/MD5 用 node:crypto 原生。

## 关键决策

1. **mediaGateway port 而非直传 cdn client**：初版 processor 直接 import frameworks 的 WeixinCdnClient 被 eslint 分层规则拦截——照飞书 FeishuResourceGateway 模式抽 port，processor 依赖 usecases 接口，实现细节（key 编码/转码降级）封装在 frameworks 的 WeixinMediaClient。
2. **语音降级链**：SILK 解码失败 → 存原始 .silk（octet-stream）而非丢弃——服务端 ASR 转写 text 仍随消息体可用，agent 侧不瞎。
3. **出站附件先文本后媒体**：投影文本里的附件占位 + Web 链接是兜底可见性；媒体上传失败时占位仍可点，比「失败重发整条文本」简单且不乱序。
4. **4xx/5xx 重试语义平移**：CDN PUT 的 client error（签名/参数错）重试无意义立即抛；server error 重试 ≤3 次——与 openclaw-weixin 行为一致，避免向微信侧发垃圾请求。
5. **无缩略图上传**：getuploadurl 传 no_need_thumb=true（单图上传，微信侧自处理中图/缩略图展示），平移参考实现默认行为。

## 验证

- 全仓 vitest **2157 passed**（新增 27：cdn-client 11 + silk-transcode 2 + processor 媒体 4 + gateway-adapter replyMedia 3 + 既有用例适配）
- tsc --noEmit / eslint 0 错误
- fetch 全 mock 不出网（CDN/上传/下载均 stub）；silk 测试用 silk-wasm 真编码 roundtrip 验证 WAV 容器头
- **真机验收（合入后需搭档配合）**：微信发图 → web/对话页可看图；otter-buddy 回图 → 微信收到；发语音 → 转写文本 + 附件入库

## 最简实现检查

已过：协议三件套（aes-ecb/cdn-url/cdn-client）是对参考实现的直接平移无多余抽象；出站复用 sendMessageItems 单一新方法（未拆 per-media sender 类）；silk-wasm 是唯一新增依赖（AES/MD5 用 node:crypto）；无缩略图生成（issue 范围内的「缩略图」项按 no_need_thumb 语义交微信侧，不自建 sharp 管线）。

## 后续

- #591（重复热启动去重）/ #592（删账号不清登录会话）仍开放，与本 PR 无耦合
- 视频/文件大媒体（>25MB）的真机表现未验证——CDN 协议无文档化的分片语义，走单次 PUT，超大文件可能需要后续跟进
