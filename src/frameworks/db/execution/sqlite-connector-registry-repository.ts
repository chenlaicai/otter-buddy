import type Database from "better-sqlite3";
import type { Device } from "@entities/execution/device";
import type {
  OnlineSession,
  OnlineSessionDisconnectReason,
} from "@entities/execution/online-session";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";

interface DeviceRow {
  id: string;
  name: string;
  pair_token: string;
  created_at: string;
  last_seen_at: string | null;
}

interface OnlineSessionRow {
  id: string;
  device_id: string;
  status: string;
  connected_at: string;
  disconnected_at: string | null;
  disconnect_reason: string | null;
  last_seen_at: string;
  protocol_version: number | null;
}

function rowToDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    pairToken: row.pair_token,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function rowToSession(row: OnlineSessionRow): OnlineSession {
  return {
    id: row.id,
    deviceId: row.device_id,
    status: row.status as OnlineSession["status"],
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    disconnectReason: row.disconnect_reason as OnlineSessionDisconnectReason,
    lastSeenAt: row.last_seen_at,
    protocolVersion: row.protocol_version,
  };
}

/**
 * connector 注册仓库 sqlite 实现。
 * 总闸唯一事实源——所有状态变更先落库，内存投影（Registry/WSS 通道）随后跟进；
 * 库写失败由调用方收敛 fail-closed（宁可误下线不可误放行）。
 */
export class SqliteConnectorRegistryRepository implements ConnectorRegistryRepository {
  constructor(private readonly db: Database.Database) {}

  async createPairingCode(code: string, expiresAt: string): Promise<void> {
    this.db.prepare(
      "INSERT OR REPLACE INTO pairing_codes (code, created_at, expires_at, redeemed_at) VALUES (?, ?, ?, NULL)",
    ).run(code, new Date().toISOString(), expiresAt);
  }

  async redeemPairingCode(code: string, now: string): Promise<boolean> {
    // 原子核销：仅当未核销且未过期时 UPDATE 命中（changes=1）——重放/过期/不存在都返回 false
    const result = this.db.prepare(
      "UPDATE pairing_codes SET redeemed_at = ? WHERE code = ? AND redeemed_at IS NULL AND expires_at > ?",
    ).run(now, code, now);
    return result.changes > 0;
  }

  async redeemAndCreateDevice(code: string, device: Device, now: string): Promise<boolean> {
    // 检视 s6：事务原子化——核销失败不建设备（消除「码已烧但设备未建」窗口）
    const runAll = this.db.transaction((): boolean => {
      const redeemed = this.db.prepare(
        "UPDATE pairing_codes SET redeemed_at = ? WHERE code = ? AND redeemed_at IS NULL AND expires_at > ?",
      ).run(now, code, now);
      if (redeemed.changes === 0) return false;
      this.db.prepare(
        "INSERT INTO devices (id, name, pair_token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      ).run(device.id, device.name, device.pairToken, device.createdAt, device.lastSeenAt);
      return true;
    });
    return runAll();
  }

  async createDevice(device: Device): Promise<void> {
    this.db.prepare(
      "INSERT INTO devices (id, name, pair_token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    ).run(device.id, device.name, device.pairToken, device.createdAt, device.lastSeenAt);
  }

  async findDeviceByToken(token: string): Promise<Device | null> {
    const row = this.db.prepare(
      "SELECT * FROM devices WHERE pair_token = ?",
    ).get(token) as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  /** （检视）：设备在线状态全量视图——离线已配对设备也返回（「已配对设备
   *  含在线状态点」——设备下线不自动回切，人要看得见才能决定切回/等重连） */
  async listDeviceOnlineStatus(): Promise<Array<{ deviceId: string; name: string; online: boolean; lastSeenAt: string | null }>> {
    const rows = this.db.prepare(
      "SELECT d.id AS deviceId, d.name AS name, "
      + "CASE WHEN o.status = 'online' THEN 1 ELSE 0 END AS online, "
      + "COALESCE(o.last_seen_at, d.last_seen_at) AS lastSeenAt "
      + "FROM devices d LEFT JOIN online_sessions o ON o.device_id = d.id AND o.status = 'online' "
      + "ORDER BY d.created_at ASC",
    ).all() as Array<{ deviceId: string; name: string; online: number; lastSeenAt: string | null }>;
    return rows.map(r => ({ deviceId: r.deviceId, name: r.name, online: r.online === 1, lastSeenAt: r.lastSeenAt }));
  }

  async deleteDevice(deviceId: string): Promise<void> {
    // 级联：删设备同时把其 online 行关掉（token 失效即执行授权失效）
    this.db.prepare(
      "UPDATE online_sessions SET status = 'offline', disconnected_at = ?, disconnect_reason = 'auth-failed' WHERE device_id = ? AND status = 'online'",
    ).run(new Date().toISOString(), deviceId);
    this.db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
  }

  async touchDeviceLastSeen(deviceId: string, at: string): Promise<void> {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, deviceId);
  }

  async openOnlineSession(session: OnlineSession): Promise<void> {
    const runAll = this.db.transaction(() => {
      // 顶替语义：同 device 旧 online 行先关（唯一索引兜底——不先关 INSERT 会撞索引）
      this.db.prepare(
        "UPDATE online_sessions SET status = 'offline', disconnected_at = ?, disconnect_reason = 'device-offline' WHERE device_id = ? AND status = 'online'",
      ).run(session.connectedAt, session.deviceId);
      this.db.prepare(
        "INSERT INTO online_sessions (id, device_id, status, connected_at, disconnected_at, disconnect_reason, last_seen_at, protocol_version) "
        + "VALUES (?, ?, 'online', ?, NULL, NULL, ?, ?)",
      ).run(session.id, session.deviceId, session.connectedAt, session.lastSeenAt, session.protocolVersion);
    });
    runAll();
  }

  async getOnlineSession(sessionId: string): Promise<OnlineSession | null> {
    const row = this.db.prepare(
      "SELECT * FROM online_sessions WHERE id = ?",
    ).get(sessionId) as OnlineSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async touchOnlineSession(sessionId: string, at: string): Promise<void> {
    this.db.prepare(
      "UPDATE online_sessions SET last_seen_at = ? WHERE id = ? AND status = 'online'",
    ).run(at, sessionId);
  }

  async closeOnlineSession(
    sessionId: string,
    reason: Exclude<OnlineSessionDisconnectReason, null>,
    at: string,
  ): Promise<void> {
    // 幂等：已 offline 不改写（先到的 reason 是真相）
    this.db.prepare(
      "UPDATE online_sessions SET status = 'offline', disconnected_at = ?, disconnect_reason = ? "
      + "WHERE id = ? AND status = 'online'",
    ).run(at, reason, sessionId);
  }

  async listOnlineSessionsByDevice(deviceId: string): Promise<Array<{ id: string; status: string; connectedAt: string }>> {
    const rows = this.db.prepare(
      "SELECT id, status, connected_at FROM online_sessions WHERE device_id = ? AND status = 'online' ORDER BY connected_at DESC LIMIT 1",
    ).all(deviceId) as Array<{ id: string; status: string; connected_at: string }>;
    return rows.map(r => ({ id: r.id, status: r.status, connectedAt: r.connected_at }));
  }

  async sweepStaleOnlineSessions(at: string): Promise<number> {
    const result = this.db.prepare(
      "UPDATE online_sessions SET status = 'offline', disconnected_at = ?, disconnect_reason = 'hub-restart' WHERE status = 'online'",
    ).run(at);
    return result.changes;
  }
}
