import { buildContextTokenWarnConfig, type AppConfig } from "@frameworks/config";
import fsSync from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { Logger } from "@usecases/ports/logger";
import type Database from "better-sqlite3";
import type { ModelPool } from "@frameworks/llm/model-pool";
import { initAgentSessionFactory } from "@frameworks/agent/pi-session-factory";
// F20260826mwrd C3（#534）：createManageHealingEventsTool 改为仅 tool-factory 内注册，此处不再 import
import type { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { OtterContextWindowProvider } from "@usecases/ports/otter-context-window-provider";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { Repositories, UseCases } from "./types";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import { seedPaperTradingTasks } from "@usecases/paper-trading/ensure-paper-trading-scheduler";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { Ledger } from "@usecases/paper-trading/ledger";
import { PaperTradeRepositoryImpl } from "@frameworks/db/paper-trade-repository-impl";
import { StockQuoteGatewayImpl } from "@frameworks/stock/stock-quote-gateway-impl";
import { syncTradingCalendar } from "@usecases/paper-trading/sync-trading-calendar";
import { registerPaperTradingFunctions } from "@usecases/paper-trading/register-functions";
import { paperTradingFunctionRegistry } from "@usecases/paper-trading/function-registry";
import { createManageHealingEventsTool } from "@interface-adapters/agent-runtime/tools/healing-tools";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { SignalRouter } from "@usecases/conversation/signal-router";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import { SimpleCronParser } from "@frameworks/scheduler/cron-parser";
import { SchedulerService } from "@usecases/scheduler/scheduler-service";
import type { SchedulerMetrics } from "@frameworks/metrics/scheduler-metrics";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { FeishuConfig } from "@frameworks/feishu/types";
import { FeishuAccessTokenManager } from "@frameworks/feishu/access-token-manager";
import { FeishuUserInfoClient } from "@frameworks/feishu/user-info-client";
import { FeishuClient } from "@frameworks/feishu/client";
import { FeishuLongConnectionClient } from "@frameworks/feishu/long-connection-client";
import { FeishuLongConnectionHandler } from "@interface-adapters/feishu/long-connection-handler";
import { FeishuMessageProcessor } from "@interface-adapters/feishu/message-processor";
import { CommandDispatcher } from "@interface-adapters/feishu/command-dispatcher";
import { PartnerResolver } from "@usecases/im/partner-resolver";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import { AttachmentInjectionService } from "@usecases/conversation/attachment-injection-service";
import { FeishuResourceClient } from "@frameworks/feishu/resource-client";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { FeishuMessageChannel } from "@usecases/im/feishu-message-channel";
import { WeixinApiClient } from "@frameworks/weixin/api-client";
import { WeixinCdnClient } from "@frameworks/weixin/cdn/cdn-client";
import { WeixinMediaClient } from "@frameworks/weixin/media-client";
import { WeixinAccountStore, type WeixinAccount } from "@frameworks/weixin/account-store";
import type { WeixinConfig } from "@frameworks/weixin/types";
import { WeixinPollingChannel } from "@frameworks/weixin/polling-channel";
import { InMemoryChannelStatusRegistry } from "@usecases/channel/channel-status-registry";
import type { ChannelStatusRegistry } from "@usecases/channel/channel-status";

import { WeixinMessageChannel } from "@usecases/im/weixin-message-channel";
import { WeixinGatewayAdapter } from "@interface-adapters/weixin/weixin-gateway-adapter";
import { WeixinMessageProcessor } from "@interface-adapters/weixin/message-processor";
import { ensureHealingConversation } from "@usecases/healing/ensure-healing-conversation";
import { ensureHealingScheduler } from "@usecases/healing/ensure-healing-scheduler";
import { ProcessInboundRecruit } from "@usecases/recruiting/process-inbound-recruit";
import { GetBridgeStatus } from "@usecases/recruiting/get-bridge-status";
import { ensureRecruitingConversation } from "@usecases/recruiting/ensure-recruiting-conversation";
import { ensureRecruitingScheduler } from "@usecases/recruiting/ensure-recruiting-scheduler";
import { buildHandoffPackage } from "@frameworks/agent/handoff-package-builder";

export interface FeishuBundle {
  client: FeishuClient;
  tokenManager: FeishuAccessTokenManager;
  dispatchChainEngine: DispatchChainEngine;
}

/** 创建 AgentGateway（PiSessionFactory），解决 OtterToolClient 循环依赖 */
export async function createAgentGateway(options: {
  repos: Repositories;
  otterConfigProvider: OtterConfigProvider;
  model: Model<Api>;
  modelPool: ModelPool;
  db: Database.Database;
  logger: Logger;
  /** pi session 文件目录（默认 ./data/sessions，测试指向临时目录） */
  sessionDir?: string;
  /** Otter 身份文案目录（默认 ./prompts/identity） */
  identityPromptDir?: string;
  /** 对话工作区网关 */
  workspaceGateway?: WorkspaceGateway;
}): Promise<{ agentGateway: PiSessionFactory; resolveOtterToolClient: (client: OtterToolClient) => void; resolveManageScheduledTask: (mst: ManageScheduledTask) => void }> {
  const { repos, otterConfigProvider, model, modelPool, db, logger } = options;
  // Why: manageScheduledTask 在 initUseCases 之后才可用，用 mutable ref 延迟注入
  let manageScheduledTaskRef: ManageScheduledTask | null = null;
  // OtterToolClient 循环依赖：先注入空占位，initUseCases 后通过 resolveOtterToolClient 注入真实实例
  const agentGateway = await initAgentSessionFactory({
    model, modelPool, db,
    otterToolClient: null,
    sessionDir: options.sessionDir,
    identityPromptDir: options.identityPromptDir ?? "./prompts/identity",
    createTools: (ctx, repo, log) => {
      // PR4: 创建纸面交易 Ledger 注入到工具
      const paperTradeRepo = new PaperTradeRepositoryImpl(db);
      const paperGateway = new StockQuoteGatewayImpl(process.cwd());
      const paperLedger = new Ledger(paperTradeRepo, paperGateway);
      const paperLedgerRef = { ledger: paperLedger, getAccountId: () => {
        const accounts = db.prepare('SELECT id FROM paper_accounts LIMIT 1').get() as { id: string } | undefined;
        return accounts?.id;
      } };
      const tools = createTools(ctx, repo, log, options.workspaceGateway, manageScheduledTaskRef ?? undefined, paperLedgerRef);
      if (repo) tools.push(createManageHealingEventsTool(ctx, repo));
      return tools;
    },
    healingRepo: repos.healingEvent,
    signalRepo: repos.signalEvent,
    // F20260826mwrd C1：halt 首次注入时把 signal_events 从 pending 迁到 resolved
    // （resolvedBy=系统，resolution=指令已到达目标獭——halt 无待裁决事项，落账即闭环）。
    // 回调在 tool_call handler 栈内执行（同步语义），resolve 走 fire-and-forget + catch。
    onHaltFirstBlock: (directive) => {
      repos.signalEvent.resolve(
        directive.id,
        "resolved",
        `halt 指令已在目标獭下一个工具调用边界注入（发起者 ${directive.fromOtterName}）`,
        "system",
      ).catch(err => logger.error("Failed to mark halt signal as resolved", err instanceof Error ? err : new Error(String(err))));
    },
    otterConfigProvider,
    otterRepo: repos.otter,
    settingsRepo: repos.settings,
  }, logger);

  return {
    agentGateway,
    resolveOtterToolClient: (client) => agentGateway.setOtterToolClient(client),
    resolveManageScheduledTask: (mst) => { manageScheduledTaskRef = mst; },
  };
}

export function createDispatchChainEngine(repos: Repositories, uc: UseCases, appConfig: AppConfig, logger: Logger, agentMetrics?: AgentMetricsPort): DispatchChainEngine {
  return new DispatchChainEngine({
    conversationRepo: repos.conversation,
    queryMessage: uc.queryMessage,
    queryOtter: uc.queryOtter,
    logger,
    maxChainDepth: appConfig.circuitBreaker.maxChainDepth,
    settingsRepo: repos.settings,
    metrics: agentMetrics,
    // F20260826fpbd：搭档身份静态判定。appConfig.feishu 可选，未配置时 PartnerResolver 降级（动态推断）
    partnerResolver: new PartnerResolver(appConfig.feishu?.partnerOpenId),
  });
}

/**
 * F20260901cxmw：otterId → modelAlias → contextWindow 解析闭包（窄端口注入，避免 interface-adapters 越层依赖 frameworks）。
 * otterConfigProvider 缺失时 getConfig 回 undefined → getContextWindow(undefined) 即默认模型窗口。
 */
function buildCtxWindowProvider(
  modelPool: ModelPool,
  otterConfigProvider?: OtterConfigProvider,
): OtterContextWindowProvider {
  return {
    getOtterContextWindow: (otterId: string): number | undefined => {
      const alias = otterConfigProvider?.getConfig(otterId)?.modelAlias;
      // 未配 alias 时走默认模型窗口（model-pool.getContextWindow 语义：null/undefined → 默认条目）
      return modelPool.getContextWindow(alias);
    },
  };
}

export async function initAgentAndScheduler(options: { repos: Repositories; uc: UseCases; agentGateway: PiSessionFactory; messageBroadcaster: MessageBroadcaster | undefined; logger: Logger; workspaceGateway?: WorkspaceGateway; metrics?: SchedulerMetrics; agentMetrics?: AgentMetricsPort; dispatchChainEngine?: DispatchChainEngine; db?: Database.Database; appConfig?: AppConfig; modelPool?: ModelPool; otterConfigProvider?: OtterConfigProvider }) {
  const { repos, uc, agentGateway, messageBroadcaster, logger, workspaceGateway, metrics, agentMetrics, dispatchChainEngine, db, appConfig, modelPool, otterConfigProvider } = options;
  await agentGateway.warmup();

  // PR4: 注册纸面交易函数（function executor 使用）
  if (db) {
    const paperTradeRepo = new PaperTradeRepositoryImpl(db);
    const paperGateway = new StockQuoteGatewayImpl(process.cwd());
    const paperLedger = new Ledger(paperTradeRepo, paperGateway);
    registerPaperTradingFunctions(paperLedger, paperTradeRepo);

    // A3: 同步交易日历（akshare 或 fallback）
    syncTradingCalendar(paperTradeRepo, process.cwd()).then((res) => {
      logger.info(`Trading calendar synced: ${res.count} entries (source: ${res.source})`);
    }).catch((err) => {
      logger.error("Trading calendar sync failed", err instanceof Error ? err : new Error(String(err)));
    });

    // PR5: seed 定时任务（幂等）
    await seedPaperTradingTasks({
      manageScheduledTask: uc.manageScheduledTask,
      manageConversation: uc.manageConversation,
      convRepo: repos.conversation,
      otterRepo: repos.otter,
      settings: repos.settings,
      logger,
    });
  }

  // F20260901cxmw：otter 实际模型 contextWindow 解析（handoff 阈值按真实窗口计算）
  const ctxWindowProvider = modelPool ? buildCtxWindowProvider(modelPool, otterConfigProvider) : undefined;

  const agentInvoker = new AgentInvoker(
    agentGateway, uc.sendMessage,
    uc.queryMessage, uc.manageSession, uc.queryOtter, logger,
    messageBroadcaster, workspaceGateway, repos.settings, agentMetrics,
    repos.healingEvent,
    // F20260825hndf：优雅上下交接依赖注入
    repos.conversation,
    repos.scheduledTask,
    (conversationId) => repos.conversation.getLinkedResources(conversationId, { status: "active" }),
    uc.manageContext,
    buildHandoffPackage,
    // F20260831cbkw：熔断 session 年龄窗口阈值（从 config 读取，缺省 2h）
    appConfig?.circuitBreaker.healthySessionThresholdMs,
    // F20260901cxmw：otter 实际模型 contextWindow 解析（handoff 阈值按真实窗口计算）
    ctxWindowProvider,
  );

  // F20260827he2f：启动时探针——验证 healing_repo 可达，熔断事件落库能力正常
  // 失败仅 warn（不阻塞启动），但日志可作为诊断入口
  agentInvoker.probeHealingRepo().catch((err: unknown) => {
    logger.warn('healing_repo startup probe failed', { error: err instanceof Error ? err.message : String(err) });
  });

  const cronParser = new SimpleCronParser();
  const schedulerService = new SchedulerService({
    taskRepo: repos.scheduledTask,
    convRepo: repos.conversation,
    sendMessage: uc.sendMessage,
    agentInvokePort: agentInvoker,
    cronParser,
    logger,
    manageScheduledTask: uc.manageScheduledTask,
    manageSession: uc.manageSession,
    healingRepo: repos.healingEvent,
    metrics,
    dispatchChainEngine,
    functionRegistry: db ? paperTradingFunctionRegistry : undefined,
  });

  return { agentInvoker, cronParser, schedulerService };
}

/** issue #281：broadcaster 由 app.ts 无条件创建（平台无关总线），飞书出站作为 channel 注册 */
export function createFeishuBundle(options: {
  feishuConfig: FeishuConfig;
  uc: UseCases;
  dispatchChainEngine: DispatchChainEngine;
  logger: Logger;
  webBaseUrl: string | undefined;
  messageBroadcaster: MessageBroadcaster;
  /** F20260828fsyc：出站标签解析用户全局名（可选,不传时 FeishuMessageChannel 回退「用户」） */
  settingsRepo?: SettingsRepository;
}): FeishuBundle {
  const { feishuConfig, uc, dispatchChainEngine, logger, webBaseUrl, messageBroadcaster, settingsRepo } = options;
  const tokenManager = new FeishuAccessTokenManager(feishuConfig, logger);
  const client = new FeishuClient(feishuConfig, logger, tokenManager);
  messageBroadcaster.registerOutboundChannel(new FeishuMessageChannel(uc.manageConnection, client, uc.queryOtter, logger, webBaseUrl, settingsRepo));
  if (!webBaseUrl) {
    logger.info("web.baseUrl not configured, feishu html-card placeholders will show without clickable links");
  }
  return { client, tokenManager, dispatchChainEngine };
}

export function setupFeishu(options: {
  appConfig: AppConfig;
  uc: UseCases;
  repos: Repositories;
  agentInvoker: AgentInvoker;
  feishu: FeishuBundle;
  messageBroadcaster: MessageBroadcaster;
  logger: Logger;
  registry?: ChannelStatusRegistry;
  /** F20260901sgpv P1：信号路由器（飞书入口换轨） */
  signalRouter?: SignalRouter;
}): void {
  const { appConfig, uc, repos, agentInvoker, feishu, messageBroadcaster, logger, registry, signalRouter } = options;
  if (!appConfig.feishu) return;

  const commandDispatcher = new CommandDispatcher(uc.manageConnection, uc.queryMessage, feishu.client, logger);
  // F20260826fpbd：命令门禁（方案B）——setupFeishu 入口有 !appConfig.feishu 早退，此处必存在；partnerOpenId 仍可选
  const partnerResolver = new PartnerResolver(appConfig.feishu?.partnerOpenId);
  const agentDispatchService = new AgentDispatchService({
    dispatchChainEngine: feishu.dispatchChainEngine,
    queryMessage: uc.queryMessage,
    agentInvokePort: agentInvoker,
    logger,
    // F20260901sgpv P1：飞书入口换轨（隐式传石查询停用，四入口勘测硬约束 1）
    ...(signalRouter && { signalRouter }),
  });

  // 多模态 Phase 2：飞书 ingress 附件三件套——资源下载客户端 + 注入服务与 controllers.ts 同构
  // （storageRoot 缺省 ./data/attachments，与 AttachmentController 一致）
  const feishuResource = new FeishuResourceClient(feishu.tokenManager, logger);
  const attachmentInjection = new AttachmentInjectionService({
    attachmentRepo: repos.attachment,
    storageRoot: appConfig.attachments?.storageRoot ?? "./data/attachments",
    logger,
  });

  const messageProcessor = new FeishuMessageProcessor({
    manageConnection: uc.manageConnection,
    sendMessage: uc.sendMessage,
    commandDispatcher,
    feishuGateway: feishu.client,
    // F20260826fuid：飞书群聊多人识别——open_id → 姓名快照
    feishuUserInfo: new FeishuUserInfoClient(feishu.tokenManager, logger),
    // F20260826fpbd：命令门禁用（方案B）
    partnerResolver,
    // 多模态 Phase 2：飞书 ingress 收图/收文件（下载 + 上传管线 + 注入组装）
    feishuResource,
    attachmentUpload: uc.attachmentUpload,
    attachmentInjection,
    agentDispatchService,
    messageBroadcaster,
    logger,
  });

  const longConnectionClient = new FeishuLongConnectionClient(appConfig.feishu, logger, feishu.tokenManager, registry);
  const longConnectionHandler = new FeishuLongConnectionHandler({
    longConnectionGateway: longConnectionClient,
    messageProcessor,
    logger,
  });

  longConnectionHandler.start().then(() => {
    logger.info("Feishu long connection started");
  }).catch((err) => {
    logger.error("Failed to start Feishu long connection", err instanceof Error ? err : undefined);
  });
}

export interface PlatformBootstrapResult {
  processInboundRecruit?: ProcessInboundRecruit;
  inboundApiKey?: string;
  getBridgeStatus?: GetBridgeStatus;
  healingInit: Promise<void>;
  recruitingInit: Promise<void>;
  /** 微信通道轮询句柄（app 关停时统一 stop） */
  weixinPollers?: WeixinPollingChannel[];
  /** 通道状态注册表（F20260901chun：统一 IM 页 + 真实健康状态） */
  registry?: ChannelStatusRegistry;
}

/** 微信通道启动（issue #565）：每个已登录账号拉一条轮询 + 注册出站通道 */
export function startWeixinChannels(options: {
  appConfig: AppConfig;
  repos: Repositories;
  uc: UseCases;
  agentInvoker: AgentInvoker;
  dispatchChainEngine: DispatchChainEngine;
  messageBroadcaster: MessageBroadcaster;
  logger: Logger;
  registry?: ChannelStatusRegistry;
  signalRouter?: SignalRouter;
}): WeixinPollingChannel[] {
  const { appConfig, repos, uc, agentInvoker, dispatchChainEngine, messageBroadcaster, logger, registry, signalRouter } = options;
  const weixinConfig = appConfig.weixin;
  if (!weixinConfig) {
    // Bugfix（F20260831wxsp）：有已登录账号但 config 无 weixin 段时不再静默 return——
    // 否则重启后轮询无声消失（web 无任何异常，微信就是不响）。
    // 触发路径：扫码时 ensureWeixinConfig 写回失败（如路径错误 ENOENT）→ 重启读不到 weixin 段。
    // 账号 state（token/游标）在 stateDir（默认 ./data/weixin）不受影响，默认段即可拉起轮询；
    // partnerUserId 缺失仅影响命令门禁锚定（PartnerResolver 未配置时不拦截命令），不阻断消息。
    const accountStore = new WeixinAccountStore(undefined);
    const orphanAccounts = accountStore.listAccounts();
    if (orphanAccounts.length === 0) return [];
    logger.warn("Weixin: logged-in accounts exist but config.yaml has no weixin section — starting with defaults (partnerUserId unset, commands ungated). Add weixin section to config.yaml to gate commands", { accounts: orphanAccounts.map((a) => a.id) });
    const pollers = orphanAccounts
      .map((account) => startWeixinAccount({ appConfig, repos, uc, agentInvoker, dispatchChainEngine, messageBroadcaster, logger, accountStore, weixinConfig: {}, account, registry, signalRouter }))
      .filter((p): p is WeixinPollingChannel => p !== undefined);
    // F20260901chun 发现8：orphan 降级拉起后标记 degraded，UI 显示「🟡 降级运行中」而非假绿
    if (registry) {
      for (const account of orphanAccounts) {
        registry.update(`weixin-${account.id}`, { kind: "weixin", state: { kind: "running", since: Date.now(), degraded: true } });
      }
    }
    return pollers;
  }

  const accountStore = new WeixinAccountStore(weixinConfig);
  const accounts = accountStore.listAccounts();
  if (accounts.length === 0) {
    logger.info("Weixin channel enabled but no logged-in account — run `npm run weixin:login` or web UI to start QR login");
    return [];
  }

  const pollers: WeixinPollingChannel[] = [];
  for (const account of accounts) {
    const poller = startWeixinAccount({ appConfig, repos, uc, agentInvoker, dispatchChainEngine, messageBroadcaster, logger, accountStore, weixinConfig, account, registry, signalRouter });
    if (poller) pollers.push(poller);
  }
  return pollers;
}

/** 单账号启动参数（初始启动与热启动共用） */
interface StartWeixinAccountOptions {
  appConfig: AppConfig;
  repos: Repositories;
  uc: UseCases;
  agentInvoker: AgentInvoker;
  dispatchChainEngine: DispatchChainEngine;
  messageBroadcaster: MessageBroadcaster;
  logger: Logger;
  accountStore: WeixinAccountStore;
  weixinConfig: WeixinConfig;
  account: WeixinAccount;
  registry?: ChannelStatusRegistry;
  /** F20260901sgpv P1：信号路由器（微信入口换轨） */
  signalRouter?: SignalRouter;
}

/** 单账号启动（初始启动与 web 扫码登录热启动共用，issue #566） */
function startWeixinAccount(options: StartWeixinAccountOptions): WeixinPollingChannel | undefined {
  const { appConfig, repos, uc, agentInvoker, dispatchChainEngine, messageBroadcaster, logger, accountStore, weixinConfig, account, registry } = options;
  try {
      const api = new WeixinApiClient({ baseUrl: account.baseUrl || weixinConfig.baseUrl || "https://ilinkai.weixin.qq.com", token: account.token });
      // 媒体支持（issue #567）：CDN 客户端同构注入 gateway（出站上传）与媒体下载实现（入站）
      const cdn = new WeixinCdnClient({ api, logger });
      const mediaGateway = new WeixinMediaClient({ cdn, logger });
      const gateway = new WeixinGatewayAdapter({ api, accountStore, accountId: account.id, logger, cdn });
      // 出站：广播总线注册（与飞书同模式；attachmentRepo 供媒体出站查存储路径）
      messageBroadcaster.registerOutboundChannel(
        new WeixinMessageChannel(uc.manageConnection, gateway, uc.queryOtter, logger, appConfig.web?.baseUrl, repos.settings, repos.attachment),
      );
      // ingress：入站处理器 + 轮询循环（媒体三项与飞书同构：注入服务与 controllers.ts 同一块装配）
      const attachmentInjection = new AttachmentInjectionService({
        attachmentRepo: repos.attachment,
        storageRoot: appConfig.attachments?.storageRoot ?? "./data/attachments",
        logger,
      });
      const processor = new WeixinMessageProcessor({
        manageConnection: uc.manageConnection,
        sendMessage: uc.sendMessage,
        queryMessage: uc.queryMessage,
        weixinGateway: gateway,
        partnerResolver: new PartnerResolver(weixinConfig.partnerUserId),
        // F20260901sgpv P1：微信入口换轨（与飞书同构）
        agentDispatchService: new AgentDispatchService({
          dispatchChainEngine, queryMessage: uc.queryMessage, agentInvokePort: agentInvoker, logger,
          ...(options.signalRouter && { signalRouter: options.signalRouter }),
        }),        messageBroadcaster,
        logger,
        mediaGateway,
        attachmentUpload: uc.attachmentUpload,
        attachmentInjection,
      });
      const poller = new WeixinPollingChannel({
        api,
        accountStore,
        accountId: account.id,
        onMessage: (msg) => processor.process(msg),
        logger,
        registry,
        contextTokenWarn: buildContextTokenWarnConfig(appConfig.weixin),
      });
      poller.setIdentity(account.ilinkUserId);
      poller.start();
      logger.info("Weixin polling channel started", { accountId: account.id, ilinkUserId: account.ilinkUserId });
      return poller;
    } catch (err) {
      logger.error("Failed to start Weixin account poller", err instanceof Error ? err : undefined, { accountId: account.id });
      return undefined;
    }
}

/**
 * web 扫码登录成功后热启动单账号（issue #566）：不重启进程把轮询拉起。
 * 调用方组装 weixinConfig（config 无 weixin 段时用默认值 + 登录回传的 partnerUserId）。
 */
export function hotStartWeixinAccount(options: StartWeixinAccountOptions): WeixinPollingChannel | undefined {
  return startWeixinAccount(options);
}

export function ensureWeixinConfig(opts: { configPath?: string; stateDir?: string; ilinkUserId?: string; logger?: Logger }): void {
  const configPath = opts.configPath ?? path.resolve(process.cwd(), "config/config.yaml");
  try {
    const text = fsSync.readFileSync(configPath, "utf8");
    const raw = yaml.load(text) as Record<string, unknown> | null;
    if (raw?.weixin) return; // 幂等
    if (!raw) return; // 非法 YAML——loadConfig 已在启动时把关，这里不覆盖文件
    // Why: 文本追加而非 yaml.dump 全量重写——config/config.yaml 满篇人工注释（对齐 example），
    // dump 会把注释全部抹掉（F20260829wxui 引入的隐患，仅在写回路径修对后才会显现）。
    // weixin 是顶层段，追加到文件末尾即等价；缩进对齐顶层键。
    const section = yaml.dump({
      weixin: {
        ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
        ...(opts.ilinkUserId ? { partnerUserId: opts.ilinkUserId } : {}),
      },
    }, { lineWidth: -1, noRefs: true });
    // Why: write-to-temp + rename 原子写——对齐 updateDefaultModelInYaml 的既有模式，
    // 避免 truncate+write 中途崩溃损坏 config.yaml
    const tmpPath = configPath + ".tmp";
    fsSync.writeFileSync(tmpPath, text + "\n" + section, "utf8");
    fsSync.renameSync(tmpPath, configPath);
    opts.logger?.info("config.yaml weixin section ensured", { configPath });
  } catch (err) {
    opts.logger?.warn("ensureWeixinConfig failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function initPlatforms(options: { appConfig: AppConfig; repos: Repositories; uc: UseCases; agentInvoker: AgentInvoker; dispatchChainEngine: DispatchChainEngine; messageBroadcaster: MessageBroadcaster; logger: Logger; signalRouter?: SignalRouter }): Promise<PlatformBootstrapResult> {
  const { appConfig, repos, uc, agentInvoker, dispatchChainEngine, logger } = options;
  const healingInit = ensureHealingConversation({ manageConversation: uc.manageConversation, convRepo: repos.conversation, otterRepo: repos.otter, settings: repos.settings, sendMessage: uc.sendMessage, logger })
    .then(({ conversationId, bigOtterId }) => ensureHealingScheduler({ manageScheduledTask: uc.manageScheduledTask, scheduledTaskRepo: repos.scheduledTask, healingConversationId: conversationId, bigOtterId }))
    .then(() => undefined)
    .catch(err => logger.warn("Self-Healing init failed", { error: err instanceof Error ? err.message : String(err) }));

  let processInboundRecruit: ProcessInboundRecruit | undefined;
  let inboundApiKey: string | undefined;
  let getBridgeStatus: GetBridgeStatus | undefined;
  let recruitingInit: Promise<void> = Promise.resolve();
  if (appConfig.inbound?.recruiting?.apiKey) {
    inboundApiKey = appConfig.inbound.recruiting.apiKey;
    processInboundRecruit = new ProcessInboundRecruit(
      repos.settings,
      uc.queryMessage,
      uc.sendMessage,
      dispatchChainEngine,
      agentInvoker,
      logger,
    );
    getBridgeStatus = new GetBridgeStatus(repos.settings);
    recruitingInit = ensureRecruitingConversation({
      manageConversation: uc.manageConversation,
      convRepo: repos.conversation,
      otterRepo: repos.otter,
      createOtter: uc.createOtter,
      settings: repos.settings,
      sendMessage: uc.sendMessage,
      logger,
    })
      .then(({ conversationId, bigOtterId }) => ensureRecruitingScheduler({
        manageScheduledTask: uc.manageScheduledTask,
        scheduledTaskRepo: repos.scheduledTask,
        recruitingConversationId: conversationId,
        bigOtterId,
      }))
      .catch(err => logger.warn("Recruiting init failed", { error: err instanceof Error ? err.message : String(err) }));
  }

  // ── 通道状态注册表（F20260901chun：统一 IM 页 + 真实健康状态） ──
  const registry = new InMemoryChannelStatusRegistry();

  // ── 微信通道（issue #565）：每个已登录账号拉起轮询 + 出站注册 ──
  const weixinPollers = startWeixinChannels({ ...options, registry });

  return { processInboundRecruit, inboundApiKey, getBridgeStatus, healingInit, recruitingInit, weixinPollers, registry };
}
