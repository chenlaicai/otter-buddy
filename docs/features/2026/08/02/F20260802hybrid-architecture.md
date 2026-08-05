---
id: F20260802hybr
title: hybrid-architecture
doc_type: feature

summary: |
  Web 前端混合架构：功能页面间 MPA 整页刷新，对话内 SPA 实时交互。每个对话有独立 URL /conversation/:id，
  功能页面用现代 URL（/memory /skills /settings /connections），对话内 SSE 不中断。
  Vite 多入口构建，服务端路由实现干净 URL（无 .html 后缀）。解决对话无独立 URL、URL 带 .html 后缀、
  800+ 行巨型组件、无法深链接等问题。

status: final
change_type: feature
tags: [web, frontend, architecture, mpa, spa, routing, vite, hybrid]
modules:
  - src/main.ts
  - web/vite.config.ts
  - web/src/pages/conversation/
  - web/src/pages/memory/
  - web/src/pages/skills/
  - web/src/pages/settings/
  - web/src/pages/connections/

created_at: 2026-08-02
---

# F20260802hybr Web 前端混合架构

## 概述

将 Web 前端从纯 MPA 架构改造为混合架构：功能页面间 MPA 整页刷新，对话内 SPA 实时交互。

## 背景

### 原有问题

1. **对话没有独立 URL**：所有对话共用 URL `/`，切换对话只是 `setActiveId(id)` 而 URL 不变
2. **URL 带 `.html` 后缀**：页面间用 `<a href="/memory.html">` 跳转，不现代
3. **代码臃肿**：`conversation/index.tsx` 是 800+ 行的巨型组件，包含所有逻辑
4. **无法深链接**：无法直接链接到某个对话，无法分享对话 URL

### 需求

1. 每个对话有独立 URL：`/conversation/:id`
2. 功能页面用现代 URL：`/memory`, `/skills`, `/settings`, `/connections`
3. 功能页面间跳转整页刷新，页面独立
4. 对话内实时交互，SSE 不中断
5. 代码可维护性

## 架构决策

### 决策：混合架构

**架构要求**：
1. 功能页面间（对话/记忆/设置）：MPA，整页刷新，页面独立
2. 对话间（对话A → 对话B）：MPA，整页刷新，独立 URL
3. 对话内（发送消息/接收流式）：SPA，实时交互，SSE 不中断

**Why:** 用户明确要求，不允许任何质疑和修改。用户认为 SPA 把所有逻辑打包成一个 JS，后期难以维护。混合架构兼顾了代码可维护性和实时交互需求。

**How to apply:**
- 每个功能页面是独立的 HTML 文件
- 页面间跳转使用 `<a href>`，整页刷新
- 对话详情页内部使用 React 管理状态和 SSE
- 对话详情页之间跳转也是整页刷新
- URL 干净，无 `.html` 后缀（通过服务端路由实现）

## 技术方案

### URL 结构

| URL | 页面 | 类型 |
|-----|------|------|
| `/` | 对话列表 | MPA（独立HTML） |
| `/conversation/:id` | 对话详情 | MPA + 内部SPA |
| `/memory` | 记忆搜索 | MPA（独立HTML） |
| `/skills` | 能力库 | MPA（独立HTML） |
| `/connections` | 连接管理 | MPA（独立HTML） |
| `/settings` | 设置 | MPA（独立HTML） |

### 服务端路由

```typescript
// src/main.ts
app.get('/', serveStatic({ root: './web/dist', path: 'index.html' }))
app.get('/conversation/:id', serveStatic({ root: './web/dist', path: 'conversation.html' }))
app.get('/memory', serveStatic({ root: './web/dist', path: 'memory.html' }))
app.get('/skills', serveStatic({ root: './web/dist', path: 'skills.html' }))
app.get('/connections', serveStatic({ root: './web/dist', path: 'connections.html' }))
app.get('/settings', serveStatic({ root: './web/dist', path: 'settings.html' }))
```

### 前端架构

#### 1. 对话详情页（MPA + 内部SPA）

```
conversation.html
├── React 入口（conversation/index.tsx）
├── 状态管理（useState）
├── SSE 长连接（对话内不中断）
├── 消息流实时渲染
└── 页面内导航（切换对话时整页刷新）
```

**关键点**：
- 对话详情页本身是一个 React 应用（SPA）
- 但对话之间是独立的（切换对话时整页刷新）
- SSE 连接在对话内保持，不会被页面跳转中断

#### 2. 其他页面（纯MPA）

```
memory.html
├── 独立HTML
├── 可以用 React（轻量）
├── 不需要 SSE
└── 跳转时整页刷新
```

### Vite 配置

```typescript
// web/vite.config.ts
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        conversation: resolve(__dirname, 'conversation.html'),
        memory: resolve(__dirname, 'memory.html'),
        skills: resolve(__dirname, 'skills.html'),
        settings: resolve(__dirname, 'settings.html'),
        connections: resolve(__dirname, 'connections.html'),
      },
    },
  },
})
```

### 文件结构

```
web/
├── index.html                    # 对话列表
├── conversation.html             # 对话详情（SPA）
├── memory.html                   # 记忆搜索
├── skills.html                   # 能力库
├── settings.html                 # 设置
├── connections.html              # 连接管理
├── src/
│   ├── components/               # 共享组件
│   │   ├── TopBar.tsx
│   │   ├── Toast.tsx
│   │   └── ...
│   ├── pages/
│   │   ├── conversation-list/    # 对话列表页
│   │   │   └── index.tsx
│   │   ├── conversation/         # 对话详情页（SPA）
│   │   │   ├── index.tsx         # 入口
│   │   │   ├── ChatView.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageInput.tsx
│   │   │   └── ...
│   │   ├── memory/               # 记忆搜索页
│   │   │   └── index.tsx
│   │   ├── skills/               # 能力库页
│   │   │   └── index.tsx
│   │   ├── settings/             # 设置页
│   │   │   └── index.tsx
│   │   └── connections/          # 连接管理页
│   │       └── index.tsx
│   └── api/                      # API 客户端
│       ├── client.ts
│       └── sse.ts
```

## 实施步骤

### Phase 1: 配置服务端路由

1. 修改 `src/main.ts`，添加服务端路由
2. `/conversation/:id` → `conversation.html`
3. `/memory` → `memory.html`
4. 等等

### Phase 2: 创建独立 HTML 文件

1. 创建 `conversation.html`
2. 创建 `memory.html`
3. 创建 `skills.html`
4. 创建 `settings.html`
5. 创建 `connections.html`

### Phase 3: 对话详情页改造

1. 对话详情页保持 React（SPA）
2. 通过 URL 参数获取对话 ID
3. 切换对话时整页刷新（跳转到新URL）

### Phase 4: 其他页面改造

1. 其他页面独立（纯MPA）
2. 可以用 React（轻量）
3. 不需要 SSE

### Phase 5: 更新 TopBar

1. TopBar 使用 `<a href>` 跳转
2. URL 干净，无 `.html` 后缀

## 关键决策

### 决策 1：架构选型 — 混合架构 vs 纯 SPA vs 纯 MPA

**选项**：
- **纯 SPA**：一个 HTML 入口，所有路由由前端处理
- **纯 MPA**：每个页面独立 HTML，路由由服务端处理
- **混合架构**：功能页面 MPA，对话内 SPA

**决策**：选择**混合架构**

**决策过程**：
1. 最初考虑纯 SPA，但用户明确反对
2. 用户认为 SPA 把所有逻辑打包成一个 JS，后期难以维护
3. 用户要求：功能页面间 MPA 整页刷新，对话内 SPA 实时交互
4. 此决策不允许任何质疑和修改

**Why:** 用户明确要求，不允许任何质疑和修改。用户认为 SPA 把所有逻辑打包成一个 JS，后期难以维护。混合架构兼顾了代码可维护性和实时交互需求。

**How to apply:**
- 每个功能页面是独立的 HTML 文件
- 页面间跳转使用 `<a href>`，整页刷新
- 对话详情页内部使用 React 管理状态和 SSE
- 对话详情页之间跳转也是整页刷新
- URL 干净，无 `.html` 后缀（通过服务端路由实现）

### 决策 2：对话详情页是否用 React？

**决策**：**是**

**原因**：
- 需要实时流式输出（SSE）
- 需要复杂状态管理（消息列表、输入框）
- 需要动态更新（新消息实时渲染）

### 决策 3：其他页面是否用 React？

**决策**：**可选**

**原因**：
- 这些页面相对简单
- 可以用原生 JS 或轻量 React
- 不需要 SSE

### 决策 4：如何处理对话间切换？

**决策**：**整页刷新**

**原因**：
- 每个对话有独立 URL
- 切换对话时跳转到新 URL
- 浏览器前进/后退正常工作

### 决策 5：如何处理对话内交互？

**决策**：**SPA 方式**

**原因**：
- SSE 长连接不中断
- 消息实时渲染
- 状态保持

### 决策 6：URL 格式

**选项**：
- 带 `.html` 后缀：`/memory.html`, `/skills.html`
- 干净 URL：`/memory`, `/skills`

**决策**：选择**干净 URL**

**原因**：
- 现代 Web 应用标准
- 更美观、更专业
- 通过服务端路由实现

### 决策 7：对话 ID 传递方式

**选项**：
- URL 路径参数：`/conversation/:id`
- URL 查询参数：`/?id=:id`
- URL 哈希：`/#/:id`

**决策**：选择**URL 路径参数**

**原因**：
- RESTful 风格
- 语义清晰
- 便于分享和书签

## 验证方法

1. **功能页面间跳转**：点击 Tab，整页刷新
2. **对话间切换**：点击对话，URL 变化，整页刷新
3. **对话内交互**：发送消息，SSE 流式输出不中断
4. **浏览器前进/后退**：正常工作
5. **刷新对话页面**：能正确加载对话

## 与纯 SPA 方案的对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| **纯 SPA** | 体验好、无刷新 | 所有逻辑打包成一个JS |
| **混合架构** | 页面独立、对话内实时 | 实现复杂度稍高 |

## 总结

混合架构是最佳选择：
- 功能页面独立（MPA）：代码可维护
- 对话内实时（SPA）：体验好
- 每个对话独立URL：可分享、可深链接
