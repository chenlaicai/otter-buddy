/**
 * SPA 路由配置单一真相源（F20260920spa，继承 #487）。
 *
 * 从 MPA 页面清单改造为 SPA 路由定义。消费方：
 * - web/src/components/TopBar.tsx（导航 tab 渲染）
 * - src/bootstrap/server.ts（SPA fallback 路径匹配）
 * - tests/bootstrap/server-static-routes.test.ts（防回归）
 *
 * Vite 不再需要多入口（单入口 src/main.tsx + React Router）。
 */

export interface SpaRoute {
  /** 路由路径（React Router 语法） */
  path: string;
  /** 导航标签（null = 不进入 TopBar 导航，如对话详情页） */
  label: string | null;
  /** TopBar href（缺省 = path，含动态段时必须显式声明静态形态） */
  nav?: string;
  /** 测试 URL（缺省 = path 中 :param 替换为 "abc"） */
  testUrl?: string;
}

/** SPA 路由配置（顺序即 TopBar 导航顺序） */
export const SPA_ROUTES: readonly SpaRoute[] = [
  { path: "/conversation", label: "对话" },
  { path: "/conversation/:id", label: null },
  { path: "/memory", label: "记忆搜索" },
  { path: "/skills", label: "能力库" },
  { path: "/im", label: "IM" },
  { path: "/health", label: "健康面板" },
  { path: "/activity", label: "活动" },
  { path: "/settings", label: "设置" },
];

/** 可导航路由（排除 label=null 的详情页） */
export const NAV_ROUTES = SPA_ROUTES.filter(r => r.label !== null);
