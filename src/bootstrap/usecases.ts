import type { AppConfig } from "@frameworks/config";
import { ScanDarkEntries } from "@usecases/memory/scan-dark-entries";
import type { Logger } from "@usecases/ports/logger";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { Repositories, UseCases } from "./types";
import { SearchEngine } from "@usecases/memory/search-engine";
import { ManageMemory } from "@usecases/memory/manage-memory";
import { ManageTerminology } from "@usecases/memory/manage-terminology";
import { SearchMemory } from "@usecases/memory/search-memory";
import { CreateEdge } from "@usecases/memory/create-edge";
import { GetRelated } from "@usecases/memory/get-related";
import { DeleteEdge } from "@usecases/memory/delete-edge";
import { GetDocProvenance } from "@usecases/memory/get-doc-provenance";
import { SendMessage } from "@usecases/conversation/send-message";
import { QueryMessage } from "@usecases/conversation/query-message";
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

export interface UseCaseDeps {
  repos: Repositories;
  agentGateway: PiSessionFactory;
  embeddingService: EmbeddingGateway;
  memoryIndex: MemoryIndexGateway;
  appConfig: AppConfig;
  logger: Logger;
  workspaceGateway?: WorkspaceGateway;
}

export function initUseCases(deps: UseCaseDeps): UseCases {
  const { repos, agentGateway, embeddingService, memoryIndex, appConfig, logger, workspaceGateway } = deps;
  const searchEngine = new SearchEngine(appConfig.memory);
  const manageMemory = new ManageMemory(repos.memory);
  const manageTerminology = new ManageTerminology(repos.terminology);
  const scanDarkEntries = new ScanDarkEntries(repos.memory, logger);
  const searchMemory = new SearchMemory(repos.memory, embeddingService, searchEngine, logger, repos.terminology);
  // F20260813mren: 记忆关系层 use cases
  const createEdge = new CreateEdge(repos.memory, logger);
  const getRelated = new GetRelated(repos.memory);
  const deleteEdge = new DeleteEdge(repos.memory);
  const getDocProvenance = new GetDocProvenance(repos.memory, repos.feature, repos.research);
  const sendMessage = new SendMessage(repos.conversation, repos.otter, memoryIndex, logger);
  const queryMessage = new QueryMessage(repos.conversation);
  const manageReadState = new ManageReadState(repos.conversation);
  const manageParticipant = new ManageParticipant(repos.conversation, repos.otter);
  const manageKeyInfo = new ManageKeyInfo(repos.conversation, memoryIndex);
  const queryOtter = new QueryOtter(repos.otter);
  const createOtter = new CreateOtter(repos.otter, agentGateway, logger);
  const manageConversation = new ManageConversation(repos.conversation, createOtter, workspaceGateway);
  const manageSession = new ManageSession(
    repos.otter, agentGateway, manageConversation, manageMemory, logger,
  );
  const dissolveOtter = new DissolveOtter(repos.otter, agentGateway, manageSession);
  const manageContext = new ManageContext(repos.otterContext);
  const manageScheduledTask = new ManageScheduledTask(repos.scheduledTask);
  const manageConnection = new ManageConnection(repos.connection, repos.conversation, logger);
  return {
    manageConversation, manageMemory, manageTerminology, searchMemory, scanDarkEntries,
    sendMessage, queryMessage, manageReadState, manageParticipant, manageKeyInfo,
    queryOtter, createOtter, manageSession, dissolveOtter, manageContext,
    manageScheduledTask, manageConnection,
    createEdge, getRelated, deleteEdge, getDocProvenance,
  };
}
