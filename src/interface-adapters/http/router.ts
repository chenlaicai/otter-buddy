import type { Context } from "hono";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import type { Logger } from "@usecases/ports/logger";
import { identityMiddleware, type Identity, type ServiceTokenVerifier, type SessionVerifier } from "./identity-middleware";
import type { AuthController } from "./controllers/auth-controller";
import type { ConversationController } from "./controllers/conversation-controller";
import type { OtterController } from "./controllers/otter-controller";
import type { MessageController } from "./controllers/message-controller";
import type { InvokeController } from "./controllers/invoke-controller";
import type { EntryController } from "./controllers/entry-controller";
import type { MemoryController } from "./controllers/memory-controller";
import type { KeyInfoController } from "./controllers/key-info-controller";
import type { SettingsController } from "./controllers/settings-controller";
import type { BackgroundController } from "./controllers/background-controller";
import type { ScheduledTaskController } from "./controllers/scheduled-task-controller";
import type { ConnectionController } from "./controllers/connection-controller";
import type { HealthController } from "./controllers/health-controller";
import type { RhiController } from "./controllers/rhi-controller";
import type { WorkLedgerController } from "./controllers/work-ledger-controller";
import type { AttachmentController } from "./controllers/attachment-controller";
import type { WorkspaceController } from "./controllers/workspace-controller";
import type { WeixinConnectionController } from "./controllers/weixin-connection-controller";
import type { FeishuConnectionController } from "./controllers/feishu-connection-controller";
import type { ChannelController } from "./controllers/channel-controller";
import type { SkillController } from "./controllers/skill-controller";
import type { PromptController } from "./controllers/prompt-controller";
import type { ActivityController } from "./controllers/activity-controller";
import type { MatterController } from "./controllers/matter-controller";
import type { UnfurlController } from "./controllers/unfurl-controller";
import type { MahjongController } from "./controllers/mahjong-controller";
import type { ConnectorPairController } from "./controllers/connector-pair-controller";
import type { ConnectorOnboardingController } from "./controllers/connector-onboarding-controller";
import { machinePoolSnapshot } from "@usecases/execution/execution-machine-pool";



/** createRouter 可选装配（统一接入 + 执行机投影；测试不传则退化为 基线 + 无 auth 端点）。 */
export interface RouterPlumbingOptions {
  auth?: {
    /** 会话校验器（session cookie → 身份），注入身份中间件。 */
    verifySession: SessionVerifier;
    /** 服务令牌校验器（Bearer token → 服务身份）；不注入 = 服务令牌通道不存在。 */
    verifyServiceToken?: ServiceTokenVerifier;
    controller: AuthController;
  };
  executionMachines?: {
    list: () => Array<{ id: string; name: string }>;
    currentId: () => string;
    /** + （检视）：已配对设备全量状态（含离线——
     *  人要看得见离线设备才能决定切回；缺省退化仅 local——旧装配/测试兼容） */
    deviceStatus?: () => Promise<Array<{ deviceId: string; name: string; online: boolean; lastSeenAt: string | null }>>;
    /** 对话存在性校验（GET 404 口径对齐 PUT——不注入则不校验，测试桩兼容） */
    conversationExists?: (conversationId: string) => Promise<boolean>;
    /** 对话当前执行机读（选择器回显用） */
    getConversationMachine?: (conversationId: string) => Promise<string | null>;
    /** 对话远程动作状态（执行状态展示） */
    listConversationRemoteActions?: (conversationId: string, limit?: number) => Promise<Array<{ actionId: string; deviceId: string; actionType: string; status: string; error: string | null; createdAt: string; settledAt: string | null }>>;
    /** 对话级切换（目标校验+写列；缺省 501） */
    setConversationMachine?: (conversationId: string, machineId: string | null) => Promise<{ ok: true } | { ok: false; status: 400 | 404; error: string }>;
  };
  /** connector 配对端点（码即秘密，无登录态） */
  connectorPair?: ConnectorPairController;
  /** Web 设备接入（登录态签发 + CLI tarball 下载） */
  connectorOnboarding?: ConnectorOnboardingController;
}

export interface Controllers {
  conversation: ConversationController;
  otter: OtterController;
  message: MessageController;
  /** invoke 只读查询端点（Session 弹窗数据源） */
  invoke: InvokeController;
  /** 切换清扫：entries 时间线只读查询端点 */
  entry: EntryController;
  memory: MemoryController;
  keyInfo: KeyInfoController;
  settings: SettingsController;
  background: BackgroundController;
  scheduledTask: ScheduledTaskController;
  connection: ConnectionController;
  health: HealthController;
  rhi: RhiController;
  /** 工作账本 + 模型效率（只读报告） */
  workLedger?: WorkLedgerController;
  /** 多模态：附件端点（上传 + 文件流） */
  attachment?: AttachmentController;
  /** 工作区文件浏览端点（只读） */
  workspace?: WorkspaceController;
  /** 微信连接管理端点 */
  weixin?: WeixinConnectionController;
  /** 飞书扫码连接管理端点 */
  feishuScan?: FeishuConnectionController;
  /** 通道状态聚合端点（统一 IM 页 + 真实健康状态） */
  channel?: ChannelController;
  /** 能力库真数据源端点 */
  skills?: SkillController;
  /** 能力库全书——系统提示词分节 + 工具清单端点 */
  prompts?: PromptController;
  /** 活动页三域台账只读端点 */
  activity: ActivityController;
  /** 待办板只读端点（matters 表 open 清单） */
  matter: MatterController;
  /** 链类 unfurl 预览卡数据端点（og 元数据代理抓取） */
  unfurl: UnfurlController;
  /** 三麻将局 API（建房/入座/开局/动作/视图/复盘/SSE/恢复）——可选装配 */
  mahjong?: MahjongController;
  /** connector 配对端点（可选装配——测试不传则无此路由） */
  connectorPair?: ConnectorPairController;
  inbound: { optionsEvents: (c: Context) => Response | Promise<Response>; receiveEvents: (c: Context) => Response | Promise<Response>; getStatus: (c: Context) => Response | Promise<Response> };
}

/** 启动时刻（供 /api/ping 探活返回 uptime） */
const PROCESS_START_TIME = Date.now();

function registerConvRoutes(app: Hono, c: Controllers): void {
  // 探活端点：无鉴权、零依赖（不碰库/不上游）——systemd ExecStartPost、
  // nginx/部署脚本健康检查、云监控专用；身份策略表置 public（不进会话/业务面）。
  app.get("/api/ping", (ctx) => ctx.json({ ok: true, pid: process.pid, uptimeSec: Math.floor((Date.now() - PROCESS_START_TIME) / 1000) }));
  app.get("/api/conversations", (ctx) => c.conversation.list(ctx));
  app.post("/api/conversations", (ctx) => c.conversation.create(ctx));
  app.get("/api/conversations/:id", (ctx) => c.conversation.getById(ctx));
  app.patch("/api/conversations/:id/kind", (ctx) => c.conversation.promoteKind(ctx));
  app.patch("/api/conversations/:id/archive", (ctx) => c.conversation.archive(ctx));
  app.patch("/api/conversations/:id/pin", (ctx) => c.conversation.pin(ctx));
  app.patch("/api/conversations/:id/unpin", (ctx) => c.conversation.unpin(ctx));
  app.get("/api/conversations/:id/participants", (ctx) => c.conversation.getParticipants(ctx));
}

function registerMsgRoutes(app: Hono, c: Controllers): void {
  app.get("/api/conversations/:id/subscribe", (ctx) => c.message.subscribe(ctx));
  app.post("/api/conversations/:id/messages", (ctx) => c.message.sendMessage(ctx));
  app.get("/api/conversations/:id/unread", (ctx) => c.message.getUnreadState(ctx));
  app.post("/api/conversations/:id/read", (ctx) => c.message.markRead(ctx));
  // invoke 只读查询（Session 弹窗 + 獭状态面板）
  app.get("/api/conversations/:id/invokes", (ctx) => c.invoke.list(ctx));
  app.get("/api/invokes/:id/events", (ctx) => c.invoke.getEvents(ctx));
  // 彻底切换：invoke 中止/重试（UI 停止与重试按钮唯一后端；messages abort/retry 退役）
  app.post("/api/invokes/:id/abort", (ctx) => c.invoke.abort(ctx));
  app.post("/api/invokes/:id/retry", (ctx) => c.invoke.retry(ctx));
  // test17（搭档拍板）：獭锚重试——重试的是獭的 session（上下文载体），invoke 只是执行记录
  app.post("/api/otters/:id/retry", (ctx) => c.invoke.retryByOtter(ctx));
  // 彻底切换：entries 时间线唯一渲染数据源（messages 只读端点退役）
  app.get("/api/conversations/:id/entries", (ctx) => c.entry.list(ctx));
}

function registerOtterRoutes(app: Hono, c: Controllers): void {
  app.get("/api/otters/:id", (ctx) => c.otter.getById(ctx));
  app.post("/api/otters", (ctx) => c.otter.create(ctx));
  app.delete("/api/otters/:id", (ctx) => c.otter.dissolve(ctx));
  app.get("/api/otters/:id/sessions", (ctx) => c.otter.getSessionHistory(ctx));
  app.post("/api/otters/:id/restart", (ctx) => c.otter.restart(ctx));
  app.get("/api/otters/:id/profile", (ctx) => c.otter.getProfile(ctx));
}

/** 活动页三域台账（全只读，无写端点——纯展示承诺） */
function registerActivityRoutes(app: Hono, c: Controllers): void {
  app.get("/api/activity/healing", (ctx) => c.activity.healing(ctx));
  app.get("/api/activity/signals", (ctx) => c.activity.signals(ctx));
  app.get("/api/activity/dispatch", (ctx) => c.activity.dispatch(ctx));
}

/** RHI 面板写路径（扫描 + 处置队列 triage）——从 registerDataRoutes 拆出控语句数 */
function registerRhiWriteRoutes(app: Hono, c: Controllers): void {
  app.post("/api/health/scan", (ctx) => c.rhi.scan(ctx));
  // 面板处置队列写路径（与 agent 工具共享 repo.triage() 单一方法）
  app.post("/api/health/signals/:id/triage", (ctx) => c.rhi.triageSignal(ctx));
}

/** 背景资产端点，与工作账本等新路由并存时保持装配函数精简。 */
function registerBackgroundRoutes(app: Hono, c: Controllers): void {
  app.get("/api/settings/background", (ctx) => c.background.get(ctx));
  app.put("/api/settings/background", (ctx) => c.background.put(ctx));
  app.delete("/api/settings/background", (ctx) => c.background.delete(ctx));
}

function registerDataRoutes(app: Hono, c: Controllers): void {
  app.get("/api/health/memory", (ctx) => c.health.memory(ctx));

  registerActivityRoutes(app, c);

  // 能力库真数据 + 全书三编数据源；未注入时 503，前端降级
  if (c.skills) app.get("/api/skills", (ctx) => c.skills!.list(ctx));
  if (c.prompts) app.get("/api/prompts", (ctx) => c.prompts!.list(ctx));
  // RHI 面板 API（与 memory 健康端点同前缀，职责分离的 controller）
  app.get("/api/health/overview", (ctx) => c.rhi.overview(ctx));
  app.get("/api/health/signals", (ctx) => c.rhi.signals(ctx));
  app.get("/api/health/chains", (ctx) => c.rhi.chains(ctx));
  // 链详情（commits 全类型序列——泳道时间线/复发卡数据源）
  app.get("/api/health/chains/:featureId", (ctx) => c.rhi.chainDetail(ctx));
  app.get("/api/health/trends", (ctx) => c.rhi.trends(ctx));
  app.get("/api/health/score", (ctx) => c.rhi.score(ctx));
  app.get("/api/health/cost-output", (ctx) => c.rhi.costOutput(ctx));
  // 工作账本（列表/详情）+ 模型效率（provider+model × 日/周/月）
  const workLedger = c.workLedger;
  if (workLedger) {
    app.get("/api/health/work-ledger", (ctx) => workLedger.workLedger(ctx));
    app.get("/api/health/work-ledger/:id", (ctx) => workLedger.workDetail(ctx));
    app.get("/api/health/model-efficiency", (ctx) => workLedger.modelEfficiency(ctx));
  }
  registerRhiWriteRoutes(app, c);
  registerMemoryRoutes(app, c);
  app.get("/api/conversations/:id/key-resources", (ctx) => c.keyInfo.getKeyResources(ctx));
  app.post("/api/conversations/:id/resources", (ctx) => c.keyInfo.linkResource(ctx));
  app.patch("/api/conversations/:id/resources/:resourceId", (ctx) => c.keyInfo.flagResource(ctx));
  app.delete("/api/conversations/:id/resources/:resourceId", (ctx) => c.keyInfo.deleteLinkedResource(ctx));
  app.get("/api/settings", (ctx) => c.settings.getSettings(ctx));
  app.put("/api/settings", (ctx) => c.settings.updateSettings(ctx));
  registerBackgroundRoutes(app, c);
}


/** 记忆域路由（拆出，守 registerDataRoutes 语句数上限；行为不变） */
function registerMemoryRoutes(app: Hono, c: Controllers): void {
  app.get("/api/memory/search", (ctx) => c.memory.search(ctx));
  // 记忆搜索页初始态数据源（最近记忆，非检索）
  app.get("/api/memory/recent", (ctx) => c.memory.recent(ctx));
  app.post("/api/memory/search/similar", (ctx) => c.memory.searchSimilar(ctx));
  app.get("/api/memory/batch", (ctx) => c.memory.getDetails(ctx));
  app.get("/api/memory/dark-entries", (ctx) => c.memory.getDarkEntries(ctx));
  app.get("/api/memory/:id", (ctx) => c.memory.getById(ctx));
  app.patch("/api/memory/:id/flag", (ctx) => c.memory.flag(ctx));
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

/** 待办板只读端点（matters 表 open 清单） */
function registerMatterRoutes(app: Hono, c: Controllers): void {
  app.get("/api/conversations/:id/matters", (ctx) => c.matter.listOpenByConversation(ctx));
}

/** 链类 unfurl——GET /api/unfurl?url=，失败 404 前端降级普通链接 */
function registerUnfurlRoutes(app: Hono, c: Controllers): void {
  app.get("/api/unfurl", (ctx) => c.unfurl.get(ctx));
}

function registerConnectionRoutes(app: Hono, c: Controllers): void {
  // 死端点下线——GET/POST /api/connections、GET :id/session、
  // POST :id/leave 已退役（前端 后零调用），仅存活端点保留；usecase 方法留命令体系。
  app.get("/api/connections/:id", (ctx) => c.connection.getById(ctx));
  app.post("/api/connections/:id/enter", (ctx) => c.connection.enterConversation(ctx));
  app.get("/api/connections/:id/conversations", (ctx) => c.connection.listActiveConversations(ctx));
}

/** 通用 inbound 端点（按 source 分发到 use case，路由名不焊死领域） */
function registerInboundRoutes(app: Hono, c: Controllers): void {
  app.options('/api/inbound/events', (ctx) => c.inbound.optionsEvents(ctx));
  app.post('/api/inbound/events', (ctx) => c.inbound.receiveEvents(ctx));
  app.get('/api/inbound/status', (ctx) => c.inbound.getStatus(ctx));
}

/** 工作区文件浏览端点（只读） */
function registerWorkspaceRoutes(app: Hono, c: Controllers): void {
  if (c.workspace) {
    app.get("/api/conversations/:id/workspace", (ctx) => c.workspace!.listDir(ctx));
    app.get("/api/conversations/:id/workspace/stats", (ctx) => c.workspace!.getStats(ctx));
    app.get("/api/conversations/:id/workspace/file", (ctx) => c.workspace!.readFile(ctx));
    app.put("/api/conversations/:id/workspace/mcp-external", (ctx) => c.workspace!.writeExternalMcp(ctx));
    app.post("/api/conversations/:id/workspace/reveal", (ctx) => c.workspace!.reveal(ctx));
  }

  // 微信连接管理：扫码登录 + 多账号
  if (c.weixin) {
    app.post("/api/weixin/login", (ctx) => c.weixin!.startLogin(ctx));
    app.get("/api/weixin/login/:id", (ctx) => c.weixin!.getLogin(ctx));
    app.post("/api/weixin/login/:id/cancel", (ctx) => c.weixin!.cancelLogin(ctx));
    app.get("/api/weixin/accounts", (ctx) => c.weixin!.listAccounts(ctx));
    // 同号识别（扫码前探测已有账号，覆盖确认用）
    app.post("/api/weixin/accounts/lookup", (ctx) => c.weixin!.lookupExistingAccount(ctx));
    app.post("/api/weixin/accounts/:id/assistant-line", (ctx) => c.weixin!.provisionAssistantLine(ctx));
    // 存量线补/改称呼（connection.metadata.userName）
    app.patch("/api/weixin/accounts/:id/user-name", (ctx) => c.weixin!.updateUserName(ctx));
    app.delete("/api/weixin/accounts/:id", (ctx) => c.weixin!.deleteAccount(ctx));
  }

  // 飞书扫码接入（registerApp 免凭证建 app；对齐微信全套语义）
  if (c.feishuScan) {
    app.post("/api/feishu/login", (ctx) => c.feishuScan!.startLogin(ctx));
    app.get("/api/feishu/login/:id", (ctx) => c.feishuScan!.getLogin(ctx));
    app.post("/api/feishu/login/:id/cancel", (ctx) => c.feishuScan!.cancelLogin(ctx));
    app.get("/api/feishu/apps", (ctx) => c.feishuScan!.listApps(ctx));
    app.post("/api/feishu/apps/:id/assistant-line", (ctx) => c.feishuScan!.provisionAssistantLine(ctx));
    app.delete("/api/feishu/apps/:id", (ctx) => c.feishuScan!.deleteApp(ctx));
  }
}

/** 创建 Hono 路由并挂载所有 Controller 端点（端点域拆分注册函数，见各 register*Routes） */


/** 麻将房间端点组（拆分降复杂度） */
function registerMahjongRoutes(app: Hono, ctrl: Controllers): void {
  if (ctrl.mahjong) {
    const m = ctrl.mahjong;
    app.post("/api/mahjong/rooms", (ctx) => m.create(ctx));
    app.post("/api/mahjong/rooms/:roomId/join", (ctx) => m.join(ctx));
    app.post("/api/mahjong/rooms/:roomId/start", (ctx) => m.start(ctx));
    app.post("/api/mahjong/rooms/:roomId/actions", (ctx) => m.action(ctx));
    app.post("/api/mahjong/rooms/:roomId/continue", (ctx) => m.continueRound(ctx));
    app.post("/api/mahjong/rooms/:roomId/stop", (ctx) => m.stop(ctx));
    app.post("/api/mahjong/rooms/:roomId/chat", (ctx) => m.chat(ctx));
    app.get("/api/mahjong/rooms/:roomId/view", (ctx) => m.view(ctx));
    app.get("/api/mahjong/rooms/:roomId/frames", (ctx) => m.frames(ctx));
    app.get("/api/mahjong/rooms/:roomId/events", (ctx) => m.events(ctx));
    app.post("/api/mahjong/rooms/:roomId/recover", (ctx) => m.recover(ctx));
  }
}

/** auth 端点组（拆分降复杂度；connector 配对端点在 registerPlumbingRoutes 尾部注册） */
function registerAuthRoutes(app: Hono, plumbing: RouterPlumbingOptions): void {
  if (plumbing?.auth) {
    app.post("/api/auth/login", (ctx) => plumbing.auth!.controller.login(ctx));
    app.post("/api/auth/logout", (ctx) => plumbing.auth!.controller.logout(ctx));
    app.get("/api/auth/session", (ctx) => plumbing.auth!.controller.session(ctx));
  }
}

/** 执行机端点组（拆出降 registerPlumbingRoutes 复杂度） */
function registerExecutionMachineRoutes(app: Hono, plumbing: RouterPlumbingOptions): void {
  // Web 执行机列表：local（Registry 恒在）+ 已配对设备全量（含离线——Registry
  // 投影下线即注销，离线设备只有 devices 表可见；「已配对设备含在线状态点」）。
  if (plumbing?.executionMachines) {
    app.get("/api/execution-machines", async (ctx) => {
      // 单一投影：与 agent list_execution_machines 工具共用 machinePoolSnapshot
      // （两处独立拼装会漂移）。
      const snapshot = await machinePoolSnapshot(
        { list: () => plumbing.executionMachines!.list(), currentMachineId: () => plumbing.executionMachines!.currentId() },
        plumbing.executionMachines!.deviceStatus,
      );
      return ctx.json(snapshot);
    });
  }

  // 对话当前执行机 + 远程动作状态（执行状态展示）。
  //  GET 404 口径对齐 PUT——不存在对话显式 404「conversation not found」。
  if (plumbing?.executionMachines?.getConversationMachine) {
    app.get("/api/conversations/:id/execution-machine", async (ctx) => {
      const conversationId = ctx.req.param("id");
      if (plumbing.executionMachines!.conversationExists
        && !(await plumbing.executionMachines!.conversationExists(conversationId))) {
        return ctx.json({ error: "conversation not found" }, 404);
      }
      const machineId = await plumbing.executionMachines!.getConversationMachine!(conversationId);
      return ctx.json({ machineId });
    });
  }
  if (plumbing?.executionMachines?.listConversationRemoteActions) {
    app.get("/api/conversations/:id/remote-actions", async (ctx) => {
      const conversationId = ctx.req.param("id");
      if (plumbing.executionMachines!.conversationExists
        && !(await plumbing.executionMachines!.conversationExists(conversationId))) {
        return ctx.json({ error: "conversation not found" }, 404);
      }
      // ctx.req.query 地道用法（行为与 URL searchParams 等价）
      const limitParam = Number(ctx.req.query("limit") ?? 50);
      const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;
      const actions = await plumbing.executionMachines!.listConversationRemoteActions!(conversationId, limit);
      return ctx.json({ actions });
    });
  }

  // 对话级当前执行机切换（owner session）
  if (plumbing?.executionMachines?.setConversationMachine) {
    app.put("/api/conversations/:id/execution-machine", async (ctx) => {
      const machineId = (await ctx.req.json().catch(() => null) as { machineId?: unknown } | null)?.machineId;
      if (machineId !== null && typeof machineId !== "string") {
        return ctx.json({ error: "machineId must be a string or null" }, 400);
      }
      const result = await plumbing.executionMachines!.setConversationMachine!(ctx.req.param("id"), machineId);
      if (!result.ok) return ctx.json({ error: result.error }, result.status);
      return ctx.json({ ok: true });
    });
  }
}

export function createRouter(ctrl: Controllers, logger: Logger, plumbing?: RouterPlumbingOptions): Hono {
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
    // 身份中间件已在 next 链内解析——带上 userId 供访问日志审计
    const identity = c.get('identity' as never) as Identity | undefined;
    logger.info('HTTP request completed', {
      requestId,
      userId: identity?.userId,
      role: identity?.role,
      method: c.req.method,
      path: c.req.path,
      statusCode: c.res.status,
      duration,
    });
  });

  /** 对话域鉴权层——身份声明 + 路由策略表 + fail-closed 兑底，
   *  挂在 requestId 之后、所有路由之前（一处覆盖既有与新增端点）。
   * 注入会话校验器后真实登录 cookie 优先，声明式头/query 回退。 */
  app.use('*', identityMiddleware(plumbing?.auth?.verifySession, plumbing?.auth?.verifyServiceToken));

  registerPlumbingRoutes(app, plumbing);

  registerConvRoutes(app, ctrl);
  registerMsgRoutes(app, ctrl);

  /** 三麻将局域端点（控制器注入时挂载） */
  if (ctrl.mahjong) registerMahjongRoutes(app, ctrl);
  registerOtterRoutes(app, ctrl);
  registerDataRoutes(app, ctrl);
  registerScheduledTaskRoutes(app, ctrl);
  registerMatterRoutes(app, ctrl);
  registerUnfurlRoutes(app, ctrl);
  registerConnectionRoutes(app, ctrl);
  registerInboundRoutes(app, ctrl);
  registerWorkspaceRoutes(app, ctrl);
  // 通道状态聚合端点（统一 IM 页 + 真实健康状态）
  if (ctrl.channel) {
    app.get("/api/channels/status", (ctx) => ctrl.channel!.getStatus(ctx));
  }

  /** 多模态：附件端点（可选装配——未注入时不暴露路由） */
  if (ctrl.attachment) {
    app.post("/api/conversations/:id/attachments", (ctx) => ctrl.attachment!.upload(ctx));
    app.get("/api/attachments/:id", (ctx) => ctrl.attachment!.getById(ctx));
  }

  return app;
}

/** 统一接入 + 执行机投影端点。拆出以守住 createRouter 行数预算。 */
function registerPlumbingRoutes(app: Hono, plumbing?: RouterPlumbingOptions): void {
  // 登录/登出已在策略表置 public，session 走 authenticated。
  if (plumbing) registerAuthRoutes(app, plumbing);

  if (plumbing) registerExecutionMachineRoutes(app, plumbing);

  // connector 配对——码即秘密，不要求登录态（connector 无浏览器）
  if (plumbing?.connectorPair) {
    app.post("/api/connector/pair", (ctx) => plumbing.connectorPair!.pair(ctx));
  }
  if (plumbing?.connectorOnboarding) {
    app.post("/api/connector/pairing-codes", (ctx) => plumbing.connectorOnboarding!.issueCode(ctx));
    app.get("/api/connector/download", (ctx) => plumbing.connectorOnboarding!.download(ctx));
    app.get("/api/connector/download/app", (ctx) => plumbing.connectorOnboarding!.downloadApp(ctx));
    app.post("/api/connector/download/bootstrap", (ctx) => plumbing.connectorOnboarding!.downloadBootstrap(ctx));
  }
}
