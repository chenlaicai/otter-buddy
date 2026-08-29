---
id: F20260829fpst
title: 飞书 post 富文本混排消息 ingress
doc_type: feature

# 记忆索引
summary: |
  飞书 post 富文本混排消息 ingress（多模态收尾件，系统侧零改动）：白名单加 post 类型；
  content JSON 段落解析——text 段拼正文（段内连写、段落间空行，a/at 文字并入）、
  img 段（image_key）与 media 段（file_key+file_name）按段落顺序收集为 postItems；
  processor 的 processMedia 泛化为多附件循环——逐项下载（resource-client）、逐项走
  统一上传管线（校验/resize/去重复用）、单项失败单项降级（key 尾串区分）、全部入库后
  一次性 validateForSend（≤2 图硬限制，与 Web 同策略）。纯文本 post 不带 media 载荷
  走原文本路径（命令 gate 零改动）。语言体定位取首个可用语言体（新旧事件兼容）。
  根仓 171 文件 2034 用例 + web 33 文件 287 用例全绿（本特性新增 17：根仓
  frameworks 8 + processor 9；其余增量来自合入的 main 新 PR）。

# 因果链路
causal_links:
  from:
    - F20260827mmdu   # Phase 1 后端契约（上传管线/attachmentIds/注入服务）
    - F20260828mpfe   # Phase 2 飞书 image/file ingress（本特性在其白名单与管线结构上扩展 post）
  to: []

# 元数据
status: implemented   # 代码已实现（测试全绿），待对抗审视
change_type: feature
capability_test: "n/a: 纯解析/IO 管线（post 段落解析、多媒体下载循环），无 LLM 行为；注入链路复用 Phase 1 AttachmentInjectionService；验证走 vitest（SDK mock 不出网）"
tags: [feishu, post, rich-text, ingress, multimodal, attachments, media]
modules: [src/frameworks/feishu, src/interface-adapters/feishu, src/usecases/im]

# 时间
created_at: 2026-08-29
created_in_conversation: 57491055-4242-493b-902c-e1626c748ed2

---

# 飞书 post 富文本混排消息 ingress

## 1. 背景与需求

Phase 2 交付 image/file 两种单类型消息后，飞书侧剩最后一种常用形态：**post 富文本
混排消息**（一条消息里文字与图片/文件交错）。用户直接发图/发文件已可用，但「文字+图
混着发」仍被 `shouldIgnoreEvent` 白名单拦在门外。

前置核实（大獭，2026-08-28）：系统侧零改动——消息模型本就图文一体（SendMessage
同时收 body + attachmentIds，Web 端图文混排每天在用），processor 已是「媒体走附件
管线 → 文字+attachmentIds 一起入库」结构，全部工作在飞书接入层。

## 2. 方案设计

### 2.1 post 消息结构（飞书事件 content 字段）

```
{
  "content": {
    "zh_cn": {                       // 语言体（新版事件推 zh_cn/en 双语体）
      "title": "标题（不入正文）",
      "content": [                   // 段落数组（title 与正文段是两级，注意）
        [ {tag:"text", text:"段内文字"}, {tag:"a", text:"链接文字", href:...} ],
        [ {tag:"img", image_key:"img_v2_xxx"} ],
        [ {tag:"media", file_key:"file_v3_xxx", file_name:"需求清单.docx"} ],
        [ {tag:"at", user_id:"ou_xxx"} ]      // @ 提及，无媒体语义
      ]
    }
  }
}
```

### 2.2 frameworks 层（long-connection-client.ts）

- **白名单**：`SUPPORTED_MESSAGE_TYPES` 加 `post`
- **正文提取**（extractPostText）：text 段文字拼接——段内连写、段落间 `\n\n`；
  a 超链接段输出 Markdown 链接 `[文字](href)`（审视处置采纳：Web Markdown 流
  自动渲染可点击，LLM 可见 URL；href 缺失或含空白时降级只保文字，不丢内容）
- **媒体项收集**（extractPostMediaItems）：img 段 → `{kind:"image", key:image_key}`；
  media 段 → `{kind:"file", key:file_key, fileName}`；按段落顺序进 `postItems`；
  段缺失 key 跳过该段不整条丢弃
- **语言体定位**（locatePostBody）：`content.content.{lang}` 每个语言体是
  `{title, content:段落数组}`，取第一个可用语言体的段落数组（新旧版事件兼容：
  旧版推 zh_cn 单语体、新版推 zh_cn/en 双语体）
- **纯文本 post**：无媒体段时**不带 media 载荷**——下游按普通文本消息处理，
  `/命令` gate（processor 以 `!msg.media` 判断）零改动
- **title 不入正文**：飞书 post 的 title 在消息列表已展示，进正文会重复
- **media 载荷形态**（FeishuMediaPayload）扩展：`type:"post"` + `postItems[]`
  （usecases 层 gateway 接口同步，image/file 单类型形态不变）

### 2.3 processor 层（message-processor.ts）

`processMedia` 泛化为**多附件循环**（原单媒体路径是循环长度=1 的特例）：

```
mediaItems(media) → [{kind, key, fileName?}, ...]     // image/file 单项；post 为列表
for item:
  download → null?   → degradeNotes.push("[图片 key尾串：下载失败…]")，continue
  ingest  → throw?   → degradeNotes.push("[文件 key尾串：附件接收失败：原因]")，continue
  ids.push(att.id)
ids 非空 → 一次性 validateForSend(ids)（≤2 图硬限制，与 Web 同一份策略）
         → buildInjectionPayload(ids) → dispatch 透传（vision 真图）
```

关键语义：
- **单项失败单项降级**：一张图下载失败只降级那一张，其余媒体项与正文照常入库
  （比 Phase 2 单媒体消息的「整条降级」粒度更细——post 天然多媒体，不能一颗老鼠
  屎坏一锅粥）；降级提示带 key 尾串，多条提示可区分是哪个媒体项失败
- **validate 时机在全部入库后**：飞书 post 可含多图，超限（>2 图）时整组拒绝附件、
  正文与降级提示保留——拒绝语义与 Web 一致（Web 是上传后发送前拒，这里是下载入库
  后发送前拒，同一道闸）
- **注入载荷**：与 Web 路径同一份 AttachmentInjectionService 组装（真图 base64 进
  当轮 LLM；document 文本块拼 message）
- **全降级兜底**：composeBodyText 已有占位逻辑不变（无附件无正文时「[媒体消息
  处理失败]」）

### 2.4 不改的东西（系统侧零改动的证据）

- Message 模型 / SendMessage / attachmentIds 契约 / Web 渲染：不动
- 命令 gate（`text.startsWith("/") && !msg.media`）：纯文本 post 无 media 载荷，
  gate 行为自动正确
- 防自环：sender_type=app 拦截 + source=feishu 不回传，post 类型不改变任何一侧
- 上传管线 / MIME magic bytes 探嗅 / sha256 去重 / sharp resize：逐项复用

## 3. 测试（18 新用例）

| 文件 | 覆盖 |
|---|---|
| tests/frameworks/feishu/long-connection-client-post.test.ts（9） | 图文混排正文拼接+a段输出Markdown链接+img按序/a段边界href缺失/空串/含空白降级只保文字/纯文本post无media/媒体段file_key+file_name/语言体缺失取首个/非法content不炸空text无media/段内img+text交错顺序/text·image·file单类型不回归 |
| tests/interface-adapters/feishu/message-processor-post.test.ts（9） | 图+文件有序入库/三项混排一次性validate/单项下载失败其余照常/单项上传拒绝其余继续/注入透传dispatch/纯文本post原路径无attachmentIds/全降级多条提示拼接不丢消息/validate拒绝正文保留/未装配按类别合并降级 |

既有测试不回归：飞书侧 8 文件 62 用例全绿（含 Phase 2 的 media/processor 19 用例）。

## 4. 验证

- 根仓：171 文件 2035 用例全绿（含本特性 2 个新测试文件 18 用例；其余增量
  来自合入的 main 新 PR，如 #554/#556/#559/#561/#562）
- web：33 文件 287 用例全绿（本特性 web 零改动；增量 3 来自 main）
- tsc（根仓+web）零错 / eslint 零新告警（剩 3 个 warning 为 main 存量
  web/index.tsx react-hooks，非本次引入）/ 根仓 vite build 同 lint 通过

## 5. 已知边界

- post 的 title 字段不入正文（消息列表已展示，避免重复）
- a 段 Markdown 链接对含空白的 href（如截断的非法 URL）降级只保文字（不产出
  断裂的 `[文字](https://x y)` 形态）
- at @提及段不解析（与 text 消息的 mention 处理同界——post 的 mention 映射
  飞书未提供稳定结构）
- 多语言体只取第一个可用（配置语言优先的精确匹配未做——飞书文档推荐按配置
  语言取，但新旧版事件均至少带一个可用语言体，首个即够用；真实双语混发场景
  出现再迭代）
- 飞书 file/media 段下载仍需 `im:resource` 权限（Phase 2 已知边界延续）
- 超长 post（>9 张图）全部入库后被 validate 整组拒绝附件——正文保留、提示可见
  （与 Web 超限行为一致；不做「前 2 张放行」的部分接受，语义一致性优先）

## 6. 审视处置记录

**首轮异体审视（检视獭mimo，2026-08-29）**：0 严重 / 2 建议，六焦点全过
（含「系统侧零改动」声明经 diff 文件清单验证）。

- **建议 2（a 段 href 丢弃是 LLM 信息缺口）→ 已修**：拼正文时 a 段输出
  Markdown 链接 `[文字](href)`，Web 端 Markdown 流自动渲染可点击。新墁
  `postSegmentText`（extractPostText 内唯一拼接入口）；href 缺失/空串/含空白
  时降级只保文字。新用例 1（三项边界合入一条 it），本特性用例 17→18。
- **建议 1（语言体按配置语言优先）→ 不修**：双语混发用不到，配置化是过度
  设计（大獭拍板），记入已知边界。

处置后状态：根仓 171 文件 2035 用例全绿（含本特性 18 用例）；tsc/eslint 干净
（实测口径）。
