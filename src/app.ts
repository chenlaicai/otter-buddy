/**
 * buildApp：可测试的系统装配入口（F20260806tstr Part 1，基于 F20260805codx bootstrap 模块）。
 *
 * 与 main.ts 的关系：main.ts 是生产薄入口（本模块的调用方），全部编排在这里。
 * 与 bootstrap/* 的关系：bootstrap 模块是零件，本模块是按序组装 + 提供测试接缝。
 *
 * 无 import 时副作用：所有路径/全局副作用（配置加载、日志文件、auth 同步、
 * 飞书长连接、调度器、静态路由）均可通过 options 注入或关闭。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { Hono } from "hono";

import { loadConfig, initConfig, type AppConfig } from "@frameworks/config";
import { PinoLogger } from "@frameworks/logger";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPool } from "@frameworks/llm/model-pool";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SchedulerService } from "@usecases/scheduler/scheduler-service";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";

import {
  syncApiKeyToAgentAuth, initDatabaseAndModels, initRepositoriesWithDb,
  postInitDatabase, postSyncMigrations, validateModelAliases, shutdownDatabase,
  verifyEmbeddingVersion,
} from "./bootstrap/database";
import { createMemoryIndex, syncDocuments, createAndStartRetryWorker } from "./bootstrap/memory";
import { initUseCases } from "./bootstrap/usecases";
import { buildOtterToolClient } from "./bootstrap/clients";
import {
  createAgentGateway, createDispatchChainEngine, initAgentAndScheduler,
  createFeishuBundle, initPlatforms, setupFeishu, type FeishuBundle,
} from "./bootstrap/platforms";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { initControllers } from "./bootstrap/controllers";
import { buildHttpApp } from "./bootstrap/server";
import { initMetricsRegistry } from "@frameworks/metrics/registry";
import { SchedulerMetrics } from "@frameworks/metrics/scheduler-metrics";
import { AgentMetrics } from "@frameworks/metrics/agent-metrics";
import type { Repositories, UseCases } from "./bootstrap/types";
import type DatabaseType from "better-sqlite3";
import type { Logger as LoggerType } from "@usecases/ports/logger";
import type { RhiScanWorker as RhiScanWorkerType } from "@usecases/health/rhi-scan-worker";
import { RhiScanWorker } from "@usecases/health/rhi-scan-worker";
import { SignalPipeline } from "@usecases/health/signal-pipeline";
import { collectHealingEvents } from "@usecases/health/healing-collector";

/** 创建 PinoLogger 实例（stdout + 文件持久化），logDir 不存在时创建 */
export function createLogger(logDir: string): PinoLogger {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "otter-buddy.log");
  return new PinoLogger({
    level: process.env.LOG_LEVEL || "info",
    transport: {
      targets: [
        { target: "pino/file", level: process.env.LOG_LEVEL || "info", options: { destination: 1 } },
        { target: "pino/file", level: process.env.LOG_LEVEL || "info", options: { destination: logFile, mkdir: true } },
      ],
    },
  });
}

/** buildApp 的可选项：所有路径/副作用均可注入，测试用临时目录 + 关闭全局副作用 */
export interface BuildAppOptions {
  /** 预构建的配置对象（测试）；与 configPath 二选一，都不传则读 ./config/config.yaml */
  config?: AppConfig;
  /** config.yaml 路径覆盖 */
  configPath?: string;
  /** Logger 注入；默认 createLogger(`${dataDir}/logs`) */
  logger?: Logger;
  /** 数据目录（logs/sessions 的父目录），默认 ./data */
  dataDir?: string;
  /** pi session 文件目录，默认 `${dataDir}/sessions` */
  sessionDir?: string;
  /** Otter 身份文案目录，默认 ./prompts/identity */
  identityPromptDir?: string;
  /** 文档同步根目录，默认 process.cwd() */
  rootDir?: string;
  /** 静态页面根目录；false = 不挂载静态路由（测试），默认 ./web/dist */
  staticRoot?: string | false;
  /** 同步 apiKey 到 ~/.pi/agent/auth.json（全局用户态副作用），默认 true；测试必须传 false */
  syncAuth?: boolean;
  /** 启用飞书长连接，默认 !!config.feishu */
  enableFeishu?: boolean;
  /** 启动调度器，默认 true */
  startScheduler?: boolean;
  /** 测试注入预构建模型（如 initFauxModels），跳过 initModels */
  models?: { model: Model<Api>; modelPool?: ModelPool };
}

/** buildApp 的返回：完整装配好的系统 + dispose 清理 */
export interface BuiltApp {
  app: Hono;
  db: Database.Database;
  config: AppConfig;
  logger: Logger;
  controllers: ReturnType<typeof initControllers>;
  usecases: UseCases;
  repos: Repositories;
  agentGateway: PiSessionFactory;
  agentInvoker: AgentInvoker;
  schedulerService: SchedulerService;
  embeddingService: EmbeddingGateway;
  modelPool: ModelPool;
  /** F20260812mrcq Part 1：embedding 重试 worker（vec 禁用时为 null） */
  retryWorker: { stopSync(): void; stop(): Promise<void> } | null;
  /** 停止调度器、释放 embedding worker、关闭 DB、flush 日志 + metric。幂等。 */
  dispose(): Promise<void>;
}

/** F20260825sgnw（#401）：装配 RhiScanWorker（依赖注入集中在此，app.ts 主体只调 start/stop） */
function createRhiScanWorker(deps: {
  db: DatabaseType.Database;
  repos: Repositories;
  embeddingService: EmbeddingGateway;
  logger: LoggerType;
  rootDir: string;
}): RhiScanWorkerType {
  const pipeline = new SignalPipeline(deps.db, deps.repos.memoryWriter, deps.repos.memoryQueue, deps.embeddingService, deps.logger);

  // healing 事件源：open 状态全部取（behavior_defect 检测数据面）
  const healingSource = async () => collectHealingEvents(await deps.repos.healingEvent.findOpen(1000));

  return new RhiScanWorker(deps.rootDir, pipeline, healingSource, deps.logger);
}

// eslint-disable-next-line max-lines-per-function, max-statements, complexity -- Composition Root 集中装配逻辑
export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const dataDir = options.dataDir ?? "./data";
  const logger = options.logger ?? createLogger(path.join(dataDir, "logs"));

  /** initConfig 必须先于一切 init：PiSessionFactory 构造时捕获全局 config 单例的 circuitBreaker */
  const config = options.config ?? loadConfig(logger, options.configPath);
  initConfig(config);

  if (options.syncAuth ?? true) {
    syncApiKeyToAgentAuth(config.llm, logger);
  }

  // ── 数据层初始化 ──
  const { db, otterConfigProvider, model, modelPool, embeddingService, dispose: disposeEmbedding } =
    await initDatabaseAndModels(config, logger, options.models);
  const repos = initRepositoriesWithDb(db);
  await postInitDatabase(db, repos, logger);

  // F20260811mrpy Part 3：Embedding 版本锚校验（在 memory index 写入前完成）
  // 模型/维度不一致时禁用 vec 路径（降级状态经检索结果 vecCoverage 暴露，F20260821evaf）
  const embeddingVersionCheck = await verifyEmbeddingVersion(embeddingService, repos, logger);
  if (!embeddingVersionCheck.vecEnabled) {
    logger.warn(`Embedding vec path disabled due to ${embeddingVersionCheck.reason}`);
  }

  // ── 记忆索引 + 文档同步 ──
  const memoryIndex = createMemoryIndex(repos, embeddingService, logger);
  const syncResult = await syncDocuments(repos, memoryIndex, logger, options.rootDir ?? process.cwd());
  postSyncMigrations(db, logger, syncResult);

  // F20260812mrcq Part 1：embedding 重试 worker + 存量暗化条目迁移
  const retryWorker = await createAndStartRetryWorker(repos, embeddingService, logger);

  // F20260825sgnw（#401）：RHI 定时采集 worker——每小时跑一轮 采集→链→信号→记忆通道
  const rhiScanWorker = createRhiScanWorker({
    db, repos, embeddingService, logger,
    rootDir: options.rootDir ?? process.cwd(),
  });
  rhiScanWorker.start();

  if (modelPool) validateModelAliases(db, modelPool, logger);
  
  // ── 对话工作区 ──
  const workspaceGateway = new NodeWorkspaceGateway(dataDir);

  // ── Agent + UseCases（解决 OtterToolClient 循环依赖）──
  const { agentGateway, resolveOtterToolClient, resolveManageScheduledTask } = await createAgentGateway({
    repos, otterConfigProvider, model, modelPool, db, logger,
    sessionDir: options.sessionDir ?? path.join(dataDir, "sessions"),
    identityPromptDir: options.identityPromptDir,
    workspaceGateway,
  });
  const uc = initUseCases({ repos, agentGateway, embeddingService, memoryIndex, appConfig: config, logger, workspaceGateway });
  // F20260813mren 审视二轮：sync_docs 工具注入——海獭写完文档可立即触发同步入库
  // 审视三轮 A-10：rootDir 透传——worktree 流程下文槛在 worktree，海獭可传 worktree 绝对路径
  resolveOtterToolClient(buildOtterToolClient(uc, {
    syncDocs: async (rootDir?: string) => {
      const r = await syncDocuments(repos, memoryIndex, logger, rootDir ?? options.rootDir ?? process.cwd());
      return { synced: r.synced, updated: r.updated, skipped: r.skipped, archived: r.archived, errors: r.errors.length };
    },
  }));
  resolveManageScheduledTask(uc.manageScheduledTask);

  // ── Metric 框架（prom-client + JSONL 文件持久化）──
  const metricsRegistry = initMetricsRegistry(logger, { dir: path.join(dataDir, "metrics") });
  const schedulerMetrics = new SchedulerMetrics(metricsRegistry);
  const agentMetrics = new AgentMetrics(metricsRegistry);

  // ── 调度引擎 + 平台集成 ──
  const dispatchChainEngine = createDispatchChainEngine(repos, uc, config, logger, agentMetrics);
  /** issue #281：广播总线无条件创建（平台无关），飞书出站作为 channel 注册——
   *  旧实现 messageBroadcaster: feishu?.broadcaster 导致 web-only 部署流式链路断流 */
  const messageBroadcaster = new MessageBroadcaster(logger);
  const feishuEnabled = options.enableFeishu ?? !!config.feishu;
  const feishu: FeishuBundle | undefined = feishuEnabled && config.feishu
    ? createFeishuBundle({
      feishuConfig: config.feishu, uc, dispatchChainEngine, logger,
      webBaseUrl: config.web?.baseUrl, messageBroadcaster,
    })
    : undefined;

  const { agentInvoker, cronParser, schedulerService } = await initAgentAndScheduler({ repos, uc, agentGateway, messageBroadcaster, logger, workspaceGateway, metrics: schedulerMetrics, agentMetrics, dispatchChainEngine });
  const { processInboundRecruit, inboundApiKey, getBridgeStatus, healingInit, recruitingInit } =
    await initPlatforms({ appConfig: config, repos, uc, agentInvoker, dispatchChainEngine, logger });

  // ── HTTP 层 ──
  const controllers = initControllers({
    uc, agentInvoker, appConfig: config, modelPool, settingsRepo: repos.settings,
    schedulerService, cronParser, dispatchChainEngine, messageBroadcaster,
    featureRepo: repos.feature, researchRepo: repos.research, embeddingGateway: embeddingService,
    processInboundRecruit, inboundApiKey, getBridgeStatus,
  }, logger);

  const app = buildHttpApp(controllers, logger, options.staticRoot ?? "./web/dist");

  // 飞书长连接启动（原 startServer 内的副作用，装配语义上属于"启动平台集成"）
  if (feishu) {
    setupFeishu({ appConfig: config, uc, agentInvoker, feishu, messageBroadcaster, logger });
  }

  /** 等待所有 ensure 完成后再启动 scheduler，确保新创建的 scheduled task 被遍历到。
   *  与旧 main() 的差异：buildApp 会 await 这两个 ensure 再返回（确定性更高，无 LLM 调用、耗时极小）。 */
  await Promise.allSettled([healingInit, recruitingInit]);
  if (options.startScheduler ?? true) {
    schedulerService.start().catch((err) => {
      logger.error(`Failed to start scheduler: ${err}`);
    });
  }

  let disposed = false;
  return {
    app, db, config, logger, controllers,
    usecases: uc, repos, agentGateway, agentInvoker, schedulerService,
    embeddingService, modelPool, retryWorker,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      schedulerService.stop();
      // F20260812mrcq Part 1：先停 retry worker 再关 DB
      retryWorker?.stopSync();
      // F20260825sgnw（#401）：RHI worker 同样先停再关 DB
      await rhiScanWorker.stop();
      // await metric flush 到文件，确保进程退出前数据落盘
      try {
        await metricsRegistry.dispose();
      } catch (err) {
        logger.error("Metrics dispose failed", err instanceof Error ? err : undefined);
      }
      disposeEmbedding();
      shutdownDatabase(db, logger);
      if ("flush" in logger && typeof logger.flush === "function") {
        (logger as PinoLogger).flush();
      }
    },
  };
}
