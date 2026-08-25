---
id: F20260825scrf
title: 弹窗背景玻璃闪烁根治（第二轮）——结构解耦 + 冻结渲染
summary: 上轮 React.memo 修复无效（backdrop-filter 重算由背后像素变化驱动，非 re-render）；本轮 Portal 结构解耦 + 弹窗期冻结三源渲染（SSE batch/双轮询/shimmer），关窗 flush 零丢失，根治流式期间弹窗背景清晰↔模糊交替。
change_type: fix
tags: [web, ui, glass, css, react, performance]
modules: [web/src/components/Modal.tsx, web/src/lib/batch-update.ts, web/src/pages/conversation/index.tsx, web/src/styles/globals.css]
from: [F20260824m2345, F20260814qswp]
created_in_conversation: be190532-2eb0-4635-9adb-a2430d3040ef
---

# F20260825scrf：弹窗背景玻璃闪烁根治（第二轮）

## 背景与需求

### 问题描述

8/24 修复（F20260824m2345，PR#382：React.memo + useCallback）合入后，用户再次反馈：最新版本上，打开弹窗且底下对话处于流式过程时，scrim 玻璃效果仍然"一下子清晰一下子模糊"交替闪烁。

### 上一轮修复为什么无效

上轮根因分析列出了 scrim 背后的三个变化源：①5 秒列表轮询；②SSE batch（50ms 窗口）持续更新 allMessages；③stream-shimmer 动画（1.6s infinite）。但修复只做了 React 层优化（memo/useCallback），它消除的是「Modal 组件被动 re-render」这一条链路；**backdrop-filter 的重算由 scrim 背后位图（像素）变化驱动，与 Modal 是否 re-render 无关**——memo 对②③完全无效。验收标准只写了「打开弹窗等 10 秒」，未覆盖流式场景，形成验收盲区。

### 本轮根源分析（kimi 独立排查 + 大獭补强）

- **机理**：backdrop-filter 合成路径 = 光栅化背后内容 → 应用 blur → 与遮罩合成。背后像素一变，旧模糊缓存失效，**重算间隙的帧直接显示未模糊的清晰背景**，下一帧恢复——清晰↔模糊交替由此而来。
- **三个变化源节奏**：SSE batch 50ms（20Hz 文本追加，index.tsx `BATCH_WINDOW_MS`）；shimmer 1.6s 无限动画每帧扫过（globals.css `.stream-shimmer::after`，MessageList.tsx:535）；in-flight 自续期轮询每 2s（index.tsx:352-370，effect 依赖 allMessages 频繁重跑）。
- **结构性根因**：Modal.tsx 的 scrim div 同时是面板布局容器，无 Portal、无合成隔离，与页面内容同层同树——React 层优化无法触及合成器行为，这是"打补丁打不好"的准确位置。
- **大獭补强**：kimi 方案 A 只暂停了 shimmer，但 SSE 文本 20Hz 追加同样驱动背景像素变化——弹窗打开期间必须把流式更新本身一并冻结，否则照闪。另发现 5 秒列表轮询的 mergeConversations 每次产出新引用（lastMessagePreview 持续变），同样需要暂停。

## 方案设计

**思路**：结构解耦（Portal）+ 弹窗期间冻结背景渲染（三源全停）+ 纯色降级开关（CSS 一行可切）。

1. **Portal**：Modal 用 createPortal 挂 document.body——scrim 脱离页面组件树（DOM 结构与事件冒泡解耦）。注：backdrop-filter 的采样语义跨 DOM 子树（scrim 仍采样页面内容位图，无论挂哪），冻结闪烁的真正机制是下述三源冻结，Portal 本身对合成零影响（检视 A-1 更正）。
2. **冻结 SSE batch**：MessageBatcher 新增 `getShouldDefer` 选项——弹窗打开期间窗口到期不产出（pending 暂存链完整保留），关窗时 `batcher.flush()` 一次性追上。流式内容零丢失，关窗瞬间背景更新到真实状态。
3. **冻结自续期轮询**：effect 入口 `modalOpenRef.current` 为真时直接 return——关窗后 allMessages 变化自然重跑 effect，轮询链自动接续，终态收敛不受影响。
4. **冻结 5 秒列表轮询**：useConversationListPolling 的 enabled 参数追加 `&& !modalOpen`——关窗后 interval 立即重建。
5. **冻结 shimmer**：`body.modal-open .stream-shimmer::after { animation: none }`——body class 由 Modal 组件在 open 期间挂载/卸载（多重弹窗共存安全：仅当 body 无其它 scrim 时才移除）。
6. **降级开关**：globals.css 预留注释掉的 `body.modal-open .scrim { backdrop-filter: none }`——若 backdrop 路线在目标环境回归失败，取消注释即切纯色遮罩，永久消除闪烁（视觉降级约 30%）。

### 关键取舍

- **舍 kimi 路线 C（独立合成层）**：backdrop-filter 语义是采样合成后的下层位图，下层任何合成层变化都使采样失效——will-change/translateZ 挡不住重采样，机理上无效。且 globals.css 性能预算明确"禁 will-change"。
- **舍"只停 shimmer"**：大獭审出 kimi 方案 A 的缺口——SSE 文本追加才是 20Hz 主力，光停 shimmer 不够。
- **取"冻结而非节流"**：弹窗期间用户注意力在弹窗内容上，背景暂停更新无感知损失；关窗一次性追上，数据零丢失。

## 修改文件

| 文件 | 改动 |
|------|------|
| web/src/components/Modal.tsx | createPortal 挂 body；open 期间挂 body.modal-open（effect 管理，多重弹窗共存安全） |
| web/src/lib/batch-update.ts | MessageBatcher 新增 getShouldDefer：窗口到期不产出，暂存保留，手动 flush 追上 |
| web/src/pages/conversation/index.tsx | modalOpen 派生 state + ref；batcher 接 defer；关窗 flush；自续期轮询 gate；5s 列表轮询 gate |
| web/src/styles/globals.css | body.modal-open 冻结 shimmer；降级开关（注释） |
| web/src/components/Modal.test.tsx | 新增：body class 生命周期 ×3（含多重弹窗共存）+ Portal 挂载位置 |
| web/src/lib/batch-update.test.ts | 新增：defer 冻结/解冻/自然恢复 ×3 |
| web/src/pages/conversation/ScheduledTaskModal.test.tsx | 适配 Portal：查询范围从 container 改为 document（回归适配，非行为变更） |

## 测试覆盖

- MessageBatcher.getShouldDefer：冻结期窗口到期不产出 / 暂存链不丢解冻后一次产出 / 解冻后自然恢复产出（timer 未清除）。
- Modal：body.modal-open 挂载卸载生命周期、多重弹窗共存不误删、Portal 渲染在 body 直下。
- 全量：19 文件 163 测试全过，TSC 通过。

## 验收标准

- [x] 所有测试通过
- [x] TSC 通过
- [ ] **打开弹窗 + 底下触发一条流式回复 + 观察 30 秒，无清晰/模糊交替**（上轮盲区场景，需人工/CI 验证）
- [ ] Esc 关闭、点遮罩关闭、多重弹窗共存场景回归正常
- [ ] CI 通过
- [ ] 关窗后流式内容完整追上（零丢失）

## 影响范围

影响模块：frontend（Modal 组件 + 对话页渲染管线）
影响文件：7 个（4 实现 + 3 测试）
破坏性变更：无（非弹窗场景行为不变；弹窗场景新增冻结行为，关窗自动恢复）
所有 8 种弹窗共用 Modal.tsx，一处修复全受益。

## 验证

- 单元测试：163 全过（含 9 个新增）
- 类型检查：tsc --noEmit 通过
- 手动验证：待 CI + 搭档验收（重点：流式中开弹窗 30 秒观察）

## 参考

- 问题来源：用户二次反馈（8/25）
- 前轮修复：F20260824m2345（PR#382，仅 React 层优化，未触及合成器根因）
- kimi 排查报告：`data/workspaces/be190532-2eb0-4635-9adb-a2430d3040ef/scrim-flicker-report.md`
- 关联：F20260814qswp（MessageBatcher 三轮演进，本次 defer 复用其暂存链机制）
