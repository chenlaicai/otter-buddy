import { Hono } from "hono";
import type { ConversationController } from "./controllers/conversation-controller";
import type { OtterController } from "./controllers/otter-controller";
import type { MessageController } from "./controllers/message-controller";
import type { MemoryController } from "./controllers/memory-controller";
import type { KeyInfoController } from "./controllers/key-info-controller";
import type { SettingsController } from "./controllers/settings-controller";

export interface Controllers {
  conversation: ConversationController;
  otter: OtterController;
  message: MessageController;
  memory: MemoryController;
  keyInfo: KeyInfoController;
  settings: SettingsController;
}

function registerConvRoutes(app: Hono, c: Controllers): void {
  app.get("/api/conversations", (ctx) => c.conversation.list(ctx));
  app.post("/api/conversations", (ctx) => c.conversation.create(ctx));
  app.get("/api/conversations/:id", (ctx) => c.conversation.getById(ctx));
  app.patch("/api/conversations/:id/complete", (ctx) => c.conversation.complete(ctx));
  app.patch("/api/conversations/:id/archive", (ctx) => c.conversation.archive(ctx));
  app.get("/api/conversations/:id/participants", (ctx) => c.conversation.getParticipants(ctx));
}

function registerMsgRoutes(app: Hono, c: Controllers): void {
  app.get("/api/conversations/:id/messages", (ctx) => c.message.list(ctx));
  app.post("/api/conversations/:id/messages", (ctx) => c.message.sendMessage(ctx));
  app.get("/api/messages/:id", (ctx) => c.message.getById(ctx));
  app.get("/api/messages/:id/events", (ctx) => c.message.getEvents(ctx));
  app.post("/api/messages/:id/abort", (ctx) => c.message.abort(ctx));
}

function registerOtterRoutes(app: Hono, c: Controllers): void {
  app.get("/api/otters/:id", (ctx) => c.otter.getById(ctx));
  app.post("/api/otters", (ctx) => c.otter.create(ctx));
  app.delete("/api/otters/:id", (ctx) => c.otter.dissolve(ctx));
  app.get("/api/otters/:id/sessions", (ctx) => c.otter.getSessionHistory(ctx));
  app.post("/api/otters/:id/sessions", (ctx) => c.otter.createSession(ctx));
  app.post("/api/otters/:id/restart", (ctx) => c.otter.restart(ctx));
}

function registerDataRoutes(app: Hono, c: Controllers): void {
  app.get("/api/memory/search", (ctx) => c.memory.search(ctx));
  app.post("/api/memory/search/similar", (ctx) => c.memory.searchSimilar(ctx));
  app.get("/api/memory/batch", (ctx) => c.memory.getDetails(ctx));
  app.get("/api/memory/:id", (ctx) => c.memory.getById(ctx));
  app.patch("/api/memory/:id/flag", (ctx) => c.memory.flag(ctx));
  app.get("/api/conversations/:id/key-resources", (ctx) => c.keyInfo.getKeyResources(ctx));
  app.post("/api/conversations/:id/resources", (ctx) => c.keyInfo.linkResource(ctx));
  app.patch("/api/conversations/:id/resources/:resourceId", (ctx) => c.keyInfo.flagResource(ctx));
  app.delete("/api/conversations/:id/resources/:resourceId", (ctx) => c.keyInfo.deleteLinkedResource(ctx));
  app.get("/api/settings", (ctx) => c.settings.getSettings(ctx));
  app.put("/api/settings", (ctx) => c.settings.updateSettings(ctx));
}

/** 创建 Hono 路由并挂载所有 Controller 端点 */
export function createRouter(ctrl: Controllers): Hono {
  const app = new Hono();
  registerConvRoutes(app, ctrl);
  registerMsgRoutes(app, ctrl);
  registerOtterRoutes(app, ctrl);
  registerDataRoutes(app, ctrl);
  return app;
}
