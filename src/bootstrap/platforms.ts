import type { AppConfig } from "@frameworks/config";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { Logger } from "@usecases/ports/logger";
import type Database from "better-sqlite3";
import type { ModelPool } from "@frameworks/llm/model-pool";
import { initAgentSessionFactory } from "@frameworks/agent/pi-session-factory";
// F20260826mwrd C3（#534）：createManageHealingEventsTool 改为仅 tool-factory 内注册，此处不再 import
import type { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { Repositories, UseCases } from "./types";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
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
import { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { FeishuMessageChannel } from "@usecases/im/feishu-message-channel";
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
      // F20260826mwrd C3（#534）：manage_healing_events 只在 tool-factory 内注册，
      // 此处不再二次 push（双注册曾浪费上下文 token 且注册路径分歧）。
      // manifest 归 system block，big/small 均可见——行为不变，只去重。
      return createTools(ctx, repo, log, options.workspaceGateway, manageScheduledTaskRef ?? undefined);
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

export async function initAgentAndScheduler(options: { repos: Repositories; uc: UseCases; agentGateway: PiSessionFactory; messageBroadcaster: MessageBroadcaster | undefined; logger: Logger; workspaceGateway?: WorkspaceGateway; metrics?: SchedulerMetrics; agentMetrics?: AgentMetricsPort; dispatchChainEngine?: DispatchChainEngine }) {
  const { repos, uc, agentGateway, messageBroadcaster, logger, workspaceGateway, metrics, agentMetrics, dispatchChainEngine } = options;
  await agentGateway.warmup();

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
}): FeishuBundle {
  const { feishuConfig, uc, dispatchChainEngine, logger, webBaseUrl, messageBroadcaster } = options;
  const tokenManager = new FeishuAccessTokenManager(feishuConfig, logger);
  const client = new FeishuClient(feishuConfig, logger, tokenManager);
  messageBroadcaster.registerOutboundChannel(new FeishuMessageChannel(uc.manageConnection, client, uc.queryOtter, logger, webBaseUrl));
  if (!webBaseUrl) {
    logger.info("web.baseUrl not configured, feishu html-card placeholders will show without clickable links");
  }
  return { client, tokenManager, dispatchChainEngine };
}

export function setupFeishu(options: {
  appConfig: AppConfig;
  uc: UseCases;
  agentInvoker: AgentInvoker;
  feishu: FeishuBundle;
  messageBroadcaster: MessageBroadcaster;
  logger: Logger;
}): void {
  const { appConfig, uc, agentInvoker, feishu, messageBroadcaster, logger } = options;
  if (!appConfig.feishu) return;

  const commandDispatcher = new CommandDispatcher(uc.manageConnection, uc.queryMessage, feishu.client, logger);
  // F20260826fpbd：命令门禁（方案B）——setupFeishu 入口有 !appConfig.feishu 早退，此处必存在；partnerOpenId 仍可选
  const partnerResolver = new PartnerResolver(appConfig.feishu?.partnerOpenId);
  const agentDispatchService = new AgentDispatchService({
    dispatchChainEngine: feishu.dispatchChainEngine,
    queryMessage: uc.queryMessage,
    agentInvokePort: agentInvoker,
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
    agentDispatchService,
    messageBroadcaster,
    logger,
  });

  const longConnectionClient = new FeishuLongConnectionClient(appConfig.feishu, logger, feishu.tokenManager);
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
}

export async function initPlatforms(options: { appConfig: AppConfig; repos: Repositories; uc: UseCases; agentInvoker: AgentInvoker; dispatchChainEngine: DispatchChainEngine; logger: Logger }): Promise<PlatformBootstrapResult> {
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

  return { processInboundRecruit, inboundApiKey, getBridgeStatus, healingInit, recruitingInit };
}
