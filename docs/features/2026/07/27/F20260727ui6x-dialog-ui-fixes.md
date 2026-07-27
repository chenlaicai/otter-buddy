---
id: F20260727ui6x
title: dialog-ui-fixes
doc_type: feature

summary: |
  修复对话界面的多个 UI 问题，提升用户体验：
  1. 弹窗字体颜色对比度不足：将 text-stone-500/400 提升为 text-stone-600/500，
     确保在玻璃材质背景上的可读性
  2. 移除多余的"子对话"按钮：简化对话头部操作区，保留完成和归档按钮
  3. 消息气泡两侧空间优化：将 padding 从 px-6 减小到 px-3，减少视觉留白
  4. 消息换行显示修复：在 Markdown 渲染的 p 标签添加 whiteSpace: pre-wrap，
     保留用户输入的换行格式
  5. package-lock.json 路径修正：修正 pi-ai 的 bin 路径格式

causal_links:
  from:
    - F20260724glas

status: draft
change_type: bugfix
tags: [ui, modal, conversation, typography, layout, markdown]
modules:
  - web/src/pages/conversation/
  - package-lock.json

created_at: 2026-07-27
---

# F20260727ui6x 对话界面多项 UI 修复

## 问题描述

### 1. 弹窗字体颜色对比度不足
- **现象**：弹窗中的标签文字和描述文字颜色过浅，在玻璃材质背景上难以辨认
- **根因**：使用了 `text-stone-500`（#78716C）和 `text-stone-400`（#A8A29E），
  在 `glass-overlay` 的浅色半透明背景上对比度不足
- **修复**：提升为 `text-stone-600`（#57534E）和 `text-stone-500`（#78716C）

### 2. 多余的"子对话"按钮
- **现象**：对话头部同时显示"子对话"、"完成"、"归档"三个按钮，操作区拥挤
- **决策**：移除"子对话"按钮，保留核心的完成和归档操作
- **影响**：子对话功能仍可通过右键菜单创建

### 3. 消息气泡两侧空间过大
- **现象**：消息气泡两侧留白过多，浪费屏幕空间
- **修复**：将 `px-6` 减小到 `px-3`，让气泡更贴近两侧

### 4. 消息换行丢失
- **现象**：用户在输入框中使用 Shift+Enter 换行，但发送后换行消失
- **根因**：ReactMarkdown 默认将连续文本合并为单行
- **修复**：在 p 标签样式中添加 `whiteSpace: 'pre-wrap'` 保留换行

### 5. package-lock.json 路径格式
- **现象**：每次编译后 `pi-ai` 的 bin 路径从 `"./dist/cli.js"` 变为 `"dist/cli.js"`
- **修复**：统一为 `"./dist/cli.js"` 格式

## 修改文件

| 文件 | 修改内容 |
|------|----------|
| `web/src/pages/conversation/Modals.tsx` | 32 处颜色类名修改 |
| `web/src/pages/conversation/ChatView.tsx` | 移除子对话按钮及相关 import |
| `web/src/pages/conversation/MessageList.tsx` | padding 调整 + Markdown 换行修复 |
| `package-lock.json` | pi-ai bin 路径修正 |

## 测试要点

- [ ] 弹窗标签文字清晰可读
- [ ] 对话头部不再显示"子对话"按钮
- [ ] 完成/归档按钮功能正常
- [ ] 消息气泡两侧留白减少
- [ ] 输入框换行在消息中正确显示
