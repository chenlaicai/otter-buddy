import type Database from "better-sqlite3";
import type { Entry, EntrySource, EntryType, SenderType, EntryStatus } from "@entities/conversation/entry";
import type { AttachmentRef } from "@entities/conversation/attachment";
import { EntryMemoryProjector } from "@usecases/memory/entry-memory-projector";
import {
  decideEntryProjection,
  hashEntryProjectionContent,
  ENTRY_MEMORY_POLICY_VERSION,
  type ProjectionDecision,
} from "@usecases/memory/entry-projection-policy";
import { SqliteMemoryRepository } from "./sqlite-memory-repository";
import type { StoredEntryProjectionInput } from "@usecases/memory/entry-projection-worker";
import { enqueueProjectionOutbox, recordProjectionOutboxTerminal } from "./projection-outbox-repository";

export type { StoredEntryProjectionInput } from "@usecases/memory/entry-projection-worker";

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

const ENTRY_PROJECTION_SELECT = `
  SELECT e.*, c.kind AS conversation_kind,
    CASE WHEN json_extract(i.metadata, '$.externalProfile') = 'restricted' THEN 1 ELSE 0 END AS external_speak
  FROM entries e
  JOIN conversations c ON c.id = e.conversation_id
  LEFT JOIN invokes i ON i.id = e.invoke_id
`;

interface AttachmentRow {
  id: string;
  kind: AttachmentRef["kind"];
  original_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
}

function toAttachmentRef(row: AttachmentRow): AttachmentRef {
  return {
    id: row.id, kind: row.kind, originalName: row.original_name,
    mimeType: row.mime_type, sizeBytes: row.size_bytes,
    width: row.width, height: row.height, caption: row.caption,
  };
}

function toProjectionEntry(row: EntryProjectionRow): Entry {
  return {
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
}

const SQL_ID_BATCH_SIZE = 500;

function hydrateProjectionInputs(
  db: Database.Database,
  rows: EntryProjectionRow[],
  attachmentIntentByEntry?: ReadonlyMap<string, string[]>,
): StoredEntryProjectionInput[] {
  const entryIds = rows.map((row) => row.id);
  const boundIdsByEntry = new Map<string, string[]>();
  for (let offset = 0; offset < entryIds.length; offset += SQL_ID_BATCH_SIZE) {
    const batch = entryIds.slice(offset, offset + SQL_ID_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const boundRows = db.prepare(`
      SELECT entry_id, attachment_id FROM entry_attachments
      WHERE entry_id IN (${placeholders}) ORDER BY entry_id, sequence_num
    `).all(...batch) as Array<{ entry_id: string; attachment_id: string }>;
    for (const row of boundRows) {
      const ids = boundIdsByEntry.get(row.entry_id) ?? [];
      ids.push(row.attachment_id);
      boundIdsByEntry.set(row.entry_id, ids);
    }
  }

  const idsByEntry = new Map<string, string[]>();
  const allAttachmentIds = new Set<string>();
  for (const entryId of entryIds) {
    const ids = attachmentIntentByEntry?.get(entryId) ?? boundIdsByEntry.get(entryId) ?? [];
    idsByEntry.set(entryId, ids);
    for (const id of ids) allAttachmentIds.add(id);
  }
  const refsById = new Map<string, AttachmentRef>();
  const allIds = [...allAttachmentIds];
  for (let offset = 0; offset < allIds.length; offset += SQL_ID_BATCH_SIZE) {
    const batch = allIds.slice(offset, offset + SQL_ID_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const attachmentRows = db.prepare(`
      SELECT id, kind, original_name, mime_type, size_bytes, width, height, caption
      FROM attachments WHERE id IN (${placeholders})
    `).all(...batch) as AttachmentRow[];
    for (const row of attachmentRows) refsById.set(row.id, toAttachmentRef(row));
  }

  return rows.map((row) => {
    const entry = toProjectionEntry(row);
    const attachments = (idsByEntry.get(entry.id) ?? [])
      .map((id) => refsById.get(id))
      .filter((value): value is AttachmentRef => value !== undefined);
    return {
      entry,
      conversationKind: row.conversation_kind === "external" ? "external" : "normal",
      externalSpeak: row.external_speak === 1,
      attachments,
      createdAt: row.created_at,
    };
  });
}

/** 启动回填与离线 audit/cleanup 共用源行读取，externalSpeak 不依赖历史 source 标记。 */
export function readEntryProjectionInputs(
  db: Database.Database,
  attachmentIntentByEntry?: ReadonlyMap<string, string[]>,
): StoredEntryProjectionInput[] {
  const rows = db.prepare(`${ENTRY_PROJECTION_SELECT}
    WHERE e.entry_type IN ('user', 'speak')
    ORDER BY e.created_at, e.id
  `).all() as EntryProjectionRow[];
  return hydrateProjectionInputs(db, rows, attachmentIntentByEntry);
}

/** worker 只持 entryId 与附件 intent，每次投递都重读当前源行和元数据。 */
export function readEntryProjectionInput(
  db: Database.Database,
  entryId: string,
  attachmentIntentIds?: string[],
): StoredEntryProjectionInput | null {
  const row = db.prepare(`${ENTRY_PROJECTION_SELECT} WHERE e.id = ?`).get(entryId) as EntryProjectionRow | undefined;
  if (!row) return null;
  const intents = attachmentIntentIds === undefined ? undefined : new Map([[entryId, attachmentIntentIds]]);
  return hydrateProjectionInputs(db, [row], intents)[0] ?? null;
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
  if (tableExists(db, "memory_vec_generations")
    && hasRow(db, "SELECT 1 FROM memory_vec_generations WHERE entry_id = ?", entryId)) return true;
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

export interface ProjectionReconciliationDifference {
  entryId: string;
  expectedHash: string;
  actualHash?: string;
}

export interface ProjectionReconciliationReport {
  scanned: number;
  matched: number;
  missing: number;
  different: number;
  pending: number;
  dead: number;
  skipped: number;
  orphaned: number;
  oldestPendingAgeSeconds: number | null;
  missingEntryIds: string[];
  orphanedEntryIds: string[];
  differentItems: ProjectionReconciliationDifference[];
}

interface OutboxReconciliationRow {
  entry_id: string;
  status: "pending" | "done" | "skipped" | "dead";
  attachment_intent_json: string | null;
  created_at: string;
}

function parseAttachmentIntent(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

interface ReconciliationContext {
  db: Database.Database;
  outboxById: ReadonlyMap<string, OutboxReconciliationRow>;
  memoryContent: ReadonlyMap<string, string>;
  nowIso: string;
}

function reconcileProjectionInput(
  input: StoredEntryProjectionInput,
  context: ReconciliationContext,
  differences: { missingEntryIds: string[]; differentItems: ProjectionReconciliationDifference[] },
): boolean {
  const { db, memoryContent, nowIso } = context;
  const entryId = input.entry.id;
  const outbox = context.outboxById.get(entryId);
  const decision = decideEntryProjection(input);
  const attachmentIds = input.attachments.map((attachment) => attachment.id);
  if (decision.kind === "skip") {
    if (outbox?.status !== "skipped") recordProjectionOutboxTerminal(db, entryId, "skipped", attachmentIds, nowIso);
    return false;
  }

  const oldContent = memoryContent.get(entryId);
  const actualHash = oldContent === undefined ? undefined : hashEntryProjectionContent(oldContent);
  if (actualHash === decision.contentHash) {
    if (outbox?.status !== "done") recordProjectionOutboxTerminal(db, entryId, "done", attachmentIds, nowIso);
    return true;
  }

  if (oldContent === undefined) differences.missingEntryIds.push(entryId);
  else differences.differentItems.push({ entryId, expectedHash: decision.contentHash, actualHash });
  // Why: dead remains an explicit operational decision; periodic scans must not endlessly revive permanent failures.
  if (!outbox || outbox.status === "done" || outbox.status === "skipped") {
    enqueueProjectionOutbox(db, entryId, attachmentIds, nowIso);
  }
  return false;
}

/** 无 watermark 对账：兼容回滚的同 hash 直写补 done，缺失或不同才进入持久待投。 */
export function reconcileEntryProjectionOutbox(db: Database.Database, now = new Date()): ProjectionReconciliationReport {
  const outboxRows = db.prepare(`
    SELECT entry_id, status, attachment_intent_json, created_at FROM memory_projection_outbox
  `).all() as OutboxReconciliationRow[];
  const outboxById = new Map(outboxRows.map((row) => [row.entry_id, row]));
  const intents = new Map<string, string[]>();
  for (const row of outboxRows) {
    const ids = parseAttachmentIntent(row.attachment_intent_json);
    if (ids !== undefined) intents.set(row.entry_id, ids);
  }
  const inputs = readEntryProjectionInputs(db, intents);
  const memoryContent = new Map<string, string>();
  for (const row of db.prepare("SELECT id, content FROM memory_entries WHERE source_table = 'entries'").all() as Array<{ id: string; content: string }>) {
    memoryContent.set(row.id, row.content);
  }

  const nowIso = now.toISOString();
  const missingEntryIds: string[] = [];
  const differentItems: ProjectionReconciliationDifference[] = [];
  let matched = 0;
  db.transaction(() => {
    for (const input of inputs) {
      if (reconcileProjectionInput(input, { db, outboxById, memoryContent, nowIso }, { missingEntryIds, differentItems })) matched++;
    }
  })();

  const sourceIds = new Set(inputs.map((input) => input.entry.id));
  const orphanedEntryIds = outboxRows.map((row) => row.entry_id).filter((entryId) => !sourceIds.has(entryId));
  const finalRows = db.prepare("SELECT status, created_at FROM memory_projection_outbox").all() as Array<Pick<OutboxReconciliationRow, "status" | "created_at">>;
  const pendingAges = finalRows
    .filter((row) => row.status === "pending")
    .map((row) => Math.max(0, Math.floor((now.getTime() - Date.parse(row.created_at)) / 1000)))
    .filter((age) => Number.isFinite(age));
  return {
    scanned: inputs.length,
    matched,
    missing: missingEntryIds.length,
    different: differentItems.length,
    pending: finalRows.filter((row) => row.status === "pending").length,
    dead: finalRows.filter((row) => row.status === "dead").length,
    skipped: finalRows.filter((row) => row.status === "skipped").length,
    orphaned: orphanedEntryIds.length,
    oldestPendingAgeSeconds: pendingAges.length > 0 ? Math.max(...pendingAges) : null,
    missingEntryIds,
    orphanedEntryIds,
    differentItems,
  };
}
