import type { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import type { SqliteOtterContextRepository } from "@frameworks/db/otter/sqlite-otter-context-repository";
import type { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import type { SqliteTerminologyRepository } from "@frameworks/db/memory/sqlite-terminology-repository";
import type { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { SqliteSettingsRepository } from "@frameworks/db/settings/sqlite-settings-repository";
import type { SqliteFeatureRepository } from "@frameworks/db/document/sqlite-feature-repository";
import type { SqliteResearchRepository } from "@frameworks/db/document/sqlite-research-repository";
import type { SqliteScheduledTaskRepository } from "@frameworks/db/scheduled-task/sqlite-scheduled-task-repository";
import type { SqliteConnectionRepository } from "@frameworks/db/im/sqlite-connection-repository";
import type { SqliteHealingEventRepository } from "@frameworks/db/healing/sqlite-healing-event-repository";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ManageMemory } from "@usecases/memory/manage-memory";
import type { ManageTerminology } from "@usecases/memory/manage-terminology";
import type { ScanDarkEntries } from "@usecases/memory/scan-dark-entries";
import type { SearchMemory } from "@usecases/memory/search-memory";
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
  otter: SqliteOtterRepository;
  otterContext: SqliteOtterContextRepository;
  memory: SqliteMemoryRepository;
  terminology: SqliteTerminologyRepository;
  conversation: SqliteConversationRepository;
  settings: SqliteSettingsRepository;
  feature: SqliteFeatureRepository;
  research: SqliteResearchRepository;
  scheduledTask: SqliteScheduledTaskRepository;
  connection: SqliteConnectionRepository;
  healingEvent: SqliteHealingEventRepository;
}

export interface UseCases {
  manageConversation: ManageConversation;
  manageMemory: ManageMemory;
  manageTerminology: ManageTerminology;
  searchMemory: SearchMemory;
  scanDarkEntries: ScanDarkEntries;
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
