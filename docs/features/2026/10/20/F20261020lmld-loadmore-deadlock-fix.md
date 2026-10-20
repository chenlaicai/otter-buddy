---
id: F20261020lmld
title: 对话上翻加载历史死锁修复——意图驱动触发 + 近顶带容差 + 可见入口
summary: 修复对话消息列表上翻加载历史的死锁（到顶后 scroll 事件归零永不再触发）：意图事件（wheel/触摸/按键）近顶带触发 + 8px 触发带容差 + 可见「加载更早消息」入口，不动 W8 恢复语义与后端
created_at: 2026-10-20
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
type: feature
change_type: bugfix
status: implemented
related: F20261008w8lt, F20260803vmsg, F20261010vwst, F20261016inbs
---

# 对话上翻加载历史死锁修复

## 问题现象

搭档报告（2026-10-20）：「我在对话界面中往上滚动，我期望加载历史消息，但我发现没有加载更多功能！」

真机取证（Playwright 驱动真实页面，repro-loadmore4）：

- 到顶 → 第一批正常加载（50→70 条，1 次 before 请求）✅
- **不回滚直接继续上滚 15 大步 → 零反应**（仍 70 条，请求数不变）❌ 死锁
- 「下滚再上滚」自救 → 才加载出第二批（70→90）——用户不会知道这个暗门

## 根因分析

`web/src/pages/conversation/MessageList.tsx`（修复前 511 行）：

```js
if (el.scrollTop === 0 && onLoadMore && !loadingMore) {
```

触发模型 = 「scroll 事件 + scrollTop **严格等于 0**」，三重缺陷：

1. **死锁（实证，高置信）**：到顶后 scrollTop=0 静止，继续上滚不再产生位移 → 无 scroll 事件 → handleScroll 永不再触发 → 第二批及以后历史永远加载不出
2. **触发带过窄（推测，中置信）**：触控板惯性常停在 0.5px 等分数位置（视觉即「到顶」），`=== 0` 严格相等永远打不到
3. **无可见入口**：唯一 UI 是加载中的「加载中...」一闪而过，无按钮/顶部指示——功能存在但完全不可感知

链路其余环节（后端 before 分页、api client、loadMoreBefore、ChatView 转发）curl + 代码双重验证均完好；F20260803vmsg 记的「前端从未传 before」旧缺陷已被 F20260913ctlv 修复。

## 方案设计

窄修（修法决策树①，既有机制语义内修），核心 = **意图驱动触发**：

- **A'. wheel/触摸/按键近顶触发**（替代原报方案的「加载后自动续批」）：到顶静止后用户继续上滚/touch 上翻/按键上翻 = 显式加载意图，在近顶带内直接触发，不依赖 scroll 位移——死锁的唯一解。
  - **取舍修正**：原报方案 B「加载完成后若仍在顶部附近自动续批」被否——W8 距顶恢复语义下用户每批加载后仍停在顶部，自动续批会把全量历史一口气拉完（长会话数十请求连发），改为按批意图驱动：用户滚一次出一批，停手即停。
- **B. 近顶触发带**：`el.scrollTop === 0` → `<= LOAD_MORE_TOP_PX`（8px），覆盖分数停位与「视觉到顶」，不误伤正常阅读区。
- **C. 可见入口按钮**：内容顶部渲染「加载更早消息」按钮（hasMoreBefore=true 时），点击直接触发；加载中置灰「加载中...」；hasMoreBefore=false 不渲染（防假入口）。
- **重入护栏**：loadingMore 在途时各通道直接 return（父层 loadMoreBefore 的 loadingMoreRef 双保险不变）。
- **W8 restore 语义不动**：各触发通道统一走 fireLoadMore，臂 pendingScrollRestoreRef = 触发时距顶距离，与旧路径同语义（F20261008w8lt 消费逻辑零改动）。

机制判定：不命中机制清单（无新配置字段/状态生命周期/定时任务/信号/持久化/跨模块调用；load-more 功能语义不变）→ `narrow-fix`。

## 影响范围

- `web/src/pages/conversation/MessageList.tsx`：触发逻辑（handleScroll/wheel/touch/keydown）+ 顶部入口按钮渲染 + fireLoadMore 统一入口
- `web/src/pages/conversation/ChatView.tsx`：hasMoreBefore prop 透传
- `web/src/pages/conversation/index.tsx`：hasMoreBefore 传入（既有 state，无新逻辑）
- 后端零改动

## 验证

### 固化失败测试（修复前红 → 修复后绿）

`MessageList.test.tsx` 新增 5 条（修复前 3 红 2 绿）：

| 测试 | 修复前 | 修复后 |
|---|---|---|
| 死锁回归锚：到顶静止后 wheel 上滚（零位移）应触发加载 | ❌ | ✅ |
| 触发带容差：分数 scrollTop（0.5px 近顶静止）应触发加载 | ❌ | ✅ |
| 可见入口：hasMoreBefore=true 渲染按钮，点击触发加载 | ❌ | ✅ |
| 入口收敛：hasMoreBefore=false 不渲染按钮 | ✅ | ✅ |
| 重入护栏：loadingMore 期间 wheel 不重复触发 | ✅ | ✅ |

### 回归

- web 全量 vitest：71 files / 724 tests 全绿（含 F20261008w8lt W8 恢复语义、F20261016inbs 高度补偿、F20261008scpg 滚动归因全部既有测试零回退）
- `tsc --noEmit` 干净

### 真机验证（Playwright + worktree 隔离 vite 实例）

对照 repro-loadmore4 死锁场景：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 到顶加载第一批 | 50→70 ✅ | 50→110 ✅（连续意图出 3 批） |
| **不回滚直接续滚（死锁点）** | **零反应 ❌** | **110→177 继续出批 ✅** |
| 可见入口按钮 | 无 | 渲染可见（24px），历史耗尽自动消失 ✅ |
| 0.5px 小数停位触发 | 不触发（=== 0 打不到） | 单测覆盖 ✅ |

UI 截图核对：布局完好，无溢出/错位。

## 设计取舍

1. **wheel 优先于 IntersectionObserver 哨兵**：哨兵方案（原报方案 A）需要在内容顶部插 sentinel 元素 + IO 管理生命周期，与 W8 restore 的 useLayoutEffect 消费门交互面大；wheel/touch/keydown 意图事件与既有「意图脱锚」监听器（F20261008scpg）同处挂载，改动面更小且语义更准（用户意图 vs 位置巧合）。scroll 通道保留近顶带位置触发作兜底（滚动条拖拽场景）。
2. **不自动续批**：见上文取舍修正。
3. **入口按钮放滚动内容顶部**：跟随内容滚动自然露出，不占独立视口高度（F20261015inpd 视口恒定成果不回退）。

## 遗留

- 触发带宽 8px 是经验值，未做真机多机型调参（当前单端自用场景足够）
- 按键通道（PageUp/Home/ArrowUp）带内触发可能与浏览器原生滚动语义有轻微重叠，真机未见异常，后续按需收紧
