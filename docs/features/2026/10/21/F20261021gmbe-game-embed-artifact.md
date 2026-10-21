---
id: F20261021gmbe
title: 产物卡「游戏」形态——宿主内嵌游戏面板（麻将实景首发）
summary: 产物卡六形态补「游戏」真内嵌能力：linked_resource 新增 resourceType=game，中间栏渲染为宿主直渲 iframe 游戏面板（sandbox="allow-scripts allow-same-origin"，同源 SSE/fetch 全通 + 拦 top 跳转/弹窗/表单），麻将三麻首发实景。填补「摘要卡+新窗口打开」的能力缺口（搭档 10-21 定调）。
doc_type: feature
change_type: feature
capability_test: web/src/pages/conversation/ArtifactCard.game.test.tsx
created_in_conversation: a00f8fec-1ec0-4c63-9b1d-27b5756b2fc8
created_at: 2026-10-21T09:30:00+08:00
tags: [conversation-view, product-form, game, artifact, embed, mahjong]
modules: [web/src/pages/conversation/ArtifactCard.tsx, src/usecases/conversation/manage-key-info.ts, api-contract/api/key-info.ts]
from: [F20261008csfw, F20261016mjsg]
supersedes: []
intent:
  problem: 产物卡 url/file/pr/fact 四型全是「摘要卡+点击新窗口打开」，无内嵌形态；html-card-play 活类是纯前端小游戏沙箱（CSP connect-src none 断 SSE/fetch），麻将这种有后端的游戏塞不进——产物卡缺「游戏/应用内嵌」形态（搭档 10-21 原话「产物卡能力的严重缺失」「我就要嵌进来」）
  expected_effect: 建房后产物卡在游戏对话中间栏直接渲染为可玩的游戏面板（宿主 iframe sandbox="allow-scripts allow-same-origin"，同源网络全通），搭档不离开对话即可打牌；面板上限宽度/高度适配牌桌最小可用尺寸
  verify_by:
    type: behavior_check
---

# 产物卡「游戏」形态——宿主内嵌游戏面板（麻将实景首发）

## 背景

搭档原话（意图锚，2026-10-21，本对话）：

> 「不是入口，我就要嵌进来。你确认下，产物卡的能力！不要只看html card！产物卡又不止html卡！」（09:15）
> 「哇，那这是咱们中间栏的产物卡能力的严重缺失啊。我当时提的就是这种、能准确展示url/md/html/游戏/图片等等，咋又都变成 摘要+新窗口打开呢，简直离谱。你这次先来把游戏这种做好！借助麻将这个实际场景」（09:25）

### 需求结晶（本需求偏「明确+隐含」类——形态明确，机制需落地，五问自答留痕）

- C1 为谁解决什么问题：搭档+獭——在对话中间栏直接玩/看产物（游戏首发），不用复制 URL 开新标签；游戏类产物（麻将）嵌入后可玩（SSE 实时联动）
- C2 现状怎么应付、代价是什么：现状 ArtifactCard 四型（pr/file/fact/url）全是「摘要卡+ExternalLink 新窗口」（ArtifactCard.tsx:53-123 核实），html-card-play 活类是 CSP 沙箱断网（connect-src 'none'，HtmlCard.tsx:28 核实），麻将游戏 EventSource+fetch 全被堵——代价：搭档被迫「复制 URL 再开一个标签页」，对话与游戏割裂
- C3 成功长什么样：建房后对话中间栏出现游戏产物卡，**卡片内直接是可玩的牌桌**（iframe 宿主直渲，同源 `/mahjong/:roomId`，SSE 全通），搭档在对话里摸打；不玩时可收起/点大
- C4 明确不做什么：不做 url/md/html/图片的通用内嵌（本期只做 game 型，麻将首发——搭档原话「先把游戏这种做好」）；不改 html-card 沙箱安全模型；不动牌局页本身代码（web-mahjong 已是 v3）；不做多游戏注册表（首个 game 实例硬编码麻将路由，通用化留后续）
- C5 最小可交付：linked_resource 支持 `resourceType: "game"`（url 指向 `/mahjong/:roomId`）+ 中间栏 ArtifactCard 渲染 game 型为宿主内嵌 iframe 面板（可玩/可收起/可放大）+ 建房流程自动登记 game 产物

## 目标

T1：linked_resource 新增 `resourceType: "game"`——后端开放字符串已兼容（api-contract resourceType: string 透传，manage-key-info.ts 非 fact 需 url 即可），零 schema 迁移
T2：中间栏 ArtifactCard 渲染 game 型为**宿主直渲 iframe 面板**（sandbox="allow-scripts allow-same-origin"）——同源 `/mahjong/:roomId`，SSE/fetch 网络全通，牌桌可玩
T3：面板尺寸适配——中间栏默认紧凑（折叠态=标题+缩略/「展开玩」按钮），展开态=可玩 iframe（宽 100%·高 600px，中间栏 ≥940px 直接可玩，<940px 纵队需「放大」），支持「放大」modal 全屏
T4：建房流程自动登记——獭建房后 speak 链接的同时 create_linked_resource(resourceType=game, url=/mahjong/:roomId)，产物卡自动混排进时间轴
T5：安全边界不破坏——game 面板 iframe 仅限**同源白名单**（`/mahjong/*` 等本应用路由），不放开任意外部 URL 内嵌（防 XSS/钓鱼挂载）；html-card 沙箱 CSP 不动

## 非目标

- ❌ 不做 url/md/html/图片的通用内嵌预览（后续形态各自立项，本期只游戏）
- ❌ 不改 html-card / html-card-play 沙箱模型（CSP 断网是安全设计，保留）
- ❌ 不动 web-mahjong 牌局页代码（v3 已上线，面板复用现有路由）
- ❌ 不做多游戏/外部游戏注册表（game 型首个实例=麻将，通用 game provider 抽象留后续）
- ❌ 不做面板内布局自适应重写（牌桌 v3 已有窄屏断点，面板给足最小宽度即可）

## 现状分析（锚点均来自本世工具读取）

### 产物卡渲染链现状

- **ArtifactCard**（web/src/pages/conversation/ArtifactCard.tsx）：`TYPE_BADGES[resource.type]` 驱动徽章（pr/file/fact/url 四型），正文渲染=标题+摘要+`ExternalLink` 新窗口按钮（L53-123），无 iframe 内嵌
- **类型透传**：`LocalLinkedResource.type: string`（mappers.ts:182），`mapLinkedResourceDTO` 直接透 `dto.resourceType`（mappers.ts:332）——**web 端类型是开放字符串，加 game 型零迁移**
- **后端契约**：`LinkedResourceDTO.resourceType: string`（api-contract/api/key-info.ts:5），`createResourceInput` 校验仅「非 fact 必填 url」（manage-key-info.ts:88）——**加 game 型无需改后端**
- **挂载点**：MessageList.tsx:682 `<ArtifactCard resource={...}>` 混排进时间轴

### 游戏网络需求（为何沙箱塞不进）

- 麻将 `/mahjong/:roomId` 页：EventSource 连 `/api/mahjong/rooms/:roomId/events`（sse.js:5）+ fetch 动作端点（api.js）
- html-card 沙箱 CSP：`default-src 'none'; connect-src 'none'`（HtmlCard.tsx:28）——EventSource/fetch 全断
- 结论：**游戏面板必须宿主直渲**（对话页渲染 iframe + sandbox="allow-scripts allow-same-origin"），html-card 沙箱通道不可行（connect-src 'none' 断 SSE/fetch，安全模型不能为游戏拆洞）

### 可复用资产

- 牌局页 v3 已有窄屏断点（@media max-width 940px，style.css:525）——面板展开态 ≥940px 直接可玩，<940px 触发纵队重排需「放大」
- 牌局页是独立路由 `/mahjong/:roomId`（server.ts app.get("/mahjong/:roomId")）——iframe src 直挂
- 建房流程：獭调 `/api/mahjong/rooms` POST 建房拿 roomId（麻将引擎獭/大獭现状）
- ArtifactCard 已有展开/收起交互骨架（useState expanded，L40）

## 方案设计

### 形态定位（宪法对齐）

六形态宪法（F20261008csfw）：言/卡/图/活/链/文。**游戏不是第七形态**——是「活」的子型：活类原覆盖纯前端小游戏（html-card-play），本期扩展覆盖**后端应用类游戏**（宿主内嵌 iframe）。产物卡体系（文类 ArtifactCard）新增 game 资源型承载它。

### 核心决策：宿主直渲 iframe（sandbox="allow-scripts allow-same-origin"）

```
对话时间轴
  └─ ArtifactCard（game 型）
       ├─ 折叠态：🀄 标题 + 房间号 + [展开玩] 按钮（与现摘要卡视觉一致）
       └─ 展开态：<iframe src="/mahjong/:roomId">
                     · sandbox="allow-scripts allow-same-origin"（同源 SSE/fetch 全通 + 拦 top 跳转/弹窗/表单）
                     · 同源白名单校验：new URL 解析→拒绝绝对 URL→pathname 全匹配 ^/mahjong/[\w-]+$
                     · 尺寸：宽 100%（中间栏 ≥940px 直接可玩），高 600px；<940px 纵队布局需「放大」盖右侧栏/全屏
```

### 模块改动

| 模块 | 改动 |
|------|------|
| `web/src/pages/conversation/ArtifactCard.tsx` | `TYPE_BADGES` 加 `game: { label: '游戏', icon: Gamepad2 }`；game 型渲染分支：折叠态（标题+房间号+展开按钮）/ 展开态（同源校验后的 iframe 面板 + 收起/放大/新窗口三操作） |
| `web/src/pages/conversation/GameEmbedPanel.tsx`（新） | 内嵌游戏面板组件：同源白名单校验（new URL 解析 + pathname 全匹配 `^/mahjong/[\w-]+$`）、sandbox="allow-scripts allow-same-origin" iframe 挂载、尺寸自适应、加载态/错误态 |
| `web/src/lib/mappers.ts` | 无需改（type 已是 string 透传）；如需 game 专属字段（roomId）可在 url 解析 |
| `src/usecases/conversation/manage-key-info.ts` | game 型 url 前缀校验（`^/mahjong/[\w-]+$` 全匹配）——**必做**（写入时固化数据卫生，防未来白名单扩展时存量脏数据变内嵌面；与 pr/worktree 的 groupId 校验同构） |
| `api-contract/api/key-info.ts` | 无需改（resourceType: string）；文档注释补 game 型说明 |
| 建房流程（大獭/引擎獭 speak 习惯） | 建房后 `create_linked_resource({ resourceType: "game", url: "/mahjong/"+roomId, title })` —— 写入 otter-summon/麻将 workflow 惯例 |

### 同源白名单（安全边界）

- game 面板 iframe src 必须经 `new URL(url, location.origin)` 解析→**拒绝绝对 URL**→pathname 跑**全匹配** `^/mahjong/[\w-]+$`（`[\w-]` 不含 `/` 和 `.`，路径穿越变体被堵）；不通过则降级为「摘要卡+新窗口」（不内嵌）
- **引入 `sandbox="allow-scripts allow-same-origin"`**——iframe 保持同源（SSE/fetch/相对 URL 全通，麻将页零功能损失），同时默认拦 **top-level navigation**（iframe 不能把对话页 parent.location 跳去钓鱼站）、弹窗、表单。麻将页无表单无弹窗，此组合是纯增量防线。诚实标注边界：allow-same-origin 下恶意脚本仍可访问 parent DOM（MDN 警告此组合可自我解除）——防意外不防恶意，但「防整页跳转钓鱼」恰是最现实意外面
- **宿主 CSP 实况**：宿主对话页**当前无 CSP**（web/index.html 无 CSP meta，server.ts 无 CSP 响应头，全仓 grep 仅命中 HtmlCard.tsx 卡片级 CSP）——同源 iframe 天然可挂载，边界=白名单+sandbox 组合+麻将页自身转义纪律（app.js:26-28 esc 纪律），**不存在「宿主 CSP 已允许」的防线**

### 尺寸策略（发现 5 校准——940px 断点灰色区）

- **折叠态**：一行摘要（默认进时间轴的样子）
- **展开态**：iframe 宽 100%（中间栏），高 600px；**中间栏 ≥940px**（牌桌窄屏断点，style.css:525）时直接可玩；**<940px 时牌桌触发纵队重排**（六行单列，总高 >700px 装不下）——此时「放大」从兜底升为主要玩法入口
- **放大态**：modal 全屏（~90vw×85vh），牌桌完整体验

### 后续形态接入契约（发现 6——防类型膨胀路线图）

搭档原话列举 url/md/html/图片皆要内嵌。本期 YAGNI 硬编码麻将成立，但后续形态接入契约先定死，防下次立项重吵：

1. **白名单扩展**：内嵌白名单=代码常量数组（本期 `^/mahjong/[\w-]+$`），新形态接入=往数组加本应用路由前缀（如未来 `/docs/` 内嵌 md）——不走配置，不走数据库
2. **新形态默认降级**：任何资源型/URL 在未显式接入白名单前，一律降级「摘要卡+新窗口」——内嵌是显式开通的特权，不是默认行为
3. **资源型新增论证**：新形态立独立资源型（如 game/md）须过 E2 同款论证（语义独立性 vs url 型泛化污染）——开放字符串无 schema 约束，靠本契约治理防膨胀
4. **外部 URL 永不内嵌**：E5 底线不变——外部站点一律新窗口或 html-card 沙箱断网展示

## 影响范围

- web 端：ArtifactCard + 新增 GameEmbedPanel（纯前端）
- 后端：manage-key-info.ts game 型 url 前缀校验（必做，发现 4）；类型开放字符串本身零迁移
- 牌局页：零改动（复用 v3 路由）
- 獭侧：建房后登记 game 产物的惯例（写入 workflow）

## 风险与约束

| 风险 | 等级 | 缓解 |
|------|------|------|
| 同源 iframe 内嵌的安全面扩大 | 中 | 白名单全匹配仅 `/mahjong/` 路由 + sandbox="allow-scripts allow-same-origin"（拦 top 跳转/弹窗/表单）+ 麻将页 esc 转义纪律；外部 URL 不内嵌 |
| 中间栏宽度不足牌桌可操作 | 中 | 折叠态默认 + 展开态 100% 宽 + 「放大」modal 全屏兜底；牌桌 v3 已有窄屏断点 |
| 多房间面板同时展开内存/SSE 占用 | 低 | 折叠态不挂 iframe（展开才挂）；收起即卸载（iframe 移除断 SSE） |
| game 型被滥登记非游戏 url | 低 | 后端必做 url 前缀校验（manage-key-info.ts）；web 端白名单全匹配兜底降级 |
| 宿主未来引入 CSP 时 frame-src 未含同源 | 低 | frame-src 须含同源（验证节演进约束），否则 game 面板静默挂掉 |
| 宿主/麻将页可被任意外部站点嵌入（clickjacking 存量面，非本方案引入） | 低 | 指引：后续给宿主加 `frame-ancestors 'self'`、麻将页加 `X-Frame-Options: SAMEORIGIN`——同源互嵌不受影响，纯增量；本 PR 不承载，另行立项 |

## 不兼容更新

无（新增资源型，存量四型不变；无 game 型资源时渲染链不触发新分支）。

## 设计取舍

| # | 取舍 | 决策 | 替代方案 | 理由 |
|---|------|------|----------|------|
| E1 | 游戏嵌入通道 | **宿主直渲 iframe + `sandbox="allow-scripts allow-same-origin"`**（同源全通 + 拦 top 跳转/弹窗/表单） | ①html-card-play 沙箱（connect-src none 断 SSE/fetch，麻将塞不进）②开放沙箱 CSP（拆安全模型）③宿主直渲无 sandbox（同源信任，但放弃了拦「iframe 跳转宿主整页」的免费防线） | 沙箱断网使麻将不可行；开放 CSP 不可接受；无 sandbox 放弃了免费防线（麻将页不需跳转宿主的能力应默认关闭）。allow-same-origin 下恶意脚本仍可触 parent DOM（防意外不防恶意）——但防整页跳转钓鱼是最现实意外面 |
| E2 | 资源型载体 | 新增 resourceType=game | 扩展 url 型加 embed 标记 / 复用 file 型 | game 语义独立（后续游戏专属字段：房间状态/入座情况）；url 型泛化会污染外链语义 |
| E3 | 通用化程度 | 首个实例硬编码麻将路由 | 抽象 game provider 注册表 | 搭档原话「先把游戏这种做好，借助麻将实景」——YAGNI，多游戏出现时再抽象 |
| E4 | 默认形态 | 折叠态进时间轴，点击展开玩 | 默认展开即玩 | 折叠态不挂 iframe（省 SSE 连接）；时间轴扫读性优先（与产物卡宪法一致） |
| E5 | 外部 URL 内嵌 | 不放开，仅本应用同源白名单 | 通用 iframe 任意 url | 安全底线：任意外部内嵌=XSS/钓鱼挂载面；要嵌外部走 html-card 沙箱（断网展示）或新窗口 |
| E6 | 面板尺寸 | 折叠/展开 100%/放大 modal 三档 | 固定尺寸 | 中间栏宽度可变（搭档可拖），三档适配可用性 |

## 机制识别检查点（逐项）

- □ 新增配置字段/枚举/开关——无（同源白名单为代码常量，非配置）
- □ 新增状态生命周期——game 面板折叠/展开/放大（会话内 UI 态，不落盘；与 ArtifactCard 现有 expanded 态同构）
- □ 新增定时任务/后台进程——无（iframe 内游戏自己的 SSE 与宿主无关）
- ☑ 新增资源类型——`resourceType: "game"`（linked_resource 新枚举值，开放字符串零迁移，但语义新增）
- □ 新增信号类型/消息格式——无
- □ 新增持久化存储——无（game 资源走现有 linked_resources 表）
- □ 新增决策分支（结果被记住）——无（折叠/展开纯运行时）
- ☑ 新增跨模块调用路径——ArtifactCard → GameEmbedPanel（新组件）→ iframe 牌局路由（宿主网络）

**判定**：机制增量 = 1 个资源型（开放字符串，零迁移）+ 1 个宿主渲染通道（同源白名单 iframe）。**E1 宿主直渲是新渲染通道，走机制预算四问**：

1. **谁需要**：搭档「嵌进来玩」是明确需求（原话）；宿主直渲是唯一不拆沙箱安全模型的路
2. **失败后果**：白名单绕过=外部恶意 URL 内嵌（XSS 面）——缓解：白名单仅 `/mahjong/` 前缀 + web 端校验 + 降级摘要卡兜底；最坏=渲染失败不影响对话其他功能
3. **后续机制**：多游戏时抽象 game provider（E3 已留）；url/md/html 内嵌后续形态复用本通道（E5 外部 URL 仍不放开）
4. **退役条件**：若产物卡体系重构（六形态渲染层统一），game 面板随 ArtifactCard 一并演进而非独立遗留

**结论**：机制增量轻量（1 资源型+1 渲染通道，沙箱安全模型不动），不升重对抗门，常规对抗审视照走。

## 验证

1. web 端测试：ArtifactCard game 型渲染（折叠→展开→iframe 挂载/同源校验/外部 URL 降级）+ GameEmbedPanel 单测
2. 端到端：建房→登记 game 产物→中间栏面板展开→iframe 内入座/摸打/SSE 实时联动可玩
3. 安全：game url 非 `/mahjong/` 前缀时不内嵌（降级摘要卡）；外部 http URL 不内嵌；**白名单穿越用例**：`/mahjong/../api`、`/mahjong/a/b`、`%2e%2e`、`/\mahjong`、绝对 URL `http://evil.com/mahjong/x` 全部拒绝内嵌（发现 3）
4. 目检（搭档 playtest）：对话中间栏直接打麻将，不离开对话
5. **演进约束**（发现 1）：宿主未来引入 CSP 时 frame-src 须含同源——本条登记风险表防静默挂掉

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| web/src/pages/conversation/ArtifactCard.tsx | M | game 型徽章+渲染分支 |
| web/src/pages/conversation/GameEmbedPanel.tsx | C | 宿主内嵌游戏面板组件（同源白名单+iframe+尺寸三档） |
| api-contract/api/key-info.ts | M | resourceType 文档注释补 game 型 |
| src/usecases/conversation/manage-key-info.ts | M | 必做：game 型 url 前缀校验（`^/mahjong/[\w-]+$` 全匹配） |
| tests/web/ 或 web/src/pages/conversation/ArtifactCard.test.tsx | M/C | game 型渲染测试 |
| .pi/skills/otter-summon 或麻将 workflow 文档 | M | 建房后登记 game 产物惯例 |

## 实现记录（2026-10-21，游戏嵌入实现獭）

### 落地清单

| 文件 | 操作 | 要点 |
|------|------|------|
| `web/src/pages/conversation/GameEmbedPanel.tsx` | C | resolveGameEmbedPath 白名单校验（scheme/协议相对/反斜杠/控制字符四拒 → new URL 解析 → origin 复核 → pathname 全匹配 `^/mahjong/[\w-]+$`）；iframe sandbox="allow-scripts allow-same-origin"；加载态遮罩 + 超时探针错误态（15s）+ 重试重建 |
| `web/src/pages/conversation/ArtifactCard.tsx` | M | TYPE_BADGES 加 game（label 游戏/Gamepad2/violet）；折叠态=房间号+「展开玩」，展开态=w-full + GameEmbedPanel + 收起/放大；放大 modal（复用 Modal，90vw）；外部 URL/白名单外降级摘要卡（复用现有 url+新窗口分支） |
| `src/usecases/conversation/manage-key-info.ts` | M | validateGameUrl（GAME_URL_PATTERN 全匹配）入 validateInput——linkResource/supersedeResource 双路径必经 |
| `api-contract/api/key-info.ts` | M | LinkedResourceDTO 文档注释补 resourceType 已用值清单（含 game 约束） |
| `web/src/pages/conversation/GameEmbedPanel.test.tsx` | C | 白名单穿越 5 用例 + 协议相对/javascript:/空值/根路径附加拒绝 + 组件挂载/sandbox 口径/超时重试 |
| `web/src/pages/conversation/ArtifactCard.game.test.tsx` | C | 折叠→展开→收起→放大→外部 URL 降级→穿越降级→非 game 回归，7 用例 |
| `tests/usecases/conversation/manage-key-info.test.ts` | M | game 白名单 6 用例（放行/穿越/多段/外部/缺 url/非 game 回归） |

### 实现期发现（写进代码注释，非方案偏差）

1. **React 19 对 iframe 不接 onError**（react-dom-client.production.js：iframe case 只挂 load 非委托监听，error 仅 img/image/link/source/media）——且浏览器同源 iframe 加载失败本就不冒 error 事件。错误态改由**超时探针**驱动（loading 态 15s 无 onLoad → error，带重试/新窗口出路）；原方案「加载态/错误态」口径不变，触发机制换了更诚实的一种
2. **放大态双挂载**：初版放大时内联面板+modal 面板同时挂载（双 iframe 双 SSE）——改为放大态内联位让位（`gameExpanded && !enlarged`），单实例，与 E4/风险表「收起即卸载」同向
3. **control-char 正则踩坑**：`/[\u0000-\u0020]/` 字面量写进源码时带不可见字符（工具链序列化断裂）——改用 charCode 循环 `hasControlChar`，语义等价且源码可见性好

### 尺寸口径落地

- 折叠态：max-w-md（与现产物卡一致）
- 展开态：w-full（撑满中间栏，≥940px 牌桌断点直接可玩）；iframe h-[600px]
- 放大态：Modal width=90vw，iframe h-[calc(80vh-170px)]（扣 header/padding，内容区上限 calc(80vh-120px) 内）

## 下一步

1. 对抗审视（检视獭，异模型——重点：E1 宿主直渲安全边界、白名单绕过面、机制四问论证）
2. 呈搭档终审（决策简报）
3. 批准后 code-implementation（派实现獭）
