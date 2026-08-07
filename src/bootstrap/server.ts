import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Logger } from "@usecases/ports/logger";
import { createRouter } from "@interface-adapters/http/router";
import type { initControllers } from "./controllers";

type Controllers = ReturnType<typeof initControllers>;

/** 组装 Hono app（路由 + 可选静态页面），不监听端口——测试可直接 app.request */
export function buildHttpApp(controllers: Controllers, logger: Logger, staticRoot: string | false): Hono {
  const app = new Hono();
  app.route("/", createRouter(controllers, logger));

  if (staticRoot !== false) {
    app.get("/", serveStatic({ root: staticRoot, path: "index.html" }));
    app.get("/conversation/:id", serveStatic({ root: staticRoot, path: "conversation.html" }));
    app.get("/memory", serveStatic({ root: staticRoot, path: "memory.html" }));
    app.get("/skills", serveStatic({ root: staticRoot, path: "skills.html" }));
    app.get("/connections", serveStatic({ root: staticRoot, path: "connections.html" }));
    app.get("/settings", serveStatic({ root: staticRoot, path: "settings.html" }));

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
