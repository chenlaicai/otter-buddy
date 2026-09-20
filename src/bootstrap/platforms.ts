/* eslint-disable max-lines -- F20260908rlcp: dispatchAttemptRepo 退役后行数仍超 450（装配文件由注入项决定） */
import { buildContextTokenWarnConfig, type AppConfig } from "@frameworks/config";
import fsSync from "node:fs";
import path from "node:path";
import { getRepoRoot } from "@frameworks/repo-root";
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
// F20260920uhuc：统一交接引擎（bootstrap=组合根，import frameworks 合法）
import type { HandoffEngineDeps } from "../interface-adapters/agent-runtime/agent-invoker";
import { buildNarrativeSynthesisPrompt, assembleHandoffArchive, buildMechanicalArchive, NARRATIVE_SYNTHESIS_TIMEOUT_MS } from "@frameworks/agent/narrative-synthesis-engine";
import { sliceSessionEntries, serializeKeptWindow } from "@frameworks/agent/session-slicer";
import { collectStateInventory, renderStateInventory } from "@frameworks/agent/state-inventory";
import { scanWorkspaceFiles, renderFileTrail } from "@frameworks/agent/file-trail-extractor";
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
import type { SchedulerServiceOptions } from "@usecases/scheduler/scheduler-service";
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
import { resolveFeatureGates, gateOn, inferDomainActive } from "./feature-gates";
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
    // Why: 默认目录基于代码位置解析（#429）；注入参数 override 优先
    identityPromptDir: options.identityPromptDir ?? path.resolve(getRepoRoot(), "prompts/identity"),
    createTools: (ctx, repo, log) => {
      // PR4: 创建纸面交易 Ledger 注入到工具
      const paperTradeRepo = new PaperTradeRepositoryImpl(db);
      const paperGateway = new StockQuoteGatewayImpl(getRepoRoot());
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
    // F20260917trig：RHI 健康信号仓库注入——triage_signal/list_rhi_signals 注册条件
    // （signals 表，与獭间 signal_events 语义池分离）
    rhiSignalRepo: repos.rhiSignal,
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
    conversationRepo: repos.conversation,
  }, logger);

  return {
    agentGateway,
    resolveOtterToolClient: (client) => agentGateway.setOtterToolClient(client),
    resolveManageScheduledTask: (mst) => { manageScheduledTaskRef = mst; },
  };
}

export function createDispatchChainEngine(repos: Repositories, uc: UseCases, appConfig: AppConfig, logger: Logger, options?: { agentMetrics?: AgentMetricsPort; agentGateway?: PiSessionFactory }): DispatchChainEngine {
  return new DispatchChainEngine({
    conversationRepo: repos.conversation,
    queryOtter: uc.queryOtter,
    logger,
    maxChainDepth: appConfig.circuitBreaker.maxChainDepth,
    settingsRepo: repos.settings,
    metrics: options?.agentMetrics,
    // F20260826fpbd：搭档身份静态判定。appConfig.feishu 可选，未配置时 PartnerResolver 降级（动态推断）
    partnerResolver: new PartnerResolver(appConfig.feishu?.partnerOpenId),
    // F20260902sgp2 S1：派发台账注入——所有入口每次派发都记账（链引擎是必经之路，§4.2）。
    // 记账失败仅日志不阻断（硬约束 1）；不注入时链路行为与 sgpv 回滚基线一致。
    // #530 梯度护栏：abort 回调注入（可选——不注入时降级为纯日志）。
    // F20260907ylfs ②：steer 回调已删（③ 检视修复后 steer 注入改走 ChainHopResult.steerText
    // 进程级传递，回调零调用点成死装配——检视-838 移交件 A）；steerSession 保留在
    // pi-session-factory（① URGENT steer 注入的依赖，signal-router 直调不经链引擎 deps）。
    abort: options?.agentGateway ? (otterId) => options.agentGateway!.abort(otterId) : undefined,
    healingRepo: repos.healingEvent,
    // F20260913ctlv 彻底切换：未读注入/hop 产出判定/self-yield 护栏数据源（entries + invokes）
    entryRepo: repos.entry,
    invokeRepo: repos.invoke,
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
    // F20260920uhuc 需求变更（2026-09-20）：交接阈值按模型直给（已用 token 绝对值）
    getOtterHandoffThresholdTokens: (otterId: string): number | undefined => {
      const alias = otterConfigProvider?.getConfig(otterId)?.modelAlias;
      return modelPool.getHandoffThresholdTokens(alias);
    },
  };
}

/** F20260920uhuc：统一交接引擎函数包组装（bootstrap 层 import frameworks——组合根合法）。
 *  水位阈值按模型读 ModelConfig.handoffThresholdTokens（2026-09-20 需求变更，直给制）。
 *  类型桥接：frameworks 具体签名 → HandoffEngineDeps 结构面（具体类型在 bootstrap 收敛）。 */
function buildHandoffEngineDeps(): HandoffEngineDeps {
  return {
    buildNarrativeSynthesisPrompt,
    assembleHandoffArchive,
    buildMechanicalArchive,
    sliceSessionEntries: sliceSessionEntries as unknown as HandoffEngineDeps["sliceSessionEntries"],
    serializeKeptWindow: serializeKeptWindow as unknown as HandoffEngineDeps["serializeKeptWindow"],
    collectStateInventory: collectStateInventory as unknown as HandoffEngineDeps["collectStateInventory"],
    renderStateInventory: renderStateInventory as unknown as HandoffEngineDeps["renderStateInventory"],
    scanWorkspaceFiles,
    renderFileTrail: renderFileTrail as unknown as HandoffEngineDeps["renderFileTrail"],
    synthesisTimeoutMs: NARRATIVE_SYNTHESIS_TIMEOUT_MS,
  };
}

  /** 控 max-lines-per-function：AgentInvoker 构造拆行（initAgentAndScheduler 子步骤） */
function buildAgentInvoker(o: {
  agentGateway: PiSessionFactory; uc: UseCases; repos: Repositories; logger: Logger;
  messageBroadcaster: MessageBroadcaster | undefined; workspaceGateway?: WorkspaceGateway;
  agentMetrics?: AgentMetricsPort; appConfig?: AppConfig; ctxWindowProvider?: OtterContextWindowProvider;
  agentDispatchService?: AgentDispatchService;
  /** F20260920uhuc：统一交接引擎函数包 */
  handoffEngine?: HandoffEngineDeps;
}): AgentInvoker {
  return new AgentInvoker(
    o.agentGateway,
    o.uc.queryMessage, o.uc.manageSession, o.uc.queryOtter, o.logger,
    o.messageBroadcaster, o.workspaceGateway, o.repos.settings, o.agentMetrics,
    o.repos.healingEvent,
    // F20260825hndf：优雅上下交接依赖注入
    o.repos.conversation,
    o.repos.scheduledTask,
    (conversationId) => o.repos.conversation.getLinkedResources(conversationId, { status: "active" }),
    o.uc.manageContext,
    buildHandoffPackage,
    // F20260831cbkw：熔断 session 年龄窗口阈值（从 config 读取，缺省 2h）
    o.appConfig?.circuitBreaker.healthySessionThresholdMs,
    // F20260901cxmw：otter 实际模型 contextWindow 解析（handoff 阈值按真实窗口计算）
    o.ctxWindowProvider,
    // F20260913ctlv 彻底切换：invoke 生命周期管理（唯一写入面）
    o.uc.sendEntry,
    // F20260913ctlv 彻底切换：invoke 仓库（熔断摘要读 invoke_events）
    o.repos.invoke,
    // F20260916fst4：首哑信号消费时 dispatch 大獭（setter 延迟挂接，见 initAgentAndScheduler 注释）
    o.agentDispatchService,
    // F20260920uhuc：统一交接引擎函数包
    o.handoffEngine,
  );
}

export async function initAgentAndScheduler(options: { repos: Repositories; uc: UseCases; agentGateway: PiSessionFactory; messageBroadcaster: MessageBroadcaster | undefined; logger: Logger; workspaceGateway?: WorkspaceGateway; metrics?: SchedulerMetrics; agentMetrics?: AgentMetricsPort; dispatchChainEngine?: DispatchChainEngine; db?: Database.Database; appConfig?: AppConfig; modelPool?: ModelPool; otterConfigProvider?: OtterConfigProvider }) {
  const { repos, uc, agentGateway, messageBroadcaster, logger, workspaceGateway, metrics, agentMetrics, dispatchChainEngine, db, appConfig, modelPool, otterConfigProvider } = options;
  await agentGateway.warmup();

  // PR4: 注册纸面交易函数（function executor 使用）
  if (db) {
    const paperTradeRepo = new PaperTradeRepositoryImpl(db);
    const paperGateway = new StockQuoteGatewayImpl(getRepoRoot());
    const paperLedger = new Ledger(paperTradeRepo, paperGateway);
    registerPaperTradingFunctions(paperLedger, paperTradeRepo);

    // A3: 同步交易日历（akshare 或 fallback）
    syncTradingCalendar(paperTradeRepo, process.cwd()).then((res) => {
      logger.info(`Trading calendar synced: ${res.count} entries (source: ${res.source})`);
    }).catch((err) => {
      logger.error("Trading calendar sync failed", err instanceof Error ? err : new Error(String(err)));
    });

    // PR5: seed 定时任务（幂等）——F20260915cfgt：受 features.paperTrading 门控（个人场景默认关）。
    // S1 修复（检视发现）：走完整三态门（显式配置 > DB 存量推断），与 initPlatforms 的
    // gates 同语义——老部署未写配置但 DB 有 active paper-trading 任务时靠推断保活（T3）。
    // registerPaperTradingFunctions / syncTradingCalendar 保持无条件：进程内注册随重启重建，
    // 不持久化，保留不动改动面最小；开关打开后无需关心注册时序
    const paperTradingOn = await gateOn(
      appConfig?.features.paperTrading,
      () => inferDomainActive(repos.scheduledTask, 'paperTrading'),
    );
    if (paperTradingOn) {
      await seedPaperTradingTasks({
        manageScheduledTask: uc.manageScheduledTask,
        manageConversation: uc.manageConversation,
        convRepo: repos.conversation,
        otterRepo: repos.otter,
        settings: repos.settings,
        logger,
      });
    }
  }

  // F20260901cxmw：otter 实际模型 contextWindow 解析（handoff 阈值按真实窗口计算）
  const ctxWindowProvider = modelPool ? buildCtxWindowProvider(modelPool, otterConfigProvider) : undefined;

  // F20260916fst4：首哑信号消费依赖——AgentDispatchService 构建晚于 agentInvoker
  //（initPlatforms 内 feishu/weixin 分支），时序上无法构造注入。方案选定 setter 延迟挂接：
  // 延迟到 initPlatforms 各 AgentDispatchService 构建完成后调用（见下方两处），
  // 对既有构造零侵入（agentDispatchService 为可选参数，缺省降级仅日志）。
  const agentInvoker = buildAgentInvoker({
    agentGateway, uc, repos, logger, messageBroadcaster, workspaceGateway, agentMetrics,
    appConfig, ctxWindowProvider,
    handoffEngine: buildHandoffEngineDeps(),
  });

  // F20260920uhuc：压缩钩子接线退役——setCompactionSynthesis 随 session_before_compact 钩子退役
  //（时机权回收应用层轮边界水位，七段合成迁入统一引擎 narrative-synthesis-engine，
  //  经 HandoffEngineDeps 注入 agentInvoker）。

  // F20260827he2f：启动时探针——验证 healing_repo 可达，熔断事件落库能力正常
  // 失败仅 warn（不阻塞启动），但日志可作为诊断入口
  agentInvoker.probeHealingRepo().catch((err: unknown) => {
    logger.warn('healing_repo startup probe failed', { error: err instanceof Error ? err.message : String(err) });
  });

  const cronParser = new SimpleCronParser();
  const schedulerService = new SchedulerService(
    // F20260913ctlv 收尾批2：内部信号唯一落点 = entries（system entry + entry.system 广播）
    buildSchedulerServiceOptions({
      taskRepo: repos.scheduledTask,
      convRepo: repos.conversation,
      sendEntry: uc.sendEntry,
      entryRepo: repos.entry,
      messageBroadcaster: options.messageBroadcaster,
      agentInvokePort: agentInvoker,
      cronParser,
      logger,
      manageScheduledTask: uc.manageScheduledTask,
      manageSession: uc.manageSession,
      healingRepo: repos.healingEvent,
      metrics,
      dispatchChainEngine,
      functionRegistry: db ? paperTradingFunctionRegistry : undefined,
    }),
  );

  return { agentInvoker, cronParser, schedulerService };
}

/** 控 max-lines-per-function：SchedulerServiceOptions 透传（initAgentAndScheduler 拆行） */
function buildSchedulerServiceOptions(o: SchedulerServiceOptions): SchedulerServiceOptions {
  return o;
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
  messageBroadcaster.registerOutboundChannel("feishu", new FeishuMessageChannel(uc.manageConnection, client, logger, webBaseUrl, settingsRepo));
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
  /** #460：返回飞书 stop 句柄（app dispose 时停 WSClient 重连，防僵尸进程） */
}): { stopFeishu: () => void; agentDispatchService: AgentDispatchService } | undefined {
  const { appConfig, uc, repos, agentInvoker, feishu, messageBroadcaster, logger, registry, signalRouter } = options;
  if (!appConfig.feishu) return undefined;

  const commandDispatcher = new CommandDispatcher(uc.manageConnection, repos.entry, feishu.client, logger);
  // F20260826fpbd：命令门禁（方案B）——setupFeishu 入口有 !appConfig.feishu 早退，此处必存在；partnerOpenId 仍可选
  const partnerResolver = new PartnerResolver(appConfig.feishu?.partnerOpenId);
  const agentDispatchService = new AgentDispatchService({
    dispatchChainEngine: feishu.dispatchChainEngine,
    entryRepo: repos.entry,
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
    // F20260918imas：助理态（p2p 自动开户 + 软轮换）；总开关关闭时不注入（回退拒聊）
    ...(appConfig.im?.assistant?.enabled !== false && { assistantSession: uc.assistantSession }),
    // F20260913ctlv 彻底切换：飞书用户消息写 entries
    sendEntry: uc.sendEntry,
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

  // #460：返回 stop 句柄接入 app.ts dispose 链——WSClient 重连会阻止进程退出（僵尸进程根因之四）
  return {
    stopFeishu: () => void longConnectionClient.stop().catch((err) =>
      logger.error("Feishu long connection stop failed", err instanceof Error ? err : undefined)),
    // F20260916fst4：首哑信号消费依赖——供 app.ts setter 延迟挂接 agentInvoker
    agentDispatchService,
  };
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
  /** #460：飞书长连接 stop 句柄（app dispose 时停 WSClient 重连，防僵尸进程） */
  stopFeishu?: () => void;
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
      const api = new WeixinApiClient({ baseUrl: account.baseUrl || weixinConfig.baseUrl || "https://ilinkai.weixin.qq.com", token: account.token, logger });
      // 媒体支持（issue #567）：CDN 客户端同构注入 gateway（出站上传）与媒体下载实现（入站）
      const cdn = new WeixinCdnClient({ api, logger });
      const mediaGateway = new WeixinMediaClient({ cdn, logger });
      const gateway = new WeixinGatewayAdapter({ api, accountStore, accountId: account.id, logger, cdn });
      // 出站：广播总线注册（与飞书同模式；F20260913ctlv 处置轮：attachmentRepo 死参数已删，媒体出站恢复待独立 issue）
      // #591：键控注册（"weixin-<accountId>"）——同账号重登录时替换旧通道而非追加，
      // 防止重复投递；停轮询/删账号时 unregisterOutboundChannel 成对清理
      messageBroadcaster.registerOutboundChannel(
        `weixin-${account.id}`,
        new WeixinMessageChannel(uc.manageConnection, gateway, uc.queryOtter, logger, appConfig.web?.baseUrl, repos.settings),
      );
      // ingress：入站处理器 + 轮询循环（媒体三项与飞书同构：注入服务与 controllers.ts 同一块装配）
      const attachmentInjection = new AttachmentInjectionService({
        attachmentRepo: repos.attachment,
        storageRoot: appConfig.attachments?.storageRoot ?? "./data/attachments",
        logger,
      });
      const processor = new WeixinMessageProcessor({
        manageConnection: uc.manageConnection,
        // F20260918imas：助理态（私聊自动开户 + 软轮换）；总开关关闭时不注入（回退拒聊）
        ...(appConfig.im?.assistant?.enabled !== false && { assistantSession: uc.assistantSession }),
        // F20260913ctlv 收尾批2：微信消息唯一落点 = entries（与飞书同构）
        sendEntry: uc.sendEntry,
        entryRepo: repos.entry,
        weixinGateway: gateway,
        partnerResolver: new PartnerResolver(weixinConfig.partnerUserId),
        // F20260901sgpv P1：微信入口换轨（与飞书同构）
        agentDispatchService: (() => {
          const svc = new AgentDispatchService({
            dispatchChainEngine, entryRepo: repos.entry, agentInvokePort: agentInvoker, logger,
            ...(options.signalRouter && { signalRouter: options.signalRouter }),
          });
          // F20260916fst4：首哑信号消费依赖挂接——微信通道的 dispatch 实例就地 setter 挂到 agentInvoker
          // （幂等：与 feishu 实例能力等价，双通道装配时后挂接者覆盖前者无语义差异）
          agentInvoker.attachAgentDispatchService(svc);
          return svc;
        })(),        messageBroadcaster,
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
  // Why: 默认路径基于代码位置解析（#429）；opts.configPath override 优先
  const configPath = opts.configPath ?? path.resolve(getRepoRoot(), "config/config.yaml");
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
  const { appConfig, repos, uc, agentInvoker, dispatchChainEngine, logger, signalRouter } = options;

  // F20260915cfgt：功能开关门控（三态：显式配置 > DB 存量推断 > 缺省值）。
  // gates 解析必须同步完成后再接 ensure 链——推断依赖 getAllActive，放 Promise 链外保证顺序确定。
  const gates = await resolveFeatureGates({
    features: appConfig.features,
    scheduledTaskRepo: repos.scheduledTask,
    recruitingApiKey: appConfig.inbound?.recruiting?.apiKey,
    logger,
  });
  logger.info("Feature gates resolved", { gates });

  // F20260915cfgt：self-healing 属海獭系统优化（除作者外无人关心），默认关；老部署靠存量推断保持 on
  let healingInit: Promise<void> = Promise.resolve();
  if (gates.selfHealing) {
    healingInit = ensureHealingConversation({ manageConversation: uc.manageConversation, convRepo: repos.conversation, otterRepo: repos.otter, settings: repos.settings, sendEntry: uc.sendEntry, logger })
      .then(({ conversationId, bigOtterId }) => ensureHealingScheduler({ manageScheduledTask: uc.manageScheduledTask, scheduledTaskRepo: repos.scheduledTask, healingConversationId: conversationId, bigOtterId }))
      .then(() => undefined)
      .catch(err => logger.warn("Self-Healing init failed", { error: err instanceof Error ? err.message : String(err) }));
  }

  let processInboundRecruit: ProcessInboundRecruit | undefined;
  let inboundApiKey: string | undefined;
  let getBridgeStatus: GetBridgeStatus | undefined;
  let recruitingInit: Promise<void> = Promise.resolve();
  // F20260915cfgt：recruiting 双门（apiKey && features.recruiting）。
  // 门控边界 = 整个子系统：webhook 处理器/桥接状态/seed 三对象同块创建，关 features 时
  // processInboundRecruit 留 undefined，initControllers 侧自动降级 NoopInboundController（controllers.ts:182-189）
  if (appConfig.inbound?.recruiting?.apiKey && gates.recruiting) {
    inboundApiKey = appConfig.inbound.recruiting.apiKey;
    processInboundRecruit = new ProcessInboundRecruit(
      repos.settings,
      uc.sendEntry,
      repos.entry,
      dispatchChainEngine,
      agentInvoker,
      logger,
      // #775 S4a：招聘入口换轨——过闸门+台账（未注入回退直连链）
      signalRouter,
    );
    getBridgeStatus = new GetBridgeStatus(repos.settings);
    recruitingInit = ensureRecruitingConversation({
      manageConversation: uc.manageConversation,
      convRepo: repos.conversation,
      otterRepo: repos.otter,
      createOtter: uc.createOtter,
      settings: repos.settings,
      sendEntry: uc.sendEntry,
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
