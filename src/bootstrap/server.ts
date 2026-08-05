import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { AppConfig } from "@frameworks/config";
import type { PinoLogger } from "@frameworks/logger";
import { createRouter } from "@interface-adapters/http/router";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { FeishuBundle } from "./platforms";
import { setupFeishu } from "./platforms";
import type { initControllers } from "./controllers";
import type { UseCases } from "./types";

type Controllers = ReturnType<typeof initControllers>;

export interface ServerDeps {
  controllers: Controllers;
  agentInvoker: AgentInvoker;
  appConfig: AppConfig;
  uc: UseCases;
  port: number;
  feishu?: FeishuBundle;
  logger: PinoLogger;
}

export function startServer(deps: ServerDeps): void {
  const { controllers, agentInvoker, appConfig, uc, port, feishu, logger } = deps;
  const app = new Hono();
  if (feishu) {
    setupFeishu(appConfig, uc, agentInvoker, feishu, logger);
  }
  app.route("/", createRouter(controllers, logger));

  app.get("/", serveStatic({ root: "./web/dist", path: "index.html" }));
  app.get("/conversation/:id", serveStatic({ root: "./web/dist", path: "conversation.html" }));
  app.get("/memory", serveStatic({ root: "./web/dist", path: "memory.html" }));
  app.get("/skills", serveStatic({ root: "./web/dist", path: "skills.html" }));
  app.get("/connections", serveStatic({ root: "./web/dist", path: "connections.html" }));
  app.get("/settings", serveStatic({ root: "./web/dist", path: "settings.html" }));

  app.use("/*", serveStatic({ root: "./web/dist" }));

  serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`Otter Buddy server running at http://localhost:${info.port}`);
  });
}
