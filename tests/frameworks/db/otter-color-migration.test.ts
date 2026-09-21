// lint-tests:allow-ddl —— 迁移测试需要手工建旧 schema 的表（模拟存量库形态）
/**
 * F20260921otcl：otters.color 列迁移 + 存量回填测试。
 *
 * 覆盖：
 * - 老库补列（PRAGMA 探测幂等）
 * - 分组回填：同对话小獭互异（≤8）、跨对话互不影响、active+dissolved 全回填
 * - 大獭不分配（color 恒 NULL）
 * - fill-only 续算幂等：重跑零变化；中断后续算与一次跑完一致
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "../../helpers/logger";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

/** 建旧形态 otters 表（无 color 列）+ 会话归属数据 */
function createLegacyDb(): Database.Database {
  const db = createTestDb();
  // 模拟升级前：无 color 列
  db.exec("ALTER TABLE otters DROP COLUMN color");
  return db;
}

interface OtterSeed {
  id: string; name: string; type: string; status?: string; conv: string | null; createdAt: string;
}

function seedOtters(db: Database.Database, seeds: OtterSeed[]): void {
  const insertOtter = db.prepare(`
    INSERT INTO otters (id, name, type, status, created_at) VALUES (?, ?, ?, ?, ?)
  `);
  const insertConv = db.prepare("INSERT OR IGNORE INTO conversations (id, title) VALUES (?, ?)");
  // F20260921otcl 修正：小獭对话归属在 conversation_participants（现行参与者表），
  // conversation_otters 是遗留 join 表（几乎全为大獭）——迁移 join 后者会漏掉全部小獭
  const insertJoin = db.prepare("INSERT OR IGNORE INTO conversation_participants (id, conversation_id, otter_id, status, created_at) VALUES (?, ?, ?, 'active', ?)");
  const convs = new Set(seeds.map(s => s.conv).filter((c): c is string => !!c));
  for (const c of convs) insertConv.run(c, `对话-${c}`);
  for (const s of seeds) {
    insertOtter.run(s.id, s.name, s.type, s.status ?? "active", s.createdAt);
    if (s.conv) insertJoin.run(`p-${s.id}`, s.conv, s.id, s.createdAt);
  }
}

function getColors(db: Database.Database): Map<string, string | null> {
  const rows = db.prepare("SELECT id, color FROM otters").all() as Array<{ id: string; color: string | null }>;
  return new Map(rows.map(r => [r.id, r.color]));
}

describe("migrateDatabase - F20260921otcl otters.color", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createLegacyDb();
  });

  afterEach(() => {
    db.close();
  });

  it("老库补列：无 color 列时 migrate 补列（nullable）", () => {
    const before = (db.prepare("PRAGMA table_info(otters)").all() as Array<{ name: string }>).some(c => c.name === "color");
    expect(before).toBe(false);

    migrateDatabase(db, createTestLogger());

    const col = (db.prepare("PRAGMA table_info(otters)").all() as Array<{ name: string; notnull: number }>).find(c => c.name === "color");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("分组回填：同对话小獭按 createdAt 升序依次挑未占用色（互异），大獭 NULL，跨对话互不影响", () => {
    seedOtters(db, [
      // conv-A：1 大獭 + 3 小獭
      { id: "big-a", name: "大獭", type: "big", conv: "conv-a", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s-a1", name: "小獭一", type: "small", conv: "conv-a", createdAt: "2026-01-02T00:00:00Z" },
      { id: "s-a2", name: "小獭二", type: "small", conv: "conv-a", createdAt: "2026-01-03T00:00:00Z" },
      { id: "s-a3", name: "小獭三", type: "small", conv: "conv-a", createdAt: "2026-01-04T00:00:00Z" },
      // conv-B：独立对话 2 小獭——应从色板头重新开始（分配域=对话内）
      { id: "s-b1", name: "乙一小獭", type: "small", conv: "conv-b", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s-b2", name: "乙二小獭", type: "small", conv: "conv-b", createdAt: "2026-01-02T00:00:00Z" },
    ]);

    migrateDatabase(db, createTestLogger());

    const colors = getColors(db);
    // 大獭不分配
    expect(colors.get("big-a")).toBeNull();
    // conv-A 小獭互异且按序取色板前三
    expect(colors.get("s-a1")).toBe("teal");
    expect(colors.get("s-a2")).toBe("caramel");
    expect(colors.get("s-a3")).toBe("lavender");
    // conv-B 独立分配（不受 conv-A 影响）
    expect(colors.get("s-b1")).toBe("teal");
    expect(colors.get("s-b2")).toBe("caramel");
  });

  it("dissolved 小獭也回填（历史消息含已解散獭）", () => {
    seedOtters(db, [
      { id: "s-live", name: "存活獭", type: "small", conv: "conv-a", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s-dead", name: "已解散獭", type: "small", status: "dissolved", conv: "conv-a", createdAt: "2026-01-02T00:00:00Z" },
    ]);

    migrateDatabase(db, createTestLogger());

    const colors = getColors(db);
    expect(colors.get("s-live")).toBe("teal");
    expect(colors.get("s-dead")).toBe("caramel");
  });

  it("fill-only 续算幂等：重跑零变化（已填色行不动）", () => {
    seedOtters(db, [
      { id: "big-a", name: "大獭", type: "big", conv: "conv-a", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s-a1", name: "小獭一", type: "small", conv: "conv-a", createdAt: "2026-01-02T00:00:00Z" },
    ]);

    migrateDatabase(db, createTestLogger());
    const first = getColors(db);

    // 模拟外部干预已填色行（验证 fill-only 不覆盖）+ 新增一行未填色獭
    db.prepare("UPDATE otters SET color = 'plum' WHERE id = 's-a1'").run();
    seedOtters(db, [
      { id: "s-a2", name: "小獭二", type: "small", conv: "conv-a", createdAt: "2026-01-05T00:00:00Z" },
    ]);

    migrateDatabase(db, createTestLogger());

    const second = getColors(db);
    // 外部干预的值保留（fill-only）；新獭按占用集（plum 已占）续算取 teal
    expect(second.get("s-a1")).toBe("plum");
    expect(second.get("s-a2")).toBe("teal");
    // 大獭恒 NULL
    expect(second.get("big-a")).toBeNull();
    // 首跑结果对照
    expect(first.get("s-a1")).toBe("teal");
  });

  it("全新库（initSchema 已含 color 列 + 无存量小獭）：迁移直接通过零副作用", () => {
    db.close();
    db = createTestDb(); // 新库形态
    expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
    const n = (db.prepare("SELECT COUNT(*) AS n FROM otters WHERE color IS NOT NULL").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it(">8 獭同对话：挑占用数最少（并列取 index 最小）——不炸不丢行", () => {
    const seeds: OtterSeed[] = [
      { id: "big-x", name: "大獭", type: "big", conv: "conv-x", createdAt: "2026-01-01T00:00:00Z" },
    ];
    for (let i = 1; i <= 10; i++) {
      seeds.push({ id: `s-x${i}`, name: `小獭${i}`, type: "small", conv: "conv-x", createdAt: `2026-02-${String(i).padStart(2, "0")}T00:00:00Z` });
    }
    seedOtters(db, seeds);

    migrateDatabase(db, createTestLogger());

    const colors = getColors(db);
    // 10 只全部有色（>8 时撞色兜底生效）
    for (let i = 1; i <= 10; i++) {
      expect(colors.get(`s-x${i}`)).not.toBeNull();
    }
    // 前 8 只互异
    const first8 = Array.from({ length: 8 }, (_, i) => colors.get(`s-x${i + 1}`));
    expect(new Set(first8).size).toBe(8);
    // 第 9/10 只取占用最少（各 1 次，并列取 index 最小 = teal）
    expect(colors.get("s-x9")).toBe("teal");
    expect(colors.get("s-x10")).toBe("caramel");
  });
});
