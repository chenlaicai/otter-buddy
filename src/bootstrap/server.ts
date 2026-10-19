import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "@usecases/ports/logger";
import { createRouter } from "@interface-adapters/http/router";
import { getMetricsRegistry } from "@frameworks/metrics/registry";
import type { initControllers } from "./controllers";

type Controllers = ReturnType<typeof initControllers>;

/** 组装 Hono app（路由 + SPA fallback），不监听端口——测试可直接 app.request。
 *  @param mahjongStaticRoot 三麻牌局页根目录（页面层静态挂载·缺口④）；缺省跟随 staticRoot 开关——
 *  staticRoot=false（测试关静态页）时不挂 */
export function buildHttpApp(
  controllers: Controllers,
  logger: Logger,
  staticRoot: string | false,
  mahjongStaticRoot: string | false = staticRoot === false ? false : resolve(process.cwd(), "web-mahjong"),
): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const requestId = c.get('requestId' as never) as string | undefined;
    logger.error(`Unhandled HTTP error: ${c.req.method} ${c.req.path}`, err instanceof Error ? err : new Error(String(err)), { requestId });
    return c.json({ error: "Internal server error", ...(requestId ? { requestId } : {}) }, 500);
  });

  // Prometheus metric 端点（Prometheus 文本格式）
  app.get("/metrics", async (c) => {
    const registry = getMetricsRegistry();
    if (!registry) return c.text("metrics not initialized", 503);
    const text = await registry.metricsText();
    return c.text(text, 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
  });

  app.route("/", createRouter(controllers, logger));

  // 页面层：三麻牌局页（F20261015mjsg 模块四）。独立原生单页、不进 web/ 的 vite 构建链；
  // 必须先于下方 SPA fallback 注册——app.get("*") 会把 /mahjong/:roomId 吞成 SPA 入口
  //（方案模块四「注意与 SPA fallback 的交互」）。/mahjong=大厅（建房/入座），/mahjong/:roomId=牌局页
  if (mahjongStaticRoot !== false) {
    const mahjongRoot = resolve(mahjongStaticRoot);
    const indexHtml = async (): Promise<Response> => {
      try {
        const content = await readFile(join(mahjongRoot, "index.html"), "utf-8");
        return new Response(content, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("mahjong entry not found", { status: 404 });
      }
    };
    app.get("/mahjong", () => indexHtml());
    app.get("/mahjong/:roomId", () => indexHtml());
    // 资源 URL /mahjong/assets/* → 文件 <mahjongRoot>/*（serveStatic 把 URL 路径拼在 root 后，需改写）
    app.use(
      "/mahjong/assets/*",
      serveStatic({ root: mahjongRoot, rewriteRequestPath: (path) => path.slice("/mahjong/assets".length) }),
    );
  }

  if (staticRoot !== false) {
    // F20260901chun：旧 URL 301 重定向到 /im（防外链断裂）
    app.get("/connections", (c) => c.redirect("/im", 301));
    app.get("/weixin", (c) => c.redirect("/im", 301));

    // SPA 模式：静态资源优先，其余全部 fallback 到 index.html
    // Why: React Router 处理客户端路由，服务端只需确保深链接不 404
    app.use("/*", serveStatic({ root: staticRoot }));

    // SPA fallback：非 API、非静态文件的 GET 请求全部返回 index.html
    // 覆盖 /memory、/skills、/settings 等干净 URL 的深链接直达
    // Why: serveStatic 的 path 选项行为不可靠（Hono 文档不明确），改为异步读取文件
    //       避免模块加载时 readFileSync 的 CWD 问题——alpha 实例启动时 CWD 可能与模块加载时不同
    // S2 修复：排除 /api/ 前缀——API 路由未命中应返回 404，不能被 SPA fallback 吞掉成 200
    const staticRootResolved = resolve(staticRoot);
    app.get("*", async (c) => {
      // API 路由未命中 → 404，不 fallback 到 SPA
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "Not found" }, 404);
      }
      // 页面层：/mahjong* 已由上方显式路由负责，走到这里 = 入口文件缺失 → 404，不回落 SPA
      if (c.req.path === "/mahjong" || c.req.path.startsWith("/mahjong/")) {
        return c.text("mahjong entry not found", 404);
      }
      try {
        const content = await readFile(resolve(staticRootResolved, "index.html"), "utf-8");
        return c.html(content);
      } catch {
        return c.text("SPA entry not found", 404);
      }
    });
  }

  return app;
}

/** 监听端口（生产路径；测试用 app.request 不需要）。
 *  #460：serve() 回调只在成功时触发；EADDRINUSE 等绑定错误走 server 的 'error' 事件——
 *  捕获后干净退出，避免 port 冲突时走 uncaughtException → dispose 链又卡住（僵尸进程根因之三）。 */
export function listen(app: Hono, port: number, logger: Logger): void {
  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`Otter Buddy server running at http://localhost:${info.port}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(`Port ${port} already in use — another instance is likely running. Exiting. (code=${err.code})`);
    } else {
      logger.error(`HTTP server error, exiting`, err);
    }
    process.exit(1);
  });
}
