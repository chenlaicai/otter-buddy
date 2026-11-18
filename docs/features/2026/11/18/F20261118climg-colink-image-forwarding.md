---
title: "CoLink 双向图片文件交互：接收注入海獭附件 + 回复 SVG 渲染回发"
id: F20261118climg
date: 2026-11-18
module: extensions
change_type: feature
status: active
capability_test: "n/a: 不新增工具/检索行为，双向图片由海獭 attachment 注入链路与 CoLink files/messages API 表现；行为门禁为 colink-agent-app 单测（54 项中新增/更新 17 项）"
intent:
  problem: "CoLink 与海獭 app 的双向图片链路都是断的：接收方向海獭 app 丢弃事件 fileIds 从不下载图片字节，发送方向海獭 app 只 ctx.reply({text}) 无法带附件，而 CoLink 平台只把 png/jpeg/gif/webp 识别为可预览图片（SVG 不在白名单）。"
  expected_effect: "接收：事件 fileIds 下载字节注入海獭 vision 模型（≤2 张/轮，失败逐张降级）。发送：频道里海獭回复中的 ```svg 围栏被渲染成 PNG、走 files.upload 上传、messages.send 带 fileIds 发「文字+图片」；私聊无 channel 上传降级纯文本；发送失败不回抛避免 SDK 重放海獭 turn。"
  verify_by:
    type: behavior_check
    note: "colink-agent-app npm test 54/54（接收下载/降级/纯图、发送 SVG 渲染转码/提取/净化/失败降级/DM 降级、附件上传与失败降级等用例）；部署后在 CoLink 实机发图与收图验证。"
summary: |
  CoLink 事件 data 只带 fileIds 不带字节、海獭 app 此前既不下发图也不会上传回图。
  本次打通双向：接收方向 manifest 增加 files:read，mention-handler 按来源
  readImage/downloadAttachment 下载图片（≤2 张/轮），OtterBridge 上传海獭附件库随
  attachmentIds 注入 vision；发送方向 manifest 增加 files:upload，新增 image-forward
  (```svg 提取 + sharp 渲染 PNG)，频道回复用 files.upload + messages.send 发文字+图片，
  私聊降级纯文本。配合 apig vision 模型 input 修正（ds flash/glm-5.3(-flash) 实测支持）。
tags: ["colink", "multimodal", "vision", "attachments", "image", "svg", "egress"]
modules: ["extensions/colink-agent-app"]
from: []
supersedes: []
---

# F20261118climg CoLink 双向图片文件交互

## 背景与问题

chen 在 CoLink 里问海獭 app，app 回复「只看到图片元数据、没看到图片本身」。排查结论是双层根因，且双向都不通：

**接收方向（CoLink → 海獭）**
1. **转发缺失**：CoLink 事件 `app.user_message_received` 的 `data` 只带 `text` + `fileIds: string[]`（附件 ID，上限 20，取自消息 richContent 的 `artifacts[].id`），不带文件字节。海獭 app 此前只提取 `data.text`，完全丢弃 `fileIds`，从不调用 CoLink 的文件 API 下载图片字节；纯图无文本时直接抛 `EMPTY_MESSAGE_TEXT`。
2. **模型配置错误**：apig 族模型的 `input` 被统一误标为 `["text"]`。实测（1×1 纯红 PNG）`apig-deepseek-v4.1-flash`、`apig-glm-5.3-flash`、`apig-glm-5.3` 均支持 vision；`apig-deepseek-v4-pro`（图片请求超时）、`apig-kimi-k3`（吞图答黑）、`apig-hy3`（明确无图）不支持。本地与 ECS 的 config 已将支持者改为 `input: ["text", "image"]`。

**发送方向（海獭 → CoLink）**
3. 海獭 app 回复只走 `ctx.reply({ text })`（SDK 该入口只收 text，不支持 fileIds），没有调用 `files.upload` / `messages.send` 的任何代码。模型不生成位图但能输出 SVG 矢量图（文本）；CoLink 平台只把 `image/png / jpeg / gif / webp` 识别为可预览图片（`isPreviewableChannelImage`），SVG 不在白名单，直接发 SVG 文件不会被渲染成图片。

## 方案

### 接收方向：附件注入

复用海獭系统已验证的多模态 Phase 1 链路（附件上传 → `attachmentIds` 随消息 → `AttachmentInjectionService` 注入图片给 vision 模型）：

1. `manifest.mjs` 增加 `files:read` 用户委托权限（读图字节必需，与 pi-agent 同一条授权链）。
2. `mention-handler.mjs` 提取 `data.fileIds`，按事件来源下载图片字节（≤2 张/轮，对齐 vision 注入硬限制）：
   - 频道话题：`ctx.colink.user.topics.readImage({ topicId, artifactId })` → `{ data: base64, mimeType }`
   - 私聊：`ctx.colink.user.directMessages.downloadAttachment({ conversationId, artifactId })` → `{ bytes, contentType }`
3. `otter-bridge.mjs` 新增 `uploadAttachment`（multipart/form-data 上传到 `/api/conversations/:id/attachments`），拿到 attachmentId 后随消息 `POST /messages` 带 `attachmentIds`。
4. 降级语义：读图/上传失败逐张记录 `failedImageIds`，以文本提示追加进消息，不阻断文本；纯图消息不再报 `EMPTY_MESSAGE_TEXT`。

### 发送方向：SVG 渲染回发

1. `manifest.mjs` 增加 `files:upload` 权限（app 身份上传文件）。
2. 新增 `image-forward.mjs`：从回复文本提取 ````svg ... ``` 围栏（含裸 `<svg>` 兜底，去重，≤2 个/轮）→ `sharp` 渲染成 PNG（density 150、resize 1600px inside、白色底防透明）。
3. `mention-handler.mjs` 发送分支：
   - 频道回复含 SVG：逐张渲染 PNG → `ctx.colink.app.files.upload({ bytes, idempotencyKey, channelId, fileName })` 拿 fileId → `ctx.colink.app.messages.send({ idempotencyKey, text: 净化文本, fileIds, channelId, topicId })` 发「文字+图片」。
   - 私聊 `files.upload` 需要 channelId（DM 没有），降级纯文本 `ctx.reply`。
   - 单张渲染/上传失败逐张跳过，不阻断文本；发送阶段 catch 全部异常不回抛（handler 失败会触发 SDK 重放，导致 bridge.reply 重复跑海獭 turn）。
4. `colink-tools.mjs` 频道 prompt 增加约定：用户要求画图/配图时用 ````svg 围栏输出 SVG（≤2 个），App 会渲染成图片；不要输出 base64 或图片外链。

## 影响范围

文件 | 改动
--- | ---
extensions/colink-agent-app/src/manifest.mjs | permissions 增加 `files:read` + `files:upload`
extensions/colink-agent-app/src/mention-handler.mjs | 接收：fileIds 下载 + 降级；发送：SVG 渲染上传 + messages.send/ctx.reply 分流
extensions/colink-agent-app/src/image-forward.mjs | 新增：SVG 提取/净化 + sharp 渲染 PNG
extensions/colink-agent-app/src/otter-bridge.mjs | uploadAttachment + attachmentIds 透传
extensions/colink-agent-app/src/colink-tools.mjs | 频道 prompt 增加 SVG 输出约定
extensions/colink-agent-app/package.json | 新增 sharp 依赖

## 验证

- `extensions/colink-agent-app` 本地 `npm test` 54/54 全绿。
- 部署后需在 CoLink 实机验证：发图给海獭 app 确认能读；让海獭画图确认 PNG 图片随消息出现在频道。
- 若提示「未授权 files:read / files:upload」需重新走海獭 app 的授权确认。