---
id: F20260907sgpt
title: "信号高度变化贴底补偿：修复信号 chip/徽标/GateBanner 引起的视口周期性上跳"
doc_type: feature
summary: >
  搭档第五次报告「消息框自动上跳、不在最底部」（09-07）。排查确认 #790（F20260904smsj）
  只修了发言时刻未读分隔线一条路；本 PR 补齐其余路径：信号轨迹 chip（trailItems 2s 轮询
  异步到达）、信号徽标（SSE 终态替换 tmp- 消息，条数不变）、GateBanner 插入等高度变化
  均不改 messages.length，而滚动补偿 effect 只看条数 → 无补偿 → 在底部时视口漂离。
  修法：双 ResizeObserver——contentObserver 观测滚动容器内的内容包裹 div（chip 弹出/
  徽标出现/流式增长时 contentRect.height 真实变化），在底部时高度增大即贴底；
  viewportObserver 观测滚动容器本身（GateBanner 出现压缩视口时拉回）。
  不在底部（上翻阅读）/高度减小不打扰。修复「这一类」而非逐个打地鼠。
change_type: fix
tags: [conversation, scroll, signal-trail, resize-observer, ux]
modules: [web/src/pages/conversation/MessageList.tsx]
capability_test: "n/a: 前端滚动交互行为，MessageList.test.tsx 新增 3 用例（jsdom 伪造型 scrollHeight/scrollTop 计数断言）+ 既有 9 用例回归通过，407 例全绿"
created_in_conversation: d8a282d9-e0e7-4cdc-931b-96abbe68cc22
causal_links:
  from:
    - F20260818nscp   # virtuoso→原生滚动迁移：overflowAnchor:'none' 的出处
    - F20260904smsj   # #790 只修了发言时刻一条路，本 PR 补齐其余高度变化来源
  references:
    - F20260902u5tr   # 信号轨迹 chip（本 bug 的主要触发源）
    - F20260903s35u   # GateBanner（高度变化来源之一）
---

# F20260907sgpt: 信号高度变化贴底补偿

## 需求背景

搭档报告（09-07，同类现象第五次）：
「现在对话界面中，消息框还是会自动上跳一下，而不是维持在最底部……应该跟那个信号有关」

历史修复链：F20260803vmsg → F20260805abpp → F20260810p7zg（三连修后整体重构迁移到原生滚动
F20260818nscp）→ F20260904smsj（#790，发言即已读）。#790 只修了「发言时刻未读分隔线」
那一条路，其余高度变化来源未覆盖。

## 根因分析

### 为什么 messages.length effect 补偿不到

`MessageList.tsx` 滚动补偿 effect（L233-246）以 `messages.length` 为依赖：
条数不变 → 直接 return。但以下三个信号相关的高度变化来源都**不改消息条数**：

| 来源 | 机制 | 高度变化 |
|------|------|---------|
| 信号轨迹 chip（F20260902u5tr） | `trailItems` 由 2s 轮询异步到达（index.tsx:452），到达后消息下方弹出 pill（~36px） | 内容高度增大 |
| 信号徽标（F20260826mwrd C4） | SSE 终态消息替换 tmp- 乐观消息（insertBySeq 同 id 替换，条数不变），`m.signals` 渲染徽标 | 内容高度增大 |
| GateBanner（F20260903s35u） | `gateState` 随同轮询到达，halted/rateLimited 时在滚动容器外（ChatView flex 同级）插横幅 | 视口高度减小（flex-1 被挤压）——检视发现 3 修正：原描述误归为内容增大 |
| （对照）流式过程面板折叠 | streaming→completed 折叠，条数不变 | 内容高度减小 |

### 为什么浏览器自己不补

原生滚动迁移（F20260818nscp）设了 `overflowAnchor: 'none'`（MessageList.tsx:354）
——避免与手动滚动指令打架。原生滚动锚定关闭 + 手动补偿只认条数 = 高度变化
无人补偿 → 在底部时视口漂离底部 → 搭档看到的「上跳一下」；下一条真消息到达
（条数变化）时猛地弹回底部 → 「跳一下」。

## 方案设计

### 核心思路：从「按来源打地鼠」到「按现象补偿」

前四轮修复都是「某个来源出现 → 在那个来源的渲染点补滚动」——每补一个，
下一个来源又冒出来。这次直接盯**高度**本身，且区分两种高度语义：

- **内容高度**（scrollHeight 语义）：chip/徽标/流式增长——contentObserver 观测
  滚动容器内的**内容包裹 div**（普通 block，contentRect.height = 内容总高度）。
  不可观测滚动容器本身：flex-1 容器的 contentRect.height 是视口布局高度，
  内容变化不触发（首版实现踩坑，检视发现 1）
- **视口高度**（clientHeight 语义）：GateBanner 出现/loadingMore 指示条/窗口缩小
  会压缩 flex-1 视口——viewportObserver 观测滚动容器，视口减小且在底部时拉回

### 行为条目

1. **内容高度增大 × 在底部** → rAF 后 `scrollTop = scrollHeight`（贴底补偿）
2. **视口高度减小 × 在底部**（GateBanner 出现等）→ rAF 后贴底拉回
3. **高度增大 × 不在底部**（用户上翻阅读中）→ 不打扰
4. **内容高度减小**（流式面板折叠）/ **视口增大**（banner 消失/窗口拉大）→ 不写 scrollTop
5. **高度不变**（width-only resize）→ 不动作
6. **上翻加载历史的 preserve-scroll**（pendingScrollRestoreRef 路径）→ 与本机制互斥不干扰
7. **切会话**：滚动容器带 key={conversationId} 重建 → observer 依赖 [conversationId] 重挂，
   采样基线归零重启（首版 mount-only 会观测已卸载元素而失效——自查发现，检视报告外围加固）

### 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 监听对象 | A：双 ResizeObserver（内容包裹 div + 滚动容器） | B：逐来源在渲染点补滚动 | B 已打地鼠 4 次证明不可持续；A 与来源解耦，对未来的高度来源也免疫 |
| 内容观测目标 | 内容包裹 div | 滚动容器本身 | 容器的 contentRect.height 是视口布局高度（flex 决定），内容变化不触发——检视发现 1 实证 |
| 补偿时机 | rAF 合帧 | 直接同步写 | 高频 resize（流式渲染）下避免布局抖动 |
| 减小时处理 | 不补 | 双向都补 | 减小时 scrollHeight 缩短，浏览器保持 scrollTop、视口被自然推近底部，isNearBottom(100px) 重判——补了反而可能造成反向跳动 |
| 挂载点 | MessageList 内部 | index.tsx | 滚动容器与 isAtBottomRef 都在 MessageList 内，内聚 |
| 兼容性 | `typeof ResizeObserver === 'undefined'` 优雅降级为无补偿 | 不降级 | jsdom/老浏览器环境不崩，行为退回现状 |

## 实现

单文件改动（MessageList.tsx）：
- 内容包裹 div（contentRef）：ResizeObserver 的内容观测目标，普通 block 高度随内容真实变化
- 双 observer effect（依赖 [conversationId]）：contentObserver（内容增大×在底→贴底）+
  viewportObserver（视口减小×在底→拉回）；各自采样基线 ref；rAF 合帧；缺 ResizeObserver 优雅降级
- 测试（MessageList.test.tsx 7 用例，jsdom 伪造型 + 结构断言）：
  1. 结构：contentObserver 观测内容包裹 div、viewportObserver 观测滚动容器（检视发现 1 回归锚）
  2. 内容高度增大×在底 → 贴底（信号 chip 弹出场景）
  3. 内容高度增大×上翻阅读 → 不打扰
  4. 内容高度减小 → 不写
  5. 视口高度减小（GateBanner 出现）×在底 → 拉回
  6. 视口高度增大（banner 消失）→ 不写
  7. 切会话 observer 重挂、基线重置

## 对抗审视与处置（检视獭：mimo，异模型）

| 发现 | 分级 | 处置 |
|------|------|------|
| 1. ResizeObserver 观测对象错误：滚动容器的 contentRect.height 是视口布局高度，内容变化不触发，首版核心机制在真实浏览器不生效；jsdom 手动 fire 掩盖了这一点 | 严重 | 接受并修复：新增内容包裹 div 作为观测目标（采纳其方案 A）；补充结构断言用例锁定观测对象 |
| 2. 测试只验证回调逻辑、不验证 observer 真挂对目标 | 严重 | 接受并修复：新增结构断言（observer × 观测目标对应关系）作为回归锚；fire 改为按 target 解析实例 |
| 3. 特性文档把 GateBanner 误归为内容高度增大来源（实际在滚动容器外，压缩视口） | 建议 | 接受并修复：文档表格与行为条目改为「视口高度减小」语义，新增行为条目 2/视口 observer |
| 4. CI 需 rebase（branch behind main） | 建议 | 接受并修复：rebase 后重推 |
| （自查，检视外围）切会话时滚动容器带 key 重建，mount-only observer 观测已卸载元素失效 | — | 顺手修复：effect 依赖 [conversationId] 重挂 + 基线归零 + 用例 7 锁定 |

## 验证

- `npx vitest run src/pages/conversation/MessageList.test.tsx`：16/16 通过（含新增 7 例）
- `npx vitest run`（web 全量）：47 文件 411 用例全绿，无回归
- `npx tsc --noEmit`（web）：通过
- `npx eslint MessageList.tsx MessageList.test.tsx`：通过
- **最简实现检查**：已过——无新依赖（ResizeObserver 是平台原生 API）、除内容包裹 div 外无新文件级结构；阶梯检查：仓库已有实现（card-bridge.ts 已用 ResizeObserver，但那是 body 卡片高度上报，语义不同）→ 平台原生 → 采纳；双 observer 是发现 1/3 修正后的最小正确结构（单 observer 无法同时覆盖内容增大与视口压缩两类语义）
- 人工验收（待合并后搭档确认）：① 底部等待獭回复 → 信号 chip 弹出时视口不再上跳；② 上翻阅读历史时 chip 弹出不打扰；③ GateBanner 出现/消失不跳
