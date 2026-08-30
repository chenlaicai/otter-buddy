/**
 * HealthSnapshotRepository: health_snapshots 表读写（Issue #396）
 *
 * SQLite 持久化指标快照，支持按日期/日期范围/指标键查询。
 * schema 定义见 frameworks/db/schema.ts createHealthSnapshotsTable。
 */

import type Database from "better-sqlite3";

export interface HealthSnapshot {
  id: number;
  snapshot_date: string;
  metric_type: string;
  metric_key: string;
  metric_value: number;
  metadata: string | null;
  created_at: string;
}

export interface CreateHealthSnapshot {
  snapshotDate: string;
  metricType: string;
  metricKey: string;
  metricValue: number;
  metadata?: string;
}

export class HealthSnapshotRepository {
  private readonly insertStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO health_snapshots (snapshot_date, metric_type, metric_key, metric_value, metadata)
      VALUES (@snapshotDate, @metricType, @metricKey, @metricValue, @metadata)
    `);
  }

  /** 批量写入（单事务） */
  createBatch(snapshots: CreateHealthSnapshot[]): HealthSnapshot[] {
    const tx = this.db.transaction((rows: CreateHealthSnapshot[]) => {
      const results: HealthSnapshot[] = [];
      for (const s of rows) {
        const r = this.insertStmt.run({
          snapshotDate: s.snapshotDate,
          metricType: s.metricType,
          metricKey: s.metricKey,
          metricValue: s.metricValue,
          metadata: s.metadata ?? null,
        });
        results.push({
          id: Number(r.lastInsertRowid),
          snapshot_date: s.snapshotDate,
          metric_type: s.metricType,
          metric_key: s.metricKey,
          metric_value: s.metricValue,
          metadata: s.metadata ?? null,
          created_at: new Date().toISOString(),
        });
      }
      return results;
    });
    return tx(snapshots);
  }

  /** 同日覆盖写入：单事务内先删当日旧快照再批量插入（对抗审视发现 4）。
   *  @param metricType 可选，指定后只删除该 metric_type 的行（避免误删其他类型数据）。
   *                   #583 修复：cost_output 全局行按历史日期分批写入，需类型限定删除范围。 */
  replaceForDate(snapshotDate: string, snapshots: CreateHealthSnapshot[], metricType?: string): HealthSnapshot[] {
    const tx = this.db.transaction((rows: CreateHealthSnapshot[]) => {
      if (metricType) {
        this.db
          .prepare("DELETE FROM health_snapshots WHERE snapshot_date = ? AND metric_type = ?")
          .run(snapshotDate, metricType);
      } else {
        this.db
          .prepare("DELETE FROM health_snapshots WHERE snapshot_date = ?")
          .run(snapshotDate);
      }
      return this.createBatch(rows);
    });
    return tx(snapshots);
  }

  findByDate(date: string): HealthSnapshot[] {
    return this.db
      .prepare("SELECT * FROM health_snapshots WHERE snapshot_date = ? ORDER BY id")
      .all(date) as HealthSnapshot[];
  }

  findByDateRange(startDate: string, endDate: string): HealthSnapshot[] {
    return this.db
      .prepare("SELECT * FROM health_snapshots WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date, id")
      .all(startDate, endDate) as HealthSnapshot[];
  }

  findByMetricKey(metricKey: string): HealthSnapshot[] {
    return this.db
      .prepare("SELECT * FROM health_snapshots WHERE metric_key = ? ORDER BY snapshot_date DESC")
      .all(metricKey) as HealthSnapshot[];
  }

  findLatestByMetricKey(metricKey: string): HealthSnapshot | null {
    return (this.db
      .prepare("SELECT * FROM health_snapshots WHERE metric_key = ? ORDER BY snapshot_date DESC, id DESC LIMIT 1")
      .get(metricKey) as HealthSnapshot | undefined) ?? null;
  }

  /** 删除 N 天前的快照（数据保留策略：默认 90 天） */
  deleteOlderThan(days: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return this.db
      .prepare("DELETE FROM health_snapshots WHERE snapshot_date < ?")
      .run(cutoff.toISOString().slice(0, 10)).changes;
  }

  /** 查询 status='active' 的 otter ID 列表（#583 active 过滤用） */
  findActiveOtterIds(): string[] {
    return (this.db
      .prepare("SELECT id FROM otters WHERE status = 'active'")
      .all() as Array<{ id: string }>)
      .map(r => r.id);
  }
}
