---
id: F20260828mpfe
title: 多模态 Phase 2：输入框粘贴/拖拽附件 + 飞书 ingress 收图收文件
doc_type: feature

# 记忆索引
summary: |
  多模态 Phase 2 三件套（搭档拍板范围）：①输入框粘贴/拖拽文件直达附件管线（微信式体验，
  纯文本粘贴不打断）；②飞书 image 消息 ingress——long-connection 放行 + image_key 结构化
  透传 + resource-client 下载字节 + 复用统一上传管线（校验/resize/去重免费）+ attachmentIds
  随消息入库 + 注入载荷透传 dispatch（vision 真图进当轮 LLM）；③飞书 file 消息同理
  （file_key + file_name）。四类降级路径消息不丢（未装配/下载失败/校验拒绝/上传异常→可见
  文本占位）。AgentDispatchService 扩展 injection 透传（documentBlock 拼 message、images 走
  executeChain→invokeConversation，与 Web 路径同一份注入策略）。根仓 167 文件 1991 用例 +
  web 33 文件 284 用例全绿（本特性新增 27：根仓 21 + web 6）。

# 因果链路
causal_links:
  from:
    - F20260827mmdu  # Phase 1 后端契约（上传管线/attachmentIds/注入服务）
    - F20260828mmwb  # Phase 1 Web 前端（中转区/发送链路）
  to: []

# 元数据
status: implemented   # 代码已实现（测试全绿），待对抗审视
change_type: feature
capability_test: "n/a: 纯 IO 管线（粘贴事件/飞书下载/上传复用），无 LLM 行为；vision 注入链路与 Phase 1 同构（AttachmentInjectionService 复用）；验证走 vitest（fetch 全 mock 不出网）"
tags: [multimodal, attachments, paste, drag-drop, feishu, ingress, media]
modules: [web/src/pages/conversation, src/frameworks/feishu, src/interface-adapters/feishu, src/usecases/im, src/usecases/conversation, src/bootstrap]

# 时间
created_at: 2026-08-28
created_in_conversation: 57491055-4242-493b-902c-e1626c748ed2
---

# 多模态 Phase 2：输入框粘贴/拖拽附件 + 飞书 ingress 收图收文件

Phase 1（F20260827mmdu 后端 + F20260828mmwb 前端）交付了附件的完整闭环。
Phase 2 按搭档拍板的三件补齐（caption worker 已砍：需单开 LLM 调用，搭档不要；
附件鉴权已作废：不公网部署；document 内容进记忆已作废：搭档明确不想要）。

## 1. 输入框粘贴/拖拽（web/src/pages/conversation/MessageInput.tsx）

- `handlePaste`：textarea 粘贴事件提取 `clipboardData.files` → 走 `onPickFiles`
  （即 staging hook 的 `addFiles`——校验/占位/上传/中转区渲染全复用）
- `handleDrop` + `onDragOver`（Files 类型才 preventDefault）：拖拽文件同管线
- **纯文本粘贴不打断**：`files.length === 0` 时直接 return（原生行为），截图工具
  写入剪贴板的文本 URL、复制文字等场景零影响
- 拒绝策略不在事件层预判：粘贴的 zip 等非白名单文件照样进管线，由
  `pickValidFiles` 统一给出拒绝原因（单一真相源，事件层只做提取）

体验语义：粘贴的图和点回形针选的图完全同路——占位缩略图 → 上传 → 随消息发送，
微信式「输入框里图文共存」。

## 2. 飞书 ingress 收图/收文件

### 2.1 消息类型放行（long-connection-client.ts）

- `shouldIgnoreEvent` 白名单 `text → {text, image, file}`；audio/sticker/share_chat
  等仍忽略（逐类适配等真实需求出现再做，避免写无测试的解析分支）
- `extractMediaPayload`：content JSON 解析 → `{type:"image", imageKey}` /
  `{type:"file", fileKey, fileName}`；解析失败返回 null（消息照常透传，降级在
  processor 统一做）
- bot 消息（sender_type=app）仍忽略——防自环不变

### 2.2 资源下载客户端（resource-client.ts 新文件）

- `GET /open-apis/im/v1/messages/{message_id}/resources/{key}?type=image|file`
- 失败统一 null 降级（HTTP 错误/空体/网络异常），不抛错不重试——消息文本不丢即可
- URL 组装 encodeURIComponent 全量转义（message_id/file_key 均可能含特殊字符）

### 2.3 媒体处理（message-processor.ts processMedia）

主链路：`下载字节 → Readable.from(buffer) 灌 AttachmentUploadService.upload() →
attachmentIds 随 sendMessage 入库 → AttachmentInjectionService 组装注入载荷 →
AgentDispatchService.dispatch 透传`

关键决策：
- **复用统一上传管线**：MIME 双路径校验（飞书字节同样不可信）、sharp resize 2048px、
  sha256 去重全部免费获得——飞书 ingress 不持有私有附件实现（与 Phase 1 「附件是
  后端域能力」的分层一致）
- **文件名**：飞书 image 不推原始文件名，用 `feishu-{image_key尾12}.png` 展示名
  （管线 sanitize + magic bytes 探嗅说了算，声明名仅辅助）；file 消息用飞书携带的
  file_name
- **注入策略与 Web 同源**：同一份 AttachmentInjectionService（validateForSend 把关
  ≤2 图硬限制 + buildInjectionPayload 组装），分叉只发生在入口（Web 从 DTO、
  飞书从下载字节）
- **四类降级全走可见文本**：管线未装配（旧部署）/ 下载失败（资源过期、im:resource
  权限缺失）/ 上传校验拒绝（白名单/大小）/ 注入校验拒绝——degradeNote 拼进消息体，
  用户在飞书和 Web 都能看到失败原因，消息永不丢

### 2.4 dispatch 注入透传（agent-dispatch-service.ts + agent-turn-port.ts）

- `dispatch()` 加第四参 `injection?: InjectionPayload`：
  - documentBlock 拼接在 userMessageContent 后（与 message-controller.withDocumentBlock
    同语义）
  - images 经 executeChain → invokeFn → invokeConversation → AgentInvoker 全链透传
- AgentTurnPort.invokeConversation 签名补 `images?`（接口此前漏声明，AgentInvoker
  实现已支持——飞书路径此前无图所以未暴露）

### 2.5 装配（platforms.ts + app.ts）

setupFeishu 加 repos 参数：FeishuResourceClient（tokenManager 复用飞书 bundle）+
AttachmentInjectionService（storageRoot 与 controllers.ts 同构缺省）+
attachmentUpload（uc.attachmentUpload）注入 messageProcessor。

## 3. 测试（27 新用例：根仓 21 + web 6）

| 文件 | 覆盖 |
|---|---|
| web message-input-paste.test.tsx（6） | 粘贴文件走管线/纯文本不打断/拖拽走管线/拖文本不拦截/多文件混合/非白名单照样进管线 |
| tests/frameworks/feishu/resource-client.test.ts（6） | 成功字节透传/HTTP 错误 null/空体 null/网络异常 null/空参数防御/URL 转义 |
| tests/frameworks/feishu/long-connection-client-media.test.ts（6） | image 放行+载荷/file 放行+载荷/audio、sticker 仍忽略/text 不回归/非法 content 透传无 media/bot 仍忽略 |
| tests/interface-adapters/feishu/message-processor-media.test.ts（9） | image 入库 attachmentIds/file fileName 透传/注入载荷透传 dispatch/下载失败降级/上传拒绝降级/未装配降级/超限防御降级/图文混合/纯文本不回归 |

测试设施说明：
- long-connection 测试 mock 了 @larksuiteoapi/node-sdk（WSClient/EventDispatcher），
  handler 注册发生在 start() 内——makeClient 必须 await start() 再 dispatch
  （初版漏 start 导致 4 用例假红）
- paste 测试 jsdom 无 DataTransfer 构造器，最小 stub（files/types/getData）+
  Object.defineProperty 注入 clipboardData/dataTransfer

## 4. 验证

- 根仓：167 文件 1991 用例全绿（含本特性 3 个新测试文件 21 用例；其余增量来自
  合入的 main 新 PR）
- web：33 文件 284 用例全绿（含本特性 1 个新测试文件 6 用例 paste；其余增量来自合入的 main 新 PR）
- tsc（根仓+web）/ eslint / vite build 全干净

### 审视处置记录（2026-08-28，PR #555 首轮，检视珇mimo）

- 🔴 文档测试计数失实（声称 1985，实测 1991；另有「21 新增」漏计 web 6 例、
  long-connection 表格多写 1 例）→ 全部改为实测口径：根仓 1991 / web 284 / 新增 27
  （根仓 21 + web 6），并注明其余增量来自合入的 main 新 PR
- 🟡 可选链风格不一致（message-processor.ts validateForSend/buildInjectionPayload 用 `?.` 而
  ingestThroughPipeline 用 `!`）→ 统一为非空断言：attachmentInjection 在 platforms.ts:206
  与 feishuResource/attachmentUpload 同块无条件装配，processMedia 入口早退守卫已挡未装配
  场景，走到此处服务必在，行为等价零回归（1991/284 复跑全绿）

## 5. 已知边界

- 飞书 file 下载需要 `im:resource` 权限（image 走 im:message 体系已有）——未开通时
  file 消息降级为 `[文件：下载失败…]` 提示，开通后自动恢复（无需重启）
- 飞书富文本 post 消息、合并转发等类型仍忽略（本期只做 image/file，见 2.1 决策）
- 粘贴的截图在 Windows 部分应用是 DIB 格式（剪贴板 file 名 image.png）——走管线后
  由后端 magic bytes 探嗅兜底，非 PNG 会被拒（白名单外），提示可见
