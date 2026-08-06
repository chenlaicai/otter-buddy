import type { Context } from "hono";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationController } from "./controllers/conversation-controller";
import type { OtterController } from "./controllers/otter-controller";
import type { MessageController } from "./controllers/message-controller";
import type { MemoryController } from "./controllers/memory-controller";
import type { KeyInfoController } from "./controllers/key-info-controller";
import type { SettingsController } from "./controllers/settings-controller";
import type { ScheduledTaskController } from "./controllers/scheduled-task-controller";
import type { ConnectionController } from "./controllers/connection-controller";
import type { HealthController } from "./controllers/health-controller";


export interface Controllers {
  conversation: ConversationController;
  otter: OtterController;
  message: MessageController;
  memory: MemoryController;
  keyInfo: KeyInfoController;
  settings: SettingsController;
  scheduledTask: ScheduledTaskController;
  connection: ConnectionController;
  health: HealthController;
  inbound: { optionsEvents: (c: Context) => Response | Promise<Response>; receiveEvents: (c: Context) => Response | Promise<Response>; getStatus: (c: Context) => Response | Promise<Response> };
}

function registerConvRoutes(app: Hono, c: Controllers): void {
  app.get("/api/conversations", (ctx) => c.conversation.list(ctx));
  app.post("/api/conversations", (ctx) => c.conversation.create(ctx));
  app.get("/api/conversations/:id", (ctx) => c.conversation.getById(ctx));
  app.patch("/api/conversations/:id/complete", (ctx) => c.conversation.complete(ctx));
  app.patch("/api/conversations/:id/archive", (ctx) => c.conversation.archive(ctx));
  app.patch("/api/conversations/:id/pin", (ctx) => c.conversation.pin(ctx));
  app.patch("/api/conversations/:id/unpin", (ctx) => c.conversation.unpin(ctx));
  app.get("/api/conversations/:id/participants", (ctx) => c.conversation.getParticipants(ctx));
}

function registerMsgRoutes(app: Hono, c: Controllers): void {
  app.get("/api/conversations/:id/messages", (ctx) => c.message.list(ctx));
  app.get("/api/conversations/:id/messages/after", (ctx) => c.message.listAfter(ctx));
  app.get("/api/conversations/:id/subscribe", (ctx) => c.message.subscribe(ctx));
  app.post("/api/conversations/:id/messages", (ctx) => c.message.sendMessage(ctx));
  app.get("/api/conversations/:id/unread", (ctx) => c.message.getUnreadState(ctx));
  app.post("/api/conversations/:id/read", (ctx) => c.message.markRead(ctx));
  app.get("/api/messages/:id", (ctx) => c.message.getById(ctx));
  app.get("/api/messages/:id/events", (ctx) => c.message.getEvents(ctx));
  app.get("/api/messages/:id/expand", (ctx) => c.message.expand(ctx));
  app.post("/api/messages/:id/abort", (ctx) => c.message.abort(ctx));
}

function registerOtterRoutes(app: Hono, c: Controllers): void {
  app.get("/api/otters/:id", (ctx) => c.otter.getById(ctx));
  app.post("/api/otters", (ctx) => c.otter.create(ctx));
  app.delete("/api/otters/:id", (ctx) => c.otter.dissolve(ctx));
  app.get("/api/otters/:id/sessions", (ctx) => c.otter.getSessionHistory(ctx));
  app.post("/api/otters/:id/restart", (ctx) => c.otter.restart(ctx));
}

function registerDataRoutes(app: Hono, c: Controllers): void {
  app.get("/api/health/memory", (ctx) => c.health.memory(ctx));
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

function registerScheduledTaskRoutes(app: Hono, c: Controllers): void {
  app.post("/api/conversations/:id/scheduled-tasks", (ctx) => c.scheduledTask.create(ctx));
  app.get("/api/conversations/:id/scheduled-tasks", (ctx) => c.scheduledTask.listByConversation(ctx));
  app.get("/api/scheduled-tasks/:taskId", (ctx) => c.scheduledTask.getById(ctx));
  app.patch("/api/scheduled-tasks/:taskId", (ctx) => c.scheduledTask.update(ctx));
  app.delete("/api/scheduled-tasks/:taskId", (ctx) => c.scheduledTask.delete(ctx));
  app.post("/api/scheduled-tasks/:taskId/trigger", (ctx) => c.scheduledTask.trigger(ctx));
  app.get("/api/scheduled-tasks/:taskId/executions", (ctx) => c.scheduledTask.listExecutions(ctx));
}

function registerConnectionRoutes(app: Hono, c: Controllers): void {
  app.get("/api/connections", (ctx) => c.connection.list(ctx));
  app.post("/api/connections", (ctx) => c.connection.create(ctx));
  app.get("/api/connections/:id", (ctx) => c.connection.getById(ctx));
  app.get("/api/connections/:id/session", (ctx) => c.connection.getSession(ctx));
  app.post("/api/connections/:id/enter", (ctx) => c.connection.enterConversation(ctx));
  app.post("/api/connections/:id/leave", (ctx) => c.connection.leaveConversation(ctx));
  app.get("/api/connections/:id/conversations", (ctx) => c.connection.listActiveConversations(ctx));
}

/** F20260805rbrg：通用 inbound 端点（按 source 分发到 use case，路由名不焊死领域） */
function registerInboundRoutes(app: Hono, c: Controllers): void {
  app.options('/api/inbound/events', (ctx) => c.inbound.optionsEvents(ctx));
  app.post('/api/inbound/events', (ctx) => c.inbound.receiveEvents(ctx));
  app.get('/api/inbound/status', (ctx) => c.inbound.getStatus(ctx));
}

/** 创建 Hono 路由并挂载所有 Controller 端点 */
export function createRouter(ctrl: Controllers, logger: Logger): Hono {
  const app = new Hono();

  /** HTTP 请求日志中间件 */
  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    const start = Date.now();

    // 注入 requestId 到 context（下游 sse-streamer、http-error 通过 c.get('requestId') 读取）
    c.set('requestId' as never, requestId);
    c.header('X-Request-ID', requestId);

    await next();

    const duration = Date.now() - start;
    logger.info('HTTP request completed', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      statusCode: c.res.status,
      duration,
    });
  });

  registerConvRoutes(app, ctrl);
  registerMsgRoutes(app, ctrl);
  registerOtterRoutes(app, ctrl);
  registerDataRoutes(app, ctrl);
  registerScheduledTaskRoutes(app, ctrl);
  registerConnectionRoutes(app, ctrl);
  registerInboundRoutes(app, ctrl);

  return app;
}
