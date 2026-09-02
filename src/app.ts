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
import { ResumeInterruptedService } from "@usecases/conversation/resume-interrupted-service";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";

import {
  syncApiKeyToAgentAuth, initDatabaseAndModels, initRepositoriesWithDb,
  postInitDatabase, postSyncMigrations, validateModelAliases, shutdownDatabase,
  verifyEmbeddingVersion,
} from "./bootstrap/database";
import { createMemoryIndex, syncDocuments, createAndStartRetryWorker } from "./bootstrap/memory";
import { initUseCases } from "./bootstrap/usecases";
import { QueryOtterProfile } from "@usecases/otter/query-otter-profile";
import { SqliteStatsQuery } from "@frameworks/db/stats/sqlite-stats-query";
import { buildOtterToolClient } from "./bootstrap/clients";
import {
  createAgentGateway, createDispatchChainEngine, initAgentAndScheduler,
  createFeishuBundle, initPlatforms, setupFeishu, type FeishuBundle,
  hotStartWeixinAccount, ensureWeixinConfig,
} from "./bootstrap/platforms";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { WeixinAccountStore } from "@frameworks/weixin/account-store";
import { WeixinLoginSessionManager } from "@frameworks/weixin/login-session-manager";
import type { WeixinPollingChannel } from "@frameworks/weixin/polling-channel";
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
import { countFidMentions } from "@frameworks/db/health/fid-mention-counter";
import { SignalRepository } from "@usecases/health/signal-repository";
import { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";
import type { AgentSessionSource } from "@usecases/health/cost-output-collector";
import type { CreateSnapshotRow } from "@usecases/health/snapshot-rows";

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
  /** F20260825sgnw 审视发现 1：RHI 扫描 worker 启动开关（对齐 startScheduler 模式；测试/CI 可关） */
  startRhiWorker?: boolean;
  /** F20260826rsme：重启自动恢复启动开关（对齐 startScheduler 模式；测试/CI 可关）。
   *  只在 resume 层生效，reconcile 侧不联动——reconcile 在 postInitDatabase 调用无 options 上下文，
   *  且统一入队在测试库中无副作用（记录不触发任何行为），行为开关收敛一处。 */
  startResume?: boolean;
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
  resumeService: ResumeInterruptedService;
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

  // FID 提及计数源（zombie 判定，审视发现 2：messages_fts 近 30 天窗口计数）
  const fidMentionSource = async (fids: string[], windowDays: number) =>
    countFidMentions(deps.db, fids, windowDays);

  // 指标快照落库端口（F20260829hviz Fix A）：scanOnce 计算指标写 health_snapshots
  const snapshotRepo = new HealthSnapshotRepository(deps.db);
  const snapshotSink = (snapshotDate: string, rows: CreateSnapshotRow[]) =>
    snapshotRepo.replaceForDate(snapshotDate, rows);

  // 健康评分 D5 输入：open 信号计数（issue #595 PR1）
  const signalRepo = new SignalRepository(deps.db);

  // 成本/产出快照落库端口（#583）：同 repo 的 replaceForDate，独立 metric_type
  const costOutputSink = (snapshotDate: string, rows: Array<{ snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata?: string }>, metricType?: string) =>
    snapshotRepo.replaceForDate(snapshotDate, rows.map(r => ({
      snapshotDate: r.snapshotDate,
      metricType: r.metricType,
      metricKey: r.metricKey,
      metricValue: r.metricValue,
      metadata: r.metadata,
    })), metricType);

  // session → otter 映射源（#583）：查询 agent_sessions + otters 表
  const agentSessionSource: AgentSessionSource = async () => {
    const rows = deps.db.prepare(`
      SELECT a.pi_session_id AS piSessionId, a.otter_id AS otterId,
             o.name AS otterName, o.type AS otterType
      FROM agent_sessions a
      JOIN otters o ON o.id = a.otter_id
    `).all() as Array<{ piSessionId: string; otterId: string; otterName: string; otterType: string }>;
    return rows;
  };

  const sessionsDir = path.join(deps.rootDir, "data", "sessions");

  return new RhiScanWorker(deps.rootDir, pipeline, healingSource, deps.logger, {
    fidMentionSource, snapshotSink, signalRepo, costOutputSink, sessionsDir, agentSessionSource, costOutputDb: deps.db,
  });
}

// eslint-disable-next-line max-lines-per-function, max-statements, complexity -- Composition Root 集中装配逻辑
export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const dataDir = options.dataDir ?? "./data";
  const logger = options.logger ?? createLogger(path.join(dataDir, "logs"));

  /** initConfig 必须先于一切 init：PiSessionFactory 构造时捕获全局 config 单例的 circuitBreaker */
  const config = options.config ?? loadConfig(logger, options.configPath);
  initConfig(config);

  // F20260829cach: prompt 缓存长留存。pi-ai 的 anthropic-messages 适配器读
  // PI_CACHE_RETENTION 环境变量（getProviderEnvValue），值为 "long" 时 cache_control
  // 携带 ttl="1h"，缓存命中窗口从默认 5 分钟扩到 1 小时（实测 miss 里 47.9% 来自
  // 5 分钟 TTL 过期）。必须在首个 LLM 调用前注入；显式设 false 时尊重外部环境。
  if (config.llm.cacheLongRetention !== false && !process.env.PI_CACHE_RETENTION) {
    process.env.PI_CACHE_RETENTION = 'long';
  }
  // 检视建议（PR #573 R1）：记录 1h TTL 实际生效状态，后续排查缓存命中率时有直接证据
  logger.info('Prompt cache long retention', {
    piCacheRetention: process.env.PI_CACHE_RETENTION ?? '(sdk-default 5m)',
  });

  if (options.syncAuth ?? true) {
    syncApiKeyToAgentAuth(config.llm, logger);
  }

  // ── 数据层初始化 ──
  const { db, otterConfigProvider, model, modelPool, embeddingService, dispose: disposeEmbedding } =
    await initDatabaseAndModels(config, logger, options.models);
  const repos = initRepositoriesWithDb(db, logger);
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
  // 审视发现 1：对齐 startScheduler 开关模式，测试/CI 可关（否则 buildApp 每次起 setInterval + git 采集副作用）
  const rhiScanWorker = createRhiScanWorker({
    db, repos, embeddingService, logger,
    rootDir: options.rootDir ?? process.cwd(),
  });
  if (options.startRhiWorker ?? true) {
    rhiScanWorker.start();
  }

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
  const uc = initUseCases({ repos, agentGateway, embeddingService, memoryIndex, appConfig: config, logger, workspaceGateway, otterConfigProvider });
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
      // F20260828fsyc：出站标签解析用户全局名（settingsRepo 可选注入,web-only 部署不传也不炸）
      settingsRepo: repos.settings,
    })
    : undefined;

  const { agentInvoker, cronParser, schedulerService } = await initAgentAndScheduler({ repos, uc, agentGateway, messageBroadcaster, logger, workspaceGateway, metrics: schedulerMetrics, agentMetrics, dispatchChainEngine, db, appConfig: config, modelPool, otterConfigProvider });

  // ── F20260902rbsg：信号路由器 P1 回滚（装配摘除）──
  // F20260901sgpv 上线后两起事故（F20260902uspr 投影哑火 + 存量信号批量点火，详见
  // F20260902rbsg 根因分析）：收件箱「未读=待行动」语义不成立，需重新设计。P1 的
  // 可选注入降级面即设计的回滚通道——此处不构造 SignalRouter，四入口（web MC /
  // 飞书 ADS / 微信 / RIS 启动补扫）全部回落直连链，行为与 sgpv 合入前一致。
  // signal-router.ts 类与单测保留，作为重设计的参考实现；恢复装配即重新启用。
  const { processInboundRecruit, inboundApiKey, getBridgeStatus, healingInit, recruitingInit, weixinPollers, registry } =
    await initPlatforms({ appConfig: config, repos, uc, agentInvoker, dispatchChainEngine, logger, messageBroadcaster });

  // ── 微信 web 登录（issue #566）：零配置可用 ──
  // config 无 weixin 段时也能发起扫码（登录会话用默认网关 + 默认 stateDir）；
  // 登录成功后：ensureWeixinConfig 补写 config.yaml + 热启动轮询，重启后常驻生效。
  // 注：账号删除后的轮询停止由 controller 层回调处理（此处闭包注入 stop 逻辑）
  const weixinAccountStore = new WeixinAccountStore(config.weixin ?? {});
  const extraWeixinPollers: WeixinPollingChannel[] = [];
  // #591：停掉并注销同 accountId 的旧轮询（替换语义）。热启动重登录虽生成新
  // accountId，但同账号重登/极窗内并发登录可产生同 id 场景；registry 条目
  // 同步清（对齐 stopStalePollersForUser 的做法：stop() 内部会写回状态，
  // 必须先 stop 再 remove，否则被覆盖）
  const stopWeixinPoller = (accountId: string, pool: WeixinPollingChannel[]): boolean => {
    const idx = pool.findIndex((p) => p.accountId === accountId);
    if (idx >= 0) {
      pool[idx].stop();
      registry?.remove(`weixin-${pool[idx].accountId}`);
      messageBroadcaster.unregisterOutboundChannel(`weixin-${pool[idx].accountId}`);
      pool.splice(idx, 1);
      return true;
    }
    return false;
  };
  // F20260831wxsp 修复 4：重新扫码后回收同扫码人的旧轮询。账号 id 每次扫码新生成
  //（weixin-<时间戳>），旧 token 的轮询若在 -14 的 1h 暂停 sleep 里，不回收就成了
  // 每小时醒一次吃 -14 再睡回去的僵尸循环——直到下次重启才消失。按 ilinkUserId
  // （扫码人）识别旧轮询；两个池都清（冷启动池 + 热启动池），与账号删除的停法同构。
  const stopStalePollersForUser = (ilinkUserId: string): number => {
    let stopped = 0;
    for (const pool of [extraWeixinPollers, weixinPollers ?? []]) {
      for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].ilinkUserId === ilinkUserId) {
          pool[i].stop();
          // F20260901chun：鬼影回收时同步清 registry 条目（防残留状态误导 UI）
          // 必须在 stop() 之后——stop() 内部会写回状态，先清会被覆盖
          registry?.remove(`weixin-${pool[i].accountId}`);
          // #591：出站通道同步注销——旧 poller 停了但 channel 还挂在 broadcaster
          // 上，一条消息仍会投给旧 token（大概率 -14 报错吞在通道 catch 里）
          messageBroadcaster.unregisterOutboundChannel(`weixin-${pool[i].accountId}`);
          pool.splice(i, 1);
          stopped++;
        }
      }
    }
    return stopped;
  };
  const weixinLoginSessions = new WeixinLoginSessionManager({
    baseUrl: config.weixin?.baseUrl,
    accountStore: weixinAccountStore,
    logger,
    onSuccess: (accountId, ilinkUserId) => {
      // partnerUserId = 命令门禁锚定的扫码人（命令重启后仍生效）；config 无 weixin 段时兜底注入
      // Bugfix（F20260831wxsp）：补写目标必须与读入路径一致——此前缺省 "./config.yaml" 而真实
      // 配置在 config/config.yaml，写回 ENOENT 静默失败，重启后 weixin 段丢失、轮询拉不起来。
      // options.configPath 是测试注入的临时路径；生产缺省走 ensureWeixinConfig 内的默认（对齐 loadConfig）。
      ensureWeixinConfig({ configPath: options.configPath, stateDir: config.weixin?.stateDir, ilinkUserId, logger });
      const account = weixinAccountStore.getAccount(accountId);
      if (!account) return;
      // #591 替换语义：同 accountId 的旧 poller 先停再重启（防同账号并发轮询
      // 消费同游标致重复投递）；stopStalePollersForUser 负责同扫码人旧账号的
      // 僵尸循环回收（-14 暂停 sleep 监听 abort，stop 即醒即退）。两道去重
      // 独立生效：前者管「同 id」，后者管「同人不同 id」
      const stoppedSameAccount = stopWeixinPoller(accountId, extraWeixinPollers)
        || (weixinPollers ? stopWeixinPoller(accountId, weixinPollers) : false);
      if (stoppedSameAccount) logger.info("Weixin: replaced poller with same accountId on re-login", { accountId });
      const stoppedStale = stopStalePollersForUser(account.ilinkUserId ?? ilinkUserId ?? "");
      if (stoppedStale > 0) logger.info("Weixin: stopped stale poller(s) after re-login", { ilinkUserId, count: stoppedStale });
      const poller = hotStartWeixinAccount({
        appConfig: config, repos, uc, agentInvoker, dispatchChainEngine, messageBroadcaster, logger,
        accountStore: weixinAccountStore,
        // config 无 weixin 段时用默认配置 + 扫码人作为 partner（命令门禁锚定）
        weixinConfig: config.weixin ?? { partnerUserId: account.ilinkUserId ?? ilinkUserId },
        account,
        registry,
      });
      if (poller) extraWeixinPollers.push(poller);
    },
  });

  // ── HTTP 层 ──
  // PR-2：创建 profile 聚合 use case（warmup 后 ResourceLoader 可用）
  const resourceLoader = agentGateway.getResourceLoader();
  const statsQuery = new SqliteStatsQuery(db);
  const queryOtterProfile = new QueryOtterProfile(repos.otter, otterConfigProvider, modelPool, logger, { resourceLoader: resourceLoader as any, statsQuery });

  /** #576（F20260901emps）：能力库页面数据源——ResourceLoader 适配 SkillDirectory 端口。
   *  与 otter 实际加载的 skill 一致（页面所见即系统所载），替代前端静态快照。
   *  warmup 前 resourceLoader 可能为 null——返回空列表，前端展示显式空态（不静默空白） */
  const skillDirectory = resourceLoader
    ? {
        list: async () => {
          const { skills } = resourceLoader.getSkills();
          return skills.map((s: { name: string; description: string }) => ({ name: s.name, description: s.description }));
        },
      }
    : undefined;

  const controllers = initControllers({
    uc, repos, agentInvoker, appConfig: config, modelPool, settingsRepo: repos.settings,
    otterConfigProvider,
    queryOtterProfile,
    schedulerService, cronParser, dispatchChainEngine, messageBroadcaster,
    featureRepo: repos.feature, researchRepo: repos.research, embeddingGateway: embeddingService,
    processInboundRecruit, inboundApiKey, getBridgeStatus,
    // F20260825rweb（#402）：RHI 面板 API 依赖
    rhiScanWorker,
    signalRepo: new SignalRepository(db),
    healthSnapshotRepo: new HealthSnapshotRepository(db),
    // F20260826mwrd C4：消息徽章数据源（signal_events 表，与 RHI 的 health 语义池区分）
    signalEventRepo: repos.signalEvent,
    // 多模态 Phase 1（D1 修复）：显式传递附件 repo——漏传会导致附件路由生产 404
    attachmentRepo: repos.attachment,
    // 微信连接管理（issue #566）
    weixinLoginSessions,
    weixinAccountStore,
    onWeixinAccountDeleted: (accountId) => {
      // 账号删除：停轮询（热启动池 + 初始启动池都查；初始池删除后无法 splice
      // 因为 weixinPollers 在别处持有——stop 即可，数组残留无害：进程生命周期内
      // 它不再拉起新轮询，长轮询 35s 超时后自然停止）
      const stopped = stopWeixinPoller(accountId, extraWeixinPollers);
      if (!stopped && weixinPollers) stopWeixinPoller(accountId, weixinPollers);
      // #592：清理关联的活跃登录会话——开着登录页又去删账号的竞态场景，不清理
      // 的话扫码确认后账号重新落盘（「删了又复活」）。非终态会话置 cancelled；
      // 若扫码已在后台完成（accountId 已回填）连带清同扫码人的其它会话。已终态
      // （success/error/expired/cancelled）的不动——终态语义不可变更。
      const account = weixinAccountStore.getAccount(accountId);
      const sessionsCancelled = weixinLoginSessions.cancelByAccountId(accountId);
      const userCancelled = account?.ilinkUserId
        ? weixinLoginSessions.cancelByIlinkUserId(account.ilinkUserId)
        : 0;
      if (sessionsCancelled + userCancelled > 0) {
        logger.info("Weixin account deleted; cancelled in-flight login sessions", { accountId, sessionsCancelled, userCancelled });
      }
      logger.info("Weixin account deleted; poller stopped", { accountId });
    },
    // 通道状态注册表（F20260901chun：统一 IM 页 + 真实健康状态）
    registry,
    // #576（F20260901emps）：能力库真数据源
    skillDirectory,
  }, logger);

  const app = buildHttpApp(controllers, logger, options.staticRoot ?? "./web/dist");

  // 飞书长连接启动（原 startServer 内的副作用，装配语义上属于"启动平台集成"）
  if (feishu) {
    setupFeishu({ appConfig: config, uc, repos, agentInvoker, feishu, messageBroadcaster, logger, registry });
  }

  /** 等待所有 ensure 完成后再启动 scheduler，确保新创建的 scheduled task 被遍历到。
   *  与旧 main() 的差异：buildApp 会 await 这两个 ensure 再返回（确定性更高，无 LLM 调用、耗时极小）。 */
  await Promise.allSettled([healingInit, recruitingInit]);
  if (options.startScheduler ?? true) {
    schedulerService.start().catch((err) => {
      logger.error(`Failed to start scheduler: ${err}`);
    });
  }

  // ── F20260826rsme 重启自动恢复：装配在 agentInvoker 诞生之后（initAgentAndScheduler），闭包捕获无循环依赖 ──
  const resumeService = new ResumeInterruptedService({
    conversationRepo: repos.conversation,
    queryMessage: uc.queryMessage,
    sendMessage: uc.sendMessage,
    dispatchChainEngine,
    invokeFn: (params) => agentInvoker.invokeConversation(params),
    logger,
    // #613：服务重启事件落 healing 台账（观测层闭环，severity 按中断发言数分级）
    healingRepo: repos.healingEvent,
  });
  if (options.startResume ?? true) {
    // fire-and-forget：resume 内部自带延迟，不阻塞也不吞启动错误
    void resumeService.resume().catch((err) => {
      logger.error(`Failed to resume interrupted messages: ${err}`);
    });
  }

  let disposed = false;
  return {
    app, db, config, logger, controllers,
    usecases: uc, repos, agentGateway, agentInvoker, schedulerService, resumeService,
    embeddingService, modelPool, retryWorker,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      // F20260829wxch（#213 检视发现2）：停微信长轮询通道——否则 SIGINT/SIGTERM 时
      // fetch 挂到超时、notifyStop 不调用、服务端不知客户端已断
      weixinPollers?.forEach((p) => p.stop());
      // issue #566：web 登录热启动的轮询同样要停（dispose 单独数组）
      extraWeixinPollers.forEach((p) => p.stop());
      // F20260901chun：防御性清空通道状态注册表（防未来加事件监听/定时器泄漏）
      registry?.clear();
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
