import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteSettingsRepository } from "@frameworks/db/settings/sqlite-settings-repository";

/** 创建内存 SQLite 数据库并初始化 schema */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

describe("SqliteSettingsRepository", () => {
  let db: Database.Database;
  let repo: SqliteSettingsRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteSettingsRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("get", () => {
    it("不存在的 key 返回 null", async () => {
      const result = await repo.get("nonexistent-key");
      expect(result).toBeNull();
    });
  });

  describe("update + get", () => {
    it("写入后可读取到值", async () => {
      await repo.update("theme", "dark");

      const result = await repo.get("theme");
      expect(result).toBe("dark");
    });

    it("支持中文值", async () => {
      await repo.update("language", "简体中文");

      const result = await repo.get("language");
      expect(result).toBe("简体中文");
    });
  });

  describe("update 语义：upsert", () => {
    it("第二次写入覆盖已有值", async () => {
      await repo.update("theme", "dark");
      await repo.update("theme", "light");

      const result = await repo.get("theme");
      expect(result).toBe("light");
    });

    it("不同 key 互不影响", async () => {
      await repo.update("theme", "dark");
      await repo.update("language", "en");

      expect(await repo.get("theme")).toBe("dark");
      expect(await repo.get("language")).toBe("en");
    });
  });

  describe("getAll", () => {
    it("无数据时返回空对象", async () => {
      const result = await repo.getAll();
      expect(result).toEqual({});
    });

    it("返回所有键值对", async () => {
      await repo.update("theme", "dark");
      await repo.update("language", "en");
      await repo.update("notifications", "enabled");

      const result = await repo.getAll();
      expect(Object.keys(result)).toHaveLength(3);
      expect(result["theme"]).toBe("dark");
      expect(result["language"]).toBe("en");
      expect(result["notifications"]).toBe("enabled");
    });

    it("覆盖更新后 getAll 返回最新值", async () => {
      await repo.update("theme", "dark");
      await repo.update("theme", "light");

      const result = await repo.getAll();
      expect(result["theme"]).toBe("light");
    });
  });
});
