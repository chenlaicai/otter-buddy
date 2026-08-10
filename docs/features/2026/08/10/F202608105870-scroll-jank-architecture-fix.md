---
id: F202608105870
title: scroll-jank-architecture-fix
doc_type: feature

# 记忆索引
summary: |
  彻底根治页面滚动抖动问题，从架构层面优化。核心改动：移除 StreamingProcess 的 key 切换、
  添加批量更新机制（50ms 窗口）、用 allMessagesRef 解除闭包依赖、debounce 300ms、
  useMemo 稳定 data 引用。

# 因果链路
causal_links:
  from:
    - F20260805abpp   # Agent 无缝重试机制

# 元数据
status: development
change_type: refactor
tags: [scroll, jank, virtuoso, batch-update, performance]
modules: [web]

# 时间
created_at: 2026-08-10
---

# F202608105870 - 彻底根治页面滚动抖动问题

## 1. 需求背景

### 1.1 问题陈述

| 问题 | 现象 | 根因 |
|------|------|------|
| 流式消息完成时抖动 | 所有后续消息位置突然跳动 170-370px | StreamingProcess 组件的 key 切换导致卸载/挂载 |
| 流式消息期间抖动 | 消息列表不断重排 | SSE 事件高频触发 setAllMessages，Virtuoso 不断重算布局 |
| 向上加载历史时抖动 | 加载后位置不稳定 | firstItemIndex 与 data 同时变化，Virtuoso 经历中间状态 |
| 新消息提示误判 | "新消息 N 条"提示不准确 | debounce 150ms 不够，Virtuoso 瞬态 false 信号导致误累加 |

### 1.2 设计目标

1. 消除流式消息完成时的高度突变
2. 减少 Virtuoso 重渲染频率
3. 稳定回调函数引用，解除闭包依赖
4. 减少底部状态误判
5. 不影响流式文本的实时感

## 2. 设计方案

### 2.1 移除 StreamingProcess 的 key 切换

**问题**：`<StreamingProcess key={inFlight ? 'live' : 'done'} ... />` 导致组件卸载/挂载，高度突变。

**方案**：移除 key 切换，改用 useEffect 同步折叠状态。

```typescript
// 之前
<StreamingProcess key={inFlight ? 'live' : 'done'} events={m.events} />

// 之后
<StreamingProcess events={m.events} />

// 新增 useEffect 同步
useEffect(() => {
  if (!inFlight && !collapsed) {
    setCollapsed(true)
  }
}, [inFlight, collapsed])
```

**权衡**：
- 优点：消除高度突变，组件不再卸载/挂载
- 缺点：折叠状态变化需要 useEffect 同步，可能有一次额外渲染

### 2.2 批量更新机制（50ms 窗口）

**问题**：SSE 事件高频触发 setAllMessages，Virtuoso 不断重算布局。

**方案**：添加批量更新机制，50ms 窗口内的 SSE 事件合并为一次 setAllMessages。

```typescript
const BATCH_WINDOW_MS = 50
const pendingUpdatesRef = useRef<Map<string, LocalMessage[]>>(new Map())
const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

const batchUpdateMessages = useCallback((convId: string, updater: (prev: LocalMessage[]) => LocalMessage[]) => {
  setAllMessages(prev => {
    const current = prev[convId] || []
    const updated = updater(current)
    if (updated === current) return prev
    pendingUpdatesRef.current.set(convId, updated)
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(() => {
        batchTimerRef.current = null
        flushBatchUpdates()
      }, BATCH_WINDOW_MS)
    }
    return prev
  })
}, [flushBatchUpdates])
```

**权衡**：
- 优点：减少 Virtuoso 重渲染频率，消除滚动抖动
- 缺点：流式中间态可能有 ≤50ms 延迟显示，但终态事件（message.complete）保证最终正确

**选择依据**：
- ≥16ms：保证至少一帧合并
- ≤100ms：保证流式体感（人类感知延迟阈值约 100ms）
- 50ms：平衡点，既减少重渲染，又不明显影响实时感

### 2.3 allMessagesRef 解除闭包依赖

**问题**：refreshMessages、loadMoreBefore、loadMoreAfter 依赖 allMessages，导致闭包频繁重建。

**方案**：用 allMessagesRef 镜像 allMessages，回调函数通过 ref 读取最新值。

```typescript
const allMessagesRef = useRef<Record<string, LocalMessage[]>>({})
useEffect(() => {
  allMessagesRef.current = allMessages
}, [allMessages])

const refreshMessages = useCallback(async (convId: string) => {
  const list = allMessagesRef.current[convId] || []
  // ...
}, []) // 依赖为空，通过 ref 读取最新值
```

**权衡**：
- 优点：回调函数引用稳定，不会因为 allMessages 变化而重建
- 缺点：需要手动同步 ref，增加一次 useEffect

### 2.4 debounce 150ms → 300ms

**问题**：Virtuoso 在流式消息内容高度重算时产生瞬态 false 信号，150ms debounce 不够。

**方案**：增加 debounce 到 300ms。

```typescript
const handleAtBottomChange = useCallback((atBottom: boolean) => {
  if (atBottom) {
    // ...
  } else {
    if (!atBottomDebounceRef.current) {
      atBottomDebounceRef.current = setTimeout(() => {
        atBottomDebounceRef.current = null
        isAtBottomRef.current = false
      }, 300) // 150ms → 300ms
    }
  }
}, [])
```

**权衡**：
- 优点：减少底部状态误判，避免 newMessagesCount 误累加
- 缺点：用户滚动到底部后，300ms 内新消息不会触发"新消息"提示

### 2.5 useMemo 稳定 data 引用

**问题**：activeMessages 每次渲染都创建新数组引用，Virtuoso 收到新 data prop 会重算布局。

**方案**：用 useMemo 稳定引用。

```typescript
const activeMessages = useMemo(() => activeId ? (allMessages[activeId] || []) : [], [activeId, allMessages])
```

**权衡**：
- 优点：Virtuoso 收到稳定的 data 引用，减少不必要的重算
- 缺点：增加一次 useMemo 计算

## 3. 行为条目

### 3.1 流式消息完成时不再抖动

**触发条件**：流式消息从 streaming 变为 completed

**预期行为**：StreamingProcess 组件平滑折叠，不产生高度突变

**验证方法**：
1. 发送消息触发流式回复
2. 观察流式消息完成时，后续消息位置是否稳定
3. 验证 StreamingProcess 组件是否平滑折叠

### 3.2 流式消息期间不抖动

**触发条件**：流式消息进行中，SSE 事件高频到达

**预期行为**：消息列表稳定，不不断重排

**验证方法**：
1. 发送消息触发流式回复
2. 观察流式消息期间，消息列表是否稳定
3. 验证 Virtuoso 重渲染频率是否降低

### 3.3 向上加载历史时不抖动

**触发条件**：滚动到顶部，触发 loadMoreBefore

**预期行为**：加载后位置稳定，不跳动

**验证方法**：
1. 滚动到顶部，触发加载更多
2. 观察加载后，当前位置是否稳定
3. 验证 firstItemIndex 与 data 是否同步变化

### 3.4 新消息提示准确

**触发条件**：用户不在底部，收到新消息

**预期行为**：准确显示"新消息 N 条"提示

**验证方法**：
1. 滚动到中间位置
2. 收到新消息
3. 验证提示是否准确，不误判

## 4. 权衡分析

### 4.1 批量更新的"最终一致性"语义

**问题**：批量更新可能导致流式中间态有 ≤50ms 延迟显示。

**影响**：
- 用户感知：流式文本显示可能略有延迟，但终态正确
- 数据一致性：中间态可能丢失，但终态事件（message.complete）保证最终正确

**权衡**：
- 选择：接受 ≤50ms 延迟，换取 Virtuoso 重渲染频率降低
- 理由：人类感知延迟阈值约 100ms，50ms 延迟不影响体验

### 4.2 Map-overwrite 语义

**问题**：同一 convId 的多次 batchUpdateMessages 调用，只有最后一次的 updated 被 flush。

**影响**：
- 中间态丢失：同一 50ms 窗口内的多个 SSE 事件，只有最后一个生效
- 终态正确：message.complete 事件保证最终状态正确

**权衡**：
- 选择：接受中间态丢失，换取批量更新的简洁性
- 理由：中间态丢失不影响用户体验，终态正确是关键

## 5. 验证计划

### 5.1 自动化测试

- 构建通过（tsc --noEmit + vite build）
- 所有 109 个测试通过（原 103 个 + 新增 6 个）
- 新增 batch-update.test.ts，覆盖批量更新机制的核心行为

### 5.2 手动验证

- [ ] 流式消息完成时不再抖动
- [ ] 流式消息期间不抖动
- [ ] 向上加载历史时不抖动
- [ ] 新消息提示准确
- [ ] 长时间运行无内存泄漏

### 5.3 性能验证

- [ ] 批量更新减少 Virtuoso 重渲染频率
- [ ] 50ms 延迟不影响流式体感

## 6. 回滚方案

### 6.1 快速回滚

如果批量更新引入新问题，可以快速回滚：

1. 移除批量更新机制，恢复直接调用 setAllMessages
2. 恢复 StreamingProcess 的 key 切换
3. 恢复 debounce 150ms
4. 移除 allMessagesRef

### 6.2 渐进回滚

如果只部分功能有问题，可以渐进回滚：

1. 如果批量更新有问题：移除批量更新，恢复直接调用 setAllMessages
2. 如果 StreamingProcess 折叠有问题：恢复 key 切换
3. 如果 debounce 有问题：恢复 150ms

## 7. 变更记录

### 7.1 初始实现（2026-08-10）

- 移除 StreamingProcess 的 key 切换
- 添加批量更新机制（50ms 窗口）
- 用 allMessagesRef 解除闭包依赖
- debounce 150ms → 300ms
- useMemo 稳定 data 引用
- 所有 SSE 事件处理器改用 batchUpdateMessages

### 7.2 检视獭反馈修复（2026-08-10）

- 提取 50ms 批量窗口为 BATCH_WINDOW_MS 常量并添加注释
- 补充批量更新机制的单元测试（batch-update.test.ts）

## 8. 相关资源

- PR #206：https://github.com/chenlaicai/otter-buddy/pull/206
- Worktree：/Users/orca/ai/otter-buddy/.claude/worktrees/fix-scroll-jank
- 检视獭对抗审视报告：见对话历史
