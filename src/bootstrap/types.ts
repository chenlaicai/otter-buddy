// R20260817arnt PR-A：组合根声明 port 接口而非 Sqlite 具体类——替换实现时类型不突变
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { OtterContextRepository } from "@usecases/otter/otter-context-repository";
import type { MemoryRepository } from "@usecases/memory/memory-repository";
import type { MemoryReader } from "@usecases/memory/memory-reader";
import type { MemoryWriter } from "@usecases/memory/memory-writer";
import type { MemoryQueue } from "@usecases/memory/memory-queue";
import type { SearchQueryLogRepository } from "@usecases/memory/search-query-log-repository";
import type { RecordSearchQuery } from "@usecases/memory/record-search-query";
import type { TerminologyRepository } from "@usecases/memory/terminology-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import type { ScheduledTaskRepository } from "@usecases/scheduled-task/scheduled-task-repository";
import type { ConnectionRepository } from "@usecases/im/connection-repository";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import type { AttachmentRepository } from "@usecases/conversation/attachment-repository";
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
import type { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";

export interface Repositories {
  otter: OtterRepository;
  otterContext: OtterContextRepository;
  /** @deprecated 使用 memoryReader / memoryWriter / memoryQueue 窄接口 */
  memory: MemoryRepository;
  memoryReader: MemoryReader;
  memoryWriter: MemoryWriter;
  memoryQueue: MemoryQueue;
  /** F20260826rcmm Phase 0：检索埋点（评估基线数据源） */
  searchQueryLog: SearchQueryLogRepository;
  terminology: TerminologyRepository;
  conversation: ConversationRepository;
  settings: SettingsRepository;
  feature: FeatureRepository;
  research: ResearchRepository;
  scheduledTask: ScheduledTaskRepository;
  connection: ConnectionRepository;
  healingEvent: HealingEventRepository;
  /** F20260826mwrd C1：獭间结构化信号台账（halt 落账；C2 objection/blocked） */
  signalEvent: SignalEventRepository;
  /** 多模态 Phase 1：附件 repo（上传管线 + 消息组装共用） */
  attachment: AttachmentRepository;
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
  /** F20260826rcmm Phase 0：检索埋点（评估基线数据源） */
  recordSearchQuery: RecordSearchQuery;
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
  /** 多模态 Phase 1：附件上传服务 */
  attachmentUpload: AttachmentUploadService;
}
