import type Database from "better-sqlite3";
import type {
  Invoke,
  InvokeStatus,
  InvokeEvent,
  InvokeEventType,
} from "@entities/conversation/invoke";
import type {
  InvokeRepository,
  GetInvokesOptions,
} from "@usecases/conversation/invoke-repository";

/** Invoke 表行类型 */
interface InvokeRow {
  id: string;
  conversation_id: string;
  otter_id: string;
  status: string;
  trigger_entry_id: string | null;
  talking_stone_passed_to: string | null;
  started_at: string;
  ended_at: string | null;
  tool_call_count: number;
  token_usage_input: number | null;
  token_usage_output: number | null;
  metadata: string | null;
}

function rowToInvoke(row: InvokeRow): Invoke {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    otterId: row.otter_id,
    status: row.status as InvokeStatus,
    triggerEntryId: row.trigger_entry_id,
    talkingStonePassedTo: row.talking_stone_passed_to
      ? (JSON.parse(row.talking_stone_passed_to) as string[])
      : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    toolCallCount: row.tool_call_count,
    tokenUsageInput: row.token_usage_input,
    tokenUsageOutput: row.token_usage_output,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  };
}

interface InvokeEventRow {
  id: string;
  invoke_id: string;
  event_type: string;
  payload: string;
  sequence_num: number;
  created_at: string;
}

function rowToInvokeEvent(row: InvokeEventRow): InvokeEvent {
  return {
    id: row.id,
    invokeId: row.invoke_id,
    eventType: row.event_type as InvokeEventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    sequenceNum: row.sequence_num,
    createdAt: row.created_at,
  };
}

export class SqliteInvokeRepository implements InvokeRepository {
  constructor(private readonly db: Database.Database) {}

  async createInvoke(invoke: Invoke): Promise<void> {
    this.db.prepare(`
      INSERT INTO invokes (
        id, conversation_id, otter_id, status, trigger_entry_id,
        talking_stone_passed_to, started_at, ended_at, tool_call_count,
        token_usage_input, token_usage_output, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invoke.id, invoke.conversationId, invoke.otterId, invoke.status,
      invoke.triggerEntryId,
      invoke.talkingStonePassedTo ? JSON.stringify(invoke.talkingStonePassedTo) : null,
      invoke.startedAt, invoke.endedAt, invoke.toolCallCount,
      invoke.tokenUsageInput, invoke.tokenUsageOutput,
      invoke.metadata ? JSON.stringify(invoke.metadata) : null,
    );
  }

  async updateInvokeStatus(
    invokeId: string,
    status: InvokeStatus,
    endedAt?: string,
  ): Promise<void> {
    if (endedAt) {
      this.db.prepare(
        "UPDATE invokes SET status = ?, ended_at = ? WHERE id = ?",
      ).run(status, endedAt, invokeId);
    } else {
      this.db.prepare(
        "UPDATE invokes SET status = ? WHERE id = ?",
      ).run(status, invokeId);
    }
  }

  async updateInvokeTalkingStonePassedTo(
    invokeId: string,
    talkingStonePassedTo: string[],
  ): Promise<void> {
    this.db.prepare(
      "UPDATE invokes SET talking_stone_passed_to = ? WHERE id = ?",
    ).run(JSON.stringify(talkingStonePassedTo), invokeId);
  }

  async updateInvokeToolCallCount(invokeId: string, count: number): Promise<void> {
    this.db.prepare(
      "UPDATE invokes SET tool_call_count = ? WHERE id = ?",
    ).run(count, invokeId);
  }

  async updateInvokeTokenUsage(
    invokeId: string,
    input: number,
    output: number,
  ): Promise<void> {
    this.db.prepare(
      "UPDATE invokes SET token_usage_input = ?, token_usage_output = ? WHERE id = ?",
    ).run(input, output, invokeId);
  }

  async updateInvokeMetadata(
    invokeId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.db.prepare(
      "UPDATE invokes SET metadata = ? WHERE id = ?",
    ).run(JSON.stringify(metadata), invokeId);
  }

  async getInvokeById(id: string): Promise<Invoke | null> {
    const row = this.db.prepare("SELECT * FROM invokes WHERE id = ?")
      .get(id) as InvokeRow | undefined;
    return row ? rowToInvoke(row) : null;
  }

  async getInvokes(
    conversationId: string,
    options?: GetInvokesOptions,
  ): Promise<Invoke[]> {
    const limit = options?.limit ?? 50;
    let sql = "SELECT * FROM invokes WHERE conversation_id = ?";
    const params: unknown[] = [conversationId];

    if (options?.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }
    if (options?.otterId) {
      sql += " AND otter_id = ?";
      params.push(options.otterId);
    }
    if (options?.before) {
      sql += " AND started_at < (SELECT started_at FROM invokes WHERE id = ?)";
      params.push(options.before);
    }

    sql += " ORDER BY started_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as InvokeRow[];
    return rows.map(rowToInvoke);
  }

  async getActiveInvokeByOtterId(
    conversationId: string,
    otterId: string,
  ): Promise<Invoke | null> {
    const row = this.db.prepare(
      "SELECT * FROM invokes WHERE conversation_id = ? AND otter_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    ).get(conversationId, otterId) as InvokeRow | undefined;
    return row ? rowToInvoke(row) : null;
  }

  async getInvokeByTriggerEntryId(triggerEntryId: string): Promise<Invoke | null> {
    const row = this.db.prepare(
      "SELECT * FROM invokes WHERE trigger_entry_id = ?",
    ).get(triggerEntryId) as InvokeRow | undefined;
    return row ? rowToInvoke(row) : null;
  }

  /** F20260913ctlv 彻底切换：按 turn 查 invokes（tryCloseTurn 判据） */
  async getInvokesByTurnId(turnId: string): Promise<Invoke[]> {
    const rows = this.db.prepare(
      "SELECT DISTINCT i.* FROM invokes i JOIN entries e ON e.invoke_id = i.id WHERE e.turn_id = ?",
    ).all(turnId) as InvokeRow[];
    return rows.map(rowToInvoke);
  }

  /** F20260913ctlv 彻底切换：重启 reconcile——running invokes 全部置 failed */
  async failRunningInvokes(failedAt: string): Promise<number> {
    const result = this.db.prepare(
      "UPDATE invokes SET status = 'failed', ended_at = ? WHERE status = 'running'",
    ).run(failedAt);
    return result.changes;
  }

  async appendInvokeEvent(event: InvokeEvent): Promise<void> {
    this.db.prepare(`
      INSERT INTO invoke_events (id, invoke_id, event_type, payload, sequence_num, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.invokeId, event.eventType,
      JSON.stringify(event.payload), event.sequenceNum, event.createdAt,
    );
  }

  async getInvokeEvents(invokeId: string): Promise<InvokeEvent[]> {
    const rows = this.db.prepare(
      "SELECT * FROM invoke_events WHERE invoke_id = ? ORDER BY sequence_num ASC",
    ).all(invokeId) as InvokeEventRow[];
    return rows.map(rowToInvokeEvent);
  }

  async getInvokeEventsByInvokeIds(invokeIds: string[]): Promise<InvokeEvent[]> {
    if (invokeIds.length === 0) return [];
    const placeholders = invokeIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM invoke_events WHERE invoke_id IN (${placeholders}) ORDER BY sequence_num ASC`,
    ).all(...invokeIds) as InvokeEventRow[];
    return rows.map(rowToInvokeEvent);
  }

  async getMaxEventSequenceNum(invokeId: string): Promise<number> {
    const row = this.db.prepare(
      "SELECT MAX(sequence_num) as max_seq FROM invoke_events WHERE invoke_id = ?",
    ).get(invokeId) as { max_seq: number | null };
    return row.max_seq ?? 0;
  }
}
