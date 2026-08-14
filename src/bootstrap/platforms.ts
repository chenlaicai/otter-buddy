import type { AppConfig } from "@frameworks/config";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { Logger } from "@usecases/ports/logger";
import type Database from "better-sqlite3";
import type { ModelPool } from "@frameworks/llm/model-pool";
import { initAgentSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { Repositories, UseCases } from "./types";
import type { OtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client";
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { createManageHealingEventsTool } from "@interface-adapters/agent-runtime/tools/healing-tools";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import { AgentInvokePortAdapter } from "@usecases/ports/agent-invoke-port";
import { SimpleCronParser } from "@frameworks/scheduler/cron-parser";
import { SchedulerService } from "@usecases/scheduler/scheduler-service";
import type { SchedulerMetrics } from "@frameworks/metrics/scheduler-metrics";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { FeishuConfig } from "@frameworks/feishu/types";
import { FeishuAccessTokenManager } from "@frameworks/feishu/access-token-manager";
import { FeishuClient } from "@frameworks/feishu/client";
import { FeishuLongConnectionClient } from "@frameworks/feishu/long-connection-client";
import { FeishuLongConnectionHandler } from "@interface-adapters/feishu/long-connection-handler";
import { FeishuMessageProcessor } from "@interface-adapters/feishu/message-processor";
import { CommandDispatcher } from "@interface-adapters/feishu/command-dispatcher";
import { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { ensureHealingConversation } from "@usecases/healing/ensure-healing-conversation";
import { ensureHealingScheduler } from "@usecases/healing/ensure-healing-scheduler";
import { ProcessInboundRecruit } from "@usecases/recruiting/process-inbound-recruit";
import { GetBridgeStatus } from "@usecases/recruiting/get-bridge-status";
import { ensureRecruitingConversation } from "@usecases/recruiting/ensure-recruiting-conversation";
import { ensureRecruitingScheduler } from "@usecases/recruiting/ensure-recruiting-scheduler";

export interface FeishuBundle {
  broadcaster: MessageBroadcaster;
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
      const tools = createTools(ctx, repo, log, options.workspaceGateway, manageScheduledTaskRef ?? undefined);
      if (repo) tools.push(createManageHealingEventsTool(ctx, repo));
      return tools;
    },
    healingRepo: repos.healingEvent,
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
  });
}

export async function initAgentAndScheduler(options: { repos: Repositories; uc: UseCases; agentGateway: PiSessionFactory; messageBroadcaster: MessageBroadcaster | undefined; logger: Logger; workspaceGateway?: WorkspaceGateway; metrics?: SchedulerMetrics; agentMetrics?: AgentMetricsPort }) {
  const { repos, uc, agentGateway, messageBroadcaster, logger, workspaceGateway, metrics, agentMetrics } = options;
  await agentGateway.warmup();

  const agentInvoker = new AgentInvoker(
    agentGateway, uc.sendMessage,
    uc.queryMessage, uc.manageSession, uc.queryOtter, logger,
    messageBroadcaster, workspaceGateway, repos.settings, agentMetrics,
  );

  const cronParser = new SimpleCronParser();
  const agentInvokePort = new AgentInvokePortAdapter(agentInvoker);
  const schedulerService = new SchedulerService({
    taskRepo: repos.scheduledTask,
    convRepo: repos.conversation,
    sendMessage: uc.sendMessage,
    agentInvokePort,
    cronParser,
    logger,
    manageScheduledTask: uc.manageScheduledTask,
    manageSession: uc.manageSession,
    healingRepo: repos.healingEvent,
    metrics,
  });

  return { agentInvoker, cronParser, schedulerService };
}

export function createFeishuBundle(feishuConfig: FeishuConfig, uc: UseCases, dispatchChainEngine: DispatchChainEngine, logger: Logger, webBaseUrl?: string): FeishuBundle {
  const tokenManager = new FeishuAccessTokenManager(feishuConfig, logger);
  const client = new FeishuClient(feishuConfig, logger, tokenManager);
  const broadcaster = new MessageBroadcaster(uc.manageConnection, client, uc.queryOtter, logger, webBaseUrl);
  if (!webBaseUrl) {
    logger.info("web.baseUrl not configured, feishu html-card placeholders will show without clickable links");
  }
  return { broadcaster, client, tokenManager, dispatchChainEngine };
}

export function setupFeishu(appConfig: AppConfig, uc: UseCases, agentInvoker: AgentInvoker, feishu: FeishuBundle, logger: Logger): void {
  if (!appConfig.feishu) return;

  const commandDispatcher = new CommandDispatcher(uc.manageConnection, uc.queryMessage, feishu.client, logger);
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
    agentDispatchService,
    messageBroadcaster: feishu.broadcaster,
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
