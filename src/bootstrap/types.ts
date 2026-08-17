// R20260817arnt PR-A：组合根声明 port 接口而非 Sqlite 具体类——替换实现时类型不突变
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { OtterContextRepository } from "@usecases/otter/otter-context-repository";
import type { MemoryRepository } from "@usecases/memory/memory-repository";
import type { TerminologyRepository } from "@usecases/memory/terminology-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import type { ScheduledTaskRepository } from "@usecases/scheduled-task/scheduled-task-repository";
import type { ConnectionRepository } from "@usecases/im/connection-repository";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ManageMemory } from "@usecases/memory/manage-memory";
import type { ManageTerminology } from "@usecases/memory/manage-terminology";
import type { ScanDarkEntries } from "@usecases/memory/scan-dark-entries";
import type { SearchMemory } from "@usecases/memory/search-memory";
import type { CreateEdge } from "@usecases/memory/create-edge";
import type { GetRelated } from "@usecases/memory/get-related";
import type { DeleteEdge } from "@usecases/memory/delete-edge";
import type { GetDocProvenance } from "@usecases/memory/get-doc-provenance";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageReadState } from "@usecases/conversation/manage-read-state";
import type { ManageParticipant } from "@usecases/conversation/manage-participant";
import type { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { ManageContext } from "@usecases/otter/manage-context";
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
import type { ManageConnection } from "@usecases/im/manage-connection";

export interface Repositories {
  otter: OtterRepository;
  otterContext: OtterContextRepository;
  memory: MemoryRepository;
  terminology: TerminologyRepository;
  conversation: ConversationRepository;
  settings: SettingsRepository;
  feature: FeatureRepository;
  research: ResearchRepository;
  scheduledTask: ScheduledTaskRepository;
  connection: ConnectionRepository;
  healingEvent: HealingEventRepository;
}

export interface UseCases {
  manageConversation: ManageConversation;
  manageMemory: ManageMemory;
  manageTerminology: ManageTerminology;
  searchMemory: SearchMemory;
  scanDarkEntries: ScanDarkEntries;
  createEdge: CreateEdge;
  getRelated: GetRelated;
  deleteEdge: DeleteEdge;
  getDocProvenance: GetDocProvenance;
  sendMessage: SendMessage;
  queryMessage: QueryMessage;
  manageReadState: ManageReadState;
  manageParticipant: ManageParticipant;
  manageKeyInfo: ManageKeyInfo;
  queryOtter: QueryOtter;
  createOtter: CreateOtter;
  manageSession: ManageSession;
  dissolveOtter: DissolveOtter;
  manageContext: ManageContext;
  manageScheduledTask: ManageScheduledTask;
  manageConnection: ManageConnection;
}
