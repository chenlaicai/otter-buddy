/**
 * ManageSession 单元测试（真 sqlite）。
 *
 * restart 全链路的回归守护归 tests/usecases/otter/restart-flow.integration.test.ts
 * （真 sqlite + 真用例 + 真控制器）与 tests/capability/otter-lifecycle.capability.test.ts
 * （真系统 + 真 LLM）——本文件只保留它们不覆盖的错误分支，不再做 mock 镜像
 * （mock 镜像曾导致 fake green：F20260805rsto 事故的教训）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { ManageSession } from "@usecases/otter/manage-session";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";
import { fakeAgentGateway } from "../helpers/agent-gateway.fake";

describe("ManageSession", () => {
  let db: Database.Database;
  let repo: SqliteOtterRepository;
  let ms: ManageSession;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteOtterRepository(db);
    await repo.createOtter({
      id: "otter-1", name: "测试獭", type: "big", status: "active",
      role: null, parentOtterId: null, createdAt: new Date().toISOString(), dissolvedAt: null,
    });
    ms = new ManageSession(
      repo,
      fakeAgentGateway(),
      { getIdsByOtterId: async () => [] },
      { updateLayer: async () => {} },
      createTestLogger(),
    );
  });

  afterEach(() => {
    db.close();
  });

  it("createSession：已有 active session 时拒绝（错误分支）", async () => {
    await ms.createSession("otter-1");
    await expect(ms.createSession("otter-1")).rejects.toThrow("already has an active session");
  });
});
