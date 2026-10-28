/**
 * F20261027hwl1 cost_output 旧口径失效钩子测试：
 * 幂等判据 = 存在 metadata 无 provider 字段的 cost_output 行 → 全清；新口径行全带 provider → 不清。
 * 场景：换轨后首次扫描清旧行；二次扫描（新口径）不再清（保护重扫窗口）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

/** app.ts 内联钩子的同构实现（判定逻辑拷贝自生产代码——测试断言语义等价） */
function buildInvalidateHook(db: Database.Database): () => void {
  return () => {
    const stale = db.prepare(`
      SELECT COUNT(*) AS c FROM health_snapshots
      WHERE metric_type = 'cost_output' AND metric_key = 'total_tokens'
        AND (metadata IS NULL OR JSON_EXTRACT(metadata, '$.provider') IS NULL)
    `).get() as { c: number };
    if (stale.c === 0) return;
    db.exec("DELETE FROM health_snapshots WHERE metric_type = 'cost_output'");
  };
}

describe("cost_output 旧口径失效钩子", () => {
  it("旧行（无 provider metadata）触发全清；新口径行（provider/unknown）保留", () => {
    const invalidate = buildInvalidateHook(db);
    // 旧口径行：无 provider 字段
    db.prepare(`INSERT INTO health_snapshots (snapshot_date, metric_type, metric_key, metric_value, metadata) VALUES ('2026-10-01', 'cost_output', 'total_tokens', 100, ?)`).run(JSON.stringify({ otterId: "o1", model: "glm-5.3" }));
    // 新口径行：provider 显式（含 unknown 显式标记）
    db.prepare(`INSERT INTO health_snapshots (snapshot_date, metric_type, metric_key, metric_value, metadata) VALUES ('2026-10-02', 'cost_output', 'total_tokens', 200, ?)`).run(JSON.stringify({ otterId: "o1", model: "glm-5.3", provider: "zhipu" }));
    db.prepare(`INSERT INTO health_snapshots (snapshot_date, metric_type, metric_key, metric_value, metadata) VALUES ('2026-10-03', 'cost_output', 'total_tokens', 300, ?)`).run(JSON.stringify({ otterId: "o1", model: "mystery", provider: "unknown" }));

    invalidate(); // 首次：检测到旧行 → 全清（含新行——DELETE 按 metric_type 整批）
    const afterFirst = (db.prepare("SELECT COUNT(*) AS c FROM health_snapshots WHERE metric_type = 'cost_output'").get() as { c: number }).c;
    expect(afterFirst).toBe(0);

    // 重扫后只有新口径行（provider 恒在）
    db.prepare(`INSERT INTO health_snapshots (snapshot_date, metric_type, metric_key, metric_value, metadata) VALUES ('2026-10-02', 'cost_output', 'total_tokens', 200, ?)`).run(JSON.stringify({ otterId: "o1", model: "glm-5.3", provider: "zhipu" }));
    invalidate(); // 二次：无旧行 → 不清（幂等收敛）
    const afterSecond = (db.prepare("SELECT COUNT(*) AS c FROM health_snapshots WHERE metric_type = 'cost_output'").get() as { c: number }).c;
    expect(afterSecond).toBe(1);
  });
});
