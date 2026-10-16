---
id: F20261016inbs
title: 输入框固定边界：可拖分割条 + 双框独立滚动 + 动态衬垫，死区与弹回一并根治
doc_type: feature
created: 2026-10-16
created_in_conversation: 6b8384a6-6c88-495f-8edb-7ef2175dcc2e
tags: [web, scroll, layout, ui]
modules:
  - web/src/pages/conversation/ChatView.tsx
  - web/src/pages/conversation/MessageInput.tsx
  - web/src/pages/conversation/MessageList.tsx
  - web/src/pages/conversation/MessageList.test.tsx
  - web/src/pages/conversation/input-fixed-split.test.tsx
  - web/e2e/input-fixed-split-visual.spec.ts
change_type: fix
capability_test: web/e2e/scroll-pin-frame-guard.spec.ts
summary: |
  搭档 10-16 报告两个 UI 问题：①消息到不了底部（视口写死 paddingBottom:170px vs 单行
  输入实高 72px → 98px 死区；附件超高时反向压住消息）；②上滚一两行被弹回底部（wheel
  脱锚后近底 100px 内的 scroll 位移被「未归因且近底→回锚」吞掉，下一次 React 提交贴底
  写入弹回）。搭档拍板微信式固定边界方案：隔离边界固定 + 手动可拖分割条 + 两框各自
  滚动 + 输入内容绝不改变边界。落地：覆盖层顶部 8px 拖拽热区（clamp [64px, 容器 55%]，
  localStorage 持久化）、玻璃框固定高度 textarea 内部滚动（field-sizing/min-h/max-h
  全删）、写死 170px 预留改 ResizeObserver 盯 overlay 实高的等高动态衬垫、滚动归因
  修复（未归因向上位移且 scrollHeight 未缩 → 一律脱锚，不受 100px 阈值限制）。
causal_links:
  from:
    - F20261015inpd
    - F20261008scpg
    - F20261010vwst
---

## 1. 背景与问题现象

### 1.1 问题一：消息到不了底部（98px 死区）

F20261015inpd 落地覆盖层方案时给消息列表视口写死 `paddingBottom: '170px'` 预留。但单行输入框实高仅 ~72px（外层 `px-1 pb-5 pt-2` + 玻璃框 `py-2.5` + 文本 24px），滚到底时最后一条消息悬在输入框上方 ~98px 死区。反向问题：附件/错误行使输入区超 170px 时压住消息底部滚不出来（F20261015inpd §5 已记「本轮不修」）。

### 1.2 问题二：上滚一两行被弹回底部

滚轮上滚时 wheel 监听先脱锚（takeUserControl 置 floating），但紧随的 scroll 事件中位移不足 100px 仍在底部附近（isNearBottom 阈值 100）→ 脱锚条件 `movedUp && !nearBottom` 不成立，反而走「未归因且近底 → 回锚」重新贴底，覆盖 wheel 意图；下一次 React 提交（流式期间几乎每 token 一次）执行贴底写入 → 弹回最下方。**单次位移超 100px 才能逃掉**——用户体感「上滚一两行就被弹回」。

### 1.3 搭档拍板（不可协商）

> 「微信是这样子的，首先，输入框合消息框是隔离边界是固定，然后各自两个框中各自有滚动条，输入内容并不会改变这个 边界，但是！我手动可以移动这个隔离边界来改变上下两个框的大小！你就按照这个方案来说，不去做 输入内容自动改变输入框大小这种事！越复杂越容易出错！」

即：**固定边界 + 可手动拖动的分割条 + 两框各自独立滚动 + 输入内容绝不改变边界**。明确否决「输入内容驱动高度」（field-sizing / autoResize 全删）。

## 2. 第一性原理分析

- **死区根因**：预留量的「静态猜测」（170px）与输入区的「动态实高」（72px~240px+）永远错位。猜测偏大 → 死区；偏小 → 遮挡。根治 = 预留随实高动态变化（实测而非猜测）。
- **弹回根因**：滚动归因把「位移大小」当「意图判据」——100px 阈值假设「小幅位移≈程序噪声」。但用户上滚 1-2 行就是 30-60px 的小幅位移，意图明确。意图判据应该是「位移方向 + 账本归因」，不是位移大小。
- **边界治理哲学**：微信桌面端证明「固定边界 + 手动调整」比「自动适应」更稳——自动适应是开放集合（每次内容变化都要重算），固定边界是闭集（只有用户手动改变）。

## 3. 方案设计

### 3.1 可拖分割条（ChatView.tsx）

覆盖层顶部 8px 热区（`h-2 -mt-2`，cursor row-resize，hover 显示 GripHorizontal 手柄）：
- 拖动经 window 级 pointermove（拖出热区仍跟踪；setPointerCapture 在 iframe 边界场景不可靠）
- clamp `[64px, 容器高 55%]`；默认 120px
- 松手持久化 `localStorage['otter.chat.inputHeight']`，下次进入恢复（异常值回退默认）
- aria role="separator" + aria-label 无障碍

### 3.2 输入框固定高度（MessageInput.tsx）

- 玻璃框外层固定高容器 `style={{ height: inputHeight }}`（flex flex-col）
- textarea `h-full overflow-y-auto` 占满玻璃框内部滚动——两框各自滚动
- **删 field-sizing: content / min-h-[24px] / max-h-[120px]**（内容驱动高度路径全删，按拍板）
- 附件暂存行在固定高容器**外**、玻璃框**上**方：附件不挤压 textarea 可用空间；overlay 自然长高由 3.3 的动态衬垫兜住（F20261015inpd §5 的溢出遮挡问题一并根治）

### 3.3 动态衬垫（死区归零）

```
旧：视口 paddingBottom 写死 170px（静态猜测，恒错位）
新：ChatView ResizeObserver 盯 overlay 实高 → bottomSpacerPx prop
    → MessageList 在 contentRef 内容末尾渲染等高衬垫 div
```

- 视口 clientHeight 恒定（F20261015inpd 根治成果**保持**，不可回退——任何改视口高度的补偿路径都会重新引入 clamp 跳动机制链）
- 衬垫在滚动内容末尾：衬垫长高也是内容长高，contentObserver 观测 → pinned 用户由既有贴底补偿保持齐平，floating 用户不打扰
- 附件行出现/消失 → overlay 实高变 → RO 同步衬垫 → 消息与输入框间距恒等于真实间隙

### 3.4 脱锚归因修复（MessageList.tsx handleScroll）

```ts
// 旧：向上位移脱锚受 100px nearBottom 阈值限制——wheel 脱锚后小幅 scroll 落入
//     「未归因且近底 → 回锚」分支，重新贴底覆盖 wheel 意图（弹回 bug）
if (movedUp && !nearBottom) takeUserControl()
else { ...账本匹配... if (!attributed && nearBottom) pinRef.current = true }

// 新：账本未归因的向上位移一律脱锚；唯一例外是内容收缩 clamp（被动几何调整非意图）。
//     「未归因且近底 → 回锚」仅承接非向上位移（向下滚回底部，回锚合法）
const shrank = el.scrollHeight < lastScrollHeightRef.current - 1
if (movedUp && !shrank) takeUserControl()
else { ...账本匹配... if (!attributed && nearBottom) pinRef.current = true }
```

- 新增 `lastScrollHeightRef`：与 lastScrollTopRef 同点采样（handleScroll 末尾），无观测缺口
- 内容收缩 clamp（如流式面板折叠）期间 pinned 用户保持 pinned，不误伤

## 4. 影响范围

| 文件 | 改动 | 修改类 |
|------|------|--------|
| ChatView.tsx | 分割条机制 + overlay RO + bottomSpacerPx 透传 | mechanism-addition |
| MessageInput.tsx | 固定高容器 + 删内容驱动 + 附件行移出固定容器 | mechanism-addition |
| MessageList.tsx | 删写死 padding + bottomSpacerPx 衬垫渲染 | mechanism-addition |
| MessageList.tsx | handleScroll 脱锚归因修复（movedUp && !shrank） | narrow-fix |
| MessageList.test.tsx | 弹回回归锚 + clamp 保护两用例 | test |
| input-fixed-split.test.tsx（新） | 分割条/持久化/恢复/衬垫/固定边界 8 用例 | test |
| input-fixed-split-visual.spec.ts（新） | 真机视觉自查 4 场景（vite 隔离实例 + API mock） | test |
| message-input-mention/paste.test.tsx | 适配 inputHeight 必填 prop | test |

**不受影响**：scroll-pin 状态机其余逻辑（账本/wheel/touch/键盘监听）、contentObserver、F20261015inpd 视口恒定（保持）、wireframe/preview 卡片。

## 5. 取舍

| 取舍 | 理由 |
|------|------|
| 上限取容器 55%（比例非绝对值） | 大屏 55% 是绝对大数（1080p 下 ~370px），小屏保底部消息可读；固定绝对值在大屏偏小 |
| 未测量（clientHeight=0）时上限不设限 | clamp 只在有真实容器尺寸时才有意义，否则误吞持久化的合理高度（单测实锤抓到：jsdom 下 180px 被吞回 120） |
| 附件行在固定容器外 | 附件不挤压 textarea（规格要求）；overlay 长高由衬垫动态兜住，F20261015inpd §5 一并根治 |
| shrank 用「缩小 >1px」判定 | 抵抗亚像素抖动（RO 精度/圆整）；1px 阈值与 movedUp 判定同款 |
| 持久化在 pointerup（非 move 节流） | move 是高频路径不碰 storage；up 是终态一次写 |
| 删 field-sizing | 搭档拍板「不做内容驱动」；且 field-sizing 在低版本浏览器回退为固定 24px 反而与固定边界方案冲突 |

## 6. 验证（Verification）

### 6.1 失败证据链（bugfix 硬规则：先失败后通过）

**弹回 bug 失败单测**（修复前跑一次留失败输出，`近底小幅上滚脱锚` 用例）：

```
$ git stash push -- web/src/pages/conversation/MessageList.tsx   # 退回未修复实现
$ npx vitest run src/pages/conversation/MessageList.test.tsx
FAIL  ... > 近底小幅上滚脱锚（F20261016inbs 弹回 bug 根因回归锚）...
AssertionError: 近底小幅上滚的 scroll 必须保持脱锚（这是弹回 bug 的核心断言）: expected true to be false
      Tests  1 failed | 21 passed (22)
$ git stash pop                                                   # 恢复修复
$ npx vitest run src/pages/conversation/MessageList.test.tsx
      Tests  22 passed (22)   ← 修复后通过
```

复现路径：pinned 用户 → 滚到距底 40px → wheel 上滚 30px（takeUserControl 脱锚）→ scroll 事件（位移向上 30px，距底 70px 仍近底）→ **旧实现在此回锚**（断言失败点）→ 下一次内容增长执行贴底写入（弹回）。修复后：scroll 保持脱锚，内容增长零写入（`st.writes === 0`）。

### 6.2 单测（vitest，jsdom）

| 套件 | 结果 |
|------|------|
| MessageList.test.tsx（含 2 新用例：弹回归因 + clamp 保护） | 22/22 ✅ |
| input-fixed-split.test.tsx（新，8 用例：拖动/clamp/持久化/恢复/衬垫/输入不改边界/无内容驱动类） | 8/8 ✅ |
| web 全量 | **702/702（69 文件）✅** |
| tsc --noEmit | ✅ 零错误 |

### 6.3 真机 e2e（playwright + vite 隔离实例 + API mock，无后端依赖）

| 场景 | 断言 | 结果 |
|------|------|------|
| 1 默认边界 | 玻璃框固定高 120px；衬垫 ≈ overlay 实高（±2px）；截图 | ✅ |
| 2 拖分割条 | 上拖 80px → 200px；下拖过头 → clamp 64px；localStorage='200' | ✅ |
| 3 重载恢复 | 拖到 160 → reload → 恢复 160px | ✅ |
| 4 输入不改边界 | fill 20 行 → 玻璃框/textarea 高度不变；scrollHeight > clientHeight（内部滚动） | ✅ |
| 5 死区归零 | 滚到底（distToBottom=0）时最后消息与玻璃框 gap=25px（= mb-4 16 + pt-2 8 + 圆整 1；旧 bug 98px）；断言 ≤30px | ✅ |
| 像素自检 | 三态截图底部亮带 122/66/139px ≈ 边界 120/64/160（含 hint 行） | ✅ |

### 6.4 既有回归锚

- e2e scroll-pin-frame-guard.spec.ts：环境门控 skip（需复刻会话数据实例 E2E_REPLICA_DATA=1；本 worktree 无 alpha 实例——alpha.sh 启动被 bash 守卫拦截，CI 侧有数据实例时运行）
- MessageList 既有贴底状态机 20 用例全绿（弹回修复未破坏既有语义）

## 7. 逃生口

- 分割条拖动若在某些触屏浏览器不稳定（pointer 事件差异），回退为仅桌面端显示热区（`@media (pointer: fine)`），固定边界默认 120px 仍生效。
- 若 55% 上限在超宽屏（如带鱼屏竖向空间小）体感过大，可降为 45%——纯常量调整。
