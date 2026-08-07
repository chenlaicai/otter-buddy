---
id: F20260807scrk
title: scroll-jitter-and-new-message-count
doc_type: feature

summary: |
  流式消息期间两个 UI 问题：(1) 用户在底部时页面周期性向上跳动；
  (2) 用户不在底部时"新消息 N 条"计数持续增长。
  根因是 Virtuoso atBottomStateChange 在内容高度重算时产生瞬态 false 信号，
  加上 followOutput 和手动 scrollToIndex 两套滚动机制竞争。

causal_links:
  from: []
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

## 根因分析

消息列表使用 react-virtuoso 虚拟滚动，滚动状态由三套独立机制管理：

| 机制 | 触发时机 | 作用 |
|------|----------|------|
| `followOutput='smooth'` | data 数组新增元素时 | Virtuoso 内置跟随 |
| `maybeScrollToBottom()` 手动 `scrollToIndex` | message / message.start / syncLiveEvents 等 | 自定义跟随 |
| `atBottomStateChange` → `handleAtBottomChange` | Virtuoso 检测到滚动位置变化时 | 更新 `isAtBottomRef` |

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
