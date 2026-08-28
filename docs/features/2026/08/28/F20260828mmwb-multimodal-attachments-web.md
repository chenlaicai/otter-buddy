---
id: F20260828mmwb
title: 多模态附件支持 Web 前端：上传交互与消息内附件渲染
doc_type: feature

# 记忆索引
summary: |
  多模态附件 Phase 1 第二棒（Web 前端）：上传中转状态机（选择→上传→随消息发送，
  占位→服务端 DTO 替换、失败回滚、预览 URL 释放）；输入框回形针入口+中转区渲染
  （缩略图/文件卡/移除/错误提示）；消息气泡附件块（图片网格点击看原图、document
  文件卡点击下载，统一走 /api/attachments/:id）；发送链路 attachmentIds 透传+乐观
  消息带附件。前端校验白名单与后端对齐（SVG 排除/图 10MB/文 20MB/≤2 图/≤5 文件）。

# 因果链路
causal_links:
  from:
    - F20260827mmdu  # 后端契约（attachmentIds + atts DTO + 上传/下载端点）
  to: []

# 元数据
status: implemented   # 代码已实现（web 267 用例全绿 + 根仓 1958 全绿），待对抗审视
change_type: feature
capability_test: "n/a: 纯前端 UI 交互（上传状态机/渲染/校验），无 LLM 行为；验证走 vitest + jsdom（28 个新用例覆盖校验纯函数/状态机/渲染三件套）"
tags: [multimodal, attachments, web, upload, ui]
modules: [web/src/api/client.ts, web/src/lib, web/src/pages/conversation]

# 时间
created_at: 2026-08-28
created_in_conversation: 57491055-4242-493b-902c-e1626c748ed2
---

# 多模态附件支持 Web 前端：上传交互与消息内附件渲染

后端 F20260827mmdu（PR #538 已合入）交付了附件数据层、上传 API 与 DTO 透出，
本 PR 补齐 Web 前端闭环：**用户能选文件 → 看到上传状态 → 随消息发送 → 历史消息
里看到附件渲染**。Phase 1 完成口径 = 后端 + 本前端双 PR 合入。

## 实现内容

### 1. API 层（web/src/api/client.ts）

- `uploadAttachments(conversationId, files, uploaderId?)`：multipart 上传，
  POST `/conversations/:id/attachments?uploaderId=user`，返回
  `UploadAttachmentResponseDTO { attachments: AttachmentDTO[] }`
- 细节：用 request() 通道但 headers 显式置空——multipart 禁止手动设
  Content-Type（boundary 必须由浏览器生成）

### 2. 校验与格式化纯函数（web/src/lib/attachments.ts 新文件）

- 扩展名白名单与后端 `upload-validation.ts` 一一对应：图片 png/jpg/jpeg/webp/gif
  （**SVG 排除**——XSS 向量）、文档 txt/md/markdown/csv/json
- 大小限制与后端 config 默认值对齐：图 10MB / 文档 20MB
- `ATTACHMENT_ACCEPT` 供 file input；`pickValidFiles` 批量拆分通过/拒绝
- 定位：前端拒一次省一趟网络；后端仍是真相源（magic bytes 校验只有后端能做）

### 3. 上传中转状态机（hooks/useAttachmentStaging.ts 新文件）

状态流转：`选择 → 占位（uploading + 本地 blob 预览）→ 上传 → 服务端 DTO 替换`。

关键决策：
- **独立 hook 而非塞进 useDraftCache**：草稿是纯文本可 localStorage 持久化；
  附件含 File 对象（不可序列化）且上传后是服务端 id 引用——生命周期不同，不混存
- **占位替换按 uploading 标记扫描**（非按 index 对齐）：后端保序返回，但按标记
  替换对乱序/部分失败更鲁棒
- **失败回滚**：占位全部移除 + 错误提示可见（不留幽灵条目；服务端无残留，用户重选即可）
- **blob URL 生命周期**：上传完成/移除/发送/清空四路径全部 revoke，不漏引用
- **每轮 ≤2 图前端兜底**：takeForSend 时校验（后端 AttachmentInjectionService
  仍是硬限制真相源）；拒绝后中转区保留，用户可自行移除
- **会话切换即清空**：与草稿跨会话保留不同——附件上传有服务端落盘副作用，
  遗留状态容易误发（刻意决策）

### 4. 输入框（MessageInput.tsx）

- 回形针按钮 + 隐藏 file input（multiple + accept 白名单）
- 中转区渲染：图片缩略图（上传中用 blob 预览，完成切服务端端点）/ 文档文件卡 /
  hover 移除按钮 / 上传错误提示条
- **纯附件可发送**：携带附件时空文本允许发送（canSend 条件与纯文本互斥判定分开）
- 提示行显示已选图片计数（`已选图片 n/2`）
- 单次上传 ≤5 文件上限（按钮 disabled + 提示）

### 5. 消息渲染（MessageList.tsx AttachmentBlock）

- 消息气泡正文后渲染附件块：
  - 图片：单图 max 260px / 多图双列网格（aspect-square），点击新窗口看原图
  - document：文件卡（图标+文件名+大小），点击下载（后端 Content-Disposition:
    attachment 保证）
- 引用后端端点 `/api/attachments/:id` 而非 base64 内嵌：DTO 只带引用（id/尺寸），
  消息体积不变，immutable 缓存友好

### 6. 发送链路（index.tsx handleSend）

- `onSend` 签名扩展第三参 `attachments?: StagedAttachment[]`（ChatView 透传，
  staging hook 提升到 ChatView 层）
- 乐观 user 消息带 `atts`（上传完成的条目，剥离 localPreviewUrl/uploading 内部字段）
- `api.sendMessage` 请求体带 `attachmentIds`（后端 SendMessageRequestDTO 契约）

### 7. mappers（lib/mappers.ts）

- `LocalAttachment` 本地类型（与 AttachmentDTO 同构）
- `LocalMessage.atts?` 可选字段 + `mapMessageDTO` 透出（历史消息路径）

## 测试（28 新用例）

| 文件 | 覆盖 |
|---|---|
| lib/attachments.test.ts（12） | 白名单分类（含 SVG 排除/accept 不含 svg）/大小边界（10MB 含/超）/混合批次拆分/字节格式化 |
| hooks/useAttachmentStaging.test.ts（8） | 占位→DTO 替换/预览 URL 释放/失败回滚/白名单拒发/提取清空/≤2 图兜底（拒绝后保留）/移除/清空 |
| attachments-render.test.tsx（5） | 图片 src 指向端点/文件卡含文件名+大小/多图/混合/无附件不受影响 |

测试设施说明：hook 测试用 `vi.mock` 模块级拦截 api/client——`vi.spyOn` 拦截不到
hook 闭包内 `import * as api` 的命名空间调用（5 个通过用例恰是未走到 upload 路径
的，排查后换模块级 mock）。

## 验证

- web：31 文件 267 用例全绿（28 新增）；tsc 干净；vite build 通过
- 根仓：163 文件 1958 用例全绿（后端契约未动，零回归）；eslint 0 error

## 与后端契约的对接点（本 PR 消费不修改）

- `POST /api/conversations/:id/attachments`（上传，F20260827mmdu §3.3）
- `GET /api/attachments/:id`（image inline / document attachment 下载）
- `SendMessageRequestDTO.attachmentIds?`（发送引用）
- `MessageDTO.atts?`（历史消息透出）
