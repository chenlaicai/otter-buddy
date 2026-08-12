---
id: F20260812fmdr
title: feishu-markdown-rendering
doc_type: feature

summary: |
  飞书消息渲染从纯 text 升级为 post + md 富文本,消除 Markdown 语法裸字符暴露。
  根因:MessageBroadcaster.broadcastToFeishu 无信道适配层,把 body 原样塞 msg_type=text。
  主机制:在扇出点引入 projectForChannel 投影(剥离 html-card 围栏 + Web 链接占位 + 字节级截断),走新增 FeishuGateway.replyMarkdown 发 post + md;附 message.start 触发"正在思考..."临时消息消除 30-60s 静默。

causal_links:
  from:
    - F20260728htar

status: development
change_type: feature
tags: [feishu, im, rendering, channel-adapter]
modules:
  - src/entities/conversation/message-body-projection.ts
  - src/usecases/im/feishu-gateway.ts
  - src/frameworks/feishu/client.ts
  - src/usecases/im/message-broadcaster.ts
  - src/frameworks/config-service.ts
capability_test: "n/a: 纯代码逻辑改动(A 类),无 LLM 参与行为"
---

# F20260812fmdr: 飞书消息渲染适配层 — Markdown 投影

## 背景与需求

### 问题描述

后端 `body` 是统一 Markdown 字符串(GFM + `html-card` 自定义围栏),由 `MessageBroadcaster` 扇出到 Web 和飞书。Web 走 SSE + react-markdown 完整渲染;飞书走 `FeishuGateway.replyText`,`msg_type: "text"` 把 Markdown 当纯文本发,`#` / `**` / ```` ``` ```` 全是裸字符,`html-card` 围栏更是整段 HTML 源码暴露。飞书侧消息难读,核心交互卡(html-card)在飞书侧完全不可访问。

### 根因分析

- `MessageBroadcaster.broadcastToFeishu`(`src/usecases/im/message-broadcaster.ts:148-172`)无格式适配层,直接把 body 原样塞 text 消息
- `FeishuGateway`(`src/usecases/im/feishu-gateway.ts`)只有 `replyText` 一个出口,没有富文本通道
- `buildFeishuMessageText`(`message-broadcaster.ts:188-196`)只组装前缀,不做格式投影

### 数据实锤

- 飞书侧实际消息样例:用户在飞书看到 `# 标题\n\n**加粗**\n\n` 而不是渲染后的"标题"+"加粗"样式
- `html-card` 围栏在飞书侧显示为 ```` ```html-card title="..."\n<div>...</div>``` ``,长达数屏的 HTML 源码
- 飞书开放平台支持 post 消息 + `md` 标签(CommonMark 0.31 + GFM,见 [发送消息内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json?lang=zh-CN)),当前代码未使用

## 方案设计

### 技术方案

引入信道适配层:`body`(单一真相源)保持不变,在 `MessageBroadcaster` 扇出点对飞书信道做投影变换。

```
body (Markdown, 单一真相源)
   │
   ├─→ WebProjection         → SSE DTO 透传(不变)
   ├─→ projectForChannel()   → 飞书 Markdown(剥离围栏 + Web 链接占位 + 字节截断)
   │       └─ 复用 stripHtmlCardFences(F20260728htar)
   └─→ FeishuGateway
            ├─ replyMarkdown(chatId, senderLabel, markdown)  [新增]
            └─ replyText(chatId, text)                       [保留:降级 + 思考中消息]
```

**职责分工(Clean Architecture)**:

- **Entity 层投影**(扩展现有 `src/entities/conversation/message-body-projection.ts`):新增导出 `projectForChannel(body, options)`。纯函数 `(body, options) => string`。
  - 复用 `stripHtmlCardFences` 剥离 html-card / html-card-reply 围栏
  - 把剥离后的机器占位符替换为人类可读形式:`[html-card: 标题]` → `【交互卡片:标题】\n👉 {webBaseUrl}/conversations/{conversationId}`,`[html-card-reply: cardId]` → `[已提交交互卡片]`
  - 长度截断:options 接收 `maxBytes`(默认 25000)和 `truncationHint`,按 UTF-8 字节阈值对齐段落边界截断

- **Port**(`src/usecases/im/feishu-gateway.ts`):新增 `replyMarkdown(chatId, senderLabel, markdown): Promise<void>`。`senderLabel` 是跨信道的"发送者显示名"语义,不暴露飞书 post `title` 字段细节。`replyText` 保留。

- **Adapter**(`src/frameworks/feishu/client.ts`):
  - `replyMarkdown` 实现:把 `senderLabel` 塞进 post JSON `zh_cn.title`(`[senderLabel]`),`markdown` 塞进 `content[0][0] = {tag:"md", text: markdown}`,`msg_type: "post"` 发送
  - 失败降级:catch 后调 `replyText(chatId, \`[纯文本降级]\n\n${markdown}\`)` (审视建议:降级必须标记,体感落差可识别)

- **Broadcaster**(`src/usecases/im/message-broadcaster.ts`):
  - `broadcastToFeishu`(message.complete 路径):用 `queryOtter.getById` 组装 `senderLabel`,调 `projectForChannel(body, {webBaseUrl, conversationId, maxBytes})`,调 `feishuGateway.replyMarkdown(chatId, senderLabel, markdown)`
  - **新增"正在思考..."路径**:`broadcastEvent` 处理 SSEEvent 时,当 `event.event === "message.start"` 且 conversation 有飞书绑定时,用 `replyText` 发 `[otter名] 正在思考...`。利用 message.start 已携带的 `otterName`
  - 删除 `buildFeishuMessageText`(被新投影取代)

### 目标

- T1: 飞书侧回复以 post + md 渲染,标题/代码块/列表/表格/链接/删除线 正确显示
- T2: html-card 围栏替换为 `【交互卡片:标题】\n👉 {url}`,飞书用户可点击跳 Web 完成交互
- T3: 超长消息按字节截断,不触发飞书 post 请求体 30KB 上限错误
- T4: 渲染失败降级到纯文本,标记 `[纯文本降级]` 前缀,消息必达
- T5: 飞书侧收到用户消息后 1s 内看到 `[otter名] 正在思考...`,消除静默期"机器人挂了"误解
- T6: Web 侧渲染链路零改动

### 成功标准

- 飞书侧回复视觉上可读,Markdown 语法被正确渲染而非裸字符
- 单测覆盖:html-card 占位符替换、字节级截断、post JSON 结构、降级路径、message.start 触发思考中消息
- 既有 `tests/usecases/im/feishu-command-parser.test.ts` 通过;新增 `tests/entities/conversation/message-body-projection.test.ts` 中 projectForChannel 用例;扩展 `tests/frameworks/feishu/client.test.ts` 和 `tests/usecases/im/message-broadcaster.test.ts`
- `replyText` 通道保留且仍可用于降级 + 思考中消息

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 | 验证方式 |
|------|------|---------|----------|---------|
| AT-1 | Markdown 渲染 | 飞书触发带 #/代码块/表格/列表/链接的 otter 回复 | post md 渲染正确,语法符号不再裸露 | 真机 |
| AT-2 | html-card 占位带链接 | otter 回复含 `html-card` 围栏 | 飞书侧显示 `【交互卡片:标题】\n👉 {url}`,点击跳 Web 端 | 真机 |
| AT-3 | 字节级截断 | 构造 >30KB body(中文为主) | 截断版到达,无 API 报错,尾部带截断提示 | 真机 + 单测 |
| AT-4 | 降级标记 | mock replyMarkdown 抛错 | replyText 兜底 + `[纯文本降级]` 前缀 | 单测 |
| AT-5 | 思考中消息 | 飞书发消息触发 otter | 1s 内收到 `[otter名] 正在思考...`,主回复到达后无静默期 | 真机 |
| AT-6 | Web 不受影响 | web 触发同一回复 | web 渲染链路原样工作,html-card iframe 正常 | 真机 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| 全部 | n/a(纯代码逻辑改动 A 类,无 LLM 行为) |

本特性为渲染投影层改造,不触及 LLM prompt / skill / 工具选择,声明 `capability_test: "n/a"`。

## 实现细节

### 代码修改

已按方案落地,涉及 13 个文件:

| 文件 | 操作 | 行数变化 |
|------|------|---------|
| `src/entities/conversation/message-body-projection.ts` | 修改 | +95(新增 projectForChannel + 截断/人化函数) |
| `tests/entities/conversation/message-body-projection.test.ts` | 修改 | +91(projectForChannel 测试套) |
| `src/usecases/im/feishu-gateway.ts` | 修改 | +5(replyMarkdown 接口方法) |
| `src/frameworks/feishu/client.ts` | 修改 | +60(replyMarkdown 实现 + 降级路径) |
| `tests/frameworks/feishu/client.test.ts` | 新建 | +169(7 个用例:replyText/replyMarkdown/降级) |
| `src/usecases/im/message-broadcaster.ts` | 修改 | +50/-15(replyMarkdown 路径 + 思考中消息 + 删 buildFeishuMessageText) |
| `tests/usecases/im/message-broadcaster.test.ts` | 修改 | +115(17 个用例:走 replyMarkdown + message.start 思考中消息) |
| `tests/usecases/im/subscribe-sse.test.ts` | 修改 | +2(mock gateway 加 replyMarkdown) |
| `tests/interface-adapters/feishu/command-dispatcher.test.ts` | 修改 | +1(mock gateway 加 replyMarkdown) |
| `src/frameworks/config-service.ts` | 修改 | +11(web.baseUrl 配置字段) |
| `src/bootstrap/platforms.ts` | 修改 | +2(createFeishuBundle 透传 webBaseUrl) |
| `src/app.ts` | 修改 | +1(传 config.web?.baseUrl) |
| `config/config.yaml.example` | 修改 | +5(web.baseUrl 示例注释) |

### 逻辑变更

1. **`projectForChannel(body, options)`** 流水线:`stripHtmlCardFences`(围栏剥离) → `humanizePlaceholders`(`[html-card: x]` → `【交互卡片:x】\n👉 {url}`、`[html-card-reply: y]` → `[已提交交互卡片]`) → `truncateByBytes`(段落对齐 + UTF-8 字节安全切片)
2. **`replyMarkdown(chatId, senderLabel, markdown)`** 构造 post JSON:`{zh_cn:{title:"[senderLabel]", content:[[{tag:"md", text: markdown}]]}}`,发 `msg_type: "post"`。失败降级到 `replyText(chatId, "[纯文本降级]\n\n" + markdown)`
3. **`broadcastToFeishu`**:删 `buildFeishuMessageText`;新流程 = `resolveSenderLabel` + `projectForChannel` + `replyMarkdown`
4. **`broadcastEvent`**:加 `message.start` 分支,触发 `maybeSendFeishuThinkingMessage`(查 session/connection → `replyText` 发 `[otterName] 正在思考...`),fire-and-forget 不阻塞 SSE 流
5. **config schema**:`AppConfig.web.baseUrl?: string`,默认 undefined(缺省时占位符不带链接,只显示 `【交互卡片:标题】`)

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/entities/conversation/message-body-projection.ts` | 修改 | 新增 `projectForChannel(body, options)` 导出;html-card 占位符替换为 Web 链接格式;字节级截断 |
| `tests/entities/conversation/message-body-projection.test.ts` | 修改 | 加 `projectForChannel` 测试用例 |
| `src/usecases/im/feishu-gateway.ts` | 修改 | 加 `replyMarkdown(chatId, senderLabel, markdown)` 方法签名 |
| `src/frameworks/feishu/client.ts` | 修改 | 实现 `replyMarkdown`;post + md JSON;失败降级 `replyText` 带 `[纯文本降级]` 前缀 |
| `tests/frameworks/feishu/client.test.ts` | 新建/扩展 | `replyMarkdown` JSON 结构 + 降级路径单测 |
| `src/usecases/im/message-broadcaster.ts` | 修改 | `broadcastToFeishu` 走新投影 + `replyMarkdown`;`broadcastEvent` 加 message.start → 思考中消息;删 `buildFeishuMessageText` |
| `tests/usecases/im/message-broadcaster.test.ts` | 修改 | mock 加 `replyMarkdown`;新增 message.start 触发思考中消息单测 |
| `tests/usecases/im/subscribe-sse.test.ts` | 修改 | mock gateway 加 `replyMarkdown` |
| `src/frameworks/config-service.ts` | 修改 | AppConfig 加 `web.baseUrl` 字段;RawConfig + applyDefaults 同步 |
| `config/config.yaml.example` | 修改 | 加 `web.baseUrl` 注释示例 |

### 复用资产

- `stripHtmlCardFences(body)`(`src/entities/conversation/message-body-projection.ts:81`):html-card 围栏剥离
- `FeishuAccessTokenManager`(`src/frameworks/feishu/access-token-manager.ts`):token 获取
- `manageConnection.getSessionByConversation` / `getConnection`:broadcaster 已用,思考中消息复用

## 验收结果

### 测试结果

| 测试集 | 用例数 | 结果 |
|--------|--------|------|
| `tests/entities/conversation/message-body-projection.test.ts` | 50 | ✅ 通过(projectForChannel 14 个用例,含字面量误匹配防护 2 个) |
| `tests/frameworks/feishu/client.test.ts` | 7 | ✅ 通过(覆盖 replyText/replyMarkdown/降级路径,mock Response 补齐 ok/status) |
| `tests/usecases/im/message-broadcaster.test.ts` | 20 | ✅ 通过(replyMarkdown 路径 + 思考中消息 7 用例,含乱序 gate 3 个) |
| 全量回归(`npm test`) | 1124 | ✅ 93 文件全过 |
| TypeScript 编译(`npm run build`) | — | ✅ 类型干净 |
| `npm run lint:docs` | 167 docs | ✅ 无新增告警 |
| `npm run lint:capability` | 63 | ✅ 无新增告警 |

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| AT-1 Markdown 渲染 | 单测验证 post + md JSON 结构正确(senderLabel → title、markdown → md.text) | ✅(单测证明),⏳(真机渲染待用户验证) |
| AT-2 html-card 占位带链接 | `projectForChannel` 单测验证占位符 → `【交互卡片:x】\n👉 {url}` 转换 | ✅(单测证明),⏳(真机点击待用户验证) |
| AT-3 字节级截断 | 单测覆盖中文 UTF-8 字节阈值 + 段落对齐 + 自定义 hint;5000 字节预算断言通过 | ✅ |
| AT-4 降级标记 | 单测覆盖 code≠0 与网络错误两条降级路径,验证 fetch 调用 2 次(降级触发) | ✅ |
| AT-5 思考中消息 | 单测覆盖 message.start 触发 replyText;无飞书绑定/无 otterName/非 start 事件三条不触发分支 | ✅(单测证明),⏳(真机时延待用户验证) |
| AT-6 Web 不受影响 | 改动全在 feishu/broadcaster/projector 链路,Web SSE 与 react-markdown 渲染零改动;全测回归通过 | ✅ |

**真机端到端验证留给用户**:按 feedback "隔离实例做真实验证",在 worktree 启独立端口 + 独立 DB + 真实飞书机器人核对渲染效果。

## 对抗审视记录

三轮独立 agent 对抗审视(架构纯净度 / 飞书 API 真实约束 / 方案完整性)。用户逐题拍板后回写。

### 第一轮:架构纯净度审视

**采纳的修正**:
- 投影函数归属错误 → 不新建 `src/usecases/im/feishu-markdown-projector.ts`,扩展 `src/entities/conversation/message-body-projection.ts`
- `title` 概念泄漏 → gateway 接口改用 `senderLabel`,title 拼装移到 client.ts
- 截断常量不应焊进 entity → 通过 options 参数传入
- 不抽 `MessageChannel` 通用接口 → 当前只有飞书,过早抽象

**未采纳**:
- "占位符对用户语义不清" → 升级为产品决策,用户拍板"带 Web 链接"(已实现)

### 第二轮:飞书 API 真实约束查证

**采纳的修正**:
- 长度阈值 28000 字符 → 25000 字节(中文场景才不爆 30KB)
- 补充飞书 md 不支持清单:Setext 标题 / 缩进代码块 / raw HTML / 邮箱自动链接
- post + md JSON 结构、字段名 `text`、msg_type 校验 → 草案假设正确

**权威来源**: [发送消息内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json?lang=zh-CN)

### 第三轮:方案完整性审视

**采纳的修正**:
- html-card 占位符必须带 Web 链接 → 升级为产品决策,用户拍板(已实现)
- 必须实现"正在思考..."临时消息 → 升级为产品决策,用户拍板(已实现)
- 降级必须标记,加 `[纯文本降级]` 前缀
- F 文档需补完整 frontmatter + 模板章节
- 改动范围遗漏 `message-broadcaster.test.ts` / `subscribe-sse.test.ts`

**未采纳**:
- title 里带对话主题 → 无 conversation.title 字段,记为已知限制
- 用户消息未闭合围栏校验 → 风险可控,飞书 fallback 是 text,记为已知限制

### 第四轮:实现代码审视(PR #233)

合入前对实际代码做了对抗审视,补修两项 + 记一项已知限制。

**已修(本轮顺手做)**:
- F 文档"9 个文件"与实际 13 行不符 → 修笔误
- `truncateByBytes` 在 `\r\n\r\n`(Windows 换行)场景下段落分割失配 → 入口加 `\r\n` → `\n` 归一化
- 补 `\r\n` 截断 + BOM 截断测试锁定行为基线

**记已知限制**:
- 思考中消息 fire-and-forget 与最终消息无顺序保证。极快 agent 回复(cache hit/短回答)时,最终消息可能先于"正在思考..."到达飞书,造成乱序。修复路径:在 `maybeSendFeishuThinkingMessage` 加时间戳 gate(距 message.start < 3s 才发)或与最终消息串行化。本期不做(避免扩范围),留下个 PR 评估。

### 第五轮:对抗性输入 / 运维可观测性 / 幂等性 / 向后兼容

聚焦前四轮没覆盖的盲区。**0 阻塞项**。所有发现项处理完毕,**无遗留**。

**已修(本 PR 内完成)**:
- `buildWebConfig` 加 `http(s)://` 协议白名单:防止 `javascript:`/`data:` 等危险协议被注入到飞书侧占位符跳转链接。配置异常启动即抛错
- `createFeishuBundle` 在 `webBaseUrl` 缺失时输出 info 日志:运维能从启动日志发现配置遗漏
- **`humanizePlaceholders` 字面量误匹配**:扩 `stripHtmlCardFences` 加 `markPlaceholders` option,projectForChannel 调用时传 true,占位符产出自带零宽前缀 `\u200B`;`humanizePlaceholders` 正则只匹配带前缀版本。LLM 在 body 原文手写字面量 `[html-card: xxx]` 不会被误替换为 `【交互卡片】` + 链接。零宽标记不影响其他出口(FTS/记忆索引/注入仍用未标记格式)
- **mock Response 补 ok/status 字段**(测试工程化):抽 `mockResponse()` helper,所有 fetch mock 返回值带 `ok:true, status:200`,防未来加 HTTP 错误处理时假阳性。补网络错误降级 msg_type=text 验证
- **思考中消息乱序 gate**:扩 `maybeSendFeishuThinkingMessage`,发送前检查 `Date.now() - new Date(createdAt).getTime() > 3000ms` 则跳过。极快 agent 完成时,IO 慢路径下的思考中消息不再晚于最终消息到达。createdAt 缺失时仍发送(向后兼容)

**向后兼容声明**(审视 R5 盲区4a):本变更影响所有经 `broadcastToFeishu` 的消息(含历史消息重发),飞书侧从纯文本变为 post md。这是有意的用户体验提升,不是 regression。

**PR 边界声明(不在本 PR 范围,需独立 F 文档处理)**:
- **broadcaster 幂等性**:既有问题,老 `replyText` 也存在,非本 PR 引入。修复需要重新设计 webhook event_id 去重 + DB 持久化,涉及飞书 webhook 层 + broadcaster 层联动改造。本 PR 改 post md 不会让它变得更该在这里修。已开 #241 跟踪
- **降级频率 metric**:全仓库没有 metric 框架,引入是基础设施级决策(Prometheus client / 自建 counter / 接入现有告警链路)。需要项目级技术选型,不塞进单 PR。已开 #242 跟踪

### 第六轮:R5 新代码 + 跨模块隐性假设

聚焦 R5 后新加的代码(零宽前缀 / 时间戳 gate / mockResponse 抽取)及其跨模块交互。**0 阻塞,0 重要 bug**。

**已修(polish)**:
- `buildWebConfig` 代码注释与实现矛盾:注释说"忽略并返回 undefined",实际是 `throw new Error` 阻止启动。修注释对齐实现
- 思考中消息时间戳 gate 的 NaN 隐式语义:加 `Number.isNaN(elapsedMs)` 显式判断,非法 createdAt 显式当作"无 gate 信息",与缺失 createdAt 同语义
- 补裸字面量测试(无反引号包裹的 `[html-card: x]`)+ NaN createdAt 测试

**已确认无问题**(关键判断留档):
- 零宽字符 `\u200B` 在 JSON round-trip / Buffer / RegExp 中行为正确;理论攻击面"LLM 故意输出 `\u200B[html-card:fake]`"在生产不可能(LLM token 层几乎不生成 ZWSP)
- `markPlaceholders: true` 在 `stripHtmlCardFences` 短路路径(不含 "html-card" 字符串)下不生效 —— 这是正确的(无围栏就无需标记)
- 时间戳 gate 在 createdAt 合法 ISO string(生产路径)下不会触发 NaN,跨时区计算正确,conversation 绑定时序行为正确
- mockResponse helper 对当前实现充分(代码不检查 response.ok);未来加 HTTP 错误处理时自然需扩展
- 所有其他出口(FTS/记忆索引/上下文注入)调用不带 markPlaceholders 的版本,默认 false,行为不变
- broadcastEvent 不是 per-token 调用,只在离散事件触发,无性能问题

## 设计决策

### 关键选择

1. **post + md 而非卡片 rich_text**:post 更轻量,不需要 card_id;rich_text 适合需要按钮等交互外壳的场景,本期过度
2. **senderLabel 而非 title**:`senderLabel` 是跨信道的"发送者显示名"语义,不泄漏飞书 post 结构。换信道时三层不必都改
3. **字节维度截断而非字符**:飞书 30KB 限制是请求体字节上限,中文 UTF-8 3 字节/字,字符阈值会爆
4. **本期不做流式**:Streaming Card 表格 >3 降级(已知 issue),Web 流式已覆盖实时性诉求,只做 message.start 思考中消息消除静默
5. **配置默认 undefined**:web.baseUrl 缺省时占位符不带 URL,只显示 `【交互卡片:标题】`,避免强依赖配置
