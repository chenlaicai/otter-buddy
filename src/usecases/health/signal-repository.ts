/**
 * SignalRepository: signals 表读写（Issue #399/#400）
 *
 * 信号状态机：open → (acknowledged) → resolved/dismissed。
 * 相同 signal_type + feature_id/file_path 的重复触发做 occurrences 累加
 * 而非新开一行（特性文档 signals 表设计：first_seen/last_seen/occurrences）。
 */

import type Database from "better-sqlite3";

export interface SignalRecord {
  id: number;
  signal_type: string;
  severity: string;
  feature_id: string | null;
  file_path: string | null;
  evidence: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  status: string;
  suggested_action: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface UpsertSignal {
  signalType: string;
  severity: string;
  featureId: string | null;
  filePath: string | null;
  evidence: string;
  suggestedAction: string | null;
}

export class SignalRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * upsert：open 状态的同键信号 occurrences+1 / last_seen 刷新；
   * 无匹配则新开一行。返回受影响行。
   */
  upsert(signal: UpsertSignal, seenAt: Date = new Date()): SignalRecord {
    const now = seenAt.toISOString();

    const existing = this.db
      .prepare(`
        SELECT * FROM signals
        WHERE status = 'open' AND signal_type = ?
          AND COALESCE(feature_id, '') = COALESCE(?, '')
          AND COALESCE(file_path, '') = COALESCE(?, '')
        ORDER BY id DESC LIMIT 1
      `)
      .get(signal.signalType, signal.featureId, signal.filePath) as SignalRecord | undefined;

    if (existing) {
      this.db
        .prepare(`UPDATE signals SET last_seen = ?, occurrences = occurrences + 1, evidence = ? WHERE id = ?`)
        .run(now, signal.evidence, existing.id);
      return { ...existing, last_seen: now, occurrences: existing.occurrences + 1, evidence: signal.evidence };
    }

    // id 为 INTEGER PRIMARY KEY AUTOINCREMENT（Phase 0 schema 定义），用自增 id 而非 UUID
    const r = this.db
      .prepare(`
        INSERT INTO signals (signal_type, severity, feature_id, file_path, evidence,
                             first_seen, last_seen, occurrences, status, suggested_action)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'open', ?)
      `)
      .run(
        signal.signalType, signal.severity, signal.featureId, signal.filePath,
        signal.evidence, now, now, signal.suggestedAction,
      );
    const id = Number(r.lastInsertRowid);

    return {
      id,
      signal_type: signal.signalType,
      severity: signal.severity,
      feature_id: signal.featureId,
      file_path: signal.filePath,
      evidence: signal.evidence,
      first_seen: now,
      last_seen: now,
      occurrences: 1,
      status: "open",
      suggested_action: signal.suggestedAction,
      created_at: now,
      resolved_at: null,
    };
  }

  findOpen(): SignalRecord[] {
    return this.db
      .prepare("SELECT * FROM signals WHERE status = 'open' ORDER BY last_seen DESC")
      .all() as SignalRecord[];
  }

  findByStatus(status: string): SignalRecord[] {
    return this.db
      .prepare("SELECT * FROM signals WHERE status = ? ORDER BY last_seen DESC")
      .all(status) as SignalRecord[];
  }

  resolve(id: number, resolvedAt: Date = new Date()): boolean {
    const r = this.db
      .prepare("UPDATE signals SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'")
      .run(resolvedAt.toISOString(), id);
    return r.changes > 0;
  }

  dismiss(id: number, resolvedAt: Date = new Date()): boolean {
    const r = this.db
      .prepare("UPDATE signals SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'open'")
      .run(resolvedAt.toISOString(), id);
    return r.changes > 0;
  }

  /** 已解决/已忽略信号保留 N 天后清除（数据保留策略） */
  purgeClosed(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare("DELETE FROM signals WHERE status != 'open' AND COALESCE(resolved_at, '') < ?")
      .run(cutoff).changes;
  }
}
