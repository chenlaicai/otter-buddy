import type {
  SignalEvent,
  SignalQueryFilter,
  SignalSeverity,
  SignalStatus,
  SignalType,
} from '@entities/signal/signal-event';

/** SQLite 行类型（snake_case，schema.ts createSignalsTable） */
export interface SignalEventRow {
  id: string;
  conversation_id: string;
  message_id: string;
  from_otter_id: string;
  target_otter_id: string | null;
  type: string;
  severity: string;
  payload: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

/** DB Row -> Entity */
export function rowToSignalEvent(row: SignalEventRow): SignalEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    fromOtterId: row.from_otter_id,
    targetOtterId: row.target_otter_id,
    type: row.type as SignalType,
    severity: row.severity as SignalSeverity,
    payload: row.payload,
    status: row.status as SignalStatus,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

/** Entity -> DB Row 值元组（INSERT 用，列序与 sqlite-signal-repository 一致） */
export function signalEventToInsertValues(event: SignalEvent): unknown[] {
  return [
    event.id,
    event.conversationId,
    event.messageId,
    event.fromOtterId,
    event.targetOtterId,
    event.type,
    event.severity,
    event.payload,
    event.status,
    event.resolution,
    event.resolvedBy,
    event.resolvedAt,
    event.createdAt,
  ];
}

/** 查询过滤 WHERE 片段（AND 拼接，参数数组同步返回） */
export function buildSignalFilterClause(filter: SignalQueryFilter | undefined): { clause: string; params: unknown[] } {
  if (!filter) return { clause: '', params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.type) { parts.push('type = ?'); params.push(filter.type); }
  if (filter.status) { parts.push('status = ?'); params.push(filter.status); }
  if (filter.fromOtterId) { parts.push('from_otter_id = ?'); params.push(filter.fromOtterId); }
  if (filter.targetOtterId) { parts.push('target_otter_id = ?'); params.push(filter.targetOtterId); }
  return { clause: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}
