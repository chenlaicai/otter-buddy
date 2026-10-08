---
id: F20261008csf1
title: "协作现场形态补全 P1：图类内联 lightbox + 链类 unfurl 预览卡 + 文类产物摘要卡混排"
summary: "落实 F20261008csfw 宪法 P1：图类（附件图点击原位放大 lightbox，取代新窗口）、链类（裸链 unfurl 预览卡——服务端代理抓 og 元数据 + SSRF 防护 + 失败降级普通链接）、文类（pr/file/fact 产物摘要卡按 createdAt 混排进时间轴诞生位置 + 钉住逃生口）。纯前端 + 一个只读代理端点，数据现成。"
change_type: feature
capability_test: "n/a: 能力验证面 = tests/api/unfurl.test.ts（10 用例：SSRF 拦截/协议白名单/og 解析/降级 404）+ web UnfurlCard.test.tsx（10 用例：裸链判定/降级）+ ArtifactCard.test.tsx（7 用例：混排位置/钉住）——普通 vitest 套件，非 capability 目录"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
causal_links:
  - "F20261008csfw"
  - "F20260913ctlv"
modules:
  - web/src/pages/conversation/MessageList.tsx
  - web/src/pages/conversation/ArtifactCard.tsx
  - web/src/pages/conversation/UnfurlCard.tsx
  - web/src/lib/remark-bare-link.ts
  - src/interface-adapters/http/controllers/unfurl-controller.ts
tags:
  - conversation-view
  - artifact
  - unfurl
  - product-form
created_at: "2026-10-08T18:50:00+08:00"
---

# 协作现场形态补全 P1

> 宪法见 F20261008csfw（协作现场世界观 v2）。本文是实现层：P1 = 图/链/文三类形态落地。

## 目标与非目标

**目标**（宪法 P1 范围）：
1. **图类内联**：消息内图片「缩略即全文，点击原位放大」——lightbox 遮罩层，不再跳新窗口
2. **链类 unfurl**：裸链段落（正文只有一个 URL）渲染预览卡（标题+描述+站点+favicon），抓取失败降级普通链接
3. **文类摘要卡**：pr/file/fact 类型产物按登记时间（createdAt）混排进时间轴，在诞生位置插入摘要卡；钉住逃生口

**非目标**：
- 活类可玩模式（P2，前置沙盒安全评估）
- 产物链视图（P3）
- PR 卡的 diff 统计/CI 状态（linked_resources 表无此数据，需接 gh API，宪法 P1 范围外）
- 产物清单 tab 退役（右栏整理另行 PR）

## 方案设计

### 图类：lightbox 原位放大

`MessageList.tsx` 内 `ImageLightbox` 组件：点击缩略图 → fixed 遮罩层（bg-black/70）+ 图片 max-w-[92vw]/max-h-[88vh]。Esc/点击遮罩/右上按钮关闭；打开期间锁 `document.body.style.overflow` 防滚动穿透。取代原 `target=_blank`（打断对话现场，违背「原位感知」）。

### 链类：unfurl 预览卡

**数据源**：`GET /api/unfurl?url=<encoded>` → `UnfurlResult | 404`。

为什么服务端代理而非前端直连：①CORS——外部站点普遍不放行浏览器跨域读 HTML；②SSRF 防护集中（仅 http/https、禁内网段：localhost/127.*/10.*/192.168.*/172.16-31.*.local/.internal）；③目标站只见服务端 IP。

`UnfurlController` 关键决策：
- **正则提取 og 元数据**而非 DOM 解析（cheerio/jsdom 均重依赖）——og 的 meta 标签形态规整（无嵌套），property/content 两种属性顺序都收
- **降级语义统一 404**：超时（AbortSignal.timeout 5s）/非 2xx/非 HTML/og 全空 → 前端只区分「有卡/无卡」，无卡渲染普通链接（与未接特性前视觉一致——宪法失败降级要求）
- **体积上限 512KB** 截断解析（og 都在 head）；UA 声明桌面 Chrome（部分站对无 UA 返回 403）
- og:image 归一化为绝对 URL 并过 SSRF 复查；60s private 缓存防同会话重复抓

**前端 `UnfurlCard`**：会话级缓存（同 URL 只抓一次，StrictMode 双挂载保护）；loading 态显示脉动 Globe；favicon 走 google s2 服务、onError 换兜底图标不露破图。

**裸链判定（关键坑）**：初版在组件层用 `node.parent` 找父段落——**react-markdown 传给 components 的 hast 节点没有 .parent 指针**（unist 树不回填父指针，parent 只在 visitor 签名里），组件层永远拿不到段落上下文，测试暴露后改走项目既有模式：**remark 插件阶段判定**。`remark-bare-link.ts` 在 mdast 遍历时给「单 link 子节点且文本=url」的段落链接写 `data.hProperties.dataBareUrl`（与 remark-html-card-index 的 fenceIndex 同通道——mdast→hast 只透传 hName/hProperties/hChildren），组件从 `node.properties.dataBareUrl` 读。fail-closed：标记缺失维持行内链接。裸链标准：URL 与链接文本一致（`[label](url)` 有作者锚文本不算）。

### 文类：产物摘要卡混排

`ArtifactCard`（pr/file/fact 三类徽章：PR/文档/事实）：
- **fact**：content 全文直出（≤500 字）——「结论卡」的信息增量
- **file**：首段摘要（≤220 字截断）+「展开全文」
- **pr**：标题+直达链接（无 diff 统计数据，见非目标）
- **钉住**：前端 UI 状态（`pinnedIds` Set），钉住的卡高亮（otter tint 底色）——**不落持久化、不做空间位移**（渲染两份违反时间轴纯净性；宪法允许 P1 从简）
- 视觉与气泡强区分：边框+底色+类型徽章（混排可扫读性的来源）

**混排定位口径**：linked_resources 无 entry 外键（P1 不加列避免 DB 迁移），用 `createdAt` 与消息 `ts` 对比找首个不早于登记时间的消息插其前；晚于全部消息附末尾。稳定性：同刻并列时资源在前（先登记后说话）。

**数据流**：DTO `createdAt` 本就在 contract（api-contract/api/key-info.ts:15），仅前端 mapper 透出（`mapLinkedResourceDTO`）→ `index.tsx` 的 `activeLinkedRes` → `ChatView` → `MessageList.timeline`（useMemo 混排）。

## 测试

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| tests/api/unfurl.test.ts | 10 | SSRF 内网段拦截、协议白名单、og 属性两序、`<title>` 兜底、实体解码、非 HTML 降级、og 全空 404 |
| web/…/UnfurlCard.test.tsx | 10 | isBareUrlText 五态（纯 URL/带空白/句中/Markdown 链接/多行）、抓取成功渲染、失败降级、fetchUnfurl 异常返回 null |
| web/…/ArtifactCard.test.tsx | 7 | createdAt 插入位置三态（中间/末尾/最前）、非 pr-file-fact 不混排、file 首段摘要+展开、钉住切换、徽章可见 |

全量回归：后端 5027 + 前端 667 全绿。测试侧修正（实现獭半成品遗留）：`timelineOrder()` helper 需 `matches()` 自查（消息 div 的 data-message-id 在自身不在子节点）；unfurl 成功用例需 6 轮微任务 flush（fetch→Response.json→setState 链）。

## 取舍与已知限制

- **混排只认 pr/file/fact**：url/worktree/branch 类型信息密度低（无 content 本体），混排成噪音——留清单层检索用
- **钉住是 UI 态**：刷新即失——长期驻留需求等 P3 产物链/检索层系统化解法，P1 不引入持久化复杂度
- **og 解析靠正则**：极端畸形 meta 会漏——降级普通链接，可接受（预览是增量不是保底）
- **unfurl 无转链重定向跟踪**：redirect: follow 由 fetch 默认处理，跨域重定向后的 host 不在 SSRF 复查范围（目标站重定向属目标站行为）——已知边界，P2 如需收紧再加
- **同刻消息/产物排序**：资源在前的人为约定（先登记后说话的常见因果），极端并发倒挂无数据可辨

## 后续（衔接宪法分期）

- P2 活类可玩：html-card 沙盒加运行模式 + 安全评估
- P3 产物链视图：linked_memory 图谱渲染（时间轴管现场、关系链管脉络）
- 右栏产物清单 tab 退役（P1 验收后整理 PR）
