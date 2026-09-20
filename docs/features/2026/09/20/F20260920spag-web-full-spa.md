---
id: F20260920spag
title: Web 前端全量 SPA 化
summary: 将 MPA（多 HTML 入口）架构一次性重构为全 SPA（React Router 客户端路由 + 单 HTML 入口 + 路由级懒加载 + 布局层单次渲染），所有 8 个功能页面迁入
change_type: refactor
capability_test: "n/a: 纯 A 类架构重构，无 LLM 行为变更"
created_in_conversation: 2006bca9-d162-40b6-b8e1-11ec3807300d
from:
  - F20260802hybr
  - F20260828mpss
tags:
  - web
  - frontend
  - architecture
  - spa
  - react-router
modules:
  - web/src/main.tsx
  - web/vite.config.ts
  - api-contract/web/pages.ts
  - src/bootstrap/server.ts
  - src/app.ts
created_at: 2026-09-20
---

## 背景

原有架构为 MPA（多页面应用），每个页面（/memory、/skills、/settings 等）是独立 HTML 文件，页面切换走浏览器原生导航（整页刷新、白屏、顶栏侧栏重建）。

搭档（chen）在对话中提出：希望页面切换像其他网站一样丝滑，URL 变化但界面不整页刷新。

经讨论确认 SPA 化方案后，搭档选择方案 A（一次性全量迁移）。

## 目标

- T1：所有 8 个功能页面通过 React Router 客户端路由渲染，URL 变化时无白屏
- T2：TopBar/Sidebar 只渲染一次，页面切换时保持不动
- T3：路由级懒加载（React.lazy + Suspense），未访问页面代码不下载
- T4：深链接直达（直接访问 /memory 等干净 URL 不 404）
- T5：现有测试全部通过，无行为回退

## 非目标

- 不改变 SSE 连接语义（保持「切走即断」，后台保活是后续增强）
- 不做 UI 视觉重设计（外观保持现状，只换架构）
- 不做后端业务逻辑改动
- 不引入 zustand 全局状态管理（已从依赖中移除，后续按需引入）

## 设计取舍

### 机制识别检查点判定

本特性为架构重构（Refactor），属于修法排序④新增机制（SPA 路由机制取代 MPA 页面路由机制）。

**机制预算四问**：
1. **新增了什么机制？** React Router 客户端路由机制（BrowserRouter + Routes + lazy + Suspense）取代 MPA 页面路由机制（多 HTML 入口 + 服务端静态路由）
2. **影响范围？** 所有前端页面（8 个）、服务端静态路由逻辑、构建配置
3. **退役条件？** SPA 架构稳定运行后，MPA 相关代码已全部清理
4. **后续机制？** zustand 全局状态管理（按需引入）、View Transitions API（渐进增强）

### 最简实现检查

已过最简检查：
- React Router 是 React 生态标准路由方案，无更简替代
- 路由级懒加载使用 React.lazy + import()，是平台原生能力
- 服务端 SPA fallback 使用 readFile 异步读取，避免模块加载时 CWD 问题

### 关键决策

1. **SPA fallback 实现方式**：使用 `readFile(resolve(staticRootResolved, "index.html"))` 异步读取，而非 `serveStatic({ path: "index.html" })`——后者在 Hono 中行为不可靠（alpha 实例 CWD 与模块加载时不同）
2. **staticRoot 路径解析**：使用 `import.meta.dirname` 获取模块目录，再 `path.resolve(import.meta.dirname, "../..", "web/dist")` 得到绝对路径——避免 alpha 实例 CWD 问题
3. **页面组件导出方式**：改为 `export default`（React.lazy 要求），测试文件相应更新为 `const { default: XxxPage } = await import('./index')`

## 改动范围

### 新增文件

| 文件 | 说明 |
|------|------|
| web/src/main.tsx | SPA 单入口（BrowserRouter + Routes + lazy） |
| web/e2e/spa-verification.spec.ts | Playwright e2e 测试（SPA 路由验证） |

### 修改文件

| 文件 | 操作 | 说明 |
|------|------|------|
| api-contract/web/pages.ts | 改 | MPA_PAGES → SPA_ROUTES（路由配置格式） |
| src/app.ts | 改 | staticRoot 使用 import.meta.dirname 解析绝对路径 |
| src/bootstrap/server.ts | 改 | MPA 静态路由 → SPA fallback（readFile 异步读取） |
| web/vite.config.ts | 改 | 多入口构建 → 单入口构建 + exclude e2e 目录 |
| web/index.html | 改 | 指向 /src/main.tsx（SPA 入口） |
| web/src/components/AppLayout.tsx | 改 | 移除 activeView props，改为 Outlet 布局 |
| web/src/components/TopBar.tsx | 改 | 使用 Link + useLocation 导航 |
| web/src/pages/conversation/index.tsx | 改 | 移除 createRoot/AppLayout，使用 useParams/useNavigate |
| web/src/pages/conversation-list/index.tsx | 改 | 移除 createRoot/AppLayout，使用 useNavigate/useSearchParams |
| web/src/pages/memory/index.tsx | 改 | 移除 createRoot/AppLayout，改为 export default |
| web/src/pages/skills/index.tsx | 改 | 移除 createRoot/AppLayout，改为 export default |
| web/src/pages/settings/index.tsx | 改 | 移除 createRoot/AppLayout，改为 export default |
| web/src/pages/im/index.tsx | 改 | 移除 createRoot/AppLayout，改为 export default |
| web/src/pages/health/index.tsx | 改 | 移除 createRoot/AppLayout，改为 export default |
| web/src/pages/activity/index.tsx | 改 | 移除 createRoot/AppLayout，改为 export default |
| web/src/components/AppLayout.test.tsx | 改 | 使用 MemoryRouter + Route 包装测试 |
| web/src/pages/memory/index.test.tsx | 改 | 更新 import 方式（default export） |
| web/src/pages/skills/index.test.tsx | 改 | 更新 import 方式（default export） |
| tests/bootstrap/server-static-routes.test.ts | 改 | MPA 路由测试 → SPA fallback 测试 |

### 删除文件

| 文件 | 说明 |
|------|------|
| web/conversation.html | MPA 入口（已迁入 SPA） |
| web/memory.html | MPA 入口（已迁入 SPA） |
| web/skills.html | MPA 入口（已迁入 SPA） |
| web/settings.html | MPA 入口（已迁入 SPA） |
| web/im.html | MPA 入口（已迁入 SPA） |
| web/health.html | MPA 入口（已迁入 SPA） |
| web/activity.html | MPA 入口（已迁入 SPA） |

## 验证

### 测试结果

- Web 测试：54 文件 / 495 测试全绿
- 后端测试：268 文件 / 3661 测试全绿
- TypeScript 编译：通过
- Vite 构建：成功（代码分割正常）

### SPA 功能验证（alpha 实例 localhost:3116）

- ✅ 深链接直达：/、/conversation、/memory、/skills、/im、/health、/activity、/settings、/conversation/abc123 全部返回 200
- ✅ 静态资源正确返回（JS/CSS 文件）
- ✅ API 路由正常工作（/api/settings、/api/health/overview）

### 最简实现检查

已过最简检查：React Router + React.lazy + import() 是平台原生能力，无更简替代方案。

### 检视修正（2026-09-20）

对抗审视发现 4 严重 + 5 建议，本 PR 修复 S2/S3/S4 + R1/R2/R4/R5：

- **S2 SPA fallback 吞 API 404**：服务端 SPA fallback 现在排除 `/api/` 前缀，API 路由未命中返回 404 而非 200
- **S3 设置页未保存守卫失效**：从纯 `beforeunload` 升级为 `useBlocker`（SPA 路由级拦截）+ `beforeunload` 双保险
- **R1 尾斜杠语义翻转**：已登记进负面向验收条目
- **R2 TopBar「不重渲染」断言升级**：e2e spec 升级为 elementHandle identity 断言
- **R4 zustand 幽灵依赖**：已从 `web/package.json` 移除
- **R5 草稿缓存卸载不 flush**：`useDraftCache` 组件卸载时同步 flush 草稿到 localStorage

### 负面向验收条目

**本次变更破坏了什么旧契约/绕过了什么既有保护？**

- 破坏了 MPA 页面独立隔离的故障隔离特性（SPA 共享运行时，一处泄漏全局连坐）
- 绕过了 MPA 整页刷新的状态重置特性（SPA 状态跨页面保留，需注意内存管理）
- 破坏了 MPA 每页独立 HTML 的首屏加载特性（SPA 需要下载更多 JS 才能首屏渲染）
- **R1 尾斜杠语义翻转**：MPA 模式下 `/memory` 和 `/memory/` 是不同路由（不同 HTML 文件），SPA 模式下 React Router 默认标准化尾斜杠（`/memory/` → `/memory`）。这是 SPA 的标准行为，但改变了旧契约。
- **S3 beforeunload 语义翻转**：MPA 模式下页面切换触发 `beforeunload`（整页刷新），SPA 模式下客户端导航不触发。设置页未保存守卫已从纯 `beforeunload` 升级为 `useBlocker`（SPA 路由级拦截）+ `beforeunload`（浏览器关闭）双保险。

这些是 SPA 架构的已知权衡，非意外破坏。后续通过路由级懒加载、监听器/定时器审计来缓解。

## 影响范围

- 前端所有页面（8 个）的渲染方式从 MPA 改为 SPA
- 服务端静态路由逻辑从逐页面注册改为 SPA fallback
- 构建配置从多入口改为单入口
- 测试文件需要适配新的组件导出方式
