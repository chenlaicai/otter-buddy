import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";

export interface HealthSnapshot {
  id: number;
  snapshotDate: string;
  metricType: string;
  metricKey: string;
  metricValue: number;
  metadata: string | null;
  createdAt: string;
}

export interface CreateHealthSnapshot {
  snapshotDate: string;
  metricType: string;
  metricKey: string;
  metricValue: number;
  metadata?: string;
}

/**
 * 健康快照仓库。
 * 使用 SQLite 持久化指标。
 */
export class HealthSnapshotRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
  ) {}

  /**
   * 创建健康快照。
   * @param snapshot 快照数据
   * @returns 创建的快照
   */
  create(snapshot: CreateHealthSnapshot): HealthSnapshot {
    const stmt = this.db.prepare(`
      INSERT INTO health_snapshots (snapshot_date, metric_type, metric_key, metric_value, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      snapshot.snapshotDate,
      snapshot.metricType,
      snapshot.metricKey,
      snapshot.metricValue,
      snapshot.metadata || null,
    );

    return {
      id: result.lastInsertRowid as number,
      snapshotDate: snapshot.snapshotDate,
      metricType: snapshot.metricType,
      metricKey: snapshot.metricKey,
      metricValue: snapshot.metricValue,
      metadata: snapshot.metadata || null,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 批量创建健康快照。
   * @param snapshots 快照列表
   * @returns 创建的快照列表
   */
  createBatch(snapshots: CreateHealthSnapshot[]): HealthSnapshot[] {
    const stmt = this.db.prepare(`
      INSERT INTO health_snapshots (snapshot_date, metric_type, metric_key, metric_value, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    const results: HealthSnapshot[] = [];

    const transaction = this.db.transaction(() => {
      for (const snapshot of snapshots) {
        const result = stmt.run(
          snapshot.snapshotDate,
          snapshot.metricType,
          snapshot.metricKey,
          snapshot.metricValue,
          snapshot.metadata || null,
        );

        results.push({
          id: result.lastInsertRowid as number,
          snapshotDate: snapshot.snapshotDate,
          metricType: snapshot.metricType,
          metricKey: snapshot.metricKey,
          metricValue: snapshot.metricValue,
          metadata: snapshot.metadata || null,
          createdAt: new Date().toISOString(),
        });
      }
    });

    transaction();
    return results;
  }

  /**
   * 按日期查询快照。
   * @param date 日期
   * @returns 快照列表
   */
  findByDate(date: string): HealthSnapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM health_snapshots WHERE snapshot_date = ?
    `);

    return stmt.all(date) as HealthSnapshot[];
  }

  /**
   * 按日期范围查询快照。
   * @param startDate 开始日期
   * @param endDate 结束日期
   * @returns 快照列表
   */
  findByDateRange(startDate: string, endDate: string): HealthSnapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM health_snapshots WHERE snapshot_date BETWEEN ? AND ?
    `);

    return stmt.all(startDate, endDate) as HealthSnapshot[];
  }

  /**
   * 按指标类型查询最新快照。
   * @param metricType 指标类型
   * @returns 最新快照或 null
   */
  findLatestByType(metricType: string): HealthSnapshot | null {
    const stmt = this.db.prepare(`
      SELECT * FROM health_snapshots WHERE metric_type = ?
      ORDER BY snapshot_date DESC LIMIT 1
    `);

    return stmt.get(metricType) as HealthSnapshot | null;
  }

  /**
   * 按指标键查询快照。
   * @param metricKey 指标键
   * @returns 快照列表
   */
  findByKey(metricKey: string): HealthSnapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM health_snapshots WHERE metric_key = ?
      ORDER BY snapshot_date DESC
    `);

    return stmt.all(metricKey) as HealthSnapshot[];
  }

  /**
   * 删除旧快照（保留最近 N 天）。
   * @param daysToKeep 保留天数
   * @returns 删除的快照数量
   */
  deleteOldSnapshots(daysToKeep: number): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffDateStr = cutoffDate.toISOString().split("T")[0];

    const stmt = this.db.prepare(`
      DELETE FROM health_snapshots WHERE snapshot_date < ?
    `);

    const result = stmt.run(cutoffDateStr);
    return result.changes;
  }
}
