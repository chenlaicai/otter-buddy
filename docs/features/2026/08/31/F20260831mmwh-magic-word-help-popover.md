---
id: F20260831mmwh
title: 输入框 Magic Word 问号弹层
summary: 对话页 MessageInput 输入框旁新增「?」图标，点击弹出 Magic Word 词表浮层（停下/绕路了），提升拉闸词可发现性。
change_type: feature
capability_test: n/a（纯前端 UI 交互，无 LLM 行为，走 vitest A 类测试）
tags: [ui, magic-words, conversation]
modules: [web/src/pages/conversation/]
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
from: [F20260826mwrd]
---

# 输入框 Magic Word 问号弹层

## 背景（意图锚）

F20260826mwrd 完成了 Magic Words 词表精简（删 3 留 2）和獭间信号协议，但用户不知道这 2 个词的存在——可发现性缺失。

> 搭档原话：「输入框旁边放个问号，点开显示 magic word 词表」

## 目标

在 MessageInput 输入框旁放置「?」图标按钮，点击弹出浮层显示当前可用的 Magic Word 及其触发行为。

## 非目标

- 不改 SYSTEM.md 词表本身（词表是 prompt 层）
- 不做词表动态加载（2 词，硬编码组件内即可）

## 方案设计

### 新增文件

`web/src/pages/conversation/MagicWordHelp.tsx`

- 「?」图标按钮（lucide-react HelpCircle，与输入框按钮风格一致）
- 点击切换 popover 显隐（useState + click-outside 关闭）
- 词表数据硬编码组件内，注释标注「与 .pi/SYSTEM.md Magic Words 段同步维护」
- `data-testid="magic-word-popover"` 便于测试定位
- aria-expanded / aria-label 无障碍属性

### 修改文件

`web/src/pages/conversation/MessageInput.tsx`

- import MagicWordHelp
- 在 textarea 与 send button 之间插入 `<MagicWordHelp />`

### 测试

`web/src/pages/conversation/MagicWordHelp.test.tsx`

- 6 个测试覆盖：默认不展开、点击展开含两词、再点击关闭、点击外部关闭、footer 提示、aria-expanded 属性

## 影响范围

仅 `web/src/pages/conversation/` 下文件，不涉及后端、不影响其他页面。

## 取舍

1. **硬编码 vs 动态加载**：2 词不值得 API，硬编码最简。注释标注同步义务。
2. **位置**：textarea 右侧、send 按钮左侧，视觉平衡且不影响输入流。
3. **关闭方式**：click-outside 关闭，复用项目既有模式（SignalBadge 同理）。

## 验证

- `npx vitest run` — 298 passed（含 MagicWordHelp 6 个新测试）
- `npx tsc --noEmit` — 0 errors
- 已过最简检查：仓库无现成 magic word 帮助组件；HelpCircle 图标来自已装依赖 lucide-react；无新依赖引入
