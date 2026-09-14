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
import { SignalRepository } from "@usecases/health/signal-repository";
import { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";
import { SqliteAttachmentRepository } from "@frameworks/db/attachment/sqlite-attachment-repository";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";

import type { Logger } from "@usecases/ports/logger";

export function initRepositories(db: Database.Database, logger?: Logger): Repositories {
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
    conversation: new SqliteConversationRepository(db, logger),
    settings: new SqliteSettingsRepository(db),
    feature: new SqliteFeatureRepository(db),
    research: new SqliteResearchRepository(db),
    scheduledTask: new SqliteScheduledTaskRepository(db),
    connection: new SqliteConnectionRepository(db),
    healingEvent: new SqliteHealingEventRepository(db),
    signalEvent: new SqliteSignalEventRepository(db),
    /** RHI 健康池两 repo（issue #447）：此前 app.ts 4 处直实例化，绕过注册惯例 */
    rhiSignal: new SignalRepository(db),
    healthSnapshot: new HealthSnapshotRepository(db),
    /** F20260908rlcp：派发台账退役 */
    // dispatchAttempt: new SqliteDispatchAttemptRepo(db),
    /** 多模态 Phase 1：附件 repo */
    attachment: new SqliteAttachmentRepository(db),
    /** F20260913ctlv：条目仓库（取代 messages + message_segments） */
    entry: new SqliteEntryRepository(db),
    /** F20260913ctlv：invoke 生命周期仓库 */
    invoke: new SqliteInvokeRepository(db),
  };
}
