/**
 * 领域对象 <-> DB 行映射。
 *
 * 映射规则参见 F20260713o4t8 设计文档。
 */

import type {
  Otter,
  OtterRole,
  OtterSession,
  OtterStatus,
  OtterType,
  SessionStatus,
} from "../model";

/** DB 行类型（better-sqlite3 返回） */
export interface OtterRow {
  id: string;
  name: string;
  type: string;
  status: string;
  role_name: string | null;
  role_responsibilities: string | null;
  parent_otter_id: string | null;
  created_at: string;
  dissolved_at: string | null;
}

export interface SessionRow {
  id: string;
  otter_id: string;
  status: string;
  started_at: string;
  archived_at: string | null;
  archive_reason: string | null;
  is_negative_case: number;
  summary: string | null;
}

export function rowToOtter(row: OtterRow): Otter {
  const role: OtterRole | null =
    row.role_name !== null
      ? {
          name: row.role_name,
          responsibilities: row.role_responsibilities
            ? (JSON.parse(row.role_responsibilities) as string[])
            : [],
        }
      : null;

  return {
    id: row.id,
    name: row.name,
    type: row.type as OtterType,
    status: row.status as OtterStatus,
    role,
    parentOtterId: row.parent_otter_id,
    createdAt: row.created_at,
    dissolvedAt: row.dissolved_at,
  };
}

export function rowToSession(row: SessionRow): OtterSession {
  return {
    id: row.id,
    otterId: row.otter_id,
    status: row.status as SessionStatus,
    startedAt: row.started_at,
    archivedAt: row.archived_at,
    archiveReason: row.archive_reason,
    isNegativeCase: row.is_negative_case === 1,
    summary: row.summary,
  };
}
