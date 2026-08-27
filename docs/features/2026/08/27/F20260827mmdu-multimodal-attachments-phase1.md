---
id: F20260827mmdu
title: multimodal-attachments-phase1
doc_type: feature

# 记忆索引
summary: |
  多模态附件支持 Phase 1（方案 v0.5 全文实现 + 对抗审视修复轮）：两表（sha256+uploader 去重）；
  上传管线（MIME 双路径校验排除 SVG/流式计数/sharp resize 2048px）；上传/下载 API（nosniff+
  会话存在性校验+竞态修复）；投影纯函数统一五出口（FTS/记忆/未读/DTO/egress，egress 附件块
  truncate 前注入且预留截断预算）；vision 注入（usecases 层策略：真图+document 提取 16KB 截断，
  ≤2 图硬限制，retry 带原附件）；FTS 写入时序修复；models[] 可选 input。41 文件 +2600/-310，
  153 测试文件 1814 用例全绿。

# 因果链路
causal_links:
  from: []
  to: []

# 元数据
status: implemented   # 代码已实现（测试全绿），首轮对抗审视 6 严重/7 建议已处置，待 delta 复核
change_type: feature
capability_test: "n/a: 数据层+管线+投影为主，vision 端到端已由方案 §八 前置实测（GLM flash 真图识别通过）；本层验证走 vitest 单测（含 HTTP 层集成测试）"
tags: [multimodal, attachments, vision, api, projection, egress]
modules: [src/frameworks/db, src/usecases/conversation, src/entities/conversation, src/interface-adapters/http, src/frameworks/agent, src/frameworks/llm, api-contract, README.md]

# 时间
created_at: 2026-08-27
created_in_conversation: 57491055-4242-493b-902c-e1626c748ed2
---

# 多模态附件支持 Phase 1：数据层 + 上传 API + 投影层 + vision 注入

> 方案 v0.5 定稿（两轮异体审视 kimi 7 条 + mimo 8 条全部接受）全文实现，处置记录见方案 §九。
> 首轮交付后经对抗审视（6 严重/7 建议），修复轮处置记录见文末「审视修复轮」。
> 本文档记录实现落地情况；设计依据以方案为准（工作区 multimodal-upgrade-draft.md）。

## 背景与目标

glm-5.3-flash 支持多模态，系统数据层需支持图片/文件附件。多前端（web/飞书）统一后端：
附件是后端域能力，任何前端不持有私有附件实现（方案 §3.0 原则）。

Phase 1 交付：表 + 上传 API + 当前任务 vision 注入（SDK 降级兜底）+ 未读注入文本投影 +
config input 字段 + 飞书 egress 附件占位投影（跨通道不丢）。caption 缺席时降级文件名占位。

**范围口径（大獭拍板）**：Phase 1 完成以两个 PR 都合入为准——后端 PR（本 PR）+ Web 前端
PR（紧随，上传交互/附件渲染，后端契约已就绪）。Web 前端不在本 PR 不是「方案外缩水」，
是显式拆分决策。

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
  await 而非 fire-and-forget——返回时附件必须已挂上，防广播竞态；降级路径 warn 留痕非静默吞错）
- ② send 内存构造：`send-message.persistUserMessage` 的 `...(attachmentRefs && { attachments })`
- ③ 发送时入库关联：`send-message` 调 `linkMessageAttachments`（按请求序，去重防御）——
  **在 appendSegment 之前执行**（审视修复 R3：appendSegment 内 refreshMessageFts JOIN
  message_attachments 组装附件投影，先写关联才能保证附件占位进 FTS 索引）

### 2. config

- `config.yaml.example`：attachments 节（storageRoot/maxImageBytes/maxDocumentBytes）+ models[] input 示例
- `README.md`：「模型输入能力声明」节——合入后运营项（非 vision 模型必须声明 `input: ["text"]`，
  否则 anthropic 模板隐式继承 ["text","image"] 导致图片注入到看不见图的模型产生幻觉——实测坐实）
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
  单次 ≤5 文件，逐文件走管线，部分失败聚合 errors 返回（全部失败 400）；
  **会话存在性校验 404**（审视修复 R10：API 形态的会话隔离语义）；**竞态修复**（审视修复 R2：
  file handler 内收集 upload promise，busboy close 后 `Promise.all` 全部 in-flight 再返回——
  旧实现响应几乎必然返回空 attachments，主链路断）
- `GET /api/attachments/:id`：文件流——`X-Content-Type-Options: nosniff` 全局；document 强制
  `Content-Disposition: attachment`（清洗后文件名 filename*=UTF-8''）；image inline；immutable 缓存头
- `SendMessageRequestDTO.attachmentIds?: string[]`（可选向后兼容）；`MessageDTO.atts?: AttachmentDTO[]`
- 访问控制假设（方案 §3.2 显式声明）：Phase 1 不做独立鉴权，依赖网络隔离 + UUIDv4 不可猜 +
  直链不脱离 Web 同源；公网部署前必须补（Phase 2）

### 5. 投影层（方案 §3.5）

- `src/entities/conversation/attachment-projection.ts`：`projectAttachments(atts)` 纯函数——
  `[图片: caption|文件名]` / `[文件: name (size)]`，caption 空白串降级文件名
- 出口统一调用（禁止各出口自写占位，html-card 投影漂移教训）：
  - FTS 索引：`sqlite-conversation-repository.appendAttachmentProjection`（同步 JOIN，事务内安全；
    写入时序见组装点③）
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

- **策略归位 usecases 层**（审视修复 R4/R7）：`src/usecases/conversation/attachment-injection-service.ts`
  ——AttachmentInjectionService 承载：validateForSend（存在性 + ≤2 图硬限制）/
  buildInjectionPayload（image 读盘 base64 + document 提取文本）/ validateAndBuild（一次 getByIds
  完成校验+组装）。message-controller 只透传调用，不再自判
- document 注入（方案 §3.4① 本轮补齐）：plain-text extractor（白名单 MIME 均纯文本类，utf8 直解码）
  + 16KB/文件截断（UTF-8 字节级不切断多字节字符），拼进当前任务消息：`[文件: name]\n<内容>`
- 透传链：message-controller（validateAndBuild）→ dispatch-chain-engine.executeChain({ images }) →
  InvokeFnParams.images → agent-invoker → `sdk-invoke-port.InvokeOptions.images` →
  `pi-session-factory` `session.prompt(fullMessage, { images })`
- 未读历史统一文本投影（②处），不按目标獭分叉；分叉只发生在当前任务真图
- **每轮 ≤2 图服务端硬限制**（AttachmentInjectionService.validateForSend：image 数超 2 返回错误
  消息，controller 映射 400）——依据：SDK estImageChars 按图 1200 tokens 估算，实测 GLM 2048px 图
  ≈5500 input tokens（差 4.6 倍）
- **retry 路径带原附件**（审视修复 R9）：手动重试从原 user 消息 attachments 重新组装注入载荷——
  self-restart/换 session 后当前任务图不缺席
- 读盘 async（fs/promises，审视修复 R12）；读盘失败降级纯文本（占位投影仍在，warn 留痕）
- vision 降级靠 SDK `downgradeUnsupportedImages`（transform-messages.js:19，按 Model.input 判定），
  otter 层不自判——config.yaml 的 models[].input 是判定的唯一真相源

### 8. 测试

- `tests/entities/conversation/attachment-projection.test.ts`：纯函数 11 用例
- `tests/usecases/conversation/upload-validation.test.ts`：MIME 双路径 21 用例
- `tests/usecases/conversation/attachment-upload.test.ts`：管线集成 13 用例（真 sqlite + 真文件系统 +
  真 sharp：resize/sha256 去重/超限中止/文档直落盘/清洗/repository CRUD/FK CASCADE）
- `tests/entities/conversation/attachment-egress.test.ts`：egress 投影顺序 10 用例 + DTO 扩展 3 用例
  （核心验收：30000 字节正文截断后附件占位仍存活；链接形态=对话页链接非直链）
- `tests/interface-adapters/http/attachment-api.test.ts`：**HTTP 层集成 12 用例**（审视修复 R13 补齐；
  真 Hono app + 真 busboy + 真 sharp + 真 sqlite）：竞态回归（响应含附件 ID）/batch 上传/
  Content-Type 拒绝/会话 404/GET 响应头（nosniff+attachment+immutable）/404/≤2 图拒绝 400/
  真图注入 dispatch 链（base64 ImageContent 断言）/document 注入内容断言/**FTS 时序**
  （带附件消息落库后 messages_fts.body 含附件占位——直接查 FTS 表断言）

全量：153 测试文件 1814 用例全绿（首轮 1802 + 修复轮新增 12）；eslint 0 error；tsc 干净。

## 关键实现决策（与方案对齐处）

| 决策 | 落点 |
|---|---|
| sha256 按落盘（压缩后）字节 | persist() 中 resize 后 buffer 求哈希再写文件 |
| 附件与消息解耦（先传后发） | 上传 API 独立于消息；attachmentIds 是唯一入消息接口（通道无关） |
| 策略在 usecases / 机制在 frameworks | AttachmentInjectionService 承载全部附件注入策略；pi-session-factory 只透传 |
| 禁止各出口自写占位 | 五个出口全部 import projectAttachments |
| Message 实体可选 attachments | 广播链路走 entities 不经 DTO（message-broadcaster.ts:94） |
| ID 用 crypto.randomUUID() | UUIDv4 122bit（与系统既有 id 机制一致） |

## 与方案的偏差说明

无结构性偏差。实现细节的自主决策：
1. **附件块截断预算预留**：方案要求「附件投影在 truncate 之前注入」，朴素实现（拼接后整体截断）
   在超长正文时附件块作为尾部段落仍会被段落预算裁掉——实现为「附件块预留字节 + 正文按剩余预算截断」，
   严格满足「附件在截断后仍在」的验收目标（测试覆盖）。
2. **≤2 图限制的执行位置**：首轮放在 message-controller 入口；审视修复 R4/R7 后归位 usecases 层
   （AttachmentInjectionService），controller 只映射 400。

## 审视修复轮（首轮对抗审视 6 严重/7 建议的处置）

| # | 发现 | 处置 |
|---|---|---|
| 严重1 | CI 未运行（PR 0 run） | 排查：同期其他 PR 正常，pull_request 事件未触发（一次性抖动可能性大）；本修复 push 后验证 |
| 严重2 | 上传端点竞态（close 不等 upload promise → 空响应） | ✅ inFlight 数组收集 promise，close 后 Promise.all；HTTP 集成测试回归（响应含附件 ID） |
| 严重3 | FTS 出口时序断（appendSegment 先于 link） | ✅ link 提前到 appendSegment 之前（组装点③内）；FTS 时序测试（直接查 messages_fts 断言附件占位） |
| 严重4 | document 注入缺失 + 文档伪称方案非目标 | ✅ 实现 plain-text extractor + 16KB 截断（方案 §3.4①）；文档如本文档修正 |
| 严重5 | Web 前端零改动 + 文档不实理由 | ✅ 大獭拍板拆分：Web 前端紧随第二 PR，Phase 1 完成以两 PR 都合入为准（文档如实声明） |
| 严重6 | 文档数字失实（25 文件 vs 37） | ✅ 本文档按实际重写（41 文件 +2600/-310，含修复轮） |
| 建议7 | 策略落 controller 违反分层 | ✅ AttachmentInjectionService 上移 usecases（见 §7） |
| 建议8 | 吞错 catch | ✅ repository 两处降级路径改 logger.warn 留痕（SqliteConversationRepository 构造器加可选 logger） |
| 建议9 | retry 丢图 | ✅ loadRetryInjection 从原 user 消息 attachments 重载（见 §7） |
| 建议10 | 附件不绑会话 | ✅ 轻量路径：上传时校验会话存在（404）；attachments 表仍为全局命名空间（Phase 2 鉴权时一并处理归属） |
| 建议11 | 运营项未写入文档 | ✅ README.md「模型输入能力声明」节 + 本文档 §2 |
| 建议12 | 同步读盘 | ✅ fs/promises readFile |
| 建议13 | HTTP 层零测试 | ✅ tests/interface-adapters/http/attachment-api.test.ts 12 用例（含竞态回归——正是发现 2 的盲区） |

## 已知边界（Phase 2 演进项，方案已声明）

- caption worker（图片语义摘要）未实现——未读注入/投影降级文件名占位，路径已覆盖
- document 提取文本**进记忆索引**未实现（方案 §3.6：Phase 2 与 caption worker 一并纳入；注入 LLM 本期已交付）
- 附件端点正式鉴权/签名 URL——公网部署前必须补（三重前提见 §4）
- 飞书 ingress 收图转存（image_key → 统一管线）——蓝图见方案 §3.8，依赖的 SendMessage attachmentIds
  契约本期已交付
- Web 前端上传交互/渲染（§3.7）——紧随的第二 PR 承载（后端契约 atts 字段 + 上传端点已就绪）

## 影响范围

41 文件 +2600/-310（两轮合计）。新增源文件：attachment.ts / attachment-projection.ts /
attachment-repository.ts / sqlite-attachment-repository.ts / upload-validation.ts /
attachment-upload-service.ts / attachment-injection-service.ts / attachment-controller.ts +
5 测试文件。依赖新增：sharp（升为直接依赖）、busboy（multipart 流式解析）。
