---
title: "CoLink 图片文件接收：事件 fileIds 下载字节并注入海獭附件"
id: F20261118climg
date: 2026-11-18
module: extensions
change_type: feature
status: active
capability_test: "n/a: 不新增工具/prompt 检索行为，图片接收由海獭系统 attachment 注入链路表现；行为门禁为 colink-agent-app 单测（45 项中新增/更新 8 项）"
intent:
  problem: "CoLink 事件 data 只带 fileIds 不带字节，海獭 app 此前只取 data.text 丢弃 fileIds——带图消息丢失图片，纯图消息直接报 EMPTY_MESSAGE_TEXT；叠加 apig 族模型 input 错标为纯文本，模型侧也收不到图。"
  expected_effect: "带图消息能把 fileIds 对应的图片字节下载、上传到海獭附件库并随消息带 attachmentIds 注入 vision 模型；读图/上传失败逐张降级为文本提示不阻断；纯图消息可正常唤醒应答。"
  verify_by:
    type: behavior_check
    note: "colink-agent-app npm test 45/45（新增通道/私聊下载、纯图唤醒、无图无文拒绝、读图失败降级、附件上传与失败降级等用例）；部署后在 CoLink 实机发图验证。"
summary: |
  CoLink 事件 data 只带 fileIds 不带字节，海獭 app 此前丢弃 fileIds 从未读图。
  本次 manifest 增加 files:read 用户委托，mention-handler 按来源
  readImage/downloadAttachment 下载图片字节（≤2 张/轮），OtterBridge 上传海獭
  附件库并随消息带 attachmentIds 走多模态 Phase 1 注入；读图/上传失败逐张降级
  不阻断文本。配合 apig 族 vision 模型 input 修正（ds flash/glm-5.3(-flash) 实测支持）。
tags: ["colink", "multimodal", "vision", "attachments", "image"]
modules: ["extensions/colink-agent-app"]
from: []
supersedes: []
---

# F20261118climg CoLink 图片文件接收与附件注入

## 背景与问题

chen 在 CoLink 里问海獭 app，app 回复「只看到图片元数据、没看到图片本身」。排查结论是双重根因：

1. **转发缺失**：CoLink 事件 `app.user_message_received` 的 `data` 只带 `text` + `fileIds: string[]`（附件 ID，上限 20，取自消息 richContent 的 `artifacts[].id`），不带文件字节。海獭 app 此前只提取 `data.text`，完全丢弃 `fileIds`，从不调用 CoLink 的文件 API 下载图片字节；纯图无文本时直接抛 `EMPTY_MESSAGE_TEXT`。
2. **模型配置错误**：apig 族模型的 `input` 被统一误标为 `["text"]`。实测（1×1 纯红 PNG）`apig-deepseek-v4.1-flash`、`apig-glm-5.3-flash`、`apig-glm-5.3` 均支持 vision；`apig-deepseek-v4-pro`（图片请求超时）、`apig-kimi-k3`（吞图答黑）、`apig-hy3`（明确无图）不支持。本地与 ECS 的 config 已将支持者改为 `input: ["text", "image"]`。

## 方案

复用海獭系统已验证的多模态 Phase 1 链路（附件上传 → `attachmentIds` 随消息 → `AttachmentInjectionService` 注入图片给 vision 模型）：

1. `manifest.mjs` 增加 `files:read` 用户委托权限（读图字节必需，与 pi-agent 同一条授权链）。
2. `mention-handler.mjs` 提取 `data.fileIds`，按事件来源下载图片字节（≤2 张/轮，对齐 vision 注入硬限制）：
   - 频道话题：`ctx.colink.user.topics.readImage({ topicId, artifactId })` → `{ data: base64, mimeType }`
   - 私聊：`ctx.colink.user.directMessages.downloadAttachment({ conversationId, artifactId })` → `{ bytes, contentType }`
3. `otter-bridge.mjs` 新增 `uploadAttachment`（multipart/form-data 上传到 `/api/conversations/:id/attachments`），拿到 attachmentId 后随消息 `POST /messages` 带 `attachmentIds`。
4. 降级语义：读图/上传失败逐张记录 `failedImageIds`，以文本提示追加进消息，不阻断文本；纯图消息不再报 `EMPTY_MESSAGE_TEXT`。

## 影响范围

文件 | 改动
--- | ---
extensions/colink-agent-app/src/manifest.mjs | permissions 增加 `files:read`
extensions/colink-agent-app/src/mention-handler.mjs | 提取 fileIds + 下载图片字节 + 降级
extensions/colink-agent-app/src/otter-bridge.mjs | uploadAttachment + attachmentIds 透传

## 验证

- `extensions/colink-agent-app` 本地 `npm test` 45/45 全绿（含新增 8 个用例：manifest 权限、下载/降级/纯图/空消息、上传/失败降级）。
- 部署后需在 CoLink 实机发图验证；若提示「未授权 files:read」需重新走海獭 app 的授权确认。
