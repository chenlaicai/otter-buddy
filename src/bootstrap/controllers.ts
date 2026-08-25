import type { Context } from "hono";
import type { AppConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPool } from "@frameworks/llm/model-pool";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SettingsConfig } from "@interface-adapters/http/controllers/settings-controller";
import type { SchedulerService } from "@usecases/scheduler/scheduler-service";
import type { SimpleCronParser } from "@frameworks/scheduler/cron-parser";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { ProcessInboundRecruit } from "@usecases/recruiting/process-inbound-recruit";
import type { GetBridgeStatus } from "@usecases/recruiting/get-bridge-status";
import type { UseCases } from "./types";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { updateDefaultModelInYaml } from "@frameworks/config-service";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import { NodeFileSystem } from "@frameworks/file-system/node-file-system";
import { ConversationController } from "@interface-adapters/http/controllers/conversation-controller";
import { OtterController } from "@interface-adapters/http/controllers/otter-controller";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { MemoryController } from "@interface-adapters/http/controllers/memory-controller";
import { HealthController } from "@interface-adapters/http/controllers/health-controller";
import { InboundController } from "@interface-adapters/http/controllers/inbound-controller";
import { KeyInfoController } from "@interface-adapters/http/controllers/key-info-controller";
import { SettingsController } from "@interface-adapters/http/controllers/settings-controller";
import { ScheduledTaskController } from "@interface-adapters/http/controllers/scheduled-task-controller";
import { ConnectionController } from "@interface-adapters/http/controllers/connection-controller";
import { RhiController } from "@interface-adapters/http/controllers/rhi-controller";
import type { RhiScanWorker } from "@usecases/health/rhi-scan-worker";
import type { SignalRepository } from "@usecases/health/signal-repository";
import type { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";


/** 未配置 inbound 时的空实现，避免 as unknown as 双重断言 */
class NoopInboundController {
  optionsEvents(c: Context) { return c.body(null, 204); }
  receiveEvents(c: Context) { return c.json({ ok: false, error: "inbound not configured" }, 503); }
  getStatus(c: Context) { return c.json({ ok: false, error: "inbound not configured" }, 503); }
}

export interface ControllerDeps {
  uc: UseCases;
  agentInvoker: AgentInvoker;
  appConfig: AppConfig;
  modelPool: ModelPool;
  settingsRepo: SettingsRepository;
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
  /** F20260825rweb（#402）：RHI 面板 API 依赖（worker + 两个 repo） */
  rhiScanWorker: RhiScanWorker;
  signalRepo: SignalRepository;
  healthSnapshotRepo: HealthSnapshotRepository;
}

export function initControllers(deps: ControllerDeps, logger: Logger) {
  const { uc, agentInvoker, appConfig, modelPool, settingsRepo, schedulerService, cronParser, dispatchChainEngine, messageBroadcaster, featureRepo, researchRepo, embeddingGateway, processInboundRecruit, inboundApiKey, getBridgeStatus, rhiScanWorker, signalRepo, healthSnapshotRepo } = deps;

  const settings: SettingsConfig = {
    port: appConfig.server.port,
    dbPath: appConfig.db.path,
    embeddingModelPath: appConfig.embedding.modelPath,
    embeddingLocalModelPath: appConfig.embedding.localModelPath,
    embeddingDim: appConfig.embedding.dimensions,
  };

  const nodeFs = new NodeFileSystem();
  const rootDir = process.cwd();

  return {
    conversation: new ConversationController(uc.manageConversation, uc.manageParticipant, settingsRepo, logger),
    otter: new OtterController(uc.createOtter, uc.dissolveOtter, uc.manageSession, uc.queryOtter, logger),
    message: new MessageController(uc.sendMessage, uc.queryMessage, uc.manageReadState, agentInvoker, logger, uc.queryOtter, dispatchChainEngine, messageBroadcaster),
    memory: new MemoryController(uc.searchMemory, uc.manageMemory, uc.scanDarkEntries, embeddingGateway, logger),
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
  };
}
