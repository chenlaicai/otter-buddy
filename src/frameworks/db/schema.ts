/* eslint-disable max-lines -- 合并 main 分支 healing events 表定义后行数增加 */
import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";

/**
 * 初始化全部 Schema（幂等，可重复调用）。
 * 所有 CREATE 使用 IF NOT EXISTS，禁止 ALTER TABLE。单事务内执行。
 */
// eslint-disable-next-line max-statements -- 多表初始化，语句数由表数量决定
export function initSchema(db: Database.Database, logger?: Logger): void {
  const startTime = Date.now();
  db.exec("BEGIN");

  try {
    createConversationTables(db);
    createMemoryTables(db);
    createTerminologyTables(db);
    createConversationInfoTables(db);
    createOtterTables(db);
    createTurnTables(db);
    createParticipantTables(db);
    createAgentSessionsTable(db);
    createSettingsTable(db);
    createOtterContextTable(db);
    createMessagesFtsTable(db);
    createDocumentTables(db);
    createScheduledTaskTables(db);
    createConnectionTables(db);
    createHealingEventTables(db);
    createUserReadStateTable(db);
    createHealthSnapshotsTable(db);
    createSignalsTable(db);
    createSignalEventsTable(db);
    createRestartPendingResumesTable(db);

    db.exec("COMMIT");

    // 记录 Schema 初始化完成日志
    if (logger) {
      const duration = Date.now() - startTime;
      // 29 regular tables + 5 virtual tables (FTS/vec) = 34 total
      logger.info('Schema initialized', {
        duration,
        tables: 34,
      });
    }
  } catch (error) {
    db.exec("ROLLBACK");

    // 记录 Schema 初始化失败日志
    if (logger) {
      logger.error('Schema initialization failed', error instanceof Error ? error : undefined);
    }

    throw error;
  }
}

/** 对话上下文：conversations + messages + message_events + conversation_otters */
function createConversationTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      workspace_dir TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
  `);

  createMessageTables(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_otters (
      conversation_id TEXT NOT NULL,
      otter_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, otter_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (otter_id) REFERENCES otters(id)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_otters_otter_id ON conversation_otters(otter_id);
  `);
}

/** 消息表：messages + message_events */
function createMessageTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      sequence_num INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      talking_stone_passed_to TEXT,
      context_tokens INTEGER,
      context_tokens_max INTEGER,
      source TEXT,
      metadata TEXT,
      sender_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (turn_id) REFERENCES turns(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, sequence_num);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages(turn_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_events (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      sequence_num INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );

    CREATE INDEX IF NOT EXISTS idx_message_events_message_seq ON message_events(message_id, sequence_num);
    CREATE INDEX IF NOT EXISTS idx_message_events_type ON message_events(event_type);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_segments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      body TEXT NOT NULL,
      sequence_num INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_message_segments_message_seq ON message_segments(message_id, sequence_num);
  `);
}

/** 记忆上下文：memory_entries + memory_weights + FTS5 + vec0 */
/* eslint-disable max-lines-per-function -- F20260811mrpy 加入 embedding_meta 后表增多 */
function createMemoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      content_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_table TEXT NOT NULL,
      conversation_id TEXT,
      granularity TEXT NOT NULL DEFAULT 'fine',
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_entries_layer ON memory_entries(layer);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_content_type ON memory_entries(content_type);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_conversation_id ON memory_entries(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_source ON memory_entries(source_table, source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_created_at ON memory_entries(created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_weights (
      memory_entry_id TEXT PRIMARY KEY,
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      last_retrieved_at TEXT,
      user_flagged INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (memory_entry_id) REFERENCES memory_entries(id)
    );
  `);

  // F20260805hybrid: jieba 分词表，支持中文短查询
  // F370: memory_fts (trigram) 只写不查，已移除——旧库残留表无害，不主动 DROP
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_jieba USING fts5(
      memory_entry_id UNINDEXED,
      content
    );
  `);

  /** vec0 虚拟表：sqlite-vec 不可用时跳过（D22 降级模式） */
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
        memory_entry_id TEXT PRIMARY KEY,
        embedding FLOAT[1024]
      );
    `);
  } catch {
    // eslint-disable-next-line no-console -- schema 初始化不能依赖 frameworks/logger
    console.warn("sqlite-vec extension not available, falling back to FTS5-only search");
  }

  // F20260811mrpy Part 3：Embedding 版本锚（key-value 结构）
  // 记录当前 memory_vec 中向量是用哪个 modelId/modelRev/dim 生成的，
  // bootstrap 时校验，不一致则降级为纯 FTS（避免新查询与旧向量混跑导致召回静默变差）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // F20260826rcmm Phase 0：检索埋点——search_memory 真实调用记录。
  // 评估基线数据源：查询 + top 命中 + 对话上下文快照（标注者还原意图用）。
  // 上下文与 top ID 用 JSON 存 TEXT（一次性评估流程，不做关系型拆表）。
  // 只增不删（评估期结束后可整表 DROP）。无 FK——埋点是旁路观测，不与主数据耦合。
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_query_logs (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      caller_id TEXT,
      detail_level TEXT,
      library TEXT,
      limit_count INTEGER,
      top_entry_ids TEXT NOT NULL,
      total INTEGER NOT NULL,
      context_messages TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_query_logs_created
      ON search_query_logs (created_at);
  `);

  // F20260812mrcq Part 1：embedding 失败重试队列。
  // store-memory.ts 的 fire-and-forget embedding 失败后入队，
  // 由 EmbeddingRetryWorker tick 消费（指数退避），3 次失败转 dead-letter。
  // content 不冗余存储——retry worker 用 JOIN memory_entries 获取（entry content 不可变）。
  // 清理走手动 DELETE（在 deleteBySource/replaceEntryBySource 等），不依赖 FK CASCADE。
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_tasks (
      entry_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TEXT,
      next_retry_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_tasks_status_retry
      ON embedding_tasks (status, next_retry_at);
  `);

  // F20260813mren: 记忆关系层——memory_entries 之间的有向关系边。
  // 把 flat 数据变成可声明、可遍历的记忆图，让 LLM 拼证据链/因果链/发展链。
  // D4: 无 direction 字段——relates-to 查询层自动双向（from OR to），其余单向。
  // D7: 不依赖 FK CASCADE（与 embedding_tasks 一致），清理走 deleteBySource 内手动 DELETE。
  //      文档 chunk entry（fine 粒度）sync 时 replaceEntriesBySource 删旧建新，
  //      所以 D3 限制 link_memory 只能对 coarse entry 建边（CreateEdge use case 校验）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      from_entry_id TEXT NOT NULL,
      to_entry_id TEXT NOT NULL,
      edge_type TEXT NOT NULL CHECK (edge_type IN ('produced','references','supersedes','relates-to')),
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      CHECK (from_entry_id != to_entry_id),
      FOREIGN KEY (from_entry_id) REFERENCES memory_entries(id),
      FOREIGN KEY (to_entry_id) REFERENCES memory_entries(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_unique
      ON memory_edges(from_entry_id, to_entry_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_entry_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_entry_id, edge_type);
  `);
}

/** 术语库：terminology_entries + terminology_fts */
function createTerminologyTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminology_entries (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      aliases_flat TEXT NOT NULL DEFAULT '',
      definition TEXT NOT NULL,
      context TEXT,
      examples TEXT,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_terminology_status ON terminology_entries(status);
    CREATE INDEX IF NOT EXISTS idx_terminology_category ON terminology_entries(category);
  `);

  /** 唯一索引仅对 active 状态生效，允许同名术语重新添加 */
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_terminology_term_active
    ON terminology_entries(term) WHERE status = 'active';
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS terminology_fts USING fts5(
      terminology_entry_id UNINDEXED,
      term,
      aliases_flat,
      definition,
      context,
      tokenize = 'trigram'
    );
  `);
}

/** 对话关键资源：linked_resources（统一产物模型，fact 为文本类事实子类型） */
function createConversationInfoTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS linked_resources (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      url TEXT,
      title TEXT,
      content TEXT,
      category TEXT,
      user_flagged INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      linked_by TEXT NOT NULL,
      otter_id TEXT,
      auto_linked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'active',
      linked_at_turn_number INTEGER NOT NULL DEFAULT 0,
      status_changed_at_turn_number INTEGER NOT NULL DEFAULT 0,
      group_id TEXT,
      superseded_by TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_linked_resources_conversation_id ON linked_resources(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_linked_resources_type ON linked_resources(resource_type);
    CREATE INDEX IF NOT EXISTS idx_linked_resources_conversation_status ON linked_resources(conversation_id, status);
    CREATE INDEX IF NOT EXISTS idx_linked_resources_group_id ON linked_resources(group_id);
    CREATE INDEX IF NOT EXISTS idx_linked_resources_user_flagged ON linked_resources(conversation_id, user_flagged);
  `);
}

/** Otter 上下文：otters + otter_sessions */
function createOtterTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS otters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      role_name TEXT,
      role_responsibilities TEXT,
      parent_otter_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      dissolved_at TEXT,
      FOREIGN KEY (parent_otter_id) REFERENCES otters(id)
    );

    CREATE INDEX IF NOT EXISTS idx_otters_type ON otters(type);
    CREATE INDEX IF NOT EXISTS idx_otters_status ON otters(status);
    CREATE INDEX IF NOT EXISTS idx_otters_parent_otter_id ON otters(parent_otter_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS otter_sessions (
      id TEXT PRIMARY KEY,
      otter_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      archive_reason TEXT,
      is_negative_case INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      previous_session_id TEXT,
      FOREIGN KEY (otter_id) REFERENCES otters(id),
      FOREIGN KEY (previous_session_id) REFERENCES otter_sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_otter_sessions_otter_id ON otter_sessions(otter_id);
    CREATE INDEX IF NOT EXISTS idx_otter_sessions_status ON otter_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_otter_sessions_negative ON otter_sessions(is_negative_case);
    CREATE INDEX IF NOT EXISTS idx_otter_sessions_previous ON otter_sessions(previous_session_id);
  `);
}

/** Turn 表（Turn 实体，F20260715b8c6 新增） */
function createTurnTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_turns_conversation_id ON turns(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_conversation_number ON turns(conversation_id, turn_number);
  `);
}

/** 对话参与者表（ConversationParticipant 实体，E3/E4 新增） */
function createParticipantTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_participants (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      otter_id TEXT NOT NULL,
      joined_at_turn_id TEXT,
      joined_at_turn_number INTEGER NOT NULL DEFAULT 0,
      left_at_turn_id TEXT,
      left_at_turn_number INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      last_read_turn_number INTEGER NOT NULL DEFAULT 0,
      last_active_turn_number INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id),
      FOREIGN KEY (otter_id) REFERENCES otters(id),
      FOREIGN KEY (joined_at_turn_id) REFERENCES turns(id),
      FOREIGN KEY (left_at_turn_id) REFERENCES turns(id),
      UNIQUE(conversation_id, otter_id)
    );

    CREATE INDEX IF NOT EXISTS idx_participants_conversation_id ON conversation_participants(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_participants_otter_id ON conversation_participants(otter_id);
    CREATE INDEX IF NOT EXISTS idx_participants_status ON conversation_participants(status);
  `);
}

/** Agent Session 映射表（Otter ↔ Pi Session，R12） */
function createAgentSessionsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      otter_id TEXT PRIMARY KEY,
      pi_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (otter_id) REFERENCES otters(id)
    );
  `);
}

/** Settings 键值表 */
function createSettingsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** Otter 上下文存储（get_context / set_context 工具支撑） */
function createOtterContextTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS otter_context (
      otter_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (otter_id, key),
      FOREIGN KEY (otter_id) REFERENCES otters(id)
    );
  `);
}

/** 消息全文搜索（search_messages 工具支撑，trigram 分词）。
 *  F20260728htar：FTS 写入改应用层（repository 写剥离投影），触发器废弃。
 *  保留 DROP TRIGGER IF EXISTS：老库 sqlite_master 里已存在的触发器必须卸掉，
 *  否则"触发器写原文 + 应用层写剥离文本"双写。 */
function createMessagesFtsTable(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      body,
      tokenize = 'trigram'
    );

    DROP TRIGGER IF EXISTS messages_fts_insert;
    DROP TRIGGER IF EXISTS messages_fts_delete;
    DROP TRIGGER IF EXISTS messages_fts_update;
  `);
}

/** 文档表：features + research（F20260721qh74 文档数据模型）
 *  F20260803mval: 移除 change_type/status/exploration_type 的 CHECK 约束，
 *  枚举合法性改由应用层 known-values.ts 单一真相源判定。DB 不再做枚举约束，
 *  避免工作流演进时 DB CHECK 与应用层同步过期（曾导致 41 文档入库失败）。 */
function createDocumentTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
      body_hash TEXT,
      change_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      tags TEXT NOT NULL DEFAULT '[]',
      modules TEXT NOT NULL DEFAULT '[]',
      causal_links_from TEXT NOT NULL DEFAULT '[]',
      supersedes TEXT NOT NULL DEFAULT '[]',
      file_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_in_conversation_id TEXT,
      CHECK(id LIKE 'F%')
    );

    CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);
    CREATE INDEX IF NOT EXISTS idx_features_created_at ON features(created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS research (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 500),
      body_hash TEXT,
      exploration_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      tags TEXT NOT NULL DEFAULT '[]',
      conclusion TEXT,
      causal_links_from TEXT NOT NULL DEFAULT '[]',
      supersedes TEXT NOT NULL DEFAULT '[]',
      file_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_in_conversation_id TEXT,
      CHECK(id LIKE 'R%')
    );

    CREATE INDEX IF NOT EXISTS idx_research_status ON research(status);
    CREATE INDEX IF NOT EXISTS idx_research_created_at ON research(created_at);
    CREATE INDEX IF NOT EXISTS idx_research_exploration_type ON research(exploration_type);
  `);
}

/** 定时任务表：scheduled_tasks + scheduled_task_executions（F20260721x8k9） */
function createScheduledTaskTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      name TEXT NOT NULL,
      schedule_type TEXT NOT NULL DEFAULT 'cron',
      cron TEXT NOT NULL,
      trigger_at TEXT,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      body TEXT NOT NULL CHECK (length(body) <= 10000),
      talking_stone_passed_to TEXT NOT NULL DEFAULT '[]',
      sender_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TEXT,
      restart_before_invoke INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_conversation ON scheduled_tasks(conversation_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_task_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      triggered_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
      error_message TEXT,
      message_id TEXT REFERENCES messages(id),
      turn_id TEXT REFERENCES turns(id)
    );

    CREATE INDEX IF NOT EXISTS idx_executions_task ON scheduled_task_executions(task_id, triggered_at);
  `);
}

/** 连接表：connections + connection_sessions（IM 大厅） */
function createConnectionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_type TEXT NOT NULL DEFAULT 'feishu',
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_external_id
      ON connections(external_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_connections_status ON connections(status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_sessions (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      FOREIGN KEY (connection_id) REFERENCES connections(id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_sessions_conv_active
      ON connection_sessions(conversation_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_conn_sessions_conn_active
      ON connection_sessions(connection_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_conn_sessions_conn_history
      ON connection_sessions(connection_id, joined_at);
  `);
}

/** Healing events 表（Self-Healing 系统） */
function createHealingEventTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS healing_events (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      otter_id TEXT NOT NULL,
      error_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      suggestion TEXT NOT NULL DEFAULT '',
      context TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      introduced_by_pr TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_healing_events_status ON healing_events(status);
    CREATE INDEX IF NOT EXISTS idx_healing_events_severity ON healing_events(severity);
    CREATE INDEX IF NOT EXISTS idx_healing_events_created ON healing_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_healing_events_type ON healing_events(error_type);
    CREATE INDEX IF NOT EXISTS idx_healing_events_otter ON healing_events(otter_id, created_at);
  `);

  // F20260824ax376: 存量数据库迁移——introduced_by_pr 列
  // ALTER TABLE ADD COLUMN 幂等：列已存在时 SQLite 抛错，try/catch 静默处理
  // 策略：不引入独立迁移框架，保持 initSchema 幂等可重复调用的设计
  try {
    db.exec(`ALTER TABLE healing_events ADD COLUMN introduced_by_pr TEXT`);
  } catch {
    // 列已存在，忽略
  }
}

/** Web 用户已读状态（消息级，与 otter agent 的 turn 级 last_read_turn_number 独立）。
 *  单用户预留多用户：user_id 当前固定 "web-user"，多用户扩展时按 user 隔离。 */
function createUserReadStateTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_user_read_state (
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      last_read_message_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, conversation_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_read_state_conv ON conversation_user_read_state(conversation_id);
  `);
}

/** 健康快照表（RHI 指标持久化） */
function createHealthSnapshotsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      metric_value REAL NOT NULL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_date_type ON health_snapshots(snapshot_date, metric_type);
    CREATE INDEX IF NOT EXISTS idx_snapshots_key ON health_snapshots(metric_key);
  `);
}

/** 信号表（RHI 异常信号） */
function createSignalsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      feature_id TEXT,
      file_path TEXT,
      evidence TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      occurrences INTEGER DEFAULT 1,
      status TEXT DEFAULT 'open',
      suggested_action TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(signal_type);
    CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
    CREATE INDEX IF NOT EXISTS idx_signals_feature ON signals(feature_id);
  `);
}

/** Signal events 表（F20260826mwrd C1：獭间结构化信号台账，halt 落账 + C2 objection/blocked）。
 *  注意与 health 域的 signals 表（healing 去重聚合）无关——命名区分见特性文档「为什么不复用」节。 */
function createSignalEventsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      from_otter_id TEXT NOT NULL,
      target_otter_id TEXT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolution TEXT,
      resolved_by TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_signal_events_conv ON signal_events(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_signal_events_status ON signal_events(status);
    CREATE INDEX IF NOT EXISTS idx_signal_events_type ON signal_events(type);
    CREATE INDEX IF NOT EXISTS idx_signal_events_target ON signal_events(target_otter_id, created_at);
  `);
}

/** 服务重启自动恢复队列（F20260826rsme）：
 *  reconcile 阶段识别可恢复中断写入，启动完成后 ResumeInterruptedService 消费。
 *  message_id 主键幂等；attempts 原子自增守卫防二次重启循环恢复（8/24 自重启循环教训）。 */
function createRestartPendingResumesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS restart_pending_resumes (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      otter_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'exhausted')),
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_restart_pending_resumes_status ON restart_pending_resumes(status);
  `);
}


