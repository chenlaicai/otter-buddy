---
id: F20260807scrk
title: scroll-jitter-and-new-message-count
doc_type: feature

summary: |
  流式消息期间两个 UI 问题：(1) 用户在底部时页面周期性向上跳动；
  (2) 用户不在底部时"新消息 N 条"计数持续增长。
  根因是 F20260803vmsg 引入 Virtuoso 时同时保留了 followOutput 和手动 scrollToIndex
  两套滚动机制，且对抗审视修复"流式回复不跟随"时将 maybeScrollToBottom 扩展到
  message.start handler，使两套机制在新消息到达时交叉执行。
  F20260805abpp 将同一模式扩展到 message.aborted handler，进一步扩大竞争范围。

causal_links:
  from:
    - F20260803vmsg   # 消息展示机制：引入 Virtuoso + 双滚动机制 + 对抗审视加 maybeScrollToBottom 到 message.start
    - F20260805abpp   # 中断可见性：扩展 maybeScrollToBottom 到 message.aborted handler
  to: []

status: development
change_type: fix
tags: [conversation, virtuoso, scroll, streaming]
modules:
  - web/src/pages/conversation/index.tsx
capability_test: "n/a: 前端滚动逻辑改动（A 类），无 LLM 参与行为"
---

# F20260807scrk: 修复消息列表滚动抖动与新消息计数误增长

## 现象

1. 用户在对话底部，流式回复期间页面周期性向上跳动约一行高度
2. 用户滚动到中间位置后，"新消息 N 条"浮窗的 N 值持续增长，与实际新消息数不符

## 因果溯源

### 第一步：F20260803vmsg 引入双滚动机制（feefd88）

该特性完整重建对话消息展示机制，引入 react-virtuoso 虚拟滚动。初始实现中同时引入了两套滚动机制：

| 机制 | 位置 | 触发时机 |
|------|------|----------|
| `followOutput='smooth'` | MessageList.tsx → Virtuoso props | data 数组新增元素时，Virtuoso 内置自动跟随 |
| `maybeScrollToBottom()` | index.tsx → 自定义函数 | 手动调用 `scrollToIndex('LAST')` |

初始实现中 `maybeScrollToBottom` 仅在 `message` 和 `syncLiveEvents` 中调用，
与 `followOutput` 的触发条件不完全重叠，暂无明显冲突。

### 第二步：F20260803vmsg 对抗审视引入隐患

在对抗审视阶段，检视獭发现：

> 「流式消息新消息提示：message.start handler 加 newMessagesCount + autoscroll，
> 原仅 message 事件计数，流式回复被遗漏」

修复方案是在 subscribe SSE 和 handleSend 两处的 `message.start` handler 中都加了
`maybeScrollToBottom()` 调用。

这个修复解决了「流式回复不跟随」的问题，但引入了关键隐患：
**`message.start` 同时触发 `followOutput`（新元素加入 data）和 `maybeScrollToBottom`（手动 scrollToIndex），
两套滚动指令在同一时刻交叉执行。**

同时，`handleAtBottomChange` 直接同步设置 `isAtBottomRef.current = atBottom`：

```typescript
const handleAtBottomChange = useCallback((atBottom: boolean) => {
  isAtBottomRef.current = atBottom      // 立即写入，无 debounce
  if (atBottom) setNewMessagesCount(0)
}, [])
```

没有考虑 Virtuoso 在内容高度重算时会产生瞬态 `atBottomStateChange(false)` 信号。

### 第三步：F20260805abpp 扩展竞争范围（d43dae1）

该特性修复 abort 终态投影丢失，新增常驻 `/subscribe` 通道的 `message.aborted` 处理器。
为保持与 `message.complete` 一致的行为，在 `message.aborted` handler 中也加了
`maybeScrollToBottom()` 调用，将竞争范围从 4 个 handler 扩展到 6 个：

| handler | maybeScrollToBottom 调用 | 来源 |
|---------|------------------------|------|
| `message`（subscribe SSE） | ✓ | F20260803vmsg 初始实现 |
| `message.start`（subscribe SSE） | ✓ | F20260803vmsg 对抗审视修复 |
| `message.complete`（subscribe SSE） | ✓ | F20260803vmsg 初始实现 |
| `message.aborted`（subscribe SSE） | ✓ | F20260805abpp |
| `message.start`（handleSend SSE） | ✓（直接 scrollToIndex） | F20260803vmsg 对抗审视修复 |
| `syncLiveEvents`（assistant_text 等） | ✓ | F20260803vmsg 初始实现 |

### 根因总结

```
F20260803vmsg 初始实现
  ├─ 引入 followOutput='smooth'（Virtuoso 内置）
  ├─ 引入 maybeScrollToBottom()（手动 scrollToIndex）
  └─ handleAtBottomChange 无 debounce
        │
        ▼
F20260803vmsg 对抗审视修复"流式回复不跟随"
  └─ 在 message.start handler 加 maybeScrollToBottom()
     → followOutput 和手动 scrollToIndex 在新消息到达时同时触发
     → 两套滚动指令交叉执行
        │
        ▼
F20260805abpp 扩展到 message.aborted
  └─ 竞争范围扩大
        │
        ▼
实际表现
  ├─ 页面抖动：两套滚动指令交叉执行 + Virtuoso 高度重算
  └─ 计数误增长：atBottomStateChange(false) 瞬态信号污染 isAtBottomRef
```

## 根因分析

### 问题 1：页面跳动

`followOutput='smooth'` 和手动 `scrollToIndex` 竞争：

1. 流式消息的 `assistant_text` 事件更新消息内容 → ReactMarkdown 重渲染 → 高度变化
2. Virtuoso 重算布局期间，`atBottomStateChange(false)` 瞬态触发
3. `followOutput` 收到 `atBottom=false` 返回 `false`，停止跟随
4. 同时 `syncLiveEvents` 调用 `maybeScrollToBottom()` → `scrollToIndex('LAST')`
5. 两套滚动指令交叉执行，viewport 抖动

### 问题 2：计数误增长

`atBottomStateChange(false)` 瞬态信号污染 `isAtBottomRef`：

1. 用户在底部 → `isAtBottomRef.current = true`
2. Virtuoso 高度重算 → 瞬态 `atBottomStateChange(false)`
3. `handleAtBottomChange(false)` → `isAtBottomRef.current = false`
4. 下一个 SSE 事件检查 `!isAtBottomRef.current` → `newMessagesCount++`
5. Virtuoso 随后触发 `atBottomStateChange(true)` 清零计数，但在清零窗口内已累加
6. 流式期间高频重复上述过程 → 计数持续增长

## 修复方案

### 1. `handleAtBottomChange` 加 debounce（核心修复）

```typescript
// false 信号延迟 150ms 生效，true 立即生效
if (atBottom) {
  clearTimeout(debounceTimer)
  isAtBottomRef.current = true
  setNewMessagesCount(0)
} else {
  debounceTimer = setTimeout(() => {
    isAtBottomRef.current = false
  }, 150)
}
```

150ms 窗口覆盖 Virtuoso 高度重算周期（通常 <50ms），瞬态 false 信号被吞掉。
用户真正滚动离开底部时，150ms 后才标记为非底部，符合交互预期。

### 2. 移除 `maybeScrollToBottom` 及所有调用

`followOutput='smooth'` 已处理新消息跟随，Virtuoso 内部处理内容高度变化。
移除后只剩一套滚动机制，消除竞争。

移除点：`syncLiveEvents`、`message`、`message.start`、`message.complete`、`message.aborted`。

### 3. 移除发送流中重复的 `scrollToIndex`

`consumeSSE` 的 `message.start` handler 中 `scrollToIndex` 与 `followOutput` 重复。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `web/src/pages/conversation/index.tsx` | +23 -16：debounce 逻辑、移除 maybeScrollToBottom、移除重复 scrollToIndex |

## 验证

```
npx vitest run
# 980 passed (80 files)
npx tsc --noEmit --project web/tsconfig.json
# 仅存量 CSS module 警告，无新增错误
```

手动验证：
- [ ] 流式回复期间页面不跳动
- [ ] "新消息 N 条"计数与实际新消息数一致
- [ ] 点击"新消息 N 条"能正确滚到底部
- [ ] 向上加载历史消息正常
