import type {
  HealingEvent,
  HealingErrorType,
  HealingSeverity,
  HealingEventStatus,
  HealingResolution,
} from '@entities/healing/healing-event';

/** SQLite 行类型 */
export interface HealingEventRow {
  id: string;
  message_id: string;
  conversation_id: string;
  otter_id: string;
  error_type: string;
  severity: string;
  description: string;
  suggestion: string;
  context: string | null;  // JSON
  status: string;
  resolution: string | null;  // JSON
  created_at: string;
  resolved_at: string | null;
}

/** DB Row -> Entity */
export function rowToHealingEvent(row: HealingEventRow): HealingEvent {
  let context: Record<string, unknown> | null = null;
  if (row.context) {
    try { context = JSON.parse(row.context); } catch { /* ignore */ }
  }

  let resolution: HealingResolution | null = null;
  if (row.resolution) {
    try { resolution = JSON.parse(row.resolution); } catch { /* ignore */ }
  }

  return {
    id: row.id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    otterId: row.otter_id,
    errorType: row.error_type as HealingErrorType,
    severity: row.severity as HealingSeverity,
    description: row.description,
    suggestion: row.suggestion,
    context,
    status: row.status as HealingEventStatus,
    resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** Entity -> DB params */
export function eventToRow(event: HealingEvent): HealingEventRow {
  return {
    id: event.id,
    message_id: event.messageId,
    conversation_id: event.conversationId,
    otter_id: event.otterId,
    error_type: event.errorType,
    severity: event.severity,
    description: event.description,
    suggestion: event.suggestion,
    context: event.context ? JSON.stringify(event.context) : null,
    status: event.status,
    resolution: event.resolution ? JSON.stringify(event.resolution) : null,
    created_at: event.createdAt,
    resolved_at: event.resolvedAt,
  };
}
