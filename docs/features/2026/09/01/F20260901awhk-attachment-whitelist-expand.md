---
id: F20260901awhk
title: '附件白名单扩展（audio/video/pdf）+ 微信语音/文件/视频入站恢复 + 飞书 IM 卡片增强'
summary: 两 issue 打包——#608 附件管线 kind 枚举扩 audio/video（PDF 落 document）、sniffType 补 WAV/MP3/MP4/PDF magic bytes、SQLite CHECK 约束迁移、微信侧恢复 voice/file/video 四类全量下载入库（SILK→WAV 转码随 silk-wasm 回归）、飞书降级提示不进 agent dispatch（PR #603 检视建议 1 同款）；#663 飞书卡片重连次数（reconnectAttempts 入 registry）+ app_id 掩码显示（完整凭证不出 frameworks 层）。全仓 2593 测试绿。
change_type: feature
capability_test: "tests/usecases/conversation/upload-validation.test.ts"
tags: [attachments, multimodal, weixin, feishu, im, media, silk, audio, channel-status]
modules: [src/usecases/conversation/upload-validation.ts, src/usecases/conversation/attachment-upload-service.ts, src/usecases/conversation/attachment-injection-service.ts, src/entities/conversation, src/frameworks/db, src/frameworks/weixin/media-client.ts, src/frameworks/weixin/silk-transcode.ts, src/interface-adapters/weixin, src/interface-adapters/feishu, src/interface-adapters/http/controllers, src/usecases/channel/channel-status.ts, src/frameworks/feishu/long-connection-client.ts, api-contract/api/message.ts, web/src]
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
from: [F20260830wxmd, F20260827mmdu, F20260901chun]
---

# 附件白名单扩展 + 微信媒体全量入站 + 飞书 IM 卡片增强（#608 + #663）

## 背景

- PR #603（F20260830wxmd）入站收敛为仅图片入库：附件管线 sniffType 白名单不收音频/视频/PDF（WAV/MP4/PDF 返回 null → 上传管线拒绝），微信语音的 SILK→WAV 转码链建好了但终点必拒。检视发现 2 的处置即为「kind 扩展独立 issue #608」
- #663（F20260901chun 检视返工建议 6）：IM 页飞书卡片缺重连次数（reconnectAttempts 已有数据源只打日志）与 app_id 掩码显示（凭证确认用）
- #608 第 4 小项：飞书 message-processor 降级提示进了 agent dispatch 上下文（微信侧同位置 PR #603 已修）

## 变更

### 1. 附件管线白名单扩展（#608 核心）

- **upload-validation.ts**：`AttachmentKind` 扩 `"audio" | "video"`（PDF 落 document）；sniffType 新增四组 magic bytes——WAV（RIFF....WAVE，与 WebP 同 RIFF 容器靠 8-11 字段子类型区分）、MP3（ID3v2 头或裸帧同步 FF Ex + version/layer 非 reserved）、MP4（ISO-BMFF `....ftyp`）、PDF（`%PDF`）；audio/video 与 document 共用 maxDocumentBytes 上限（同为直通落盘类）
- **AttachmentUploadService**：extForMime 改表驱动并扩 .wav/.mp3/.mp4/.pdf；错误消息白名单清单更新；persist 直移分支覆盖四类
- **attachment-injection-service**：`shouldSkipInjection`——audio/video/PDF 不进注入载荷（音频视频无法文本化，PDF 二进制 utf8 解码产出乱码污染上下文；占位投影已可见；待抽帧/文本提取器后启用）
- **attachment-projection.ts**：audio kind 占位 `[语音: name (size)]`
- **DB**：schema.ts 新库 CHECK 扩 `('image','document','audio','video')`；migration.ts `rebuildAttachmentsKindCheck`——存量库表重建替换窄 CHECK（SQLite 无法 ALTER CHECK，照 rebuildDocumentTablesDropCheck 模式：检测旧 CHECK 文本 → 事务内建新表搬数据 DROP+RENAME → 重建索引），幂等
- **api-contract/api/message.ts**：AttachmentDTO.kind 值域同步扩展（真相源）

### 2. 微信侧四类全量入站恢复（#608 第 2 小项）

- **silk-transcode.ts**：从 PR #603 首 commit（d0c14600）原样恢复——silk-wasm 动态 import，SILK→PCM→WAV 容器，失败返回 null
- **media-client.ts**：恢复 voice/file/video 下载分支（原样平移 d0c14600 实现）；voice 转码失败时抛错走单项降级（原始 SILK 不在白名单——与 #567 时「降级存原始字节」不同，因 sniffType 会拒，入库必失败不如显式报错）；silk-wasm@^3.7.1 依赖恢复
- **weixin/message-processor.ts**：composeMediaOutcome 去掉「仅图片」过滤——四类逐项走下载入库管线，单项失败单项降级（语音 ASR 转写文本仍在消息体不丢）

### 3. 飞书降级提示不进 agent dispatch（#608 第 4 小项）

- **feishu/message-processor.ts**：process 拆出 `dispatchText = text.trim()`（原始正文）与 bodyText（含降级提示）分离传递；persistAndFanout 签名加 dispatchText 参数，triggerAgentDispatch 用原始正文——运维文本不进 agent 上下文，与微信侧同位置同修（PR #603 检视建议 1）

### 4. 飞书 IM 卡片增强（#663）

- **channel-status.ts**：ChannelRuntimeState.error_backoff 扩可选 `reconnectAttempts`；ChannelStatusEntry 扩可选 `appIdMasked`
- **long-connection-client.ts**：onReconnecting 回调从 getConnectionStatus() 取真实 reconnectAttempts 入 registry（原只打日志）；reportStatus 每次携带 `maskAppId(config.appId)`（前 5 后 4 可见中段掩码，≤9 位超短 id 只留前 2 后 2）——完整凭证不出 frameworks 层，registry/controller/web 均只见掩码
- **channel-controller.ts**：飞书条目输出 appIdMasked
- **web/src/api/client.ts**：ChannelStatusDTO 扩 reconnectAttempts/appIdMasked
- **web/src/pages/im/index.tsx**：飞书卡片显示 `app_id: cli_a****g7h8`（mono 字体）+ error_backoff 时 `（已重连 N 次）`

### 5. Web 前端附件四类支持（#608 展示侧）

- **web/src/lib/attachments.ts**：扩展名白名单扩 .pdf（document）/ .wav .mp3（audio）/ .mp4（video）；classifyByExtension 四类判定
- **web/src/lib/mappers.ts + useAttachmentStaging**：LocalAttachment.kind 值域扩展；staging 用 classifyByExtension 判类
- **MessageList.tsx**：audio 附件渲染原生 `<audio controls>` 回放控件；document/video 走文件卡下载（此前 audio/video 两过滤器都不命中=完全不渲染，是展示黑洞）
- **attachment-controller.ts**：Content-Disposition 只对 document 强制 attachment；audio/video inline（原生控件回放；mp4/wav/mp3 不在浏览器可执行向量内，与 image inline 同理）

## 关键决策

1. **voice 转码失败改抛错（与 #567 首版不同）**：首版「降级存原始 SILK 字节」的前提是管线宽松；现在 sniffType 白名单严格，SILK 原始字节必被拒——不如显式抛错走单项降级提示，语义诚实（转写文本仍在 body，体验不瞎）
2. **audio/video/PDF 不进 LLM 注入**：音频视频无法文本化（语音转写在 body 已覆盖）；PDF 二进制 utf8 解码只产出乱码占 16KB 上下文，比不注入更糟。均待后续能力（视频抽帧后议、PDF 文本提取器）再启用，入口就在 shouldSkipInjection 一处
3. **掩码在 frameworks 层完成**：完整 appId 只到 long-connection-client 为止，registry（内存）/controller（HTTP）/web（浏览器）全程只见掩码——凭证确认（区分多套凭证）不需要完整值
4. **reconnectAttempts 挂 error_backoff state 而非顶层**：它是错误的属性（连续重连中才存在，恢复后随 error_backoff → running 的 state 整体替换自然消失——不是显式归零），与 nextRetryAt 同级；不污染 running 态
5. **表重建迁移而非跳过 CHECK**：SQLite 无法修改已有约束；存量库中 attachments 有数据（图片已入库），必须保数据搬迁。幂等靠检测旧 CHECK 文本——新库天然宽约束直接返回

## 验证

- 全仓 vitest **2593 passed**（新增 35：upload-validation 9 + migration 4 + weixin processor 5 + media-client 8 + feishu processor 1 + registry/mask 6 + attachment-upload 3 + web attachments 2 - 收敛调整）；重跑 3 次确认无 flaky（首次运行曾有 1 例与文件无关的 flaky，两次复跑均 2593 全绿）
- 根仓 tsc --noEmit 0 错误；web tsc --noEmit 0 错误；eslint 0 error（5 个存量 warning 在本次未触碰文件）
- silk-wasm 真编解码往返验证（encode 200ms PCM → decode 还原 RIFF/WAVE 头）
- fetch 全 mock 不出网
- **真机验收（合入后需搭档配合）**：微信发语音 → web 对话页可播放 + 转写文本在消息体；微信发 PDF 文件 → web 可下载；飞书卡片显示掩码 app_id；断网时飞书卡片显示重连次数

## 最简实现检查

已过：sniffType 四组 magic bytes 各一函数（与既有 isPng 同模式，无新抽象）；silk-transcode 从历史 commit 原样恢复零改动；迁移函数一个（复用既有表重建模式）；#663 后端三字段（state.reconnectAttempts/appIdMasked/maskAppId 函数）+ 前端两行展示；web 端 audio 用原生 `<audio>` 控件不引入播放器库；无新增重依赖（silk-wasm 为 #567 已用过的恢复性依赖）。

## 后续

- 视频抽帧注入（issue #608 标注「后议」）
- PDF 文本提取器（启用 PDF 的 LLM 注入，入口已留 shouldSkipInjection）
- 飞书语音/视频入站（飞书侧 media payload 目前只有 image/file，音视频类型待飞书侧协议扩展）
- voice 转码失败时不区分 silk-wasm 基础设施异常与单条数据异常（检视建议 2，降级提示同为「接收失败」——功能正确，运维区分需后续在 silkToWav 分层错误）

## 回修记录（对抗审视后，检视獭-683 报告 1 严重 + 5 建议）

- **严重 1 修复**：`rebuildAttachmentsKindCheck` 的 DROP+RENAME 重建改入 `db.transaction()` 包裹（与注释声明和 rebuildDocumentTablesDropCheck 同模式）；新增「迁移中途失败整体回滚」测试（预置同名表迫使 CREATE 失败，断言老表无损 + 可重入）
- **建议 3 修复**：sniffType 补 RIFF 子类型互斥注释（WebP/WAV 同容器靠 8-11 字节区分，新增 RIFF 格式注意插入位置）
- **建议 4 修复**：MessageList `others` 更名 `documentsAndVideos`（显式语义，未来 video 特殊渲染时拆出）
- **建议 5 修复**：特性文档措辞「恢复归零」→「随 error_backoff → running 的 state 整体替换自然消失」
- **建议 2、6 不改**：建议 2（silk 基础设施 vs 数据异常不区分）与建议 6（guide 誊抄）均检视方自判非阻断，已入后续跟踪，不在本 PR 强行分层
- rebase：开发期间 main 推进至 d63e8e8d（#678 信号铺轨，migration.ts 尾部撞车），冲突已解（两迁移调用均保留）
- 回修后验证：全仓 vitest **2632 passed**（含事务性新用例，基数随 #678 新增测试增长）；server/web tsc 零错误；eslint 0 error
