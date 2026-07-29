---
id: F20260728htar
title: html-card-dual-speak-format
doc_type: feature
summary: |
  为水獭提供第二种发言格式：HTML 卡片（html-card）。日常发言仍是 Markdown；
  可独立存在的交付物（方案、对比、报告、可视化）以 ```html-card 围栏块嵌入 speak body，
  前端经 react-markdown code 组件路由（模块级稳定引用），sandbox iframe 渲染（默认折叠、点击展开）。
  卡片可携带表单/按钮，提交经 postMessage 桥 → 父页强制预览（摘要+JSON 全可见）→ 用户消息回传。
  安全模型：桥非信任边界，校验全在父页；form-action 'none' 堵表单外泄；导航逃逸事后检测降级。
  FTS 索引改应用层写入（废触发器），写剥离后文本；FTS body 存优化投影，messages.body 原文不动。
causal_links:
  from: [F20260724skch, F20260724tsrr]
status: draft
change_type: feature
tags: [conversation, web, agent-tools, ux, db-migration]
modules:
  - src/interface-adapters/agent-runtime/tools/
  - src/frameworks/db/
  - src/usecases/conversation/
  - web/src/pages/conversation/
  - web/src/lib/
created_at: 2026-07-28
---

# HTML 卡片：水獭的第二种发言格式

> 本文档经七轮架构师对抗审视 + 一轮 PR 实现审查修订（2026-07-28），决策史见文末「对抗审视决策史」。
> 概要：R1 安全模型与解析方案重写；R2 FTS 应用层写入（用户决策）与组件稳定性；
> R3 FTS 事实勘正（7 写入路径/触发器卸载）与回执显式路由；R4 路由校验移后端、variant 机制；
> R5 全局完整性（查询出口投影、状态矩阵、attachments 清除）；R6 封版终审（剥离按围栏分叉、落点纪律、fenceIndex 定义）；
> R7 机制核验（fenceIndex 改 hProperties 通道、契约 id 发现规则、已提交封死语义）；
> R8 PR 实现审查（契约 token 对齐、解析器改 mdast、user 卡锁死、闸门测试补齐）。

## 术语定义

| 术语 | 定义 |
|---|---|
| **HTML 卡片（html-card）** | 嵌入在 speak body 中的 ` ```html-card ` 围栏块，自包含 HTML 片段，前端沙箱渲染为卡片。**不是** LinkedResource 产物 |
| **cardId** | 卡片实例标识，`{messageId}:{fenceIndex}`。fenceIndex = 消息内 html-card 围栏按文档序的 0 基序号。**注解机制**：自定义 remark 插件按文档序写 `node.data.hProperties = { dataFenceIndex: i }`——mdast→hast 只透传 hName/hProperties/hChildren 三个保留 key，任意 `data` key 静默丢弃（已核验 mdast-util-to-hast 源码），组件从 `node.properties.dataFenceIndex` 读。前端 HtmlCard、后端剥离函数、useCardBridge 三方共享同一规则，共享测试向量须覆盖围栏嵌套在 blockquote/list 内的用例。回执按 cardId 关联，不用 title（同名卡片迭代时 title 有歧义） |
| 卡片桥（card bridge） | 前端注入到 iframe srcdoc 的宿主脚本，提供 `otterCard.submit()` 与高度上报。**只是便利 API，不是安全边界** |
| 卡片回执（card-reply） | 用户提交经预览确认后生成的用户消息，body = 人类可读摘要 + ` ```html-card-reply ` JSON 围栏（携带 cardId） |
| 说话通道 / 产物通道 | 默认 Markdown 发言 / 本特性新增的 html-card 发言形式 |

**新旧词映射（防术语碰撞）**：仓库已有 LinkedResource「产物 / artifact」（`artifact-tools.ts`），指会话引用的外部资源。本特性是**消息体内联内容**，禁用 "artifact" 命名，统一 `html-card` / `HtmlCard`。

## 背景与动机

纯文本 < Markdown（结构）< HTML（结构 + 布局 + 交互）。交付物（方案对比、报告、可视化）用 Markdown 表达力不足。HTML 是 LLM 的"母语格式"，写读可靠，源码留在上下文里可被引用与 diff 迭代。进一步：HTML 的交互能力让卡片不止于展示——用户在卡片内选择/填写，经父页预览确认后作为用户消息回传，"水獭递了一张可填写的纸，用户填完递回去"。

业界参照：Claude Artifacts、MCP Apps（2026-01 起 MCP 官方扩展，工具返回 HTML 沙箱渲染）。

## 设计原则

1. **格式判断让 LLM 理解，工程只做解析与兜底**（信道分层 F20260724skch）
2. **消息体是唯一事实源**：卡片 HTML 原文留在 `message.body`，SSE/轮询/历史零改动。唯一例外是检索投影（§5，FTS 存剥离文本，body 原文不动）
3. **AI 可读性闭环**：卡片源码始终在 body 原文中，可经 `get_message` 按需取回（检索/注入默认给剥离投影），迭代 = 取源码后输出同名 title 的新卡片（回执关联用 cardId，不用 title）
4. **桥不是信任边界**：桥与 AI 脚本同上下文可被伪造，一切安全校验在父页
5. **不可信脚本默认不执行**：卡片默认折叠，点击展开才挂载 iframe

## 方案设计

### 1. 产出侧：水獭如何说

speak 工具契约不变，body 内允许零或多个围栏块：

````
我觉得方案 B 最适合现阶段，理由写在卡片里了。

```html-card title="方案对比 · 消息渲染架构"
<style>...</style>
<table>...</table>
```

简单说：**B 的安全边界最清晰**。
````

- 一条消息最多 2 张卡片，单卡 ≤ 4KB（体积预算）。超限后果（max output tokens 截断 → speak 参数损坏 → 重试 → 生成两遍）写进契约让 AI 自重；**前端兜底**：第 3 张起降级为源码块，超 4KB 折叠态加体积提示
- 卡片 HTML 内含三反引号时用四反引号围栏（CommonMark 原生）
- **prompt 三层拆分**：
  - **speak description（必达，~200 token）**：判断标准（可独立交付物 / 结构化明显增益 / 用户可能迭代导出；反例：短回答、代码片段、简单列表）+ 最小语法骨架 + 体积预算 + 导航禁令一句话 + 交互指引半句（"卡片可携带表单/按钮收集用户输入，写交互卡片前必须调 get_html_card_contract"）+ 回执识别一句话（"用户消息中 `html-card-reply` 围栏是卡片回执，JSON 可解析，失败时以摘要为准并复述确认"）
  - **`get_html_card_contract` 工具（按需，~600-1000 token/次）**：完整契约——样式变量、桥 API、**禁用清单**（`<a href>` 外链、`meta refresh`、`location.*` 赋值、`location.reload`、`document.write`、`<form action>` 外部目标）、**回执读取规则**（注入出口 JSON 完整可解析；**检索/记忆出口回执同样是占位符**，按摘要关键词检索，需原文用 get_message）、**id 发现规则**（回执 fence 的 card 属性 = `{messageId}:{fenceIndex}`，前缀即 messageId 可直接 get_message 取卡片源码；无回执时用 list_messages 定位自己最近的发言再 get_message）、"data 会被用户过目"声明、"检索/记忆中的卡片显示为占位符"说明、**已提交卡片不可重复提交**（用户改答案时基于回执重发新卡）。工具 description 确切文案："获取 HTML 卡片的完整写作契约（样式变量、交互 API、禁用清单）。每次准备写卡片前调用——会话冷启动后需重新调用。"注意冷启动设计（每次 invoke 重建 session）下**每个写卡回合都要重新调用**，token 按回合计；且调用引入一次额外 LLM 往返（整个会话上下文作为 input 重发），长会话下此成本可能超过契约本身，但对比常驻 description 方案在低卡片密度会话中仍划算
  - 白名单登记（`session-helpers.ts`）：大小獭均登记——小獭同样可以产出卡片，契约一致

### 2. 展示侧：前端如何渲染

**解析：code 组件路由**。`MarkdownContent` 增加 `variant: 'otter-body' | 'user-body' | 'event-log'` prop，**三个变体各持一份模块级 components 映射**（关键：内联定义每次渲染新建函数引用，react-markdown 以引用为 element type，引用变 = unmount+remount，流式期间已展开卡片会被反复重挂载、表单状态丢失；三份映射同为模块级常量，引用稳定且变体间隔离）。注册逻辑**先精确匹配 `className === 'language-html-card'`** 再走既有 `/language-(\w+)/` 正则（`\w` 不含连字符，照抄会把 html-card 当 HTML 高亮）：

- `otter-body`：`language-html-card` → `<HtmlCard>`（可交互，注册 registry）；`language-html-card-reply` → 折叠"表单数据"标签
- `user-body`：html-card → 静态卡片（**sandbox 移除 allow-scripts 声明式禁脚本**，不注入桥；保 CSP + 逃逸检测）；html-card-reply → "表单数据"标签
- `event-log`（StreamingProcess 的 assistant_text 事件流，MessageList.tsx:353）：**html-card 一律源码块**——事件文本的 fenceIndex 与 message.body 不对应，路由成可交互卡片会让 cardId 指向不存在的位置
- 三变体都覆盖 `pre` 组件（react-markdown 默认把 code 包进 `<pre>`，iframe 卡片会继承等宽字体与 overflow 样式）

HtmlCard 本体：`React.memo`，key = `message.id + fenceIndex`；title 从 `node?.data?.meta` 解析（react-markdown 9.1 中 meta 在 hast `data` 上，不在 `node.meta`；info string 原样透传，title 含 `"` 时截断到首个引号）

**HtmlCard 组件**，默认折叠：

```
折叠态（默认）：⌗ {title}  [HTML 卡片] [展开渲染] [看源码]
展开态：⌗ {title} [收起] [看源码]  +  sandbox iframe  +  🛡 沙箱隔离 · 内容不可信
```

- 布局：撑满消息气泡宽度（72%），内部自适应
- **srcdoc 组装**（前端完成）：
  ```html
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
    img-src data:; connect-src 'none'; form-action 'none'">
  <style>:root{ ...设计 token... }</style>
  <script>/* 桥：otterCard.submit（携带注入的 cardId）+ ResizeObserver 高度上报 */</script>
  {AI 提供的 HTML}
  ```
- iframe：`sandbox="allow-scripts"`，**绝不加 `allow-same-origin`**
- 高度：桥 `postMessage({type:'card:resize'})` → 父页 clamp [100, 2000]px

### 3. 交互侧：提交 → 强制预览 → 用户消息

**卡片 × 消息状态矩阵**（卡片行为随消息生命周期）：

| 消息状态 | 卡片行为 |
|---|---|
| streaming | body 为 null，无卡片 |
| speaking | body 已完整落库且不再变，轮询可见——**可渲染可交互**（提早可用是体验优势，显式声明） |
| completed | 可渲染可交互 |
| failed（failInFlightMessages，启动兜底） | 保留 body——卡片仍可交互，回执路由按作者校验不受影响 |
| failed（failMessage 带 body，运行期主路径） | body 被合成文本（`[错误] …`）整体替换——**卡片消失**，挂起预览按 aborted 同款丢弃 |
| aborted | body 被合成文本整体替换——**卡片消失**，useCardBridge 对 cardId 从 DOM 消失的挂起预览自动丢弃 |

**system 消息**不经 MarkdownContent，围栏按纯文本显示；系统消息不产卡片。对称矩阵闭合：otter 可交互 / user 静态 / system 纯文本 / event-log 源码块。

**威胁前提**：桥无法区分真人点击与 AI 脚本自动调用，summary 由 AI 措辞。父页预览是唯一闸门，**强制且永久，无直接发送开关**。

**卡片内契约**（contract 工具返回）：

```js
otterCard.submit({
  summary: '选择了方案 B（沙箱 iframe），预算上限 3 天',  // ≤500 字符
  data: { choice: 'B', budget_days: 3 }                  // 序列化 ≤2KB
})
```

**父页校验链**（`useCardBridge` hook，校验全在父页）：
1. `event.source` ∈ 已渲染卡片 registry；iframe→cardId 映射匹配，不匹配即丢弃
2. payload 形状：summary ≤500 字符、data JSON 序列化 ≤2KB、禁循环引用/函数
3. resize clamp + resize/submit 各自节流；**预览挂起期间同卡 submit 直接丢弃**；**A 卡预览挂起时 B 卡提交 → 拒绝并提示**（预览为输入框上方单槽位；跨会话不存在并发——单页应用只渲染 active 会话，切会话即丢弃待确认预览）
4. **每条已发送回执仅一次**：已回复集合从消息历史扫描 `html-card-reply` 围栏的 cardId 派生（回执自带 cardId，零额外存储，跨刷新有效；前提：回执恒新于卡片，同在 100 消息窗口内）；预览拒绝后重置该卡提交闸（可修正重提），**连续拒绝 3 次后该卡 submit 关闭（会话内持久；刷新后重置，预览闸门本身仍在，防脚本打地鼠）**；**发送成功后该卡 submit 永久关闭（已回复集合跨刷新持久）——已提交卡片不可重复提交；用户要改答案时让水獭基于回执重发新卡**（预览 UI 与契约均显式声明此语义）

**预览 UI**（输入框上方）：summary 全文 + **data JSON 全文（可折叠但默认可见）** + 显著标注"以下内容由水獭卡片生成，请核对后发送"。用户点发送才构造消息。**切换会话丢弃待确认预览**。

**回执 body**（cardId 关联，非 title）：

```
选择了方案 B（沙箱 iframe），预算上限 3 天

```html-card-reply card="<uuid>:0"
{"choice":"B","budget_days":3}
```
```

**发言石路由**：`talkingStonePassedTo` **显式传卡片所在消息的 senderId（卡片作者）**——多獭场景下空数组默认派发给"最后发言者"（含 failed/aborted 消息），卡片发出后有别的獭插话时回执会派错对象。**校验在后端**：前端无法检测"作者已解散"（DissolveOtter 不级联 participant 退场，已解散的獭永远留在 active participants 列表，ParticipantDTO 不带 otter.status），因此 `SendMessage.send()` 对**显式目标也做"在场 + otter.status==='active'"校验**（复用 resolveDefaultTargets 同款逻辑），不合法则退默认派发——顺带修复存量洞（用户 @ 提及此前同样无校验，会复活已解散的獭）。**校验仅适用 `senderType === 'user'`**（回执与 @ 场景）；system（定时任务）消息豁免，防目标獭解散后任务消息被静默改派。无兜底目标时抛错——失败以 toast 可见。

**发送通道**：回执发送**复用 handleSend 整条管线**（乐观 tmp 消息 + consumeSSE + 轮询兜底），不另开通路——POST /messages 返回的 SSE 流携带水獭响应，不消费则水獭回复在前端"消失"（轮询续看只在本地已有 inFlight 消息时启动）。

### 4. 安全模型

**威胁模型**：AI 生成的 HTML/JS 完全不可信；桥可被伪造；sandbox 提供隔离不提供完整性；导航不可事前阻止、只可事后降级。

| 威胁 | 防线（全在父页/宿主） |
|---|---|
| **表单外泄**：`form.submit()` 把已填数据编码进 URL 带出，先于逃逸检测发生 | CSP `form-action 'none'` + 契约禁 `<form action>` 外部目标 |
| **导航逃逸**：location/meta refresh 加载外站，脱离 srcdoc CSP | 事后检测：iframe 二次 load → 销毁降级为"已失效 + 看源码"并向用户展示；契约禁令（含 reload/document.write，这两者也触发二次 load 属误报面，一并禁用）；徽章诚实声明"沙箱隔离 · 内容不可信" |
| **伪造提交 / 冒充他卡** | source registry + cardId 映射 + 每卡已发送回执仅一次 |
| **自动提交 / 措辞欺骗 / data 夹带指令** | 强制预览（summary + JSON 全文可见）；payload 硬限制（500 字符 / 2KB） |
| **布局 DoS** | resize clamp [100,2000]px + 节流 |
| **数据外泄** | `sandbox="allow-scripts"`（opaque origin）+ CSP `default-src 'none'; connect-src 'none'` |
| **资源消耗** | 默认折叠（执行为用户触发）；逃逸检测覆盖异常 |
| **重挂载风暴** | components 模块级稳定引用 + memo + 稳定 key（§2） |

**iframe registry**：module 级（`web/src/lib/card-registry.ts`），HtmlCard mount/unmount 登记/清理 `contentWindow ↔ cardId`。unmount 后到达的 postMessage 因 source 不在 registry 被丢弃（合理行为，切会话即放弃待确认预览）。

### 5. 检索投影：FTS 应用层写入（迁移）

**决策（用户拍板）**：`messages_fts.body` 存剥离后的优化文本，写入动作从触发器拿回应用层。`messages.body` 原文始终不动（原则 2）。

**现状勘正**（第三轮审视）：body 的写入路径不是两条，而是 **7 条**——`createCompletedMessage` INSERT（:138，用户/系统消息）、`createStreamingMessage` INSERT（:152）、`startSpeaking` UPDATE（:166）、`completeMessage` UPDATE（:178）、`failMessage` UPDATE（:196）、`failInFlightMessages` 批量 UPDATE（:204，启动兜底）、`abortMessage` UPDATE（:230）。现有触发器（`AFTER UPDATE OF body` 等，schema.ts:394-408）覆盖全部 7 条，应用层方案必须等价覆盖，否则相对现状是回退。

**落地**：
- **剥离函数放 entities 层**纯函数（`src/entities/conversation/`）：repository（frameworks/db）与 `indexMessage` 调用点（usecases）都依赖它，两侧向内依赖合法。覆盖两类围栏：`html-card` → `[html-card: {title}]`、`html-card-reply` → `[html-card-reply: {cardId}]`
- **repository 7 个写方法逐一接入**"剥离 + FTS upsert"，每个方法用 `db.transaction()` 包事务（现状是裸单语句 autocommit，加一条 FTS 写后中间崩溃即漂移）。`failInFlightMessages` 是批量 SQL，需改为"SELECT 受影响行 → JS 剥离 → 逐行 FTS 更新"
- **FTS 写入语义规范**（与现状触发器等价）：以"本次写入了 body 值"为条件——`createStreamingMessage` 写空串（复制 COALESCE(null,'') 语义）；`failMessage` 仅 `body !== undefined` 时 upsert（body 未变时现状触发器不点火）；其余五路径无条件 upsert
- **触发器卸载**：schema.ts **保留三句 `DROP TRIGGER IF EXISTS`、删除 CREATE**——只删 CREATE 行的话，老库 sqlite_master 里已存在的触发器永不消失，造成"触发器写原文 + 应用层写剥离文本"双写
- **存量 rebuild**：`messages_fts` 是独立 FTS5 表（非外部内容表），单事务内 `DELETE FROM messages_fts` + 逐条 SELECT messages → 剥离 → INSERT，挂 migrateDatabase 一次性补丁（better-sqlite3 同步单连接，事务期间自然排他，无停机）。**幂等守卫**：启动顺序是 initSchema（执行 DROP TRIGGER）先于 migrateDatabase，"触发器存在"不能作判据；用 settings 表写 `messages_fts_stripped_rebuild = done` 标记作幂等键，二次启动不重复 rebuild。注：html-card 是本特性新语法，历史消息本无此类围栏，rebuild 实为防御性一致性措施（no-op）
- working memory 的 `indexMessage` 三调用点（send :130 / complete :248 / abort :313）走同一剥离函数。**剥离粒度**：仅替换围栏为占位（`[html-card: {title}]` / `[html-card-reply: {cardId}]`），围栏外的用户摘要保留可检索
- **剥离策略按围栏类型分叉**：`html-card`（卡片源码，体积大）全路径剥离——索引（FTS/记忆）与上下文注入都给投影 `[html-card: {title}]`；`html-card-reply`（回执 JSON，≤2KB，本就是交互载荷）**仅索引剥离，上下文注入不剥离**——水獭在未读注入主信道上直接看到 JSON（否则与 description"JSON 可解析"矛盾，且每次回执强制一次 get_message 往返）
- **查询出口**：`searchMessages` 改为返回 `fts.body`（剥离投影）而非 `m.*` 的原文 body——FTS 剥离只影响匹配不影响返回，不改查询出口则检索结果仍含完整 HTML。`get_message` 保留返回原文，作"回看源码"通道
- **上下文注入**：`buildMessageWithContext`（未读历史注入）、`list_messages`、`get_turn_history` 对 html-card 给剥离投影（html-card-reply 不剥，见上）；水獭迭代卡片时经 `get_message` 按需取源码（契约已教此路径）。冷启动下历史注入是每跳每獭重付的最大 recurring 成本，单条含卡消息投影后从 ~8KB 降至百字节级
- **剥离落点纪律**：HTTP `list`/`getById` 端点**不剥离**——它们是前端消息流的唯一数据源，前端渲染依赖 body 原文（原则 2）；剥离只发生在 buildMessageWithContext 注入组装处与 agent 工具响应映射处
- 纪律：**任何 messages 写入必须走 repository**（已核验：全仓仅 repository 与 schema 触发器直写 messages，无其他旁路）
- contract 工具中注明："记忆/检索详情中卡片显示为占位符，回看源码用 get_message"，防水獭误以为内容丢失

### 6. token 预算

| 项 | 成本 | 说明 |
|---|---|---|
| speak description 增量 | ~200 token / 请求 | 判断标准 + 骨架 + 禁令 + 回执识别 |
| contract 工具 description | ~30 token / 请求 | |
| contract 全文 | ~600-1000 token / **写卡回合** | 冷启动（invoke 重建 session）下每回合重付；另引入一次额外 LLM 往返（整上下文重发） |
| 历史注入（已消除） | ~~单条含卡消息 ~8KB × 每跳每獭~~ | 未读注入默认给剥离投影后，降至百字节级；源码走 get_message 按需 |
| 卡片本体 | ≤4KB / 卡 | 前端兜底降级 |

## 决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| 卡片载体 | body 内围栏块 | body 是全链路事实源；留在 AI 上下文可迭代 |
| 解析方案 | code 组件路由，components 模块级稳定引用 | CommonMark 免费正确；内联引用导致重挂载风暴 |
| 卡片挂载 | 默认折叠，点击展开 | 不可信脚本执行为用户触发 |
| 桥的定位 | 便利 API，非信任边界 | 与 AI 脚本同上下文可被伪造 |
| 提交确认 | 父页预览强制永久，summary+JSON 全可见 | 桥无法区分点击与自动调用；data 夹带指令借用户消息信任升级 |
| 回执关联 | cardId（messageId:fenceIndex），非 title | 同名卡片迭代时 title 歧义 |
| 回执路由 | **显式作者 senderId + 后端 send() 校验退默认派发** | 多獭场景默认派发会派错对象；前端无法检测已解散作者（第四轮推翻第三轮的前端校验） |
| 回执发送通道 | 复用 handleSend 整条 SSE 管线 | 另开通路则水獭响应在前端消失（轮询只在已有 inFlight 时启动） |
| 已回复集合 | 从历史 html-card-reply 围栏派生 | 跨刷新有效，零额外存储 |
| FTS 投影 | **废触发器，repository 7 写方法事务内写剥离文本；剥离按围栏分叉** | 触发器无法加工；7 条写入路径需等价覆盖；html-card 全路径剥离 / html-card-reply 仅索引剥离（用户决策） |
| 剥离落点纪律 | HTTP list/getById 不剥离，只在注入组装处与工具响应映射处 | 前端渲染依赖 body 原文，控制器层剥离则特性全灭 |
| 历史注入 | 未读注入/list/get_turn_history 对 html-card 给投影（reply 不剥），源码走 get_message | 冷启动下历史注入是每跳每獭重付的最大 recurring 成本 |
| 卡片×状态矩阵 | speaking/failInFlight 可交互；failMessage/aborted 卡片消失、挂起预览丢弃；system 纯文本 | 轮询使 speaking 态卡片提前可见是既成事实，必须声明 |
| rebuild 幂等 | settings 表 `messages_fts_stripped_rebuild=done` 标记 | initSchema 的 DROP 先于 migrateDatabase，"触发器存在"不能作判据 |
| fenceIndex 机制 | remark 插件写 hProperties，组件读 node.properties | mdast→hast 不透传任意 data key（第七轮核验源码纠正） |
| 围栏解析实现 | **前后端统一 remark/mdast**（position 切片替换），共享测试向量 | 手写 CommonMark 子集在容器边界三类分叉；裸正则双向分叉（第八轮实证） |
| attachments 字段 | **顺手删除**（schema/实体/DTO/mapper/写方法/测试） | web 零引用、后端读了但无人消费的死字段；html-card 后存在理由塌缩；不留兼容包袱 |
| prompt 分层 | description 骨架 + contract 工具按需 | 必达信道 token 成本 |
| 预算执行 | AI 自重 + 前端兜底（第3张降级/超4KB提示） | 纯契约无强制力 |
| submit 闸 | 每条已发送回执仅一次，拒绝后可重提，连续拒绝 3 次会话内关闭 | "仅首次"与"拒绝丢弃"组合会封死合理路径；防脚本打地鼠 |
| 用户自发卡片 | 静态沙箱渲染，无脚本无桥 | 用户卡片 submit 语义混乱 |
| 命名 | html-card，禁用 artifact | LinkedResource 已占用 |
| UI Spec JSON | 不采用 | 自定义 schema 对 AI 是重约束；HTML 是模型母语 |

## 对抗审视决策史

六轮架构师对抗审视（2026-07-28，每轮独立 agent 对照代码核验），累计 45+ 项决策。记录关键转向，供回溯"为什么是现在这样"：

**第一轮（安全与解析根基）**
- 安全模型整体重写：桥定位为"便利 API 非信任边界"，校验全在父页；导航逃逸三层处理（load 检测 + 契约禁令 + 诚实徽章）；**用户确认改为父页强制预览且永久不可关闭**（否决了"点击直接发送"的初版设想——桥无法区分真人点击与脚本自动调用）
- 解析方案：手写围栏切分 → react-markdown code 组件路由（双解析器必然边界分歧）
- prompt 分层：完整契约塞 description（+800~1500 token/请求）→ description 骨架 + contract 工具按需
- 后端"零改动"声明被证伪：FTS/记忆索引污染、speak body 无长度上限

**第二轮（后端落地）**
- FTS 剥离落地方式：**用户拍板废触发器、应用层写剥离文本**（`messages_fts.body` 存优化投影，body 原文不动），否决加列方案
- 组件引用稳定性（模块级 components + memo）——流式期间 iframe 重挂载风暴
- 回执 payload 硬限制 + 预览 JSON 全可见（堵"借用户消息身份夹带指令"）
- 回执路由定为空数组默认派发（后被第三轮推翻）

**第三轮（事实勘正）**
- body 写入路径 2 条 → 实为 **7 条**；触发器卸载必须保留 DROP（只删 CREATE 老库永不消失）；剥离函数归层 entities
- **回执路由第一次推翻**：空数组 → 显式作者 + 前端在场校验（多獭场景默认派发会派错对象）
- 回执必须复用 handleSend SSE 管线（否则水獭响应在前端消失）

**第四轮（校验归属）**
- **回执路由第二次推翻**：前端校验 → **后端 send() 校验**（DissolveOtter 不级联退场，前端无数据源检测已解散作者；顺带修用户 @ 的存量洞）
- MarkdownContent variant 机制（解开第二轮模块级引用与第三轮用户侧静态渲染的结构矛盾）；rebuild 幂等键

**第五轮（全局完整性，用户指定焦点：不留兼容包袱）**
- 查询出口投影（searchMessages 返回 fts.body——只改匹配不改返回则验收永远不过）
- 卡片×消息状态矩阵（speaking 可交互是轮询带来的既成事实，必须声明）
- **历史注入给剥离投影**（用户决策：接受迭代时多一次 get_message，换每跳每獭的输入成本）；attachments 死字段清除

**第六轮（封版终审）**
- **剥离策略按围栏分叉**：html-card 全路径剥离；html-card-reply 仅索引剥离、注入不剥（否则水獭永远看不到回执 JSON，与 description 矛盾）
- 剥离落点纪律：HTTP list/getById 不剥离（前端渲染依赖原文，一字之差特性全灭）
- fenceIndex 定义落地（remark 插件文档序注解）；failed 行拆两路径；attachments 清除补齐测试与 DROP COLUMN

经验：第 2/3/4 轮连续推翻同一处设计（回执路由），说明多轮独立审视对"当时信息下都正确"的决策链有真实价值；第 5/6 轮证明"单点都对、拼起来缺一块"是文档型设计的典型终局风险。

**第七轮（机制核验与场景推演）**
- **fenceIndex 注解机制纠正**：mdast→hast 不透传任意 `data` key（核验 node_modules 源码），"注解 node.data"会让 cardId 退化为 `{messageId}:undefined`——改 `hProperties` 通道。前六轮按"data 会透传"的直觉集体误判，"最新修订最可疑"再次应验
- **契约补全 id 发现规则**：speak 响应不含 messageId、未读注入排除自己的消息——水獭迭代自己卡片的唯一可靠 id 来源是回执 fence 的 cardId 前缀，无回执时 list_messages 定位；契约补"检索/记忆出口回执也是占位符"
- **已提交卡片语义拍板（用户）**：成功即封死，改答案让水獭基于回执重发新卡
- 决策记录表与改动清单自洽性修补（旧表述分叉、useCardBridge 残留"在场校验"、测试改造漏项）
- 三场景推演验证通过：speaking 中交互→SSE complete（key 稳定不丢预览）、v1/v2 同名卡共存、定时任务链豁免路径

**第八轮（PR 实现审查——设计文档管不到的实现层）**
- **契约样式变量与注入 token 零交集**（契约教 `--otter-bg/--otter-accent`，srcdoc 注入 `--otter-50..900/--paper/--ink`）——守规矩的卡片必然破相。契约对齐注入值 + 交叉断言测试
- **手写 CommonMark 子集解析器废弃，改 remark/mdast + position 切片替换**：实证三类容器边界分叉（list 同级新项、blockquote 裸 `>`、≥4 空格嵌套），且前端 derive 裸正则双向分叉（假阳性砖卡/假阴性绕过"仅一次回执"）。前后端统一 mdast 解析，共享向量补充分叉用例两侧跑
- **user 静态卡片一次性锁死**：loadCount 重置在 interactive 分支内，静态卡再展开必误报逃逸——重置移出分支 + 回归测试
- **安全闸门测试真空**：useCardBridge 校验链与逃逸检测零测试（P1-2 正是这样漏网的）——jsdom 行为测试补齐
- submit 节流补齐（设计明文但实现遗漏）；fenceIndex 缺失 fail-closed；预览丢弃判据改"消息不再含该卡围栏"（收起卡片不丢预览）；cardId 格式断言钉住
- 教训：**文档审查与代码审查是两种不同的审视**——设计文档七轮全绿不代表实现忠实，"照契约使用即出错"的缺陷只有对着代码跑契约才能发现

**第九轮（修复后复审——"最新修复最可疑"再次应验）**
- **GFM 配置漂移**：渲染管线挂 remarkGfm 而后端剥离/前端 derive/插件测试都是裸 parse——R8 声称消灭的分叉只是从裸正则换成配置漂移。footnote definition 是 GFM 容器块，卡片写进脚注时三条解析链判定分裂（预览误丢/索引污染/回执闸门绕过）。三处解析点统一 `remarkParse + remarkGfm({singleTilde:false})` 与渲染管线逐字节对齐（实证零回归），共享向量补 footnote 用例
- **BOM 使 position 切片偏移一字符**：micromark 在剥 BOM 后的值上算 offset，切片落原串错位——R8 切片机制自身的边界缺陷。解析前剥 BOM，向量钉住
- **registry 生命周期分支测试补齐** + 顺手加固：registerCard 覆盖登记时清理旧 window 反向映射（旧 iframe 的 postMessage 不再被认领）
- 教训：**"统一解析"必须统一到配置层**——同一颗 remark 树，插件配置不同就是两种语言

## 改动清单

**后端**：
- `tool-factory.ts` — speak description 追加最小契约；`createTools()` 注册新工具（19→20）
- 新增 `get_html_card_contract` 工具 + `session-helpers.ts` 大小獭白名单登记
- `src/entities/conversation/` — 新增围栏剥离纯函数（覆盖 html-card / html-card-reply 两类）+ 单测（与前端解析共享测试向量）
- `sqlite-conversation-repository` — 7 个写方法接入"剥离 + FTS upsert"，各包 `db.transaction()`；`failInFlightMessages` 改逐行处理；`searchMessages` 返回 fts.body 投影
- `schema.ts` — 保留三句 `DROP TRIGGER IF EXISTS`，删除 CREATE TRIGGER；**删除 attachments 列**
- `migration.ts` — 一次性补丁：存量 FTS rebuild（settings 表幂等键 `messages_fts_stripped_rebuild`）
- `send-message.ts` — `indexMessage` 三调用点（:130/:248/:313）接入剥离函数；`send()` 对显式 talkingStonePassedTo 增加"在场 + active"校验（仅 senderType='user'），不合法退 resolveDefaultTargets；**既有测试改造**（send-message.test.ts 显式目标用例在新校验下的断言更新）
- `message-controller.ts` / `message-tools.ts` — buildMessageWithContext 未读注入、list_messages、get_turn_history 默认返回剥离投影
- **attachments 死字段清除**：实体 Message、DTO（api-contract）、SendMessageRequestDTO、conversation-mapper（:3,:126-127）、manage-participant 两处系统消息构造（:89,:156）、message-controller 透传（:91）、Attachment 接口本体两处、写方法签名、**10 个测试文件 + tests/api/helpers.ts**；migration.ts 加 `DROP COLUMN` 补丁（旧库列残留，该文件已有 ALTER 先例）

**前端**：
- `web/src/lib/html-card.ts` — meta/title 解析、payload 校验（500 字符/2KB/形状），纯函数 + 单测
- `web/src/lib/card-registry.ts` — iframe 注册表
- `web/src/lib/card-bridge.ts` — 桥脚本源码（注入 cardId）
- `web/src/pages/conversation/HtmlCard.tsx` — 折叠/展开/源码三态（memo + 稳定 key）、srcdoc 组装（含 form-action）、逃逸检测、前端预算兜底（第3张降级/超4KB提示）
- `web/src/pages/conversation/hooks/useCardBridge.ts` — 监听 + 校验链 + 预览 + 回执构造（ref 穿透）；已回复集合从历史派生；显式作者路由（校验在后端 send()）；发送复用 handleSend 管线
- `ChatView.tsx` — 输入框上方预览槽位布局
- `MessageList.tsx` — MarkdownContent 加 variant prop，三份模块级 components 映射（otter-body/user-body/event-log）；覆盖 pre 组件
- `conversation/index.tsx` — 接入 useCardBridge + 预览 UI

**文档**：本文件。

## 分阶段实施

- **Phase 1（展示）**：code 路由 + HtmlCard 三态 + 沙箱 + 逃逸检测 + description/contract + FTS 应用层写入迁移 + 预算兜底
- **Phase 2（交互）**：桥 submit + useCardBridge 校验链 + 强制预览 + 回执（cardId、显式作者路由 + 后端校验退默认派发）+ send() 显式目标校验
- **Phase 3（备选）**：版本关联、侧栏工作区

## 验收标准

自动化：
- [ ] 卡片默认折叠；展开后沙箱渲染、样式符合 token；源码可见；刷新后回退折叠态（声明为可接受）
- [ ] 展开后无外网请求；form.submit() 被 CSP 阻断；导航逃逸（location/meta refresh）被检测降级
- [ ] 流式发言期间已展开卡片不重挂载（表单状态保持）
- [ ] 第 3 张卡片降级源码块；超 4KB 折叠态有提示；未闭合围栏降级代码块
- [ ] search_messages 命中结果不含 HTML 标签噪声（剥离占位可搜到 title）；存量消息 rebuild 后同样
- [ ] search_messages / search_memory / list_messages / get_turn_history / 未读注入均返回剥离投影（占位 + 标题），不含 HTML 噪声；get_message 返回原文
- [ ] sqlite_master 中不存在 `messages_fts_*` 触发器；新消息写入后 FTS 仅单行（无双写）；complete/fail（带 body 与不带 body 两种）/abort/failInFlightMessages 各路径写入后 FTS 与剥离文本一致；二次启动不重复 rebuild
- [ ] 后端剥离函数与前端 html-card.ts、useCardBridge 扫描共享同一组测试向量，输出一致
- [ ] 卡片 × 状态矩阵：speaking/failed 可交互、aborted 卡片消失且挂起预览自动丢弃；system 消息围栏纯文本显示
- [ ] event-log 变体中 html-card 一律源码块，不进 registry
- [ ] attachments 字段在实体/DTO/schema 中不再存在
- [ ] （Phase 2）伪造 postMessage（source∉registry / cardId 不匹配 / 超高 resize / 超限 payload / 预览挂起期重发）全部丢弃
- [ ] （Phase 2）预览拒绝后可重提；连续拒绝 3 次该卡 submit 会话内关闭、刷新后重置；发送成功的关闭刷新后仍有效（历史派生）
- [ ] （Phase 2）预览 UI 的 data JSON 全文默认可见（可折叠）
- [ ] （Phase 2）回执显式路由到卡片作者；作者不在场或已解散时后端 send() 退默认派发不报错（已解散作者不被复活）；无兜底目标时失败 toast 可见
- [ ] （Phase 2）回执发送后水獭响应经 SSE 正常出现在消息流
- [ ] （Phase 2）用户消息侧 html-card 围栏静态渲染、无桥无脚本，CSP 与逃逸检测保留；meta refresh 导航被检测降级
- [ ] 小獭可调用 get_html_card_contract 并产出卡片

人工评审：
- [ ] 水獭在方案/对比类请求下自主输出卡片（非每次都出）
- [ ] 后续对话中水獭能输出同名卡片的修改版
- [ ] 水獭正确解析回执 JSON；解析失败时以摘要为准并复述确认
