/**
 * MPA 页面清单单一真相源（issue #487，F20260827mpss）。
 *
 * 同一「有哪些页面」曾散落 4 处副本（vite.config / server.ts / TopBar / 路由测试），
 * 靠人工同步，两次漏注册致 404（PR #116、#444）。收敛后新增/删除页面只改本文件，
 * 4 个消费方自动同步：
 * - web/vite.config.ts（构建入口）
 * - src/bootstrap/server.ts（静态路由）
 * - web/src/components/TopBar.tsx（导航 tab）
 * - tests/bootstrap/server-static-routes.test.ts（防回归 + html 集合守卫）
 */
export interface MpaPage {
  /** vite 入口名 = html 文件名（不含 .html） */
  entry: string;
  /** server 路由 pattern（Hono 语法，:id 为路径参数） */
  pattern: string;
  /** TopBar 导航文案 */
  label: string;
  /** TopBar href（缺省 = pattern 去路径参数后的静态形态） */
  nav?: string;
  /** 测试 URL（缺省 = pattern 中 :param 替换为 "abc"） */
  testUrl?: string;
}

/** MPA 页面清单（顺序即 TopBar 导航顺序——迁就现状，排除带参详情页后的可见顺序不变） */
export const MPA_PAGES: readonly MpaPage[] = [
  { entry: "index", pattern: "/", label: "对话", nav: "/" },
  { entry: "conversation", pattern: "/conversation/:id", label: "对话详情" },
  { entry: "memory", pattern: "/memory", label: "记忆搜索" },
  { entry: "skills", pattern: "/skills", label: "能力库" },
  { entry: "health", pattern: "/health", label: "健康面板" },
  { entry: "connections", pattern: "/connections", label: "连接" },
  { entry: "weixin", pattern: "/weixin", label: "微信" },
  { entry: "settings", pattern: "/settings", label: "设置" },
];

/** 清单 entry 全集（ViewKey 派生源） */
export type MpaEntry = (typeof MPA_PAGES)[number]["entry"];
