import type { Context } from "hono";
import type { AppConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPool } from "@frameworks/llm/model-pool";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SettingsConfig } from "@interface-adapters/http/controllers/settings-controller";
import type { SchedulerService } from "@usecases/scheduler/scheduler-service";
import type { SimpleCronParser } from "@frameworks/scheduler/cron-parser";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { SignalRouter } from "@usecases/conversation/signal-router";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { QueryOtterProfile } from "@usecases/otter/query-otter-profile";
import type { ProcessInboundRecruit } from "@usecases/recruiting/process-inbound-recruit";
import type { GetBridgeStatus } from "@usecases/recruiting/get-bridge-status";
import type { UseCases, Repositories } from "./types";
import type { AttachmentRepository } from "@usecases/conversation/attachment-repository";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { updateDefaultModelInYaml } from "@frameworks/config-service";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import { NodeFileSystem } from "@frameworks/file-system/node-file-system";
/** 多模态 Phase 1（审视修复 R4/R7）：注入服务（usecases 层策略） */
import { AttachmentInjectionService } from "@usecases/conversation/attachment-injection-service";
import { ConversationController } from "@interface-adapters/http/controllers/conversation-controller";
import { OtterController } from "@interface-adapters/http/controllers/otter-controller";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { MemoryController } from "@interface-adapters/http/controllers/memory-controller";
import { SkillController, type SkillDirectory } from "@interface-adapters/http/controllers/skill-controller";
import { HealthController } from "@interface-adapters/http/controllers/health-controller";
import { InboundController } from "@interface-adapters/http/controllers/inbound-controller";
import { KeyInfoController } from "@interface-adapters/http/controllers/key-info-controller";
import { SettingsController } from "@interface-adapters/http/controllers/settings-controller";
import { ScheduledTaskController } from "@interface-adapters/http/controllers/scheduled-task-controller";
import { ConnectionController } from "@interface-adapters/http/controllers/connection-controller";
import { RhiController } from "@interface-adapters/http/controllers/rhi-controller";
import { AttachmentController } from "@interface-adapters/http/controllers/attachment-controller";
import { WorkspaceController } from "@interface-adapters/http/controllers/workspace-controller";
import { WeixinConnectionController } from "@interface-adapters/http/controllers/weixin-connection-controller";
import type { WeixinLoginSessionPort, WeixinAccountStorePort } from "@interface-adapters/http/controllers/weixin-connection-controller";
import { ChannelController } from "@interface-adapters/http/controllers/channel-controller";
import type { ChannelStatusRegistry } from "@usecases/channel/channel-status";
import type { RhiScanWorker } from "@usecases/health/rhi-scan-worker";
import type { SignalRepository } from "@usecases/health/signal-repository";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import type { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";


/** 未配置 inbound 时的空实现，避免 as unknown as 双重断言 */
class NoopInboundController {
  optionsEvents(c: Context) { return c.body(null, 204); }
  receiveEvents(c: Context) { return c.json({ ok: false, error: "inbound not configured" }, 503); }
  getStatus(c: Context) { return c.json({ ok: false, error: "inbound not configured" }, 503); }
}

export interface ControllerDeps {
  uc: UseCases;
  repos: Repositories;
  agentInvoker: AgentInvoker;
  appConfig: AppConfig;
  modelPool: ModelPool;
  settingsRepo: SettingsRepository;
  /** Otter 配置提供方（读 modelAlias 注入 OtterDTO） */
  otterConfigProvider: OtterConfigProvider;
  schedulerService: SchedulerService;
  cronParser: SimpleCronParser;
  dispatchChainEngine: DispatchChainEngine;
  messageBroadcaster?: MessageBroadcaster;
  featureRepo: FeatureRepository;
  researchRepo: ResearchRepository;
  embeddingGateway: EmbeddingGateway;
  processInboundRecruit?: ProcessInboundRecruit;
  inboundApiKey?: string;
  getBridgeStatus?: GetBridgeStatus;
  /** PR-2：面板 profile 聚合端点 */
  queryOtterProfile?: QueryOtterProfile;
  /** F20260825rweb（#402）：RHI 面板 API 依赖（worker + 两个 repo） */
  rhiScanWorker: RhiScanWorker;
  signalRepo: SignalRepository;
  healthSnapshotRepo: HealthSnapshotRepository;
  /** F20260826mwrd C4：消息徽章数据源（signal_events 表，与 RHI 的 health 语义池区分） */
  signalEventRepo: SignalEventRepository;
  /** 多模态 Phase 1：附件 repo（message-controller vision 读图 + attachment-controller 文件流） */
  attachmentRepo?: AttachmentRepository;
  attachmentStorageRoot?: string;
  /** 微信连接管理（issue #566）：登录会话管理 + 账号 store */
  weixinLoginSessions?: WeixinLoginSessionPort;
  weixinAccountStore?: WeixinAccountStorePort;
  onWeixinAccountDeleted?: (accountId: string) => void;
  /** 通道状态注册表（F20260901chun：统一 IM 页 + 真实健康状态） */
  registry?: ChannelStatusRegistry;
  /** F20260901sgpv P1：信号路由器（主入口调度收敛；未注入时 MC/ADS/RIS 降级直连链） */
  signalRouter?: SignalRouter;
  /** #576（F20260901emps）：能力库页面数据源（ResourceLoader 适配器）；缺省时路由返回 503 */
  skillDirectory?: SkillDirectory;
}

function buildChannelController(deps: ControllerDeps) {
  if (!deps.registry) return undefined;
  return new ChannelController(deps.registry, deps.weixinAccountStore);
}

function buildAttachmentInjection(deps: ControllerDeps, appConfig: AppConfig, repos: Repositories, logger: Logger) {
  return new AttachmentInjectionService({
    attachmentRepo: deps.attachmentRepo ?? repos.attachment,
    storageRoot: deps.attachmentStorageRoot ?? appConfig.attachments?.storageRoot ?? "./data/attachments",
    logger,
  });
}

export function initControllers(deps: ControllerDeps, logger: Logger) {
  const { uc, repos, agentInvoker, appConfig, modelPool, settingsRepo, otterConfigProvider, schedulerService, cronParser, dispatchChainEngine, messageBroadcaster, featureRepo, researchRepo, embeddingGateway, processInboundRecruit, inboundApiKey, getBridgeStatus, rhiScanWorker, signalRepo, healthSnapshotRepo, signalEventRepo, signalRouter } = deps;

  /** issue #566：微信连接控制器（端口注入；拆出降 initControllers 复杂度） */
  const buildWeixinController = () =>
    deps.weixinLoginSessions && deps.weixinAccountStore
      ? new WeixinConnectionController({
          loginSessions: deps.weixinLoginSessions,
          accountStore: deps.weixinAccountStore,
          onAccountDeleted: deps.onWeixinAccountDeleted,
          logger,
        })
      : undefined;

  const settings: SettingsConfig = {
    port: appConfig.server.port,
    dbPath: appConfig.db.path,
    embeddingModelPath: appConfig.embedding.modelPath,
    embeddingLocalModelPath: appConfig.embedding.localModelPath,
    embeddingDim: appConfig.embedding.dimensions,
  };
  const nodeFs = new NodeFileSystem();
  const rootDir = process.cwd();

  /** 多模态 Phase 1（审视修复 R4/R7）：附件注入服务——校验+真图+document 文本组装均在此（usecases 层策略） */
  const attachmentInjection = buildAttachmentInjection(deps, appConfig, repos, logger);

  return {
    conversation: new ConversationController(uc.manageConversation, uc.manageParticipant, settingsRepo, logger),
    otter: new OtterController(uc.createOtter, uc.dissolveOtter, uc.manageSession, uc.queryOtter, logger, otterConfigProvider, deps.queryOtterProfile, modelPool),
    message: new MessageController(
      uc.sendMessage, uc.queryMessage, uc.manageReadState, agentInvoker, logger, uc.queryOtter,
      dispatchChainEngine, messageBroadcaster,
      signalEventRepo,
      attachmentInjection,
      signalRouter,
    ),
    memory: new MemoryController(uc.searchMemory, uc.manageMemory, uc.scanDarkEntries, embeddingGateway, { repo: repos.memory, logger }),
    keyInfo: new KeyInfoController(uc.manageKeyInfo, logger),
    settings: new SettingsController(settings, settingsRepo, modelPool, logger, updateDefaultModelInYaml),
    scheduledTask: new ScheduledTaskController(uc.manageScheduledTask, schedulerService, cronParser, logger),
    connection: new ConnectionController(uc.manageConnection, logger),
    health: new HealthController(featureRepo, researchRepo, embeddingGateway, nodeFs, rootDir, logger),
    rhi: new RhiController(healthSnapshotRepo, signalRepo, rhiScanWorker, logger),
    inbound: processInboundRecruit && inboundApiKey
      ? new InboundController(
          inboundApiKey,
          processInboundRecruit,
          getBridgeStatus,
          logger,
        )
      : new NoopInboundController(),
    // 多模态 Phase 1：附件端点（上传 + 文件流）。storageRoot 缺省 ./data/attachments；
    // 审视修复 R10：上传时校验会话存在（隔离语义）
    // D1 修复：fallback repos.attachment（与上方 MessageController 同模式）——
    // 此前硬性 `deps.attachmentRepo &&` 条件在装配根未显式传参时恒 false，附件路由生产 404
    attachment: new AttachmentController(
      uc.attachmentUpload,
      deps.attachmentRepo ?? repos.attachment,
      deps.attachmentStorageRoot ?? appConfig.attachments?.storageRoot ?? "./data/attachments",
      logger,
      repos.conversation,
    ),
    // 工作区文件浏览（只读）——manageWorkspace 可选注入
    workspace: uc.manageWorkspace ? new WorkspaceController(uc.manageWorkspace, logger) : undefined,
    // 微信连接管理（issue #566）——登录会话管理器注入时挂载
    weixin: buildWeixinController(),
    // 通道状态聚合端点（F20260901chun：统一 IM 页 + 真实健康状态）
    channel: buildChannelController(deps),
    // #576（F20260901emps）：能力库真数据源。测试环境（无 ResourceLoader）可省略，路由层优雅降级
    skills: deps.skillDirectory ? new SkillController(deps.skillDirectory, logger) : undefined,
  };
}
