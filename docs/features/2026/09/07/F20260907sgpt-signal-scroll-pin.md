---
id: F20260907sgpt
title: "信号高度变化贴底补偿：修复信号 chip/徽标/GateBanner 引起的视口周期性上跳"
doc_type: feature
summary: >
  搭档第五次报告「消息框自动上跳、不在最底部」（09-07）。排查确认 #790（F20260904smsj）
  只修了发言时刻未读分隔线一条路；本 PR 补齐其余路径：信号轨迹 chip（trailItems 2s 轮询
  异步到达）、信号徽标（SSE 终态替换 tmp- 消息，条数不变）、GateBanner 插入等高度变化
  均不改 messages.length，而滚动补偿 effect 只看条数 → 无补偿 → 在底部时视口漂离。
  修法：ResizeObserver 盯内容高度，在底部时任何来源的高度增大都重新贴底；
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
| 信号轨迹 chip（F20260902u5tr） | `trailItems` 由 2s 轮询异步到达（index.tsx:452），到达后消息下方弹出 pill（~36px） | 视口内 +36px |
| 信号徽标（F20260826mwrd C4） | SSE 终态消息替换 tmp- 乐观消息（insertBySeq 同 id 替换，条数不变），`m.signals` 渲染徽标 | 视口内若干 px |
| GateBanner（F20260903s35u） | `gateState` 随同轮询到达，halted/rateLimited 时消息流上方插横幅 | 列表整体下移 |
| （对照）流式过程面板折叠 | streaming→completed 折叠，条数不变 | 高度减小 |

### 为什么浏览器自己不补

原生滚动迁移（F20260818nscp）设了 `overflowAnchor: 'none'`（MessageList.tsx:354）
——避免与手动滚动指令打架。原生滚动锚定关闭 + 手动补偿只认条数 = 高度变化
无人补偿 → 在底部时视口漂离底部 → 搭档看到的「上跳一下」；下一条真消息到达
（条数变化）时猛地弹回底部 → 「跳一下」。

## 方案设计

### 核心思路：从「按来源打地鼠」到「按现象补偿」

前四轮修复都是「某个来源出现 → 在那个来源的渲染点补滚动」——每补一个，
下一个来源又冒出来。这次直接盯**高度**本身：

ResizeObserver 观察滚动容器，用户在底部（`isAtBottomRef.current === true`）时，
任何来源的内容高度增大都把 scrollTop 重新贴到底。

### 行为条目

1. **高度增大 × 在底部** → rAF 后 `scrollTop = scrollHeight`（贴底补偿）
2. **高度增大 × 不在底部**（用户上翻阅读中）→ 不打扰
3. **高度减小**（GateBanner 消失、流式面板折叠）→ 不写 scrollTop：scrollHeight 缩短
   本身会把视口推到 ≥ 新底部位置，isNearBottom 重判，不产生上跳
4. **高度不变**（width-only resize）→ 不动作
5. **上翻加载历史的 preserve-scroll**（pendingScrollRestoreRef 路径）→ 与本机制互斥不干扰
   （本机制只在 isAtBottomRef=true 时动作，而 preserve 时用户必然不在底部）

### 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 监听对象 | A：ResizeObserver 盯容器内容高度 | B：逐来源在渲染点补滚动 | B 已打地鼠 4 次证明不可持续；A 与来源解耦，对未来的高度来源也免疫 |
| 补偿时机 | rAF 合帧 | 直接同步写 | 高频 resize（流式渲染）下避免布局抖动 |
| 减小时处理 | 不补 | 双向都补 | 减小时 scrollHeight 缩短，浏览器保持 scrollTop、视口被自然推近底部，isNearBottom(100px) 重判——补了反而可能造成反向跳动 |
| 挂载点 | MessageList 内部 | index.tsx | 滚动容器与 isAtBottomRef 都在 MessageList 内，内聚 |
| 兼容性 | `typeof ResizeObserver === 'undefined'` 优雅降级为无补偿 | 不降级 | jsdom/老浏览器环境不崩，行为退回现状 |

## 实现

单文件改动（MessageList.tsx）：
- `prevContentHeightRef`：上次采样的内容高度
- mount-only ResizeObserver effect：高度增大且在底部 → rAF 后贴底；
  闭包经 ref 读最新状态，无需重订阅
- 注释完整记录背景、边界处理与历史修复链

测试（MessageList.test.tsx 新增 3 用例，jsdom 伪造型 scrollHeight/scrollTop）：
1. 高度增大且在底部 → scrollTop 被写为 scrollHeight（贴底补偿，信号 chip 弹出场景）
2. 高度增大但用户不在底部（上翻阅读中）→ 不打扰
3. 高度减小 → 不写 scrollTop

## 验证

- `npx vitest run src/pages/conversation/MessageList.test.tsx`：12/12 通过（含新增 3 例）
- `npx vitest run`（web 全量）：47 文件 407 用例全绿，无回归
- `npx tsc --noEmit`（web）：通过
- `npx eslint MessageList.tsx MessageList.test.tsx`：通过
- **最简实现检查**：已过——无新依赖（ResizeObserver 是平台原生 API）、无新文件、
  32 行实现 + 3 用例；阶梯检查：仓库已有实现（card-bridge.ts 已用 ResizeObserver，
  但那是 body 卡片高度上报，语义不同）→ 平台原生 → 采纳
- 人工验收（待合并后搭档确认）：① 底部等待獭回复 → 信号 chip 弹出时视口不再上跳；② 上翻阅读历史时 chip 弹出不打扰；③ GateBanner 出现/消失不跳
