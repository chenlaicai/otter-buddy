import type Database from "better-sqlite3";
import type { RemoteActionRequest, RemoteActionStatus } from "@entities/execution/remote-action-request";
import type { RemoteActionRegistry } from "@usecases/ports/remote-action-registry";

interface Row {
  action_id: string;
  online_session_id: string;
  device_id: string;
  action_type: string;
  status: string;
  error: string | null;
  result: string | null;
  created_at: string;
  settled_at: string | null;
  conversation_id: string | null;
  invoke_id: string | null;
}

function rowToReq(row: Row): RemoteActionRequest {
  return {
    actionId: row.action_id,
    onlineSessionId: row.online_session_id,
    deviceId: row.device_id,
    actionType: row.action_type,
    status: row.status as RemoteActionStatus,
    error: row.error,
    result: row.result,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    conversationId: row.conversation_id,
    invokeId: row.invoke_id,
  };
}

/** remote_action_requests sqlite 实现。 */
export class SqliteRemoteActionRegistry implements RemoteActionRegistry {
  constructor(private readonly db: Database.Database) {}

  async recordRequest(req: RemoteActionRequest): Promise<boolean> {
    try {
      this.db.prepare(
        "INSERT INTO remote_action_requests (action_id, online_session_id, device_id, action_type, status, error, result, created_at, settled_at, conversation_id, invoke_id) "
        + "VALUES (?, ?, ?, ?, 'requested', NULL, NULL, ?, NULL, ?, ?)",
      ).run(req.actionId, req.onlineSessionId, req.deviceId, req.actionType, req.createdAt, req.conversationId, req.invokeId);
      return true;
    } catch (err) {
      // （检视）：仅 PK 冲突是「重复 actionId」语义（返 false 调用方 fail-closed）；
      //  其他库故障（locked/磁盘满/语句错）重新抛出——错误归因不错位，排障有线索
      const code = (err as { code?: string }).code ?? "";
      if (code.includes("SQLITE_CONSTRAINT")) return false;
      throw err;
    }
  }

  async settleRequest(actionId: string, status: Exclude<RemoteActionStatus, "requested">, settledAt: string, result?: unknown, error?: string): Promise<void> {
    // 幂等：仅 requested 行可落终态（先到的真相保持，晚到回执不改写）
    this.db.prepare(
      "UPDATE remote_action_requests SET status = ?, settled_at = ?, result = COALESCE(?, result), error = COALESCE(?, error) "
      + "WHERE action_id = ? AND status = 'requested'",
    ).run(status, settledAt, result === undefined ? null : JSON.stringify(result), error ?? null, actionId);
  }

  async listByStatuses(statuses: RemoteActionStatus[], limit = 200): Promise<RemoteActionRequest[]> {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM remote_action_requests WHERE status IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`,
    ).all(...statuses, limit) as Row[];
    return rows.map(rowToReq);
  }

  async listByConversation(conversationId: string, limit = 200, order: "asc" | "desc" = "asc"): Promise<RemoteActionRequest[]> {
    // s2（检视遗留处置）：rowid tie-breaker——created_at 毫秒精度同值时 DESC LIMIT 边界不定序
    const dir = order === "desc" ? "DESC" : "ASC";
    const rows = this.db.prepare(
      `SELECT * FROM remote_action_requests WHERE conversation_id = ? ORDER BY created_at ${dir}, rowid ${dir} LIMIT ?`,
    ).all(conversationId, limit) as Row[];
    return rows.map(rowToReq);
  }

  async markSessionRequests(onlineSessionId: string, status: "interrupted" | "unknown", settledAt: string, error: string): Promise<number> {
    const result = this.db.prepare(
      "UPDATE remote_action_requests SET status = ?, settled_at = ?, error = COALESCE(error, ?) "
      + "WHERE online_session_id = ? AND status = 'requested'",
    ).run(status, settledAt, error, onlineSessionId);
    return result.changes;
  }

  /** （检视）：中枢硬崩溃重启后，残留 requested 行统一落 unknown（hub 停摆期间
   *  在途动作无人收尾——真相不明；与 sweepStaleOnlineSessions 同位调用） */
  async sweepStaleRequested(settledAt: string): Promise<number> {
    const result = this.db.prepare(
      "UPDATE remote_action_requests SET status = 'unknown', settled_at = ?, error = COALESCE(error, 'hub restart before result') "
      + "WHERE status = 'requested'",
    ).run(settledAt);
    return result.changes;
  }
}
