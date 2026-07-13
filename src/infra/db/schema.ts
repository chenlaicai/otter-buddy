import type Database from "better-sqlite3";

/**
 * 初始化全部 Schema（幂等，可重复调用）
 * - 所有 CREATE 使用 IF NOT EXISTS（S3 硬约束）
 * - 禁止 ALTER TABLE（S3 硬约束）
 * - 整个 initSchema 在单事务内执行（原子性）
 */
export function initSchema(db: Database.Database): void {
  db.exec("BEGIN");

  try {
    createConversationTables(db);
    createMemoryTables(db);
    createConversationInfoTables(db);
    createOtterTables(db);
    createSkillTables(db);
    createExternalResourceTables(db);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 对话上下文：conversations + messages + conversation_otters */
function createConversationTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      parent_id TEXT,
      tree_path TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      archived_at TEXT,
      FOREIGN KEY (parent_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_parent_id ON conversations(parent_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
    CREATE INDEX IF NOT EXISTS idx_conversations_tree_path ON conversations(tree_path);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      sequence_num INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, sequence_num);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);

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

/** 记忆上下文：memory_entries + memory_weights + FTS5 + vec0 */
function createMemoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      content_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_table TEXT NOT NULL,
      conversation_id TEXT,
      tree_path TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_memory_entries_tree_path ON memory_entries(tree_path);
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

  // FTS5 虚拟表（trigram 分词器）
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_entry_id UNINDEXED,
      content,
      tokenize = 'trigram'
    );
  `);

  // vec0 虚拟表（1024 维 embedding）
  // 注意：如果 sqlite-vec 未加载，此语句会失败，但整体事务会回滚
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
        memory_entry_id TEXT PRIMARY KEY,
        embedding FLOAT[1024]
      );
    `);
  } catch {
    // sqlite-vec 不可用时跳过 vec0 虚拟表创建
  }
}

/** 对话关键信息：linked_resources + key_facts */
function createConversationInfoTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS linked_resources (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      metadata TEXT,
      linked_by TEXT NOT NULL,
      otter_id TEXT,
      auto_linked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_linked_resources_conversation_id ON linked_resources(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_linked_resources_type ON linked_resources(resource_type);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS key_facts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      user_flagged INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      otter_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_key_facts_conversation_id ON key_facts(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_key_facts_user_flagged ON key_facts(user_flagged);
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
      FOREIGN KEY (otter_id) REFERENCES otters(id)
    );

    CREATE INDEX IF NOT EXISTS idx_otter_sessions_otter_id ON otter_sessions(otter_id);
    CREATE INDEX IF NOT EXISTS idx_otter_sessions_status ON otter_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_otter_sessions_negative ON otter_sessions(is_negative_case);
  `);
}

/** 能力上下文：skills + skill_assignments */
function createSkillTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      type TEXT NOT NULL,
      definition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_skills_type ON skills(type);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_assignments (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      otter_id TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      FOREIGN KEY (skill_id) REFERENCES skills(id),
      FOREIGN KEY (otter_id) REFERENCES otters(id)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_assignments_otter_id ON skill_assignments(otter_id);
    CREATE INDEX IF NOT EXISTS idx_skill_assignments_skill_id ON skill_assignments(skill_id);
    CREATE INDEX IF NOT EXISTS idx_skill_assignments_active ON skill_assignments(otter_id, revoked_at);
  `);
}

/** 外部系统上下文：external_resources */
function createExternalResourceTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_resources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      metadata TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_external_resources_url ON external_resources(url);
    CREATE INDEX IF NOT EXISTS idx_external_resources_type ON external_resources(type);
  `);
}
