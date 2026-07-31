/**
 * Composition Root - 依赖注入装配点。
 * main.ts 是唯一允许跨层引用的文件（Composition Root 豁免）。
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig, initConfig } from "@frameworks/config";
import { PinoLogger } from "@frameworks/logger";
import { initDatabase, closeDatabase } from "@frameworks/db/database";
import { initSchema } from "@frameworks/db/schema";
import { initModels } from "@frameworks/llm/models-factory";
import { initEmbeddingService } from "@frameworks/embedding/embedding-service";
import { initAgentSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterContextRepository } from "@frameworks/db/otter/sqlite-otter-context-repository";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteSettingsRepository } from "@frameworks/db/settings/sqlite-settings-repository";

import { ManageConversation } from "@usecases/conversation/manage-conversation";
import { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import { ManageParticipant } from "@usecases/conversation/manage-participant";
import { QueryMessage } from "@usecases/conversation/query-message";
import { SendMessage } from "@usecases/conversation/send-message";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import { SearchEngine } from "@usecases/memory/search-engine";
import { SearchMemory } from "@usecases/memory/search-memory";
import { StoreMemory } from "@usecases/memory/store-memory";
import { ManageMemory } from "@usecases/memory/manage-memory";
import { ManageTerminology } from "@usecases/memory/manage-terminology";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { SqliteTerminologyRepository } from "@frameworks/db/memory/sqlite-terminology-repository";
import { seedTerminologyData } from "@frameworks/db/memory/seed-terminology";
import { SqliteFeatureRepository } from "@frameworks/db/document/sqlite-feature-repository";
import { SqliteResearchRepository } from "@frameworks/db/document/sqlite-research-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { migrateDatabase, migrateExistingData } from "@frameworks/db/migration";
import { reconcileOrphans } from "@usecases/conversation/reconcile-orphans";
import { SyncDocuments } from "@usecases/document/sync-documents";
import { NodeFileSystem } from "@frameworks/file-system/node-file-system";
import { CreateOtter } from "@usecases/otter/create-otter";
import { DissolveOtter } from "@usecases/otter/dissolve-otter";
import { ManageSession } from "@usecases/otter/manage-session";
import { QueryOtter } from "@usecases/otter/query-otter";
import { ManageContext } from "@usecases/otter/manage-context";

import { createRouter } from "@interface-adapters/http/router";
import { ConversationController } from "@interface-adapters/http/controllers/conversation-controller";
import { OtterController } from "@interface-adapters/http/controllers/otter-controller";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { MemoryController } from "@interface-adapters/http/controllers/memory-controller";
import { KeyInfoController } from "@interface-adapters/http/controllers/key-info-controller";
import { SettingsController } from "@interface-adapters/http/controllers/settings-controller";
import type { SettingsConfig } from "@interface-adapters/http/controllers/settings-controller";
import { ScheduledTaskController } from "@interface-adapters/http/controllers/scheduled-task-controller";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { OtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client";
import { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import { SchedulerService } from "@usecases/scheduler/scheduler-service";
import { AgentInvokePortAdapter } from "@usecases/scheduler/agent-invoke-port";
import { SimpleCronParser } from "@frameworks/scheduler/cron-parser";
import { SqliteScheduledTaskRepository } from "@frameworks/db/scheduled-task/sqlite-scheduled-task-repository";
import { SqliteConnectionRepository } from "@frameworks/db/im/sqlite-connection-repository";
import { ManageConnection } from "@usecases/im/manage-connection";
import { ConnectionController } from "@interface-adapters/http/controllers/connection-controller";
import { FeishuClient } from "@frameworks/feishu/client";
import { FeishuAccessTokenManager } from "@frameworks/feishu/access-token-manager";
import { FeishuLongConnectionClient } from "@frameworks/feishu/long-connection-client";
import { FeishuLongConnectionHandler } from "@interface-adapters/feishu/long-connection-handler";
import { FeishuWebhookHandler } from "@interface-adapters/feishu/webhook-handler";
import { FeishuMessageProcessor } from "@interface-adapters/feishu/message-processor";
import { CommandDispatcher } from "@interface-adapters/feishu/command-dispatcher";
import { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { buildOtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client-builder";

/** 创建 PinoLogger 实例（stdout + 文件持久化） */
import { mkdirSync } from 'fs';
const logDir = './data/logs';
mkdirSync(logDir, { recursive: true });
const logFile = `${logDir}/otter-buddy.log`;
const logger = new PinoLogger({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      { target: 'pino/file', level: process.env.LOG_LEVEL || 'info', options: { destination: 1 } },
      { target: 'pino/file', level: process.env.LOG_LEVEL || 'info', options: { destination: logFile, mkdir: true } },
    ],
  },
});

/** 加载配置 */
const appConfig = loadConfig(logger);
initConfig(appConfig);

/**
 * MemoryIndexGateway 适配器：将 StoreMemory 适配为 MemoryIndexGateway。
 * StoreMemory.execute() 接受 MemoryEntryInput，此适配器将 index* 方法映射为 execute 调用。
 */
class MemoryIndexAdapter implements MemoryIndexGateway {
  constructor(private readonly storeMemory: StoreMemory) {}

  async indexMessage(messageId: string, conversationId: string, content: string): Promise<void> {
    await this.storeMemory.execute({
      layer: "working", contentType: "message",
      sourceId: messageId, sourceTable: "messages",
      conversationId, granularity: "fine", content,
    });
  }

  async indexLinkedResource(resourceId: string, conversationId: string, content: string, resourceType?: string): Promise<void> {
    await this.storeMemory.execute({
      layer: "working",
      contentType: resourceType === "fact" ? "fact" : "linked_resource",
      sourceId: resourceId, sourceTable: "linked_resources",
      conversationId, granularity: "coarse", content,
    });
  }

  async indexFeature(id: string, summary: string, metadata: Record<string, unknown>): Promise<void> {
    await this.storeMemory.execute({
      layer: "document",
      contentType: "feature",
      sourceId: id,
      sourceTable: "features",
      conversationId: undefined,
      granularity: "coarse",
      content: summary,
      metadata,
    });
  }

  async indexResearch(id: string, summary: string, metadata: Record<string, unknown>): Promise<void> {
    await this.storeMemory.execute({
      layer: "document",
      contentType: "research",
      sourceId: id,
      sourceTable: "research",
      conversationId: undefined,
      granularity: "coarse",
      content: summary,
      metadata,
    });
  }
}

interface Repositories {
  otter: SqliteOtterRepository;
  otterContext: SqliteOtterContextRepository;
  memory: SqliteMemoryRepository;
  terminology: SqliteTerminologyRepository;
  conversation: SqliteConversationRepository;
  settings: SqliteSettingsRepository;
  feature: SqliteFeatureRepository;
  research: SqliteResearchRepository;
  scheduledTask: SqliteScheduledTaskRepository;
  connection: SqliteConnectionRepository;
}

export interface UseCases {
  manageConversation: ManageConversation;
  manageMemory: ManageMemory;
  manageTerminology: ManageTerminology;
  storeMemory: StoreMemory;
  searchMemory: SearchMemory;
  sendMessage: SendMessage;
  queryMessage: QueryMessage;
  manageParticipant: ManageParticipant;
  manageKeyInfo: ManageKeyInfo;
  queryOtter: QueryOtter;
  createOtter: CreateOtter;
  manageSession: ManageSession;
  dissolveOtter: DissolveOtter;
  manageContext: ManageContext;
  manageScheduledTask: ManageScheduledTask;
  manageConnection: ManageConnection;
}

function initRepositories(db: ReturnType<typeof initDatabase>): Repositories {
  return {
    otter: new SqliteOtterRepository(db),
    otterContext: new SqliteOtterContextRepository(db),
    memory: new SqliteMemoryRepository(db),
    terminology: new SqliteTerminologyRepository(db),
    conversation: new SqliteConversationRepository(db),
    settings: new SqliteSettingsRepository(db),
    feature: new SqliteFeatureRepository(db),
    research: new SqliteResearchRepository(db),
    scheduledTask: new SqliteScheduledTaskRepository(db),
    connection: new SqliteConnectionRepository(db),
  };
}

function initUseCases(
  repos: Repositories,
  agentGateway: PiSessionFactory,
  embeddingService: EmbeddingGateway,
): UseCases {
  const searchEngine = new SearchEngine(appConfig.memory);
  const manageMemory = new ManageMemory(repos.memory);
  const manageTerminology = new ManageTerminology(repos.terminology);
  const storeMemory = new StoreMemory(repos.memory, embeddingService, logger);
  const searchMemory = new SearchMemory(repos.memory, embeddingService, searchEngine, logger, repos.terminology);
  const memoryIndex = new MemoryIndexAdapter(storeMemory);
  const sendMessage = new SendMessage(repos.conversation, repos.otter, memoryIndex, logger);
  const queryMessage = new QueryMessage(repos.conversation);
  const manageParticipant = new ManageParticipant(repos.conversation, repos.otter);
  const manageKeyInfo = new ManageKeyInfo(repos.conversation, memoryIndex);
  const queryOtter = new QueryOtter(repos.otter);
  /** createOtter 必须先于 manageConversation 初始化：
   *  ManageConversation.create() 需要调用 createOtter.execute() 为每个对话创建独立大獭 */
  const createOtter = new CreateOtter(repos.otter, agentGateway);
  const manageConversation = new ManageConversation(repos.conversation, createOtter);
  const manageSession = new ManageSession(
    repos.otter, agentGateway, manageConversation, manageMemory, logger,
  );
  const dissolveOtter = new DissolveOtter(repos.otter, agentGateway, manageSession);
  const manageContext = new ManageContext(repos.otterContext);
  const manageScheduledTask = new ManageScheduledTask(repos.scheduledTask);
  const manageConnection = new ManageConnection(repos.connection, repos.conversation, logger);
  return {
    manageConversation, manageMemory, manageTerminology, storeMemory, searchMemory,
    sendMessage, queryMessage, manageParticipant, manageKeyInfo,
    queryOtter, createOtter, manageSession, dissolveOtter, manageContext,
    manageScheduledTask, manageConnection,
  };
}


interface ControllerDeps {
  uc: UseCases;
  agentInvoker: AgentInvoker;
  settings: SettingsConfig;
  settingsRepo: SqliteSettingsRepository;
  schedulerService: SchedulerService;
  cronParser: SimpleCronParser;
  dispatchChainEngine: DispatchChainEngine;
  messageBroadcaster?: MessageBroadcaster;
}

function initControllers(deps: ControllerDeps) {
  return {
    conversation: new ConversationController(deps.uc.manageConversation, deps.uc.manageParticipant),
    otter: new OtterController(deps.uc.createOtter, deps.uc.dissolveOtter, deps.uc.manageSession, deps.uc.queryOtter),
    message: new MessageController(deps.uc.sendMessage, deps.uc.queryMessage, deps.agentInvoker, logger, deps.uc.queryOtter, deps.dispatchChainEngine, deps.messageBroadcaster),
    memory: new MemoryController(deps.uc.searchMemory, deps.uc.manageMemory),
    keyInfo: new KeyInfoController(deps.uc.manageKeyInfo),
    settings: new SettingsController(deps.settings, deps.settingsRepo),
    scheduledTask: new ScheduledTaskController(deps.uc.manageScheduledTask, deps.schedulerService, deps.cronParser),
    connection: new ConnectionController(deps.uc.manageConnection),
  };
}

function setupFeishu(app: Hono, uc: UseCases, agentInvoker: AgentInvoker, messageBroadcaster?: MessageBroadcaster): void {
  logger.info("setupFeishu called", { hasConfig: !!appConfig.feishu });
  if (!appConfig.feishu) return;

  const tokenManager = new FeishuAccessTokenManager(appConfig.feishu, logger);
  const feishuClient = new FeishuClient(appConfig.feishu, logger, tokenManager);
  const commandDispatcher = new CommandDispatcher(uc.manageConnection, uc.queryMessage, feishuClient, logger);
  const dispatchChainEngine = new DispatchChainEngine({
    sendMessage: uc.sendMessage,
    queryMessage: uc.queryMessage,
    queryOtter: uc.queryOtter,
    logger,
    maxChainDepth: appConfig.circuitBreaker.maxChainDepth,
  });
  const agentDispatchService = new AgentDispatchService({
    dispatchChainEngine,
    queryMessage: uc.queryMessage,
    agentInvokePort: agentInvoker,
    logger,
  });

  // 创建消息处理器
  const messageProcessor = new FeishuMessageProcessor({
    manageConnection: uc.manageConnection,
    sendMessage: uc.sendMessage,
    commandDispatcher,
    feishuGateway: feishuClient,
    agentDispatchService,
    messageBroadcaster: messageBroadcaster!,
    logger,
  });

  // 使用长连接方式（不需要公网 HTTP 回调）
  const longConnectionClient = new FeishuLongConnectionClient(appConfig.feishu, logger, tokenManager);
  const longConnectionHandler = new FeishuLongConnectionHandler({
    longConnectionGateway: longConnectionClient,
    messageProcessor,
    logger,
  });

  // 启动长连接
  longConnectionHandler.start().then(() => {
    logger.info("Feishu long connection started");
  }).catch((err) => {
    logger.error("Failed to start Feishu long connection", err instanceof Error ? err : undefined);
  });

  // 保留 webhook 路由作为备用（如果配置了 verificationToken）
  if (appConfig.feishu.verificationToken) {
    const feishuWebhookHandler = new FeishuWebhookHandler({
      messageProcessor,
      feishuGateway: feishuClient,
      config: { verificationToken: appConfig.feishu.verificationToken },
      logger,
    });
    app.post("/feishu/webhook", (ctx) => feishuWebhookHandler.handle(ctx));
    logger.info("Feishu webhook route registered (backup)");
  }
}

function startServer(
  controllers: ReturnType<typeof initControllers>,
  uc: UseCases,
  agentInvoker: AgentInvoker,
  port: number,
  messageBroadcaster?: MessageBroadcaster,
): void {
  const app = new Hono();
  setupFeishu(app, uc, agentInvoker, messageBroadcaster);
  app.route("/", createRouter(controllers, logger));
  app.use("/*", serveStatic({ root: "./web/dist" }));
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`Otter Buddy server running at http://localhost:${info.port}`);
  });
}

/** 将 config.yaml 的 apiKey 同步到 pi-coding-agent 的 auth.json（SDK 不读 config.yaml） */
function syncApiKeyToAgentAuth(llmConfig: { provider: string; apiKey?: string }): void {
  if (!llmConfig.apiKey) return;
  const homeDir = os.homedir();
  const agentDir = path.join(homeDir, ".pi", "agent");
  const authPath = path.join(agentDir, "auth.json");
  let auth: Record<string, string> = {};
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  } catch {
    /* 文件不存在或格式错误，使用空对象 */
  }
  if (auth[llmConfig.provider] !== llmConfig.apiKey) {
    auth[llmConfig.provider] = llmConfig.apiKey;
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
    logger.info(`Synced ${llmConfig.provider} API key to ${authPath}`);
  }
}

async function syncDocuments(repos: Repositories, embeddingService: EmbeddingGateway): Promise<void> {
  const fileSystem = new NodeFileSystem();
  const syncDocs = new SyncDocuments(
    fileSystem,
    repos.feature,
    repos.research,
    new MemoryIndexAdapter(new StoreMemory(repos.memory, embeddingService, logger)),
    logger
  );
  await syncDocs.execute(process.cwd());
}

async function initAgentAndScheduler(repos: Repositories, uc: UseCases, agentGateway: PiSessionFactory, messageBroadcaster?: MessageBroadcaster) {
  /** 预加载 pi-coding-agent SDK，避免首次创建对话时冷启动阻塞 HTTP 响应 */
  await agentGateway.warmup();

  const agentInvoker = new AgentInvoker(
    agentGateway, uc.sendMessage,
    uc.queryMessage, uc.manageSession, uc.queryOtter, logger,
    messageBroadcaster,
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
  });

  return { agentInvoker, cronParser, schedulerService };
}

async function initDatabaseAndModels() {
  const db = initDatabase(appConfig.db, logger);
  initSchema(db, logger);
  await seedTerminologyData(db, logger);

  // 执行数据库迁移
  migrateDatabase(db, logger);

  // 创建 OtterConfigProvider 并迁移现有数据
  const otterConfigProvider = new SqliteOtterConfigProvider(db);
  migrateExistingData(db, otterConfigProvider, logger);

  const { model } = await initModels(appConfig.llm, logger);
  const { service: embeddingService, dispose } = await initEmbeddingService(appConfig.embedding, logger);

  return { db, otterConfigProvider, model, embeddingService, dispose };
}

async function main(): Promise<void> {
  syncApiKeyToAgentAuth(appConfig.llm);

  const { db, otterConfigProvider, model, embeddingService, dispose } = await initDatabaseAndModels();

  const repos = initRepositories(db);
  /** 服务重启兜底：遗留进行中消息置 failed、孤儿 turn 关闭（重启后不存在活跃 agent） */
  await reconcileOrphans(repos.conversation, logger);
  await syncDocuments(repos, embeddingService);

  /** 创建 PiSessionFactory（OtterToolClient 稍后注入，skills 由 SDK ResourceLoader 原生发现） */
  const agentGateway = await initAgentSessionFactory({
    model, db,
    otterToolClient: {} as OtterToolClient,
    identityPromptDir: "./prompts/identity",
    createTools,
    otterConfigProvider,
    otterRepo: repos.otter,
  }, logger);

  const uc = initUseCases(repos, agentGateway, embeddingService);

  /** 构建 OtterToolClient 并注入 agentGateway（解决循环依赖） */
  const otterToolClient = buildOtterToolClient(uc);
  agentGateway.setOtterToolClient(otterToolClient);

  // 创建消息广播服务（Web + 飞书同步）
  let messageBroadcaster: MessageBroadcaster | undefined;
  if (appConfig.feishu) {
    const tokenManager = new FeishuAccessTokenManager(appConfig.feishu, logger);
    const feishuClient = new FeishuClient(appConfig.feishu, logger, tokenManager);
    messageBroadcaster = new MessageBroadcaster(uc.manageConnection, feishuClient, logger);
  }

  const { agentInvoker, cronParser, schedulerService } = await initAgentAndScheduler(repos, uc, agentGateway, messageBroadcaster);

  // 创建发言链调度引擎
  const dispatchChainEngine = new DispatchChainEngine({
    sendMessage: uc.sendMessage,
    queryMessage: uc.queryMessage,
    queryOtter: uc.queryOtter,
    logger,
    maxChainDepth: appConfig.circuitBreaker.maxChainDepth,
  });

  const settings: SettingsConfig = {
    provider: appConfig.llm.provider,
    model: appConfig.llm.model,
    port: appConfig.server.port,
    dbPath: appConfig.db.path,
    embeddingModelPath: appConfig.embedding.modelPath,
    embeddingDim: appConfig.embedding.dimensions,
  };

  const controllers = initControllers({ uc, agentInvoker, settings, settingsRepo: repos.settings, schedulerService, cronParser, dispatchChainEngine, messageBroadcaster });
  startServer(controllers, uc, agentInvoker, appConfig.server.port, messageBroadcaster);

  schedulerService.start().catch((err) => {
    logger.error(`Failed to start scheduler: ${err}`);
  });

  process.on("SIGINT", () => {
    schedulerService.stop();
    logger.flush();
    dispose();
    closeDatabase(db, logger);
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});
