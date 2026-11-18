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
  };
}

/** F20261118remex（#1868 阶段 4 C2）：remote_action_requests sqlite 实现。 */
export class SqliteRemoteActionRegistry implements RemoteActionRegistry {
  constructor(private readonly db: Database.Database) {}

  async recordRequest(req: RemoteActionRequest): Promise<boolean> {
    try {
      this.db.prepare(
        "INSERT INTO remote_action_requests (action_id, online_session_id, device_id, action_type, status, error, result, created_at, settled_at) "
        + "VALUES (?, ?, ?, ?, 'requested', NULL, NULL, ?, NULL)",
      ).run(req.actionId, req.onlineSessionId, req.deviceId, req.actionType, req.createdAt);
      return true;
    } catch {
      return false; // PK 冲突（重复 actionId）——调用方 fail-closed
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

  async markSessionRequestsUnknown(onlineSessionId: string, settledAt: string): Promise<number> {
    const result = this.db.prepare(
      "UPDATE remote_action_requests SET status = 'unknown', settled_at = ?, error = COALESCE(error, 'device offline before result') "
      + "WHERE online_session_id = ? AND status = 'requested'",
    ).run(settledAt, onlineSessionId);
    return result.changes;
  }
}
