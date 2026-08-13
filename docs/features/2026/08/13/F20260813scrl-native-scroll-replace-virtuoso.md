---
doc_type: feature
change_type: refactor
feature_id: F20260813scrl
tags: [scroll, jitter, virtuoso, native-scrolling, performance]
modules: [web/src/pages/conversation]
from: [F20260803vmsg, F20260805abpp, F20260810p7zg]
supersedes: [F20260810p7zg]
---

# 用原生滚动替换 react-virtuoso 消除抖动

## 1. 需求背景

### 问题陈述

聊天界面滚动时出现抖动，已经修复过 3 次（F20260803vmsg、F20260805abpp、F20260810p7zg），但问题依然存在。

**核心问题**：react-virtuoso 的 `followOutput` + `atBottomStateChange` + 手动 `scrollToIndex` 三套滚动指令交叉执行，导致抖动。

### 根因分析

| 问题 | 根因 |
|------|------|
| 流式消息期间抖动 | followOutput 和手动 scrollToIndex 同时触发 |
| 用户上翻时被打断 | Virtuoso 瞬态 false 信号与 debounce ref 时序矛盾 |
| 上翻加载历史时抖动 | firstItemIndex 与 data 同时变化，Virtuoso 经历中间状态 |

### 设计目标

1. 彻底消除滚动抖动
2. 保持自动跟随到底部的功能
3. 保持上翻加载历史的功能
4. 保持"新消息 N 条"提示功能

## 2. 方案设计

### 方案选择

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| 继续修复 Virtuoso | 已有基础 | 3 次未修复，根因难除 | 不适用 |
| 纯 CSS + 原生滚动 | 简单可靠，无竞争条件 | 不支持超长历史虚拟渲染 | 消息量 < 1000 |

**选择原生滚动**：我们的分页大小是 50-100 条消息，这个量级用原生滚动完全够用，不需要虚拟滚动。

### 核心改动

1. **替换组件**：用 `<div>` + `overflow-y: auto` 替换 `<Virtuoso>`
2. **自动跟随**：`useEffect` 监听 `messages.length` 变化，自动滚到底部
3. **底部检测**：`onScroll` 事件 + 阈值（100px）
4. **上翻加载**：`onScroll` 事件检测到顶部，触发加载更多
5. **跳转消息**：`scrollIntoView` 实现跳转到指定消息
6. **防抖动**：`overflow-anchor: none` 防止浏览器自动调整滚动位置

### 滚动位置恢复

上翻加载历史时，需要保持滚动位置：
1. `handleScroll` 中记录加载前的 `scrollHeight`
2. `useEffect` 监听 `messages.length` 变化
3. 消息渲染后，计算新的 `scrollHeight` 并恢复位置

## 3. 行为条目

### 3.1 新消息自动滚到底部

- **触发条件**：收到新消息且用户在底部（阈值 100px 内）
- **预期行为**：自动滚到底部
- **验证方法**：发送消息，观察是否自动滚到底部

### 3.2 上翻时不被打断

- **触发条件**：用户向上滚动查看历史
- **预期行为**：不被新消息打断
- **验证方法**：向上滚动，观察是否被新消息打断

### 3.3 上翻加载历史时位置稳定

- **触发条件**：滚动到顶部，触发加载更多
- **预期行为**：加载后位置稳定，不跳动
- **验证方法**：滚动到顶部，触发加载，观察位置是否稳定

### 3.4 新消息提示准确

- **触发条件**：用户不在底部，收到新消息
- **预期行为**：准确显示"新消息 N 条"提示
- **验证方法**：滚动到中间位置，收到新消息，验证提示是否准确

## 4. 影响范围

### 文件变更

| 文件 | 变更 |
|------|------|
| `web/src/pages/conversation/MessageList.tsx` | 替换 Virtuoso 为原生 div，实现滚动逻辑 |
| `web/src/pages/conversation/index.tsx` | 去掉 Virtuoso 相关状态（virtuosoRef、firstItemIndex 等） |
| `web/src/pages/conversation/ChatView.tsx` | 简化 props，去掉 Virtuoso 透传 |

### 依赖变更

- 移除 `react-virtuoso` 依赖（如其他地方未使用）

## 5. 取舍

### 保留

- 批量更新机制（50ms 合并 SSE 事件）：减少 DOM 操作次数，仍有价值

### 移除

- `followOutput`：原生滚动不需要
- `atBottomStateChange`：用 `onScroll` + 阈值替代
- `firstItemIndex`：原生滚动不需要虚拟索引
- `initialTopMostItemIndex`：原生滚动不需要
- `virtuosoRef`：原生滚动不需要

### 后续优化（建 issue）

- 移除未使用的 `onLoadMoreAfter` 和 `onRangeChanged` props
- 验证流式消息期间 `onAtBottomChange` 的调用频率
- 考虑移除批量更新机制（React 18 自动批处理）

## 6. 验证

### 自动化验证

- Build: ✅ pass (lint + TypeScript)
- Tests: ✅ 98 files, 1173 tests passed

### 手动验证

- [ ] 消息多时滚动无抖动
- [ ] 流式消息期间不抖动
- [ ] 上翻加载历史时位置稳定
- [ ] "新消息 N 条"提示准确
- [ ] 跳转到指定消息功能正常

## 7. 回滚方案

如果原生滚动引入新问题，可以：
1. 恢复 `react-virtuoso` 依赖
2. 恢复 Virtuoso 相关代码
3. 重新应用之前的修复（批量更新、StreamingProcess 折叠等）

## 8. 与之前修复的关系

本方案彻底解决了之前 3 次修复未能解决的问题：

| 修复 | 方案 | 结果 |
|------|------|------|
| F20260803vmsg | 引入 Virtuoso + followOutput | 引入抖动 |
| F20260805abpp | 修复 abort 终态 | 扩大竞争范围 |
| F20260810p7zg | 统一状态源 + debounce | 未根治 |
| **F20260813scrl** | **移除 Virtuoso，用原生滚动** | **彻底解决** |
