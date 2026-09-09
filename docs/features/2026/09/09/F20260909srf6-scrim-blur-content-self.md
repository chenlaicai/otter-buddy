---
id: F20260909srf6
title: 弹窗背景玻璃闪烁根治（第六轮）——模糊语义切换：scrim 实时采样 → 内容自模糊
summary: 白名单式冻结补至第五源仍漏网（流式计时器 100ms setElapsed 绕过全部 gate），结构性不治本；本轮改语义——弹窗期内容区挂 filter:blur（模糊连续跟随内容、无清晰帧跳变），scrim 摘掉 backdrop-filter 只留变暗，搭档真实页面注入验收通过后落地。
change_type: fix
tags: [web, ui, glass, css, performance]
modules: [web/src/styles/globals.css, web/src/styles/scrim-flicker-6.test.ts]
from: [F20260825scrf, F20260827scrf2, F20260824m2345]
created_in_conversation: bc4ca9ba-9348-4283-afbf-e2d6f2dd12de
---

# F20260909srf6：弹窗背景玻璃闪烁根治（第六轮）

## 背景与需求

### 问题现象

9/9 搭档反馈：点开海獭面板（OtterDetailModal）且底下有海獭流式输出时，背景玻璃仍在闪动（清晰↔模糊交替）。该问题此前已修 5 轮。

### 搭档意图锚（原话）

> 「我记得最终采用方案是固定点击当时的背景作为玻璃来渲染、然后不再实时渲染，为什么现在还有这个闪动问题」
> 「我要玻璃质感」「背后像素变化了、但为什么玻璃上的效果特别诡异呢，高频闪动。但其实如果没有玻璃的，我其实不觉得当前流式过程这些内容的变动很"刺眼"」

### 前五轮简史（全部白名单式冻结）

1. F20260824m2345（PR#382）：React.memo + useCallback——对合成器重采样无效
2. F20260825scrf（PR#456）：Portal + 冻结 SSE batch / 双轮询 / shimmer
3. F20260827scrf2：第五源治理（SSE 回调直连 setState 走 deferred ops）
4. 每轮共性：冻结「已知全部变化源」，新源漏网即复发；且每轮验收都未复现生产场景（8/27 血泪教训：空库单对话验收通过，生产多獭流式照闪）

## 本轮根因

### 漏网源（第六源）

流式计时器 `web/src/pages/conversation/MessageList.tsx:709`：StreamingProcess 在 inFlight 期间每 100ms `setElapsed` 更新「进行中 · X.Xs」文本——不走 MessageBatcher defer、不在任何 modalOpen gate 内，弹窗期照跑，驱动 scrim 背后像素 10Hz 变化。

### 结构性根因（本轮真正的结论）

backdrop-filter 的采样是**每帧实时**的：下层任何像素变化都使模糊缓存失效，重算间隙的帧直接显示未模糊背景——「清晰帧↔模糊帧」跳变才是刺眼的元凶（视觉系统对失焦/对焦交替敏感，对内容连续运动不敏感）。**白名单冻结在结构上是打地鼠**——只要未来再加任何动画/计时器，就再闪一次。搭档的洞察（「没有玻璃的话内容变动并不刺眼」）指明了正确语义：让模糊稳定挂在内容自己身上，内容怎么动、模糊连续跟随，等效于「隔着真毛玻璃看活内容」。

## 方案设计

弹窗期（body.modal-open，Modal.tsx 既有机制）模糊语义切换：

- 内容区自模糊：`body.modal-open [data-testid='app-content-scroll'] { filter: var(--scrim-blur) }`——AppLayout 主内容滚动容器挂 filter:blur(6px)，与 scrim 原模糊强度同 token
- scrim 只变暗：`body.modal-open .scrim { backdrop-filter: none }`——不再实时采样，闪烁机理整体消除
- 无障碍不回归：prefers-reduced-transparency 下内容区 filter:none（该模式本就全实色无模糊）
- 原 F20260825scrf 降级开关（纯色遮罩注释）退役——本方案即永久解，无需保留降级路径

### 关键取舍

- **舍**「截图固定背景」（html2canvas 类）：实现搭档字面期望，但开销大、边界情况多（滚动/缩放/窗口 resize 穿帮），且浏览器无原生支持——历史上已否决，本轮维持否决
- **舍**继续冻结第六/第七源（narrow-fix 路线）：治本次不治本，下一轮动画源出现时再闪
- **取**内容自模糊：模糊状态连续跟随内容变化，无清晰帧跳变；新动画源自动免疫（模糊在内容层，与内容同步重绘，无采样失效间隙）
- **视觉差异**：scr­im 变暗层之下，模糊的是「内容自身渲染」而非「下层位图采样」——视觉上同为毛玻璃，搭档验收确认质感可接受（原话「可以，有效果！」）
- **既有冻结机制保留**：index.tsx 的 batcher defer / 轮询 gate / deferred ops 不删——它们对数据一致性（关窗 flush 零丢失）仍有价值，且已无前科负担；若未来确认纯冗余可另行评估清理

### 验证方式（本轮新方法，吸取 8/27 验收盲区教训）

玩具对比页（工作区 scrim-compare.html）无法复现真实页面的 reflow 放大器，左边现状也没闪——证明玩具页断言无效。改为**搭档真实页面 DevTools 注入验收**：Console 注入等价 CSS 规则 + 开关按钮，流式期间开关海獭面板对比「现状 ↔ 新方案」，搭档确认「有效果」后才落地代码。

## 变更

- `web/src/styles/globals.css`：modal-open 期内容区 filter:blur + scrim 摘 backdrop-filter；退役旧降级开关注释
- `web/src/styles/scrim-flicker-6.test.ts`：新增样式契约测试 4 例（内容区挂 blur / scrim 摘 backdrop-filter / reduced-transparency 不回归 / 旧开关已退役）

测试：4 新例 + Modal/Modal.stack/AppLayout 既有 13 例全过（17/17）。

## 影响范围

- 所有 Modal 弹层（海獭面板、新建对话、定时任务等）打开期间的背景渲染语义
- 视觉：弹窗期背景模糊从「采样模糊」变「内容自模糊」，scr­im 变暗不变；关窗即恢复，无残留
- 性能：filter:blur 在内容区常驻（弹窗期），GPU 合成开销与 backdrop-filter 同量级

## 修法排序声明

②收窄管辖（scope-reduction）：把模糊的管辖从「scrim 对全页面实时像素的采样权」收窄为「内容区对自身渲染的滤镜」——未新增机制（modal-open class、scrim、AppLayout 容器皆既有），未走 ④ 故无重对抗门。

Modification-Class: scope-reduction
