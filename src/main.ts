/**
 * Composition Root - 依赖注入装配点。
 * main.ts 是唯一允许跨层引用的文件（Composition Root 豁免）。
 */
import { PinoLogger } from "@frameworks/logger";
import { loadConfig, initConfig } from "@frameworks/config";
import { closeDatabase } from "@frameworks/db/database";
import { initAgentSessionFactory } from "@frameworks/agent/pi-session-factory";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { OtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client";
import { createManageHealingEventsTool } from "@interface-adapters/agent-runtime/tools/healing-tools";
import { migrateFeatureBodyToChunks } from "@frameworks/db/migration";
import { backfillSessionLedger } from "@frameworks/db/otter/backfill-session-ledger";
import { reconcileOrphans } from "@usecases/conversation/reconcile-orphans";
import type { SettingsConfig } from "@interface-adapters/http/controllers/settings-controller";
import { NodeFileSystem } from "@frameworks/file-system/node-file-system";
import { seedTerminologyData } from "@frameworks/db/memory/seed-terminology";

import { syncApiKeyToAgentAuth, initDatabaseAndModels, initRepositoriesWithDb, validateModelAliases } from "./bootstrap/database";
import { createMemoryIndex, syncDocuments } from "./bootstrap/memory";
import { initUseCases } from "./bootstrap/usecases";
import { buildOtterToolClient } from "./bootstrap/clients";
import { createDispatchChainEngine, initAgentAndScheduler, createFeishuBundle, initPlatforms } from "./bootstrap/platforms";
import { initControllers } from "./bootstrap/controllers";
import type { FeishuBundle } from "./bootstrap/platforms";
import { startServer } from "./bootstrap/server";

/** 创建 PinoLogger 实例（stdout + 文件持久化） */
import { mkdirSync } from "node:fs";
const logDir = "./data/logs";
mkdirSync(logDir, { recursive: true });
const logFile = `${logDir}/otter-buddy.log`;
const logger = new PinoLogger({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    targets: [
      { target: "pino/file", level: process.env.LOG_LEVEL || "info", options: { destination: 1 } },
      { target: "pino/file", level: process.env.LOG_LEVEL || "info", options: { destination: logFile, mkdir: true } },
    ],
  },
});

const appConfig = loadConfig(logger);
initConfig(appConfig);

async function main(): Promise<void> {
  syncApiKeyToAgentAuth(appConfig.llm, logger);

  const { db, otterConfigProvider, model, modelPool, embeddingService, dispose } = await initDatabaseAndModels(appConfig, logger);
  const repos = initRepositoriesWithDb(db);
  await seedTerminologyData(db, logger);
  await reconcileOrphans(repos.conversation, logger);
  await backfillSessionLedger(db, repos.otter, logger);

  const memoryIndex = createMemoryIndex(repos, embeddingService, logger);
  const syncResult = await syncDocuments(repos, memoryIndex, logger, process.cwd());
  migrateFeatureBodyToChunks(db, logger, syncResult.errors.length);

  if (modelPool) validateModelAliases(db, modelPool, logger);

  /** 创建 PiSessionFactory（OtterToolClient 稍后注入，skills 由 SDK ResourceLoader 原生发现） */
  const agentGateway = await initAgentSessionFactory({
    model, modelPool, db,
    otterToolClient: {} as OtterToolClient,
    identityPromptDir: "./prompts/identity",
    createTools: (ctx, repo, log) => {
      const tools = createTools(ctx, repo, log);
      if (repo) tools.push(createManageHealingEventsTool(ctx, repo));
      return tools;
    },
    healingRepo: repos.healingEvent,
    otterConfigProvider,
    otterRepo: repos.otter,
  }, logger);

  const uc = initUseCases({ repos, agentGateway, embeddingService, memoryIndex, appConfig, logger });
  agentGateway.setOtterToolClient(buildOtterToolClient(uc));

  const dispatchChainEngine = createDispatchChainEngine(repos, uc, appConfig, logger);
  const feishu: FeishuBundle | undefined = appConfig.feishu
    ? createFeishuBundle(appConfig, uc, dispatchChainEngine, logger)
    : undefined;

  const { agentInvoker, cronParser, schedulerService } = await initAgentAndScheduler(repos, uc, agentGateway, feishu?.broadcaster, logger);
  const { processInboundRecruit, inboundApiKey, getBridgeStatus, healingInit, recruitingInit } = await initPlatforms({ appConfig, repos, uc, agentInvoker, dispatchChainEngine, logger });

  const settings: SettingsConfig = {
    provider: appConfig.llm.default ?? appConfig.llm.provider,
    model: modelPool ? modelPool.getDefaultAlias() : appConfig.llm.model,
    port: appConfig.server.port,
    dbPath: appConfig.db.path,
    embeddingModelPath: appConfig.embedding.modelPath,
    embeddingLocalModelPath: appConfig.embedding.localModelPath,
    embeddingDim: appConfig.embedding.dimensions,
  };

  const controllers = initControllers({ uc, agentInvoker, settings, settingsRepo: repos.settings, schedulerService, cronParser, dispatchChainEngine, messageBroadcaster: feishu?.broadcaster, featureRepo: repos.feature, researchRepo: repos.research, embeddingGateway: embeddingService, fs: new NodeFileSystem(), rootDir: process.cwd(), processInboundRecruit, inboundApiKey, getBridgeStatus }, logger);
  startServer({ controllers, agentInvoker, appConfig, uc, port: appConfig.server.port, feishu, logger });

  // 等待所有 ensure 完成后再启动 scheduler，确保新创建的 scheduled task 被遍历到
  Promise.allSettled([healingInit, recruitingInit]).then(() => {
    schedulerService.start().catch((err) => { logger.error(`Failed to start scheduler: ${err}`); });
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
