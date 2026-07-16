/**
 * Composition Root - 依赖注入装配点。
 * main.ts 是唯一允许跨层引用的文件（Composition Root 豁免）。
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { config } from "@frameworks/config";
import { logger } from "@frameworks/logger";
import { initDatabase, closeDatabase } from "@frameworks/db/database";
import { initSchema } from "@frameworks/db/schema";
import { initModels } from "@frameworks/llm/models-factory";
import { initEmbeddingService } from "@frameworks/embedding/embedding-service";
import { initAgentCore } from "@frameworks/agent/pi-harness-factory";
import type { PiHarnessFactory } from "@frameworks/agent/pi-harness-factory";
import { ToolRegistry } from "@frameworks/agent/tool-registry";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
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
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { CreateOtter } from "@usecases/otter/create-otter";
import { DissolveOtter } from "@usecases/otter/dissolve-otter";
import { ManageSession } from "@usecases/otter/manage-session";
import { QueryOtter } from "@usecases/otter/query-otter";

import { createRouter } from "@interface-adapters/http/router";
import { ConversationController } from "@interface-adapters/http/controllers/conversation-controller";
import { OtterController } from "@interface-adapters/http/controllers/otter-controller";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { MemoryController } from "@interface-adapters/http/controllers/memory-controller";
import { KeyInfoController } from "@interface-adapters/http/controllers/key-info-controller";
import { SettingsController } from "@interface-adapters/http/controllers/settings-controller";
import type { SettingsConfig } from "@interface-adapters/http/controllers/settings-controller";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";

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

  async indexKeyFact(keyFactId: string, conversationId: string, content: string): Promise<void> {
    await this.storeMemory.execute({
      layer: "key_info", contentType: "key_fact",
      sourceId: keyFactId, sourceTable: "key_facts",
      conversationId, granularity: "coarse", content,
    });
  }

  async indexLinkedResource(resourceId: string, conversationId: string, url: string): Promise<void> {
    await this.storeMemory.execute({
      layer: "working", contentType: "linked_resource",
      sourceId: resourceId, sourceTable: "linked_resources",
      conversationId, granularity: "coarse", content: url,
    });
  }
}

interface Repositories {
  otter: SqliteOtterRepository;
  memory: SqliteMemoryRepository;
  conversation: SqliteConversationRepository;
  settings: SqliteSettingsRepository;
}

interface UseCases {
  manageConversation: ManageConversation;
  manageMemory: ManageMemory;
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
}

function initRepositories(db: ReturnType<typeof initDatabase>): Repositories {
  return {
    otter: new SqliteOtterRepository(db),
    memory: new SqliteMemoryRepository(db),
    conversation: new SqliteConversationRepository(db),
    settings: new SqliteSettingsRepository(db),
  };
}

function initUseCases(
  repos: Repositories,
  agentGateway: PiHarnessFactory,
  embeddingService: EmbeddingGateway,
): UseCases {
  const searchEngine = new SearchEngine(config.memory);
  const manageConversation = new ManageConversation(repos.conversation);
  const manageMemory = new ManageMemory(repos.memory);
  const storeMemory = new StoreMemory(repos.memory, embeddingService);
  const searchMemory = new SearchMemory(repos.memory, embeddingService, searchEngine);
  const memoryIndex = new MemoryIndexAdapter(storeMemory);
  const sendMessage = new SendMessage(repos.conversation, memoryIndex);
  const queryMessage = new QueryMessage(repos.conversation);
  const manageParticipant = new ManageParticipant(repos.conversation);
  const manageKeyInfo = new ManageKeyInfo(repos.conversation, memoryIndex);
  const queryOtter = new QueryOtter(repos.otter);
  const createOtter = new CreateOtter(repos.otter, agentGateway);
  const manageSession = new ManageSession(
    repos.otter, agentGateway, manageConversation, manageMemory,
  );
  const dissolveOtter = new DissolveOtter(repos.otter, agentGateway, manageSession);
  return {
    manageConversation, manageMemory, storeMemory, searchMemory,
    sendMessage, queryMessage, manageParticipant, manageKeyInfo,
    queryOtter, createOtter, manageSession, dissolveOtter,
  };
}

function initControllers(
  uc: UseCases,
  agentInvoker: AgentInvoker,
  settings: SettingsConfig,
  settingsRepo: SqliteSettingsRepository,
) {
  return {
    conversation: new ConversationController(uc.manageConversation, uc.manageParticipant),
    otter: new OtterController(uc.createOtter, uc.dissolveOtter, uc.manageSession, uc.queryOtter),
    message: new MessageController(uc.sendMessage, uc.queryMessage, agentInvoker),
    memory: new MemoryController(uc.searchMemory, uc.manageMemory),
    keyInfo: new KeyInfoController(uc.manageKeyInfo),
    settings: new SettingsController(settings, settingsRepo),
  };
}

function startServer(
  controllers: ReturnType<typeof initControllers>,
  port: number,
): void {
  const app = new Hono();
  app.route("/", createRouter(controllers));
  app.use("/*", serveStatic({ root: "./web/dist" }));
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`Otter Buddy server running at http://localhost:${info.port}`);
  });
}

async function main(): Promise<void> {
  const db = initDatabase(config.db);
  initSchema(db);

  const { models, model } = await initModels(config.llm);
  const { service: embeddingService, dispose } = await initEmbeddingService(config.embedding);

  const toolRegistry = new ToolRegistry();
  const piHarnessFactory = await initAgentCore({ models, model, db, toolRegistry });

  const repos = initRepositories(db);
  const uc = initUseCases(repos, piHarnessFactory, embeddingService);

  for (const tool of createTools({
    sendMessage: uc.sendMessage,
    searchMemory: uc.searchMemory,
    storeMemory: uc.storeMemory,
    manageMemory: uc.manageMemory,
    createOtter: uc.createOtter,
    dissolveOtter: uc.dissolveOtter,
    manageKeyInfo: uc.manageKeyInfo,
    manageParticipant: uc.manageParticipant,
  })) {
    toolRegistry.register(tool);
  }

  const agentInvoker = new AgentInvoker(
    piHarnessFactory, uc.sendMessage, uc.searchMemory, uc.manageSession, uc.queryOtter,
  );

  const settings: SettingsConfig = {
    provider: config.llm.provider,
    model: config.llm.model,
    port: config.server.port,
    dbPath: config.db.path,
    embeddingModelPath: config.embedding.modelPath,
    embeddingDim: config.embedding.dimensions,
  };

  const controllers = initControllers(uc, agentInvoker, settings, repos.settings);
  startServer(controllers, config.server.port);

  process.on("SIGINT", () => {
    dispose();
    closeDatabase(db);
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});
