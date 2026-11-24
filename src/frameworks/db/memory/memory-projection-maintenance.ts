import type Database from "better-sqlite3";
import type { Entry, EntrySource, EntryType, SenderType, EntryStatus } from "@entities/conversation/entry";
import type { AttachmentRef } from "@entities/conversation/attachment";
import { EntryMemoryProjector } from "@usecases/memory/entry-memory-projector";
import {
  decideEntryProjection,
  hashEntryProjectionContent,
  ENTRY_MEMORY_POLICY_VERSION,
  type EntryProjectionInput,
  type ProjectionDecision,
} from "@usecases/memory/entry-projection-policy";
import { SqliteMemoryRepository } from "./sqlite-memory-repository";

export interface StoredEntryProjectionInput extends EntryProjectionInput {
  createdAt: string;
}

interface EntryProjectionRow {
  id: string;
  conversation_id: string;
  sequence_num: number;
  entry_type: EntryType;
  sender_type: SenderType | null;
  sender_id: string | null;
  body: string | null;
  invoke_id: string | null;
  yield_targets: string | null;
  status: EntryStatus;
  source: EntrySource;
  metadata: string | null;
  sender_name: string;
  context_tokens: number | null;
  context_tokens_max: number | null;
  created_at: string;
  completed_at: string | null;
  conversation_kind: string;
  external_speak: number;
}

/** 启动回填与离线 audit/cleanup 共用源行读取，externalSpeak 不依赖历史 source 标记。 */
export function readEntryProjectionInputs(db: Database.Database): StoredEntryProjectionInput[] {
  const rows = db.prepare(`
    SELECT e.*, c.kind AS conversation_kind,
      CASE WHEN json_extract(i.metadata, '$.externalProfile') = 'restricted' THEN 1 ELSE 0 END AS external_speak
    FROM entries e
    JOIN conversations c ON c.id = e.conversation_id
    LEFT JOIN invokes i ON i.id = e.invoke_id
    WHERE e.entry_type IN ('user', 'speak')
    ORDER BY e.created_at, e.id
  `).all() as EntryProjectionRow[];

  const attachmentsByEntry = new Map<string, AttachmentRef[]>();
  const attachmentRows = db.prepare(`
    SELECT ea.entry_id, a.id, a.kind, a.original_name, a.mime_type, a.size_bytes, a.width, a.height, a.caption
    FROM entry_attachments ea
    JOIN attachments a ON a.id = ea.attachment_id
    JOIN entries e ON e.id = ea.entry_id AND e.entry_type = 'user'
    ORDER BY ea.entry_id, ea.sequence_num
  `).all() as Array<Record<string, unknown>>;
  for (const a of attachmentRows) {
    const list = attachmentsByEntry.get(a.entry_id as string) ?? [];
    list.push({
      id: a.id as string, kind: a.kind as AttachmentRef["kind"], originalName: a.original_name as string,
      mimeType: a.mime_type as string, sizeBytes: a.size_bytes as number,
      width: a.width as number | null, height: a.height as number | null, caption: a.caption as string | null,
    });
    attachmentsByEntry.set(a.entry_id as string, list);
  }
  return rows.map((row) => {
    const entry: Entry = {
      id: row.id,
      conversationId: row.conversation_id,
      sequenceNum: row.sequence_num,
      entryType: row.entry_type,
      senderType: row.sender_type,
      senderId: row.sender_id,
      body: row.body,
      invokeId: row.invoke_id,
      yieldTargets: row.yield_targets ? JSON.parse(row.yield_targets) as string[] : null,
      status: row.status,
      source: row.source,
      metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
      senderName: row.sender_name,
      contextTokens: row.context_tokens,
      contextTokensMax: row.context_tokens_max,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
    const attachments = attachmentsByEntry.get(entry.id) ?? [];
    return {
      entry,
      conversationKind: row.conversation_kind === "external" ? "external" : "normal",
      externalSpeak: row.external_speak === 1,
      attachments,
      createdAt: row.created_at,
    };
  });
}

export interface MemoryProjectionAuditItem {
  entryId: string;
  conversationId: string;
  kind: "external" | "excluded-existing" | "missing" | "different" | "satellite-incomplete";
  policyVersion: string;
  expectedHash?: string;
  actualHash?: string;
}

export interface MemoryProjectionAudit {
  policyVersion: string;
  scanned: number;
  matched: number;
  skipped: number;
  items: MemoryProjectionAuditItem[];
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function hasRow(db: Database.Database, sql: string, id: string): boolean {
  return db.prepare(sql).get(id) !== undefined;
}

function hasAnyProjectionArtifact(db: Database.Database, entryId: string): boolean {
  if (hasRow(db, "SELECT 1 FROM memory_entries WHERE id = ?", entryId)) return true;
  if (hasRow(db, "SELECT 1 FROM memory_fts_jieba WHERE memory_entry_id = ?", entryId)) return true;
  if (hasRow(db, "SELECT 1 FROM memory_weights WHERE memory_entry_id = ?", entryId)) return true;
  if (hasRow(db, "SELECT 1 FROM embedding_tasks WHERE entry_id = ?", entryId)) return true;
  if (db.prepare("SELECT 1 FROM memory_edges WHERE from_entry_id = ? OR to_entry_id = ?").get(entryId, entryId) !== undefined) return true;
  if (tableExists(db, "memory_vec")) {
    try {
      if (hasRow(db, "SELECT 1 FROM memory_vec WHERE memory_entry_id = ?", entryId)) return true;
    } catch {
      // 离线连接未加载 vec0 扩展时主表/其它卫星仍可审计；脚本入口会主动加载扩展。
    }
  }
  return false;
}

/** 虚表按 memory_entry_id 点查会反复全扫；audit 一次装载快照，禁止 N+1。 */
function readProjectionAuditSnapshot(db: Database.Database) {
  const memory = new Map<string, string>();
  for (const row of db.prepare("SELECT id, content FROM memory_entries").all() as Array<{ id: string; content: string }>) {
    memory.set(row.id, row.content);
  }
  return {
    memory,
    fts: new Set((db.prepare("SELECT memory_entry_id FROM memory_fts_jieba").all() as Array<{ memory_entry_id: string }>).map((row) => row.memory_entry_id)),
    weights: new Set((db.prepare("SELECT memory_entry_id FROM memory_weights").all() as Array<{ memory_entry_id: string }>).map((row) => row.memory_entry_id)),
  };
}

/** 默认只读审计：结果只含计数、entry/conversation ID 与内容 hash，不含正文。 */
export function auditMemoryProjection(db: Database.Database): MemoryProjectionAudit {
  const inputs = readEntryProjectionInputs(db);
  const items: MemoryProjectionAuditItem[] = [];
  let matched = 0, skipped = 0;
  const snapshot = readProjectionAuditSnapshot(db);

  for (const input of inputs) {
    const decision = decideEntryProjection(input);
    const oldContent = snapshot.memory.get(input.entry.id);
    const memory = oldContent === undefined ? undefined : { content: oldContent };
    if (decision.kind === "skip") {
      skipped++;
      if (hasAnyProjectionArtifact(db, input.entry.id)) {
        items.push({
          entryId: input.entry.id,
          conversationId: input.entry.conversationId,
          kind: decision.reason === "external" ? "external" : "excluded-existing",
          policyVersion: decision.policyVersion,
          ...(memory ? { actualHash: hashEntryProjectionContent(memory.content) } : {}),
        });
      }
      continue;
    }

    if (!memory) {
      items.push({
        entryId: input.entry.id, conversationId: input.entry.conversationId,
        kind: "missing", policyVersion: decision.policyVersion, expectedHash: decision.contentHash,
      });
      continue;
    }
    const actualHash = hashEntryProjectionContent(memory.content);
    if (actualHash !== decision.contentHash) {
      items.push({
        entryId: input.entry.id, conversationId: input.entry.conversationId,
        kind: "different", policyVersion: decision.policyVersion,
        expectedHash: decision.contentHash, actualHash,
      });
      continue;
    }
    if (!snapshot.fts.has(input.entry.id) || !snapshot.weights.has(input.entry.id)) {
      items.push({
        entryId: input.entry.id, conversationId: input.entry.conversationId,
        kind: "satellite-incomplete", policyVersion: decision.policyVersion,
        expectedHash: decision.contentHash, actualHash,
      });
      continue;
    }
    matched++;
  }
  return { policyVersion: ENTRY_MEMORY_POLICY_VERSION, scanned: inputs.length, matched, skipped, items };
}

/** 显式清理入口。调用方必须先 dry-run 并备份；本函数不在启动路径调用。 */
export function cleanupMemoryProjection(db: Database.Database): { before: MemoryProjectionAudit; after: MemoryProjectionAudit } {
  const before = auditMemoryProjection(db);
  const repo = new SqliteMemoryRepository(db);
  const projector = new EntryMemoryProjector(repo);
  const inputs = readEntryProjectionInputs(db);
  const byId = new Map(inputs.map((input) => [input.entry.id, input]));

  db.transaction(() => {
    for (const item of before.items) {
      if (item.kind === "external" || item.kind === "excluded-existing") {
        repo.deleteEntryProjection(item.entryId);
        continue;
      }
      const input = byId.get(item.entryId);
      if (!input) continue;
      const decision: ProjectionDecision = decideEntryProjection(input);
      projector.apply(decision, input.createdAt);
    }
  })();
  return { before, after: auditMemoryProjection(db) };
}
