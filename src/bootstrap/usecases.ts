import type { AppConfig } from "@frameworks/config";
import { ScanDarkEntries } from "@usecases/memory/scan-dark-entries";
import type { Logger } from "@usecases/ports/logger";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import type { Repositories, UseCases } from "./types";
import { buildResolveTargetsDeps } from "@usecases/conversation/resolve-send-targets";
import { SearchEngine } from "@usecases/memory/search-engine";
import { ManageMemory } from "@usecases/memory/manage-memory";
import { ManageTerminology } from "@usecases/memory/manage-terminology";
import { SearchMemory } from "@usecases/memory/search-memory";
import { CreateEdge } from "@usecases/memory/create-edge";
import { GetRelated } from "@usecases/memory/get-related";
import { DeleteEdge } from "@usecases/memory/delete-edge";
import { GetDocProvenance } from "@usecases/memory/get-doc-provenance";
import { QueryMessage } from "@usecases/conversation/query-message";
import { RecordSearchQuery } from "@usecases/memory/record-search-query";
import { ManageReadState } from "@usecases/conversation/manage-read-state";

import { ManageParticipant } from "@usecases/conversation/manage-participant";
import { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import { QueryOtter } from "@usecases/otter/query-otter";
import { CreateOtter } from "@usecases/otter/create-otter";
import { ManageConversation } from "@usecases/conversation/manage-conversation";
import { ManageSession } from "@usecases/otter/manage-session";
import { DissolveOtter } from "@usecases/otter/dissolve-otter";
import { ManageContext } from "@usecases/otter/manage-context";
import { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import { ManageConnection } from "@usecases/im/manage-connection";
import { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";
import { ManageWorkspace } from "@usecases/conversation/manage-workspace";
import { SendEntry } from "@usecases/conversation/send-entry";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";

export interface UseCaseDeps {
  repos: Repositories;
  entryRepo: EntryRepository;
  invokeRepo: InvokeRepository;
  agentGateway: PiSessionFactory;
  embeddingService: EmbeddingGateway;
  memoryIndex: MemoryIndexGateway;
  appConfig: AppConfig;
  logger: Logger;
  workspaceGateway?: WorkspaceGateway;
  /** Otter 配置提供方（ManageParticipant 读 modelAlias 注入 ParticipantDTO） */
  otterConfigProvider?: OtterConfigProvider;
  /** F20260908efmd: 模型池（有效模型解析 / session 快照 / restart 切模型）。未注入时 T1/T2/T3 降级 */
  modelPool?: ModelPoolLike;
}

export function initUseCases(deps: UseCaseDeps): UseCases {
  const { repos, entryRepo, invokeRepo, agentGateway, embeddingService, memoryIndex, appConfig, logger, workspaceGateway, otterConfigProvider, modelPool } = deps;
  const memoryUcs = buildMemoryUseCases(repos, embeddingService, appConfig, logger);
  const { searchMemory, createEdge, getRelated, deleteEdge, getDocProvenance, manageMemory, manageTerminology, scanDarkEntries } = memoryUcs;
  // F20260913ctlv 彻底切换：未读状态读 entries
  const queryMessage = new QueryMessage(repos.conversation, entryRepo);
  // F20260826rcmm Phase 0：检索埋点（评估基线数据源）
  // F20260913ctlv 收尾批3：上下文快照数据源切 entries
  const recordSearchQuery = new RecordSearchQuery(repos.searchQueryLog, entryRepo, logger);
  const manageReadState = new ManageReadState(repos.conversation, entryRepo);
  // 信号轨迹查询退役（F20260908rlcp）
  const manageParticipant = new ManageParticipant(
    repos.conversation, repos.otter,
    // F20260913ctlv 批4c：进场/退场 system entry（必注入）
    { entryRepo, invokeRepo },
    otterConfigProvider, modelPool,
  );
  const manageKeyInfo = new ManageKeyInfo(repos.conversation, memoryIndex);
  const queryOtter = new QueryOtter(repos.otter);
  // F20260908efmd: 注入 configProvider + modelPool，首世建账快照有效模型
  const createOtter = new CreateOtter(repos.otter, agentGateway, logger, otterConfigProvider, modelPool);
  const manageConversation = new ManageConversation(repos.conversation, createOtter, workspaceGateway);
  // F20260908efmd: 注入 configProvider + modelPool，createSession/restartSession 快照有效模型
  const manageSession = new ManageSession(
    repos.otter, agentGateway, manageConversation, manageMemory, logger, otterConfigProvider, modelPool,
  );
  const dissolveOtter = new DissolveOtter(repos.otter, agentGateway, manageSession, {
    // F20260908rlcp：台账退役——dissolve 清账不再需要
    logger,
  });
  const manageContext = new ManageContext(repos.otterContext);
  const manageScheduledTask = new ManageScheduledTask(repos.scheduledTask);
  const manageConnection = new ManageConnection(repos.connection, repos.conversation, logger);
  // 多模态 Phase 1：附件上传服务（storageRoot 等来自 config.attachments）
  const attachmentUpload = buildAttachmentUploadService(repos, appConfig, logger);
  // 工作区文件浏览（只读）——workspaceGateway 可选注入
  const manageWorkspace = workspaceGateway ? new ManageWorkspace(workspaceGateway, logger) : undefined;
  // F20260913ctlv 彻底切换：目标解析依赖（默认派发数据源 = entries.speak + invokes running）
  const resolveDeps = buildResolveTargetsDeps(
    (conversationId) => repos.conversation.getActiveParticipants(conversationId),
    entryRepo,
    repos.otter,
    invokeRepo,
  );
  const sendEntry = new SendEntry(entryRepo, invokeRepo, repos.otter, repos.conversation, { logger, resolveDeps });
  return {
    manageConversation, manageMemory, manageTerminology, searchMemory, scanDarkEntries,
    queryMessage, manageReadState, manageParticipant, manageKeyInfo, recordSearchQuery,
    // querySignalTrail 退役（F20260908rlcp）
    queryOtter, createOtter, manageSession, dissolveOtter, manageContext,
    manageScheduledTask, manageConnection,
    createEdge, getRelated, deleteEdge, getDocProvenance,
    attachmentUpload,
    manageWorkspace,
    sendEntry,
  };
}

/** 多模态 Phase 1：附件上传服务工厂（config.attachments 缺省值内置） */
function buildAttachmentUploadService(
  repos: Repositories,
  appConfig: UseCaseDeps["appConfig"],
  logger: Logger,
): AttachmentUploadService {
  return new AttachmentUploadService(
    repos.attachment,
    {
      storageRoot: appConfig.attachments?.storageRoot ?? "./data/attachments",
      maxImageBytes: appConfig.attachments?.maxImageBytes ?? 10 * 1024 * 1024,
      maxDocumentBytes: appConfig.attachments?.maxDocumentBytes ?? 20 * 1024 * 1024,
    },
    logger,
  );
}

/** 记忆域 use cases 构造（自 initUseCases 拆出，控语句数） */
function buildMemoryUseCases(
  repos: Repositories,
  embeddingService: UseCaseDeps["embeddingService"],
  appConfig: UseCaseDeps["appConfig"],
  logger: Logger,
) {
  const searchEngine = new SearchEngine(appConfig.memory);
  const manageMemory = new ManageMemory(repos.memoryReader, repos.memoryWriter);
  const manageTerminology = new ManageTerminology(repos.terminology);
  const scanDarkEntries = new ScanDarkEntries(repos.memoryReader, logger);
  const searchMemory = new SearchMemory(repos.memoryReader, repos.memoryWriter, embeddingService, searchEngine, logger, repos.terminology);
  // F20260813mren: 记忆关系层 use cases
  const createEdge = new CreateEdge(repos.memoryReader, repos.memoryWriter, logger);
  const getRelated = new GetRelated(repos.memoryReader);
  const deleteEdge = new DeleteEdge(repos.memoryWriter);
  const getDocProvenance = new GetDocProvenance(repos.memoryReader, repos.feature, repos.research);
  return { searchMemory, createEdge, getRelated, deleteEdge, getDocProvenance, manageMemory, manageTerminology, scanDarkEntries };
}
