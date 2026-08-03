---
id: F20260727ui6x
title: dialog-ui-fixes
doc_type: feature

summary: |
  修复对话界面的多个 UI 问题，提升用户体验：
  1. 弹窗字体颜色对比度不足：将 text-stone-500/400 提升为 text-stone-600/500，
     确保在玻璃材质背景上的可读性
  2. 移除"子对话"按钮和"完成"按钮：简化对话头部操作区，仅保留归档按钮
  3. 彻底移除完成功能：移除 CompleteModal、confirmComplete、右键菜单项、api.completeConversation
  4. 消息气泡两侧空间优化：将 padding 从 px-6 减小到 px-1，减少视觉留白
  5. 消息换行显示修复：在 Markdown 渲染的 p 标签添加 whiteSpace: pre-wrap，
     保留用户输入的换行格式
  6. 小獭颜色动态分配：从颜色池中按顺序为每只小獭分配不同颜色
  7. 统一布局宽度约束：移除 max-w-[780px]，统一 padding 为 px-1
  8. 清理死代码：ciCounter、handleCreateChild、handleComplete、ci 参数、otterColors 导出
  9. package-lock.json 路径修正：修正 pi-ai 的 bin 路径格式
  10. CI 添加 PR 标题格式校验

causal_links:
  from:
    - F20260724glas

status: draft
change_type: fix
tags: [ui, modal, conversation, typography, layout, markdown, color, ci]
modules:
  - web/src/pages/conversation/
  - web/src/lib/otter-colors.ts
  - web/src/api/client.ts
  - .github/workflows/ci.yml
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

### 2. 移除"子对话"按钮和"完成"按钮
- **现象**：对话头部同时显示"子对话"、"完成"、"归档"三个按钮，操作区拥挤
- **决策**：移除"子对话"按钮和"完成"按钮，仅保留归档按钮
- **影响**：子对话功能仍可通过右键菜单创建；完成功能已彻底移除

### 3. 彻底移除完成功能
- **决策**：由于没有子对话功能，"完成"状态没有实际意义，决定彻底移除
- **清理范围**：
  - 前端：CompleteModal、confirmComplete、右键菜单项、api.completeConversation
  - 状态机：仅保留 active → archived 两态

### 4. 消息气泡两侧空间过大
- **现象**：消息气泡两侧留白过多，浪费屏幕空间
- **修复**：将 `px-6` 减小到 `px-1`，让气泡贴近两侧

### 5. 消息换行丢失
- **现象**：用户在输入框中使用 Shift+Enter 换行，但发送后换行消失
- **根因**：ReactMarkdown 默认将连续文本合并为单行
- **修复**：在 p 标签样式中添加 `whiteSpace: 'pre-wrap'` 保留换行

### 6. 小獭颜色固定
- **现象**：小獭颜色按固定顺序分配，无法动态适应
- **修复**：改为动态颜色池分配，每只小獭创建时自动分配不同颜色

### 7. 布局宽度约束不一致
- **现象**：消息气泡、加载骨架屏、错误消息、输入框的宽度约束和 padding 不一致
- **修复**：移除 `max-w-[780px]`，统一 padding 为 `px-1`

### 8. 死代码残留
- **现象**：移除功能后仍有残留代码（ciCounter、handleCreateChild、handleComplete、ci 参数、otterColors 导出）
- **修复**：彻底清理所有相关代码

### 9. package-lock.json 路径格式
- **现象**：每次编译后 `pi-ai` 的 bin 路径从 `"./dist/cli.js"` 变为 `"dist/cli.js"`
- **修复**：统一为 `"./dist/cli.js"` 格式

### 10. CI PR 标题格式校验
- **需求**：PR 标题必须包含特性编号，格式为 `[F{日期}{随机字符}]`
- **实现**：在 CI 中添加 PR 标题格式校验，使用 env 变量避免 shell 注入

## 修改文件

| 文件 | 修改内容 |
|------|----------|
| `web/src/pages/conversation/Modals.tsx` | 颜色类名修改 + 移除 CompleteModal |
| `web/src/pages/conversation/ChatView.tsx` | 移除子对话按钮和完成按钮 |
| `web/src/pages/conversation/MessageList.tsx` | padding 调整 + Markdown 换行修复 |
| `web/src/pages/conversation/MessageInput.tsx` | 移除 max-w-[780px] + 统一 padding |
| `web/src/pages/conversation/index.tsx` | 清理死代码 + 移除完成功能 |
| `web/src/lib/otter-colors.ts` | 小獭颜色动态分配 |
| `web/src/lib/mappers.ts` | 移除 ci 参数 |
| `web/src/api/client.ts` | 移除 completeConversation |
| `.github/workflows/ci.yml` | 添加 PR 标题格式校验 |
| `package-lock.json` | pi-ai bin 路径修正 |

## 测试要点

- [ ] 弹窗标签文字清晰可读
- [ ] 对话头部仅显示"归档"按钮
- [ ] 归档按钮功能正常
- [ ] 消息气泡两侧留白适当
- [ ] 输入框换行在消息中正确显示
- [ ] 小獭颜色动态分配
- [ ] CI PR 标题格式校验正常工作
