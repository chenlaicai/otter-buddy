---
id: F20260824m2345
title: 修复弹窗背景 backdrop-filter 闪烁问题
summary: 修复系统弹窗打开时背景 scrim 的 backdrop-filter 持续闪烁的问题。通过 React.memo 包裹 Modal 组件和稳定父组件回调引用，防止不必要的 re-render 触发 backdrop-filter 重新合成。
change_type: bugfix
status: active
created_at: 2026-08-24
related_to: []
---

# 修复弹窗背景 backdrop-filter 闪烁问题

## 背景与需求

### 问题描述

系统弹窗（如"新建对话"）打开时，背景 scrim 的 `backdrop-filter: blur(6px)` 持续闪烁（模糊 → 清晰 → 模糊 → 清晰）。

### 根因分析

`backdrop-filter` 的工作原理是：浏览器合成器需要把 scrim 背后的内容渲染出来，再对其应用模糊滤镜。**每当背后的内容有任何变化，合成器都要重新合成**，这会导致短暂的"清晰→模糊"闪烁。

对话页背后有多个持续变化源：
1. **5 秒轮询**（`use-conversation-list-polling.ts`）：每 5 秒 `setConversations` 触发整页 re-render
2. **SSE 事件**：活跃 SSE 连接通过 `batchUpdateMessages`（50ms 窗口）持续更新 `allMessages`
3. **`stream-shimmer` 动画**（1.6s infinite）：in-flight 消息的 `::after` 伪元素持续改变合成层

**关键放大因素**：`Modal.tsx` 未做 `React.memo`，且父组件传入的 `onClose` 是内联箭头函数（每次 render 新建引用），导致**父组件每次 re-render 都连带 Modal 一起 re-render**，进一步触发 scrim 的 `backdrop-filter` 重新合成。

## 设计方案

### 修复思路

1. **Memoize Modal 组件**：用 `React.memo` 包裹，稳定 props 不变时跳过 re-render
2. **稳定父组件回调引用**：`onClose`、`onOpenRestart`、`onOpenDissolve` 回调用 `useCallback` 包裹，避免每次 render 产生新引用

### 修改文件

1. **Modal.tsx**：添加 `React.memo` 包裹
2. **index.tsx**：稳定 `onClose`、`onOpenRestart`、`onOpenDissolve` 回调引用

### 测试覆盖

无需新增测试。此修复仅涉及 React 性能优化，不改变业务逻辑。

## 验收标准

- [x] 所有测试通过
- [x] 打开弹窗时背景不再闪烁
- [x] 等待 10 秒以上，背景持续稳定
- [x] CI 通过

## 影响范围

- 影响模块：frontend（Modal 组件、对话页）
- 影响文件：2 个文件
- 破坏性变更：无（向后兼容）

## 取舍

### 取

- 使用 `React.memo` 包裹 Modal 组件，防止不必要的 re-render
- 使用 `useCallback` 稳定回调引用，确保 props 稳定

### 舍

- 无

## 验证

1. 单元测试：所有测试通过
2. 手动验证：打开弹窗时背景不再闪烁
3. CI 验证：通过

## 参考

- 问题来源：用户反馈
- PR 链接：https://github.com/chenlaicai/otter-buddy/pull/382
