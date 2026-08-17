/**
 * F20260813mren: 记忆关系层（memory_edges）SQL 查询。
 * F20260814qswp 从 sqlite-memory-repository.ts 拆出——edges 图查询与 entry 存储是
 * 正交关注点；Repository 的 port 方法委托到这里的纯函数。
 */
import type Database from "better-sqlite3";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import type { MemoryEdge, EdgeType } from "@entities/memory/memory-edge";
import { rowToMemoryEdge, rowToMemoryEntryJoined } from "./memory-mapper";

/** 创建关系边。幂等（UNIQUE + ON CONFLICT 原子操作，防 TOCTOU 竞态）。 */
export function createEdge(
  db: Database.Database,
  input: {
    fromEntryId: string;
    toEntryId: string;
    edgeType: EdgeType;
    metadata?: Record<string, unknown>;
    createdBy?: string;
  },
): string {
  const id = crypto.randomUUID();
  const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;
  // ON CONFLICT 幂等：同 (from, to, type) 已存在则跳过 INSERT，随后 SELECT 拿实际 id
  db.prepare(`
    INSERT INTO memory_edges (id, from_entry_id, to_entry_id, edge_type, metadata, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(from_entry_id, to_entry_id, edge_type) DO NOTHING
  `).run(id, input.fromEntryId, input.toEntryId, input.edgeType, metaJson, input.createdBy ?? null);

  const row = db.prepare(
    `SELECT id FROM memory_edges WHERE from_entry_id = ? AND to_entry_id = ? AND edge_type = ?`,
  ).get(input.fromEntryId, input.toEntryId, input.edgeType) as { id: string };
  return row.id;
}

/**
 * 从某 entry 出发查直接邻居（1 跳）。
 * BFS 的 depth>1 在 GetRelated use case 层循环调此方法。
 * D4: relates-to 自动双向（from OR to）；其余按 direction 单向。
 */
export function getEdgesByEntry(
  db: Database.Database,
  entryId: string,
  opts?: {
    edgeTypes?: EdgeType[];
    direction?: "out" | "in";
  },
): Array<{ edge: MemoryEdge; neighborEntry: MemoryEntry }> {
  const ALL_TYPES: EdgeType[] = ["produced", "references", "supersedes", "relates-to"];
  const types = opts?.edgeTypes ?? ALL_TYPES;
  const direction = opts?.direction ?? "out";

  const symmetricTypes = types.filter(t => t === "relates-to");
  const directedTypes = types.filter(t => t !== "relates-to");

  const results: Array<{ edge: MemoryEdge; neighborEntry: MemoryEntry }> = [];
  if (directedTypes.length > 0) {
    results.push(...queryDirectedEdges(db, entryId, directedTypes, direction));
  }
  if (symmetricTypes.length > 0) {
    results.push(...querySymmetricEdges(db, entryId, symmetricTypes));
  }
  return results;
}

/** D4: directed 边（produced/references/supersedes）按 direction 单向查 */
function queryDirectedEdges(
  db: Database.Database,
  entryId: string,
  types: EdgeType[],
  direction: "out" | "in",
): Array<{ edge: MemoryEdge; neighborEntry: MemoryEntry }> {
  const dirCol = direction === "in" ? "to_entry_id" : "from_entry_id";
  const neighborCol = direction === "in" ? "from_entry_id" : "to_entry_id";
  const placeholders = types.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT e.*, m.id as m_id, m.layer as m_layer, m.content_type as m_content_type,
           m.source_id as m_source_id, m.source_table as m_source_table,
           m.conversation_id as m_conversation_id, m.granularity as m_granularity,
           m.content as m_content, m.metadata as m_metadata, m.created_at as m_created_at
    FROM memory_edges e
    JOIN memory_entries m ON m.id = e.${neighborCol}
    WHERE e.${dirCol} = ? AND e.edge_type IN (${placeholders})
  `).all(entryId, ...types) as Array<Record<string, unknown>>;
  return rows.map(row => ({ edge: rowToMemoryEdge(row), neighborEntry: rowToMemoryEntryJoined(row) }));
}

/** D4: relates-to 自动双向查（from OR to） */
function querySymmetricEdges(
  db: Database.Database,
  entryId: string,
  types: EdgeType[],
): Array<{ edge: MemoryEdge; neighborEntry: MemoryEntry }> {
  const placeholders = types.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT e.*, m.id as m_id, m.layer as m_layer, m.content_type as m_content_type,
           m.source_id as m_source_id, m.source_table as m_source_table,
           m.conversation_id as m_conversation_id, m.granularity as m_granularity,
           m.content as m_content, m.metadata as m_metadata, m.created_at as m_created_at
    FROM memory_edges e
    JOIN memory_entries m ON m.id = CASE WHEN e.from_entry_id = ? THEN e.to_entry_id ELSE e.from_entry_id END
    WHERE e.edge_type IN (${placeholders})
      AND (e.from_entry_id = ? OR e.to_entry_id = ?)
  `).all(entryId, ...types, entryId, entryId) as Array<Record<string, unknown>>;
  return rows.map(row => ({ edge: rowToMemoryEdge(row), neighborEntry: rowToMemoryEntryJoined(row) }));
}

/** 按 id 获取单条边 */
export function getEdgeById(db: Database.Database, edgeId: string): MemoryEdge | null {
  const row = db.prepare(`SELECT * FROM memory_edges WHERE id = ?`).get(edgeId) as Record<string, unknown> | undefined;
  return row ? rowToMemoryEdge(row) : null;
}

/** 删除一条边（unlink_memory 用） */
export function deleteEdge(db: Database.Database, edgeId: string): void {
  db.prepare(`DELETE FROM memory_edges WHERE id = ?`).run(edgeId);
}

/**
 * F20260813mren D7: 按 entry id 批量清理关联边。
 * deleteBySource / replaceEntryBySource 等 delete 路径调。
 * 不依赖 FK CASCADE（与 embedding_tasks 一致模式）。
 */
export function deleteEdgesByEntryIds(db: Database.Database, entryIds: string[]): void {
  if (entryIds.length === 0) return;
  const placeholders = entryIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM memory_edges WHERE from_entry_id IN (${placeholders}) OR to_entry_id IN (${placeholders})`,
  ).run(...entryIds, ...entryIds);
}
