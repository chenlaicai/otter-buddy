/**
 * Composition Root - 依赖注入装配点。
 * main.ts 是唯一允许跨层引用的文件（Composition Root 豁免）。
 * 本文件只做"组装"，不含业务逻辑。
 */
import { PinoLogger } from "@frameworks/logger";
import { loadConfig, initConfig } from "@frameworks/config";

import {
  syncApiKeyToAgentAuth, initDatabaseAndModels, initRepositoriesWithDb,
  postInitDatabase, postSyncMigrations, validateModelAliases, shutdownDatabase,
} from "./bootstrap/database";
import { createMemoryIndex, syncDocuments } from "./bootstrap/memory";
import { initUseCases } from "./bootstrap/usecases";
import { buildOtterToolClient } from "./bootstrap/clients";
import {
  createAgentGateway, createDispatchChainEngine, initAgentAndScheduler,
  createFeishuBundle, initPlatforms,
} from "./bootstrap/platforms";
import { initControllers } from "./bootstrap/controllers";
import { startServer } from "./bootstrap/server";
import type { FeishuBundle } from "./bootstrap/platforms";

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

  // ── 数据层初始化 ──
  const { db, otterConfigProvider, model, modelPool, embeddingService, dispose } = await initDatabaseAndModels(appConfig, logger);
  const repos = initRepositoriesWithDb(db);
  await postInitDatabase(db, repos, logger);

  // ── 记忆索引 + 文档同步 ──
  const memoryIndex = createMemoryIndex(repos, embeddingService, logger);
  const syncResult = await syncDocuments(repos, memoryIndex, logger, process.cwd());
  postSyncMigrations(db, logger, syncResult);

  if (modelPool) validateModelAliases(db, modelPool, logger);

  // ── Agent + UseCases（解决 OtterToolClient 循环依赖）──
  const { agentGateway, resolveOtterToolClient } = await createAgentGateway({ repos, otterConfigProvider, model, modelPool, db, logger });
  const uc = initUseCases({ repos, agentGateway, embeddingService, memoryIndex, appConfig, logger });
  resolveOtterToolClient(buildOtterToolClient(uc));

  // ── 调度引擎 + 平台集成 ──
  const dispatchChainEngine = createDispatchChainEngine(repos, uc, appConfig, logger);
  const feishu: FeishuBundle | undefined = appConfig.feishu
    ? createFeishuBundle(appConfig, uc, dispatchChainEngine, logger)
    : undefined;

  const { agentInvoker, cronParser, schedulerService } = await initAgentAndScheduler(repos, uc, agentGateway, feishu?.broadcaster, logger);
  const { processInboundRecruit, inboundApiKey, getBridgeStatus, healingInit, recruitingInit } = await initPlatforms({ appConfig, repos, uc, agentInvoker, dispatchChainEngine, logger });

  // ── HTTP 层 + 启动 ──
  const controllers = initControllers({ uc, agentInvoker, appConfig, modelPool, settingsRepo: repos.settings, schedulerService, cronParser, dispatchChainEngine, messageBroadcaster: feishu?.broadcaster, featureRepo: repos.feature, researchRepo: repos.research, embeddingGateway: embeddingService, processInboundRecruit, inboundApiKey, getBridgeStatus }, logger);
  startServer({ controllers, agentInvoker, appConfig, uc, feishu, logger });

  // 等待所有 ensure 完成后再启动 scheduler，确保新创建的 scheduled task 被遍历到
  Promise.allSettled([healingInit, recruitingInit]).then(() => {
    schedulerService.start().catch((err) => { logger.error(`Failed to start scheduler: ${err}`); });
  });

  process.on("SIGINT", () => {
    schedulerService.stop();
    logger.flush();
    dispose();
    shutdownDatabase(db, logger);
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});
