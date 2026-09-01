import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Logger } from "@usecases/ports/logger";
import { createRouter } from "@interface-adapters/http/router";
import { getMetricsRegistry } from "@frameworks/metrics/registry";
import { MPA_PAGES } from "@contract/web/pages";
import type { initControllers } from "./controllers";

type Controllers = ReturnType<typeof initControllers>;

/** 组装 Hono app（路由 + 可选静态页面），不监听端口——测试可直接 app.request */
export function buildHttpApp(controllers: Controllers, logger: Logger, staticRoot: string | false): Hono {
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

  if (staticRoot !== false) {
    // #487（F20260827mpss）：静态路由从单一清单生成（防 PR #116/#444 类漏注册）
    for (const page of MPA_PAGES) {
      app.get(page.pattern, serveStatic({ root: staticRoot, path: `${page.entry}.html` }));
    }

    // F20260901chun：旧 URL 301 重定向到 /im（防外链断裂）
    app.get("/connections", (c) => c.redirect("/im", 301));
    app.get("/weixin", (c) => c.redirect("/im", 301));

    app.use("/*", serveStatic({ root: staticRoot }));
  }

  return app;
}

/** 监听端口（生产路径；测试用 app.request 不需要） */
export function listen(app: Hono, port: number, logger: Logger): void {
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`Otter Buddy server running at http://localhost:${info.port}`);
  });
}
