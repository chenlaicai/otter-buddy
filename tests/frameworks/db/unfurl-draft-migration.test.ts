// lint-tests:allow-ddl —— 迁移测试需要手工还原存量库形态（DROP COLUMN 模拟老库）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { initSchema } from "@frameworks/db/schema";
import { SqliteUnfurlCacheRepository, unfurlNowIso } from "@frameworks/db/conversation/sqlite-unfurl-cache-repository";
import { createTestLogger } from "../../helpers/logger";

/**
 * F20261030draft：unfurl_cache 存量库补列迁移专项测试（检视 r1 建议 5-4）。
 * migration-equivalence.guard 只做表级等价（表集合断言），不覆盖「存量表补列」路径——
 * 本测试锁定：①老库（无 is_draft）跑 initSchema 后列存在；②老数据读出 isDraft=null
 * （旧数据无损，徽章退化为原三态行为）；③迁移后写入三态 round-trip；④幂等重入不抛。
 */

const logger = createTestLogger();

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  // 模拟 #1463 前的存量库：is_draft 列不存在（老库在 createTestDb 的 initSchema 后删列还原）
  db.exec("ALTER TABLE unfurl_cache DROP COLUMN is_draft");
});

afterEach(() => { db.close(); });

function columnNames(): string[] {
  return (db.prepare("PRAGMA table_info(unfurl_cache)").all() as Array<{ name: string }>).map((c) => c.name);
}

describe("存量库迁移：unfurl_cache is_draft 补列（#1463）", () => {
  it("老库跑 initSchema 后 is_draft 列存在（#506 幂等补建同款路径）", () => {
    expect(columnNames()).not.toContain("is_draft");
    initSchema(db);
    expect(columnNames()).toContain("is_draft");
    // 幂等重入安全（bootstrap 无条件 initSchema）
    expect(() => initSchema(db)).not.toThrow();
    expect(() => initSchema(db)).not.toThrow();
  });

  it("老数据读出 isDraft=null（旧数据无损），迁移后写入三态 round-trip", () => {
    // 老库形态下先落一行（无 is_draft 承载的旧数据）
    db.prepare(`
      INSERT INTO unfurl_cache (url, title, description, image, site_name, host, source, state, additions, deletions, error, fetched_at)
      VALUES (?, '老 PR', NULL, NULL, 'GitHub', 'github.com', 'github-api', 'OPEN', 1, 1, NULL, ?)
    `).run("https://github.com/a/b/pull/1", unfurlNowIso());

    initSchema(db);

    const repo = new SqliteUnfurlCacheRepository(db, logger);
    const old = repo.get("https://github.com/a/b/pull/1");
    expect(old.kind).toBe("hit");
    // 老数据 is_draft 为 NULL → 读出 null（徽章判定退化为原行为，无破坏）
    expect(old.row?.isDraft ?? null).toBeNull();

    // 迁移后三态写读无损
    for (const isDraft of [true, false, null] as const) {
      const url = `https://github.com/a/b/pull/d${String(isDraft)}`;
      repo.put({
        url, title: "新 PR", description: null, image: null, siteName: "GitHub", host: "github.com",
        source: "github-api", state: "OPEN", isDraft,
        additions: 1, deletions: 1, error: null, fetchedAt: unfurlNowIso(),
      });
      expect(repo.get(url).row?.isDraft ?? null).toBe(isDraft);
    }
  });
});
