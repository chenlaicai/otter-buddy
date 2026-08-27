---
id: F20260827mmdu
title: multimodal-attachments-phase1
doc_type: feature

# 记忆索引
summary: |
  多模态附件支持 Phase 1（方案 v0.5 定稿全文实现）：attachments+message_attachments 两表（sha256+uploader
  去重）；上传管线 MIME 双路径校验（图片 magic bytes/文档扩展名+NUL 探嗅，排除 SVG）+流式计数+
  sharp resize 2048px；上传/下载 API（nosniff+document 强制 attachment）；projectAttachments 投影纯函数
  统一五出口（FTS/记忆/未读注入/DTO/egress）；egress 附件块在 truncate 前注入且预留截断预算（跨通道
  不丢）；vision 注入链路透传至 prompt(text,{images})，每轮 ≤2 图硬限制，降级靠 SDK；models[] 可选
  input 字段。25 文件 +669/-129，152 测试文件 1802 用例全绿。

# 因果链路
causal_links:
  from: []
  to: []

# 元数据
status: implemented   # 代码已实现（测试全绿），待对抗审视
change_type: feature
capability_test: "n/a: 数据层+管线+投影为主，vision 端到端已由方案 §八 前置实测（GLM flash 真图识别通过）；本层验证走 vitest 单测"
tags: [multimodal, attachments, vision, api, projection, egress]
modules: [src/frameworks/db, src/usecases/conversation, src/entities/conversation, src/interface-adapters/http, src/frameworks/agent, src/frameworks/llm, api-contract]

# 时间
created_at: 2026-08-27
created_in_conversation: 57491055-4242-493b-902c-e1626c748ed2
---

# 多模态附件支持 Phase 1：数据层 + 上传 API + 投影层 + vision 注入

> 方案 v0.5 定稿（两轮异体审视 kimi 7 条 + mimo 8 条全部接受）全文实现，处置记录见方案 §九。
> 本文档记录实现落地情况；设计依据以方案为准（工作区 multimodal-upgrade-draft.md）。

## 背景与目标

glm-5.3-flash 支持多模态，系统数据层需支持图片/文件附件。多前端（web/飞书）统一后端：
附件是后端域能力，任何前端不持有私有附件实现（方案 §3.0 原则）。

Phase 1 交付：表 + 上传 API + 当前任务 vision 注入（SDK 降级兜底）+ 未读注入文本投影 +
config input 字段 + 飞书 egress 附件占位投影（跨通道不丢）。caption 缺席时降级文件名占位。

## 实现清单（按依赖序）

### 1. 数据层

- `src/frameworks/db/schema.ts`：`createAttachmentTables`——attachments + message_attachments 两表
  （结构与消费方声明按方案 §3.1；caption Phase 2 worker 回填，上线前恒 NULL）
- `src/frameworks/db/migration.ts`：`ensureAttachmentTables`——老库升级路径补建（CREATE IF NOT EXISTS 幂等）
- `src/entities/conversation/attachment.ts`：Attachment / AttachmentRef / MessageAttachmentLink 实体
- `src/entities/conversation/message.ts`：Message 加可选 `attachments?: AttachmentRef[]`（声明可选，
  测试 fixture 不受编译波及——方案 R2 轮 kimi Y3）

**组装点三处回填**（方案 §3.1 实体扩展段）：
- ① repository 加载：`sqlite-conversation-repository.attachAttachments`（JOIN message_attachments，
  await 而非 fire-and-forget——返回时附件必须已挂上，防广播竞态）
- ② send 内存构造：`send-message.persistUserMessage` 的 `...(attachmentRefs && { attachments })`
- ③ 发送时入库关联：`send-message` 调 `linkMessageAttachments`（按请求序，去重防御）

### 2. config

- `config.yaml.example`：attachments 节（storageRoot/maxImageBytes/maxDocumentBytes）+ models[] input 示例
- `src/frameworks/config-service.ts`：AppConfig.attachments（缺省 ./data/attachments、10MB、20MB）+
  ModelConfig.input 透传
- `src/frameworks/llm/models-factory.ts`：两处修改——CustomProviderOptions 加 `input?: ("text"|"image")[]`；
  注入模型时 `input: options.input ?? template.input`（config 显式声明优先，消除 anthropic 模板隐式继承）

### 3. 上传管线（方案 §3.2 全部细节）

- `src/usecases/conversation/upload-validation.ts`：纯函数——sniffType（图片 magic bytes：PNG/JPEG/GIF/
  WebP RIFF；文档扩展名白名单 + NUL 探嗅）、sanitizeOriginalName（basename + `[^\w.\-\u4e00-\u9fa5]`
  清洗 + 190 截断 + file 兜底）、sizeLimitFor
- `src/usecases/conversation/attachment-upload-service.ts`：流式落临时文件（计数 + 上限中止，不全量读内存）
  → 探嗅头部 64KB → 双路径校验 → 按 kind 精确大小校验 → 落盘（图片 sharp resize 2048px inside 不放大；
  文档直移）→ sha256 按落盘后最终字节 → 查重命中返回已有行 → 落库（撞唯一索引竞态也返回已有行）
- 白名单排除 SVG（XSS 向量）；客户端 Content-Type 不可信，内容说了算（假声明 .txt 里塞 PNG 按 image 落库）

### 4. HTTP API

- `POST /api/conversations/:id/attachments`：multipart 流式解析（busboy），Content-Type/Length 预检，
  单次 ≤5 文件，逐文件走管线，部分失败聚合 errors 返回（全部失败 400）
- `GET /api/attachments/:id`：文件流——`X-Content-Type-Options: nosniff` 全局；document 强制
  `Content-Disposition: attachment`（清洗后文件名 filename*=UTF-8''）；image inline；immutable 缓存头
- `SendMessageRequestDTO.attachmentIds?: string[]`（可选向后兼容）；`MessageDTO.atts?: AttachmentDTO[]`
- 访问控制假设（方案 §3.2 显式声明）：Phase 1 不做独立鉴权，依赖网络隔离 + UUIDv4 不可猜 +
  直链不脱离 Web 同源；公网部署前必须补（Phase 2）

### 5. 投影层（方案 §3.5）

- `src/entities/conversation/attachment-projection.ts`：`projectAttachments(atts)` 纯函数——
  `[图片: caption|文件名]` / `[文件: name (size)]`，caption 空白串降级文件名
- 出口统一调用（禁止各出口自写占位，html-card 投影漂移教训）：
  - FTS 索引：`sqlite-conversation-repository.appendAttachmentProjection`（同步 JOIN，事务内安全）
  - 记忆索引：`send-message.buildIndexBody`（剥离投影 + 附件占位）
  - 未读注入：`dispatch-chain-engine.appendUnreadAttachmentLine`（统一文本投影，不按獭分叉）
  - list_messages/get_message：DTO 组装经 repository 回填 → `toMessageDTO.attachmentsField`
  - egress 广播通道：feishu-message-channel 传 `attachments: message.attachments`

### 6. egress 投影（顺序写死）

- `projectForChannel(body, { attachments })` 签名扩展；附件块在 `truncateByBytes` **之前**注入
- **截断预算权收投影层**：附件块预留字节从 maxBytes 扣除，正文按剩余预算截断，附件块强制存活
  （30000 字节正文 + 附件 → 附件在截断输出中仍存在的测试验收）
- 链接形态 = 对话页链接（复用 html-card 占位符机制）：附件 ID 不进 IM 侧（测试断言投影中无附件 ID
  与 /api/attachments/ 直链）；webBaseUrl 缺失降级无链接纯文本（不拼 undefined）

### 7. vision 注入（方案 §3.4）

- 组装策略在 controller（`loadImagesForDispatch`：读盘 base64 → ImageContent，读盘失败降级纯文本）
- 透传链：dispatch-chain-engine.executeChain({ images }) → InvokeFnParams.images → agent-invoker →
  `sdk-invoke-port.InvokeOptions.images` → `pi-session-factory` `session.prompt(fullMessage, { images })`
- 未读历史统一文本投影（②处），不按目标獭分叉；分叉只发生在当前任务真图
- **每轮 ≤2 图服务端硬限制**（message-controller validateAttachmentIds：image 数超 2 返回 400）
  ——依据：SDK estImageChars 按图 1200 tokens 估算，实测 GLM 2048px 图 ≈5500 input tokens（差 4.6 倍）
- vision 降级靠 SDK `downgradeUnsupportedImages`（transform-messages.js:19，按 Model.input 判定），
  otter 层不自判——config.yaml 的 models[].input 是判定的唯一真相源

### 8. 测试

- `tests/entities/conversation/attachment-projection.test.ts`：纯函数 11 用例（caption 优先/降级、
  size 人类可读、多行拼接、undefined 安全、中文名）
- `tests/usecases/conversation/upload-validation.test.ts`：MIME 双路径 21 用例（四种图片 magic bytes、
  假声明防御、扩展名白名单、NUL 探嗅、SVG/exe 拒绝、路径穿越清洗、控制字符清洗、长度截断）
- `tests/usecases/conversation/attachment-upload.test.ts`：管线集成 13 用例（真 sqlite + 真文件系统 +
  真 sharp：resize 3000px→≤2048、sha256 去重（同 uploader 去重/跨 uploader 不去重）、超限中止无残留、
  文档直落盘、original_name 清洗、repository CRUD、FK CASCADE）
- `tests/entities/conversation/attachment-egress.test.ts`：egress 投影顺序 10 用例 + DTO 扩展 3 用例
  （**核心验收：30000 字节正文截断后附件占位仍存活**；链接形态=对话页链接非直链；webBaseUrl 缺失降级；
  多附件共享单链接；无附件行为与旧版逐字节一致；atts 字段向后兼容）

全量：152 测试文件 1802 用例全绿（既有 1747 + 新增 55）；eslint 0 error；tsc 干净。

## 关键实现决策（与方案对齐处）

| 决策 | 落点 |
|---|---|
| sha256 按落盘（压缩后）字节 | persist() 中 resize 后 buffer 求哈希再写文件 |
| 附件与消息解耦（先传后发） | 上传 API 独立于消息；attachmentIds 是唯一入消息接口（通道无关） |
| 策略在 usecases / 机制在 frameworks | 组装在 controller+dispatch-chain；pi-session-factory 只透传 |
| 禁止各出口自写占位 | 五个出口全部 import projectAttachments |
| Message 实体可选 attachments | 广播链路走 entities 不经 DTO（message-broadcaster.ts:94） |
| ID 用 crypto.randomUUID() | UUIDv4 122bit（与系统既有 id 机制一致） |

## 与方案的偏差说明

无结构性偏差。两处实现细节的自主决策：
1. **附件块截断预算预留**：方案要求「附件投影在 truncate 之前注入」，朴素实现（拼接后整体截断）
   在超长正文时附件块作为尾部段落仍会被段落预算裁掉——实现为「附件块预留字节 + 正文按剩余预算截断」，
   严格满足「附件在截断后仍在」的验收目标（测试覆盖）。
2. **每轮 ≤2 图的执行位置**：方案说「服务端硬限制（超出拒绝）」，实现在 message-controller
   sendMessage 入口校验（唯一带 attachmentIds 的 HTTP 入口），dispatch-chain 层不再重复判
   （controller 拒绝后请求根本进不了链）。

## 已知边界（Phase 2 演进项）

- caption worker（图片语义摘要）未实现——未读注入/投影降级文件名占位，路径已覆盖
- document 提取文本注入 LLM 未实现（方案 §3.4① document 分支属 Phase 1 非目标的显式声明：提取进索引 Phase 2 纳入）
- 附件端点正式鉴权/签名 URL——公网部署前必须补（三重前提见 §4）
- 飞书 ingress 收图转存（image_key → 统一管线）——蓝图见方案 §3.8，依赖的 SendMessage 契约扩展（attachmentIds）本期已交付
- Web 前端上传交互/渲染（§3.7）——属前端仓库范畴，后端契约（atts 字段 + 上传端点）已就绪

## 影响范围

25 文件 +669/-129；新增：attachment.ts / attachment-projection.ts / attachment-repository.ts /
sqlite-attachment-repository.ts / upload-validation.ts / attachment-upload-service.ts /
attachment-controller.ts + 4 测试文件。依赖新增：sharp（升为直接依赖）、busboy（multipart 流式解析）。
