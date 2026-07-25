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
}

interface UseCases {
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
  return {
    manageConversation, manageMemory, manageTerminology, storeMemory, searchMemory,
    sendMessage, queryMessage, manageParticipant, manageKeyInfo,
    queryOtter, createOtter, manageSession, dissolveOtter, manageContext,
    manageScheduledTask,
  };
}

/** 构建 OtterToolClient 的 conversation.message 部分 */
function buildMessageClient(uc: UseCases) {
  return {
    startSpeaking: (messageId: string, params: { body: string; talkingStonePassedTo: string[] }) =>
      uc.sendMessage.startSpeaking(messageId, params),
    complete: (messageId: string, params?: { body?: string; talkingStonePassedTo?: string[] }) =>
      uc.sendMessage.complete(messageId, params),
    getById: (id: string) => uc.queryMessage.getMessageById(id),
    list: (convId: string, opts?: { limit?: number; before?: string }) =>
      uc.queryMessage.getMessages(convId, { limit: opts?.limit, before: opts?.before }),
    search: (convId: string, query: string, limit?: number) =>
      uc.queryMessage.searchMessages(convId, query, limit),
    getTurnHistory: (convId: string, opts?: { includeMessages?: boolean }) =>
      uc.queryMessage.getTurnHistory(convId, opts),
  };
}

/** 构建 OtterToolClient 的 memory 部分（渐进式披露：支持 detail_level、getById 和 getDetails） */
function buildMemoryClient(uc: UseCases) {
  return {
    getById: async (id: string) => {
      const entry = await uc.manageMemory.getById(id);
      if (!entry) return null;
      return { id: entry.id, content: entry.content, score: 1, layer: entry.layer };
    },
    search: async (query: string, limit?: number, detailLevel?: "summary" | "snippet" | "full", library?: string) => {
      const result = await uc.searchMemory.search({ query, limit: limit ?? 10, detailLevel, library });
      return result.entries.map(e => ({
        id: e.id,
        content: e.content,
        score: e.score,
        layer: e.layer,
        snippet: e.snippet,
        contentType: e.contentType,
        metadata: e.metadata ?? undefined,
        createdAt: e.createdAt,
      }));
    },
    /** 按 ID 批量获取完整记忆条目（渐进式披露 get_memory_detail） */
    getDetails: async (ids: string[]) => {
      const entries = await uc.manageMemory.getDetails(ids);
      return entries.map(e => ({
        id: e.id,
        content: e.content,
        layer: e.layer,
        contentType: e.contentType,
        metadata: e.metadata ?? undefined,
        createdAt: e.createdAt,
      }));
    },
  };
}

/**
 * 构建 OtterToolClient：包装所有 use case，作为工具访问 Otter 数据的统一门面。
 */
function buildResourceClient(uc: UseCases) {
  return {
    link: (params: { conversationId: string; url?: string; title?: string; content?: string; category?: string; linkedBy: string; resourceType?: string; groupId?: string }, turnNum?: number) =>
      uc.manageKeyInfo.linkResource({
        conversationId: params.conversationId,
        resourceType: params.resourceType ?? "url",
        url: params.url,
        title: params.title,
        content: params.content,
        category: params.category,
        linkedBy: params.linkedBy,
        autoLinked: false,
        groupId: params.groupId,
      }, turnNum),
    list: (convId: string, filters?: { status?: "active" | "superseded" | "archived"; resourceType?: string }) =>
      uc.manageKeyInfo.getLinkedResources(convId, filters),
    listByGroup: (convId: string, groupId: string) =>
      uc.manageKeyInfo.getLinkedResourcesByGroup(convId, groupId),
    updateStatus: (id: string, status: "active" | "superseded" | "archived", turnNum: number, supersededBy?: string) =>
      uc.manageKeyInfo.updateResourceStatus(id, status, turnNum, supersededBy),
    supersede: (existingId: string, newInput: { conversationId: string; resourceType?: string; url?: string; title?: string; content?: string; category?: string; linkedBy: string; groupId?: string }, turnNum: number) =>
      uc.manageKeyInfo.supersedeResource(existingId, {
        conversationId: newInput.conversationId,
        resourceType: newInput.resourceType ?? "url",
        url: newInput.url,
        title: newInput.title,
        content: newInput.content,
        category: newInput.category,
        linkedBy: newInput.linkedBy,
        autoLinked: false,
        groupId: newInput.groupId,
      }, turnNum),
    archive: (id: string, convId: string, turnNum: number) =>
      uc.manageKeyInfo.archiveResource(id, convId, turnNum),
  };
}

function buildOtterToolClient(uc: UseCases): OtterToolClient {
  return {
    conversation: {
      message: buildMessageClient(uc),
      participant: {
        join: async (convId, otterId) => {
          const otter = await uc.queryOtter.getById(otterId);
          const name = otter?.name ?? otterId;
          const { participant } = await uc.manageParticipant.join(
            convId, otterId, `${name} 加入了对话`,
          );
          return participant;
        },
        getActive: async (convId) => {
          const participantsWithOtter = await uc.manageParticipant.getActiveParticipants(convId);
          return participantsWithOtter.map(p => ({ ...p.participant, otterName: p.otterName }));
        },
      },
      getActiveTurnNumber: (convId) => uc.manageConversation.getActiveTurnNumber(convId),
    },
    memory: buildMemoryClient(uc),
    terminology: {
      search: async (query: string, limit?: number) => {
        const results = await uc.manageTerminology.search(query, limit ?? 10);
        return results.map(e => ({
          id: e.id, term: e.term, definition: e.definition,
          aliases: e.aliases, category: e.category, context: e.context,
        }));
      },
      addTerm: async (params: { term: string; definition: string; aliases?: string[]; category?: string; context?: string }) => {
        const entry = await uc.manageTerminology.addTerm(params);
        return { id: entry.id, term: entry.term };
      },
    },
    otter: {
      create: (params) => uc.createOtter.execute(params),
      dissolve: (id) => uc.dissolveOtter.execute(id),
      getById: (id) => uc.queryOtter.getById(id),
    },
    context: {
      get: (otterId, key) => uc.manageContext.get(otterId, key),
      set: (otterId, key, value) => uc.manageContext.set(otterId, key, value),
      delete: (otterId, key) => uc.manageContext.delete(otterId, key),
    },
    resource: buildResourceClient(uc),
  };
}

interface ControllerDeps {
  uc: UseCases;
  agentInvoker: AgentInvoker;
  settings: SettingsConfig;
  settingsRepo: SqliteSettingsRepository;
  schedulerService: SchedulerService;
  cronParser: SimpleCronParser;
}

function initControllers(deps: ControllerDeps) {
  return {
    conversation: new ConversationController(deps.uc.manageConversation, deps.uc.manageParticipant),
    otter: new OtterController(deps.uc.createOtter, deps.uc.dissolveOtter, deps.uc.manageSession, deps.uc.queryOtter),
    message: new MessageController(deps.uc.sendMessage, deps.uc.queryMessage, deps.agentInvoker, logger, deps.uc.queryOtter, appConfig.circuitBreaker.maxChainDepth),
    memory: new MemoryController(deps.uc.searchMemory, deps.uc.manageMemory),
    keyInfo: new KeyInfoController(deps.uc.manageKeyInfo),
    settings: new SettingsController(deps.settings, deps.settingsRepo),
    scheduledTask: new ScheduledTaskController(deps.uc.manageScheduledTask, deps.schedulerService, deps.cronParser),
  };
}

function startServer(
  controllers: ReturnType<typeof initControllers>,
  port: number,
): void {
  const app = new Hono();
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

async function initAgentAndScheduler(repos: Repositories, uc: UseCases, agentGateway: PiSessionFactory) {
  /** 预加载 pi-coding-agent SDK，避免首次创建对话时冷启动阻塞 HTTP 响应 */
  await agentGateway.warmup();

  const agentInvoker = new AgentInvoker(
    agentGateway, uc.sendMessage,
    uc.queryMessage, uc.manageSession, uc.queryOtter, logger,
  );

  const cronParser = new SimpleCronParser();
  const agentInvokePort = new AgentInvokePortAdapter(agentInvoker);
  const schedulerService = new SchedulerService({
    taskRepo: repos.scheduledTask,
    convRepo: repos.conversation,
    sendMessage: uc.sendMessage,
    agentInvokePort,
    cronParser,
    manageScheduledTask: uc.manageScheduledTask,
  });

  return { agentInvoker, cronParser, schedulerService };
}

async function main(): Promise<void> {
  syncApiKeyToAgentAuth(appConfig.llm);

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

  const repos = initRepositories(db);
  await syncDocuments(repos, embeddingService);

  /** 创建 PiSessionFactory（OtterToolClient 稍后注入，skills 由 SDK ResourceLoader 原生发现） */
  const agentGateway = await initAgentSessionFactory({
    model, db,
    otterToolClient: {} as OtterToolClient,
    identityPromptDir: "./prompts/identity",
    createTools,
    otterConfigProvider,
  }, logger);

  const uc = initUseCases(repos, agentGateway, embeddingService);

  /** 构建 OtterToolClient 并注入 agentGateway（解决循环依赖） */
  const otterToolClient = buildOtterToolClient(uc);
  agentGateway.setOtterToolClient(otterToolClient);

  const { agentInvoker, cronParser, schedulerService } = await initAgentAndScheduler(repos, uc, agentGateway);

  const settings: SettingsConfig = {
    provider: appConfig.llm.provider,
    model: appConfig.llm.model,
    port: appConfig.server.port,
    dbPath: appConfig.db.path,
    embeddingModelPath: appConfig.embedding.modelPath,
    embeddingDim: appConfig.embedding.dimensions,
  };

  const controllers = initControllers({
    uc, agentInvoker, settings, settingsRepo: repos.settings, schedulerService, cronParser,
  });
  startServer(controllers, appConfig.server.port);

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
