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
import { buildNarrativeSynthesisPrompt, assembleHandoffArchive, buildMechanicalArchive, NARRATIVE_SYNTHESIS_TIMEOUT_MS, synthesisFullBudgetChars } from "@frameworks/agent/narrative-synthesis-engine";
import { sliceSessionEntries, serializeKeptWindow, setSliceLogger } from "@frameworks/agent/session-slicer";
import { collectStateInventory, renderStateInventory } from "@frameworks/agent/state-inventory";
import { scanWorkspaceFiles, renderFileTrail } from "@frameworks/agent/file-trail-extractor";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { Repositories, UseCases } from "./types";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { createManageHealingEventsTool } from "@interface-adapters/agent-runtime/tools/healing-tools";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { SignalRouter } from "@usecases/conversation/signal-router";
import type { AssistantSessionManager } from "@usecases/im/assistant-session";
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
import { botKey } from "@frameworks/feishu/bot-key";
import { maskAppId } from "@frameworks/feishu/long-connection-client";
import { FeishuLongConnectionHandler } from "@interface-adapters/feishu/long-connection-handler";
import { FeishuMessageProcessor } from "@interface-adapters/feishu/message-processor";
import { CommandDispatcher } from "@interface-adapters/feishu/command-dispatcher";
import { PartnerResolver } from "@usecases/im/partner-resolver";
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
import { HEALING_CONVERSATION_KEY } from "@usecases/healing/constants";
import { ProcessInboundRecruit } from "@usecases/recruiting/process-inbound-recruit";
import { GetBridgeStatus } from "@usecases/recruiting/get-bridge-status";
import { ensureRecruitingConversation } from "@usecases/recruiting/ensure-recruiting-conversation";
import { ensureRecruitingScheduler } from "@usecases/recruiting/ensure-recruiting-scheduler";
import { resolveFeatureGates } from "./feature-gates";
import { buildHandoffPackage } from "@frameworks/agent/handoff-package-builder";

// F20260929fsqr（delta 检视严重 1）：FeishuBundle 随静态线退役删除（见 createFeishuBundle 注释）

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
  // F20260929kws1：切片观测锚接线（[keeprecent-slice] cut → 主日志；密度告警已随估算机制退役）
  setSliceLogger(fields => {
    logger.info('[keeprecent-slice] cut', fields);
  });
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
      const tools = createTools(ctx, repo, log, options.workspaceGateway, manageScheduledTaskRef ?? undefined);
      if (repo) tools.push(createManageHealingEventsTool(ctx, repo));
      return tools;
    },
    healingRepo: repos.healingEvent,
    signalRepo: repos.signalEvent,
    // F20261006mtlp P1：matters 仓库注入——list_matters/transition_matter 注册条件
    matterRepo: repos.matter,
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

export function createDispatchChainEngine(repos: Repositories, uc: UseCases, appConfig: AppConfig, logger: Logger, options?: { agentMetrics?: AgentMetricsPort; agentGateway?: PiSessionFactory; /** F20260928fsqr：渲染链 resolver 外置注入（全局实例——飞书扫码首号运行时写入 addPartnerId）；缺省内部构造（行为不变） */ partnerResolver?: PartnerResolver }): DispatchChainEngine {
  return new DispatchChainEngine({
    conversationRepo: repos.conversation,
    queryOtter: uc.queryOtter,
    logger,
    maxChainDepth: appConfig.circuitBreaker.maxChainDepth,
    settingsRepo: repos.settings,
    metrics: options?.agentMetrics,
    // F20260826fpbd：搭档身份静态判定。未配置时 PartnerResolver 降级（动态推断）
    // F20260928wxid：双渠道 ID——微信消息也经链引擎渲染历史，搭档需被认出（含微信 ilink_user_id）
    // F20260928fsqr：外置实例（扫码首号运行时写入）；缺省内部构造保持存量行为
    // F20261008fsrm：feishu 静态段移除，feishu 锚一律扫码首号（app.ts 全局 resolver）
    partnerResolver: options?.partnerResolver ?? new PartnerResolver(undefined, appConfig.weixin?.partnerUserId),
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
    // F20260920trrt：闲置预警新口径数据源（SQLite 实现提供；turn 刻度退役后接发言 seq 刻度）。
    // 可选方法（接口声明带?）：旧测试桩不实现也能装配，但接口类型带它们，直传即可
    idleStatsRepo: repos.conversation,
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
    // F20260923hsyn：按别名直查（合成模型覆盖场景）
    getContextWindowByAlias: (modelAlias: string): number | undefined => {
      return modelPool.getContextWindow(modelAlias);
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
    synthesisFullBudgetChars,
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
    // F20261006mtlp P1：matters 仓库——机械供料 handoff_open_matters 数据源
    o.repos.matter,
  );
}

export async function initAgentAndScheduler(options: { repos: Repositories; uc: UseCases; agentGateway: PiSessionFactory; messageBroadcaster: MessageBroadcaster | undefined; logger: Logger; workspaceGateway?: WorkspaceGateway; metrics?: SchedulerMetrics; agentMetrics?: AgentMetricsPort; dispatchChainEngine?: DispatchChainEngine; db?: Database.Database; appConfig?: AppConfig; modelPool?: ModelPool; otterConfigProvider?: OtterConfigProvider }) {
  const { repos, uc, agentGateway, messageBroadcaster, logger, workspaceGateway, metrics, agentMetrics, dispatchChainEngine, appConfig, modelPool, otterConfigProvider } = options;
  await agentGateway.warmup();

  // F20260920stkx：paper-trading 能力移除（选项 A）——原 PR4/PR5 装配块随能力整体退役。

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
      // F20261008hcpa（#1356 层3）：high 超龄升级提醒的推送目的地（healing 主对话）——
      // 懒解析：healing 对话由 ensureHealingConversation 异步引导创建，构造期 settings 未就绪
      healingConversationIdResolver: async () => {
        try {
          return await repos.settings.get(HEALING_CONVERSATION_KEY) ?? undefined;
        } catch {
          return undefined; // settings 不可达时静默降级：提醒丢一次，台账不丢
        }
      },
      metrics,
      dispatchChainEngine,
      modelPool,
    }),
  );

  return { agentInvoker, cronParser, schedulerService };
}

/** 控 max-lines-per-function：SchedulerServiceOptions 透传（initAgentAndScheduler 拆行） */
function buildSchedulerServiceOptions(o: SchedulerServiceOptions): SchedulerServiceOptions {
  return o;
}

/** issue #281：broadcaster 由 app.ts 无条件创建（平台无关总线），飞书出站作为 channel 注册 */
// F20260929fsqr（delta 检视严重 1）：createFeishuBundle/setupFeishu/FeishuBundle 随静态线退役删除
// （唯一调用方 app.ts 已移除；误复活风险与死代码一并清除）

/** F20260920imax：助理态注入片段（微信/飞书共用语义：总开关 + 助理线模型；setupFeishu/startWeixinChannels 双消费方） */
function buildAssistantInjections(appConfig: AppConfig, uc: UseCases): {
  assistantSession?: AssistantSessionManager;
  assistantModelAlias?: string;
} {
  return {
    // F20260918imas / F20260920imax：助理态（p2p 自动开户；对话永续）；总开关关闭时不注入（回退拒聊）
    ...(appConfig.im?.assistant?.enabled !== false && { assistantSession: uc.assistantSession }),
    // F20260920imax：助理线模型（自动开户的大獭用；缺省全局 default）
    ...(appConfig.im?.assistant?.modelAlias && { assistantModelAlias: appConfig.im.assistant.modelAlias }),
  };
}

// F20260929fsqr（delta 检视严重 1）：setupFeishu 已随静态线退役删除
// F20260929fsqr（delta 检视严重 1）：setupFeishu 随静态线退役删除——唯一调用方 app.ts 已移除；
// 装配语义由 buildFeishuRuntime 工厂统一承担（扫码线 feishu-scan.ts 全权持有）

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

/** F20260928fsqr：单 app 飞书运行时句柄（静态 config app 与扫码 apps 共用工厂产出） */
export interface FeishuRuntime {
  /** bot 锚键（feishu-bot:<掩码appId>）——provision/出站归属/状态投影三处同源 */
  botKey: string;
  tokenManager: FeishuAccessTokenManager;
  client: FeishuClient;
  agentDispatchService: AgentDispatchService;
  /** 停 WS 长连接（#460 dispose 链接入；同步停出站通道由调用方 unregister） */
  stop: () => void;
}

/**
 * F20260928fsqr：飞书单 app 运行时工厂（静态 config app 与扫码 apps 共用）。
 *
 * 吸收原 createFeishuBundle（client/tokenManager/出站注册）+ setupFeishu 装配段
 * （commandDispatcher/partnerResolver/messageProcessor/longConnection）两段。
 * 每条 WS 一套独立装配（D1）：token 域按 app 隔离是飞书机制，共享无收益有串扰。
 *
 * 出站键控（#591 同构）：通道按 botKey 注册/注销，FeishuMessageChannel 按
 * externalId === botKey 过滤归属——多 app 广播互不串扰。
 *
 * 命令门禁锚（D7 双层）：每线独立 resolver——`new PartnerResolver(线ownerOpenId, 首号ownerOpenId?)`；
 * 线主人自己线上可跑命令、首号（部署者）任意线上可跑、陌生人被拦。
 * （静态 config app 路径已随 F20261008fsrm 移除——锚一律来自扫码人/首号。）
 */
export function buildFeishuRuntime(options: {
  appId: string;
  appSecret: string;
  /** 命令门禁锚：线 owner（扫码人） */
  gateOwnerOpenId?: string;
  /** 命令门禁锚第二锚：全局首号（部署者；仅扫码线非首号时传） */
  globalFirstOwnerOpenId?: string;
  appConfig: AppConfig;
  uc: UseCases;
  repos: Repositories;
  agentInvoker: AgentInvoker;
  dispatchChainEngine: DispatchChainEngine;
  messageBroadcaster: MessageBroadcaster;
  logger: Logger;
  registry?: ChannelStatusRegistry;
  signalRouter?: SignalRouter;
  /** 出站/状态键前缀的注册名（缺省 = botKey；状态投影 kind 需要区分时传唯一名） */
  channelKey?: string;
}): FeishuRuntime | undefined {
  const { appId, appSecret, appConfig, uc, repos, agentInvoker, dispatchChainEngine, messageBroadcaster, logger, registry, signalRouter } = options;
  const key = botKey(appId);
  try {
    const feishuConfig = buildScanFeishuConfig(appId, appSecret, options.gateOwnerOpenId);
    const tokenManager = new FeishuAccessTokenManager(feishuConfig, logger);
    const client = new FeishuClient(feishuConfig, logger, tokenManager);

    const gateResolver = new PartnerResolver(options.gateOwnerOpenId, options.globalFirstOwnerOpenId);
    const agentDispatchService = new AgentDispatchService({
      dispatchChainEngine,
      entryRepo: repos.entry,
      agentInvokePort: agentInvoker,
      logger,
      ...(signalRouter && { signalRouter }),
    });

    const messageProcessor = buildScanFeishuProcessor({
      appConfig, uc, repos, logger, client, tokenManager,
      gateResolver, agentDispatchService, messageBroadcaster,
    });

    // 键控出站（#591 同构）：按 botKey 注册，FeishuMessageChannel 按 externalId===botKey 过滤。
    // 同 app 重扫（绑定已有 app 时真实发生）替换旧通道而非追加，#591 语义。
    // #902 媒体出站：attachmentDeps 注入（实体查询 + speak 补拉 + 存储根；不注降级纯占位投影）
    const channelKey = options.channelKey ?? key;
    messageBroadcaster.registerOutboundChannel(
      channelKey,
      new FeishuMessageChannel({
        manageConnection: uc.manageConnection, feishuGateway: client, logger,
        webBaseUrl: appConfig.web?.baseUrl, settingsRepo: repos.settings, botKey: key,
        attachmentDeps: {
          attachmentRepo: repos.attachment,
          entryReader: uc.sendEntry,
          storageRoot: appConfig.attachments?.storageRoot ?? "./data/attachments",
        },
      }),
    );

    return finishFeishuRuntime({ appId, key, channelKey, feishuConfig, tokenManager, client, agentDispatchService, messageProcessor, messageBroadcaster, logger, registry });
  } catch (err) {
    logger.error("Failed to build Feishu runtime", err instanceof Error ? err : undefined, { appId: maskAppId(appId) });
    return undefined;
  }
}

/** F20260928fsqr：WS 长连接启动 + stop 句柄拼装（拆出控 buildFeishuRuntime 行数；
 *  #460：stop 接入调用方 dispose 链，出站 unregister 同步成对做） */
function finishFeishuRuntime(o: {
  appId: string; key: string; channelKey: string; feishuConfig: FeishuConfig;
  tokenManager: FeishuAccessTokenManager; client: FeishuClient;
  agentDispatchService: AgentDispatchService; messageProcessor: FeishuMessageProcessor;
  messageBroadcaster: MessageBroadcaster; logger: Logger; registry?: ChannelStatusRegistry;
}): FeishuRuntime {
  const longConnectionClient = new FeishuLongConnectionClient(
    o.feishuConfig, o.logger, o.tokenManager, o.registry, o.channelKey,
  );
  const longConnectionHandler = new FeishuLongConnectionHandler({
    longConnectionGateway: longConnectionClient,
    messageProcessor: o.messageProcessor,
    logger: o.logger,
  });
  longConnectionHandler.start().then(() => {
    o.logger.info("Feishu long connection started", { appId: maskAppId(o.appId), channelKey: o.channelKey });
  }).catch((err) => {
    o.logger.error("Failed to start Feishu long connection", err instanceof Error ? err : undefined, { appId: maskAppId(o.appId) });
  });
  return {
    botKey: o.key,
    tokenManager: o.tokenManager,
    client: o.client,
    agentDispatchService: o.agentDispatchService,
    stop: () => {
      o.messageBroadcaster.unregisterOutboundChannel(o.channelKey);
      void longConnectionClient.stop().catch((err) =>
        o.logger.error("Feishu long connection stop failed", err instanceof Error ? err : undefined, { appId: maskAppId(o.appId) }));
    },
  };
}

/** F20260928fsqr：扫码 app 的 FeishuConfig 拼装（encryptKey 不适用——事件走 WS 无 webhook 加密） */
function buildScanFeishuConfig(appId: string, appSecret: string, gateOwnerOpenId?: string): FeishuConfig {
  return {
    appId,
    appSecret,
    ...(gateOwnerOpenId ? { partnerOpenId: gateOwnerOpenId } : {}),
  };
}

/** F20260928fsqr：扫码 app 的 messageProcessor 装配（拆出控 buildFeishuRuntime 行数；
 *  语义与存量 setupFeishu 原装配段一致——助理注入/附件三件套/门禁 resolver 全同构） */
function buildScanFeishuProcessor(o: {
  appConfig: AppConfig; uc: UseCases; repos: Repositories; logger: Logger;
  client: FeishuClient; tokenManager: FeishuAccessTokenManager;
  gateResolver: PartnerResolver; agentDispatchService: AgentDispatchService; messageBroadcaster: MessageBroadcaster;
}) {
  return new FeishuMessageProcessor({
    manageConnection: o.uc.manageConnection,
    ...(o.repos.connection && { connectionRepo: o.repos.connection }),
    ...buildAssistantInjections(o.appConfig, o.uc),
    sendEntry: o.uc.sendEntry,
    commandDispatcher: new CommandDispatcher(o.uc.manageConnection, o.repos.entry, o.client, o.logger),
    feishuGateway: o.client,
    feishuUserInfo: new FeishuUserInfoClient(o.tokenManager, o.logger),
    partnerResolver: o.gateResolver,
    feishuResource: new FeishuResourceClient(o.tokenManager, o.logger),
    attachmentUpload: o.uc.attachmentUpload,
    attachmentInjection: new AttachmentInjectionService({
      attachmentRepo: o.repos.attachment,
      storageRoot: o.appConfig.attachments?.storageRoot ?? "./data/attachments",
      logger: o.logger,
    }),
    agentDispatchService: o.agentDispatchService,
    messageBroadcaster: o.messageBroadcaster,
    logger: o.logger,
  });
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
      // 出站：广播总线注册（与飞书同模式；F20260913ctlv 删 attachmentRepo 死参数，
      // #902 媒体出站恢复：重注入附件依赖——实体查询 + speak 补拉 + 存储根）
      // #591：键控注册（"weixin-<accountId>"）——同账号重登录时替换旧通道而非追加，
      // 防止重复投递；停轮询/删账号时 unregisterOutboundChannel 成对清理
      messageBroadcaster.registerOutboundChannel(
        `weixin-${account.id}`,
        new WeixinMessageChannel(uc.manageConnection, gateway, uc.queryOtter, logger, appConfig.web?.baseUrl, repos.settings, {
          attachmentRepo: repos.attachment,
          entryReader: uc.sendEntry,
          storageRoot: appConfig.attachments?.storageRoot ?? "./data/attachments",
        }),
      );
      // ingress：入站处理器 + 轮询循环（媒体三项与飞书同构：注入服务与 controllers.ts 同一块装配）
      const attachmentInjection = new AttachmentInjectionService({
        attachmentRepo: repos.attachment,
        storageRoot: appConfig.attachments?.storageRoot ?? "./data/attachments",
        logger,
      });
      const processor = new WeixinMessageProcessor({
        manageConnection: uc.manageConnection,
        // F20260921wxba：入站路由锚 = bot 账号（与扫码建线同键，bot=对话统一模型）
        botAccountId: account.id,
        // F20260928wxid：建线人鉴定（检视发现 1）——仅 owner 消息盖自报称呼
        ownerIlinkUserId: account.ilinkUserId,
        // F20260918imas / F20260920imax：助理态（私聊自动开户；对话永续 + 8h 静默换 session）；语义同 setupFeishu
        ...buildAssistantInjections(appConfig, uc),
        // F20260913ctlv 收尾批2：微信消息唯一落点 = entries（与飞书同构）
        sendEntry: uc.sendEntry,
        entryRepo: repos.entry,
        weixinGateway: gateway,
        // F20260928wxid：保持单渠道锚（语义同飞书装配处——门禁只认本渠道搭档锚，防 configured 误翻锁死命令）
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
