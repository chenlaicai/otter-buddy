---
id: F20260826hfix
title: 健康面板 404 修复——server.ts 漏注册 /health 静态路由
summary: PR #444 交付 RHI 健康面板时漏改 src/bootstrap/server.ts 的 MPA 路由注册表，TopBar 有入口但点击 404。补一行路由注册 + 静态路由全量防回归测试。
change_type: fix
tags: [web, routing, health-dashboard, mpa]
modules: [src/bootstrap/server.ts, tests/bootstrap/server-static-routes.test.ts]
from: ["F20260825rweb"]
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
---

# 健康面板 404 修复——server.ts 漏注册 /health 静态路由

## 问题现象

搭档在 Web 界面 TopBar 点击「健康面板」→ 404。导航入口、页面文件均存在。

## 根因

Web 前端是混合 MPA 架构（F20260818 混合架构决策）：每个页面是独立 HTML 入口，**页面路由由后端 server.ts 显式注册**。PR #444（F20260825rweb，Issues #402-#404）交付健康面板时：

- ✅ 新增 `web/health.html` + `web/src/pages/health/index.tsx`（页面文件齐全）
- ✅ vite.config.ts rollupOptions.input 加了 health 入口
- ✅ TopBar.tsx 加了「健康面板」导航项（href: `/health`）
- ✅ 后端 API `/api/health/overview` 等四端点已注册
- ❌ **漏改 `src/bootstrap/server.ts:31-38` 的 MPA 路由注册表**——该文件列了 conversation/memory/skills/connections/settings 五个页面的 serveStatic 注册，唯独没有 `/health`

结果：浏览器请求 `/health` → 没有命中显式路由 → 落到 catch-all `app.use("/*", serveStatic(...))` → staticRoot 下没有 `/health` 目录（只有 `health.html` 文件）→ 404。

## 修复

`src/bootstrap/server.ts` 补一行：

```ts
app.get("/health", serveStatic({ root: staticRoot, path: "health.html" }));
```

## 防回归

新增 `tests/bootstrap/server-static-routes.test.ts`：

- it.each 全量断言 7 个 MPA 页面路由（含 `/health`）→ 200 且返回对应 HTML
- 未注册路径 → 404（页面路由无意外兜底）
- staticRoot=false 时不挂页面路由
- Proxy mock controllers（静态路由不触达 API 层），tmp 目录伪造页面文件，单测毫秒级

**防回归机制**：今后新增 MPA 页面若漏注册路由，`it.each` 清单（与 vite rollupOptions.input 清单保持同步）会红——新增页面时在测试清单同步追加。

## 涉及文件

| 文件 | 改动 |
|------|------|
| src/bootstrap/server.ts | +1 行：注册 `/health` → health.html 静态路由 |
| tests/bootstrap/server-static-routes.test.ts | 新增：MPA 静态路由全量防回归测试（9 用例） |

## 验证

- `npx vitest run tests/bootstrap/server-static-routes.test.ts` → 9 passed
- `npx tsc --noEmit` → 0 error
- `npx eslint` → 0 error
