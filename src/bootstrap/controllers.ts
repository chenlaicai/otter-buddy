import type { Context } from "hono";
import type { PinoLogger } from "@frameworks/logger";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SettingsConfig } from "@interface-adapters/http/controllers/settings-controller";
import type { SchedulerService } from "@usecases/scheduler/scheduler-service";
import type { SimpleCronParser } from "@frameworks/scheduler/cron-parser";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { NodeFileSystem } from "@frameworks/file-system/node-file-system";
import type { ProcessInboundRecruit } from "@usecases/recruiting/process-inbound-recruit";
import type { GetBridgeStatus } from "@usecases/recruiting/get-bridge-status";
import type { UseCases } from "./types";
import type { SqliteSettingsRepository } from "@frameworks/db/settings/sqlite-settings-repository";
import type { SqliteFeatureRepository } from "@frameworks/db/document/sqlite-feature-repository";
import type { SqliteResearchRepository } from "@frameworks/db/document/sqlite-research-repository";
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

export interface ControllerDeps {
  uc: UseCases;
  agentInvoker: AgentInvoker;
  settings: SettingsConfig;
  settingsRepo: SqliteSettingsRepository;
  schedulerService: SchedulerService;
  cronParser: SimpleCronParser;
  dispatchChainEngine: DispatchChainEngine;
  messageBroadcaster?: MessageBroadcaster;
  featureRepo: SqliteFeatureRepository;
  researchRepo: SqliteResearchRepository;
  embeddingGateway: EmbeddingGateway;
  fs: NodeFileSystem;
  rootDir: string;
  processInboundRecruit?: ProcessInboundRecruit;
  inboundApiKey?: string;
  getBridgeStatus?: GetBridgeStatus;
}

export function initControllers(deps: ControllerDeps, logger: PinoLogger) {
  return {
    conversation: new ConversationController(deps.uc.manageConversation, deps.uc.manageParticipant, deps.settingsRepo, logger),
    otter: new OtterController(deps.uc.createOtter, deps.uc.dissolveOtter, deps.uc.manageSession, deps.uc.queryOtter, logger),
    message: new MessageController(deps.uc.sendMessage, deps.uc.queryMessage, deps.uc.manageReadState, deps.agentInvoker, logger, deps.uc.queryOtter, deps.dispatchChainEngine, deps.messageBroadcaster),
    memory: new MemoryController(deps.uc.searchMemory, deps.uc.manageMemory, deps.embeddingGateway, logger),
    keyInfo: new KeyInfoController(deps.uc.manageKeyInfo, logger),
    settings: new SettingsController(deps.settings, deps.settingsRepo, logger),
    scheduledTask: new ScheduledTaskController(deps.uc.manageScheduledTask, deps.schedulerService, deps.cronParser, logger),
    connection: new ConnectionController(deps.uc.manageConnection, logger),
    health: new HealthController(deps.featureRepo, deps.researchRepo, deps.embeddingGateway, deps.fs, deps.rootDir, logger),
    inbound: deps.processInboundRecruit && deps.inboundApiKey
      ? new InboundController(
          deps.inboundApiKey,
          deps.processInboundRecruit,
          deps.getBridgeStatus,
          logger,
        )
      : ({
          optionsEvents: (c: Context) => c.body(null, 204),
          receiveEvents: (c: Context) => c.json({ ok: false, error: "inbound not configured" }, 503),
          getStatus: (c: Context) => c.json({ ok: false, error: "inbound not configured" }, 503),
        } as unknown as InboundController),
  };
}
