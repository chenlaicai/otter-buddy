import type Database from "better-sqlite3";
import type { Repositories } from "./types";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterContextRepository } from "@frameworks/db/otter/sqlite-otter-context-repository";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SqliteSearchQueryLogRepository } from "@frameworks/db/memory/sqlite-search-query-log-repository";
import { SqliteTerminologyRepository } from "@frameworks/db/memory/sqlite-terminology-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteSettingsRepository } from "@frameworks/db/settings/sqlite-settings-repository";
import { SqliteFeatureRepository } from "@frameworks/db/document/sqlite-feature-repository";
import { SqliteResearchRepository } from "@frameworks/db/document/sqlite-research-repository";
import { SqliteScheduledTaskRepository } from "@frameworks/db/scheduled-task/sqlite-scheduled-task-repository";
import { SqliteConnectionRepository } from "@frameworks/db/im/sqlite-connection-repository";
import { SqliteHealingEventRepository } from "@frameworks/db/healing/sqlite-healing-event-repository";
import { SqliteSignalEventRepository } from "@frameworks/db/signal/sqlite-signal-repository";
import { SqliteAttachmentRepository } from "@frameworks/db/attachment/sqlite-attachment-repository";

export function initRepositories(db: Database.Database): Repositories {
  const memoryRepo = new SqliteMemoryRepository(db);
  return {
    otter: new SqliteOtterRepository(db),
    otterContext: new SqliteOtterContextRepository(db),
    memory: memoryRepo,
    memoryReader: memoryRepo,
    memoryWriter: memoryRepo,
    memoryQueue: memoryRepo,
    searchQueryLog: new SqliteSearchQueryLogRepository(db),
    terminology: new SqliteTerminologyRepository(db),
    conversation: new SqliteConversationRepository(db),
    settings: new SqliteSettingsRepository(db),
    feature: new SqliteFeatureRepository(db),
    research: new SqliteResearchRepository(db),
    scheduledTask: new SqliteScheduledTaskRepository(db),
    connection: new SqliteConnectionRepository(db),
    healingEvent: new SqliteHealingEventRepository(db),
    signalEvent: new SqliteSignalEventRepository(db),
    /** 多模态 Phase 1：附件 repo */
    attachment: new SqliteAttachmentRepository(db),
  };
}
