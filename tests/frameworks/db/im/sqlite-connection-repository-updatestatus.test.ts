import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConnectionRepository } from "@frameworks/db/im/sqlite-connection-repository";
import type { Connection } from "@entities/im/connection";

/** #1391：im-connection 仓 updateStatus 对不存在 ID fail-closed（#1370 族模式收尾） */

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function connectionFixture(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    name: "test-connection",
    externalId: "ext-1",
    externalType: "feishu",
    metadata: null,
    status: "active",
    createdAt: "2026-07-22T00:00:00Z",
    updatedAt: "2026-07-22T00:00:00Z",
    ...overrides,
  };
}

describe("SqliteConnectionRepository.updateStatus fail-closed（#1391）", () => {
  let db: Database.Database;
  let repo: SqliteConnectionRepository;

  beforeEach(() => { db = createTestDb(); repo = new SqliteConnectionRepository(db); });
  afterEach(() => { db.close(); });

  it("不存在的 ID：抛错（changes=0 不静默成功）", async () => {
    await expect(repo.updateStatus("conn-nonexistent", "inactive", "2026-10-09T00:00:00Z"))
      .rejects.toThrow(/connection 不存在/);
  });

  it("存在的 ID：正常更新不回归", async () => {
    await repo.create(connectionFixture());
    await repo.updateStatus("conn-1", "inactive", "2026-10-09T00:00:00Z");
    const conn = await repo.getById("conn-1");
    expect(conn?.status).toBe("inactive");
  });
});
