---
id: F20260811ke4k
title: fix-streaming-expand-and-scroll-jank
doc_type: feature

summary: |
  修复两个同源问题——都根植于 PR #206 (F20260810p7zg) 的架构决策：
  1. 流式过程终态后无法展开：StreamingProcess 的 useEffect 无条件拦截展开操作
  2. 消息多时滚动抖动：followOutput 用 Virtuoso 即时判断 vs newMessagesCount 用 debounce ref，
     两套"是否在底部"的状态时序矛盾，300ms debounce 放大冲突窗口

status: implemented
change_type: fix
tags: [conversation, virtuoso, scroll, streaming, debounce]
modules:
  - web/src/pages/conversation/MessageList.tsx
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/ChatView.tsx
capability_test: "n/a: 纯前端 UI 逻辑改动（A 类），无 LLM 参与行为"
causal_links:
  from:
    - F20260810p7zg   # scroll-jank-architecture-fix，引入了有缺陷的 followOutput debounce 和 StreamingProcess useEffect
---

# F20260811ke4k: 修复流式过程终态无法展开与滚动抖动

## 背景

### 问题描述

1. **流式过程无法展开**：流式完成后，点击"流式过程"面板无法展开——每次点击后立刻被推回折叠状态
2. **滚动抖动**：消息列表出现滚动条后，向下滚动触发抖动

### 根因分析

两个问题同源，都指向 PR #206 (F20260810p7zg) "彻底根治页面滚动抖动"的三个架构决策：

| 决策 | 状态 | 说明 |
|------|------|------|
| 批量更新（50ms 合并 SSE 事件） | ✅ 正确 | 保留 |
| StreamingProcess 去 key 切换改 useEffect 自动折叠 | ❌ 过度 | 无条件拦截用户展开 |
| debounce 150→300ms | ❌ 过度 | 放大 followOutput 冲突窗口 |

**问题一根因**：`StreamingProcess` 的 `useEffect` 无条件强制折叠终态：

```javascript
useEffect(() => {
    if (!inFlight && !collapsed) {
      setCollapsed(true)  // 用户点展开 → collapsed=false → 下一帧被推回 true
    }
}, [inFlight, collapsed])
```

**问题二根因**：`followOutput` 和 `newMessagesCount` 使用两套不同的"是否在底部"状态：

- `followOutput={(atBottom) => atBottom ? 'smooth' : false}` — Virtuoso 即时判断
- `isAtBottomRef.current` — 300ms debounce 后的 ref

时序矛盾：
1. 用户向上滚动 → Virtuoso 报 `atBottomStateChange(false)`
2. 300ms debounce 开启 → `isAtBottomRef` 仍为 true
3. 窗口期内 SSE 事件到达 → Virtuoso 重新渲染
4. `followOutput` 用 Virtuoso 即时判断 → 返回 `'smooth'` → 尝试滚到底部
5. 用户正在向上滚 → 冲突抖动

## 设计方案

### 改动 1：StreamingProcess 一次性折叠

用 `useRef` 追踪上一次的 `inFlight` 状态，只在 `streaming → completed` 的**瞬间**自动折叠，之后不干预用户操作。

```javascript
const prevInFlightRef = useRef(inFlight)
useEffect(() => {
    if (prevInFlightRef.current && !inFlight) {
      setCollapsed(true)
    }
    prevInFlightRef.current = inFlight
}, [inFlight])
```

### 改动 2：followOutput 统一状态源

将 `followOutput` 改为使用 `isAtBottomRef`（与 `newMessagesCount` 同源），消除时序矛盾：

```javascript
// 改前：Virtuoso 即时判断
followOutput={(atBottom) => atBottom ? 'smooth' : false}

// 改后：使用 debounce 后的 ref
followOutput={() => isAtBottomRef.current ? 'smooth' : false}
```

### 改动 3：缩短 false debounce

将 `atBottomStateChange` 的 false debounce 从 300ms 缩短到 50ms（检视獭建议）：

- followOutput 已用 ref 状态，Virtuoso 瞬态 false 不再影响跟随行为
- 50ms < 一帧，不影响跟随响应性
- 但过滤内容高度重算时的瞬态 false 信号，避免"新消息 N 条"浮窗闪烁

## 实现

### 文件变更

| 文件 | 变更 |
|------|------|
| `MessageList.tsx` | StreamingProcess 用 prevInFlightRef；followOutput 改用 isAtBottomRef；新增 isAtBottomRef prop |
| `index.tsx` | false debounce 300ms → 50ms；传递 isAtBottomRef |
| `ChatView.tsx` | 透传 isAtBottomRef prop |

### 代码统计

+21 行 / -10 行

## 验证

### 自动化验证

- Build: 0 errors ✅
- Tests: 117 passed (13 files) ✅
- Lint: passed ✅
- CI: passed ✅

### 对抗审视

- 第 1 轮：0 阻断，2 非阻断（浮窗闪烁风险、dead code）
- 第 2 轮（delta）：两个发现处置均合规 ✅

### 手动验证

- [ ] 消息多时滚动无抖动
- [ ] 流式完成后可展开流式过程面板
- [ ] 流式过程中面板默认展开
