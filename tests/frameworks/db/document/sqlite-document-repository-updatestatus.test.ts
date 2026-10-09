import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { SqliteFeatureRepository } from "@frameworks/db/document/sqlite-feature-repository";
import { SqliteResearchRepository } from "@frameworks/db/document/sqlite-research-repository";
import type { FeatureDocument } from "@entities/document/feature";
import type { ResearchDocument } from "@entities/document/research";

/** #1385：feature/research 两仓 updateStatus 对不存在 ID fail-closed（同 #1370 族模式） */

function seedFeature(id: string): FeatureDocument {
  return {
    id,
    title: "t",
    summary: "s",
    bodyHash: null,
    changeType: "fix",
    status: "draft",
    tags: [],
    modules: [],
    causalLinksFrom: [],
    supersedes: [],
    filePath: `docs/features/2026/10/09/${id}-t.md`,
    createdAt: new Date().toISOString(),
    createdInConversationId: null,
  };
}

function seedResearch(id: string): ResearchDocument {
  return {
    id,
    title: "t",
    summary: "s",
    bodyHash: null,
    explorationType: "technical",
    status: "draft",
    tags: [],
    conclusion: null,
    causalLinksFrom: [],
    supersedes: [],
    filePath: `docs/research/2026/10/09/${id}-t.md`,
    createdAt: new Date().toISOString(),
    createdInConversationId: null,
  };
}

describe("SqliteFeatureRepository.updateStatus fail-closed（#1385）", () => {
  let db: Database.Database;
  let repo: SqliteFeatureRepository;

  beforeEach(() => { db = createTestDb(); repo = new SqliteFeatureRepository(db); });
  afterEach(() => { db.close(); });

  it("不存在的 ID：抛错（changes=0 不静默成功）", async () => {
    await expect(repo.updateStatus("F-nonexistent", "archived")).rejects.toThrow(/feature 不存在/);
  });

  it("存在的 ID：正常更新不回归", async () => {
    await repo.insert(seedFeature("F20261009test"));
    await repo.updateStatus("F20261009test", "archived");
    const doc = await repo.findById("F20261009test");
    expect(doc?.status).toBe("archived");
  });
});

describe("SqliteResearchRepository.updateStatus fail-closed（#1385）", () => {
  let db: Database.Database;
  let repo: SqliteResearchRepository;

  beforeEach(() => { db = createTestDb(); repo = new SqliteResearchRepository(db); });
  afterEach(() => { db.close(); });

  it("不存在的 ID：抛错（changes=0 不静默成功）", async () => {
    await expect(repo.updateStatus("R-nonexistent", "archived")).rejects.toThrow(/research 不存在/);
  });

  it("存在的 ID：正常更新不回归", async () => {
    await repo.insert(seedResearch("R20261009test"));
    await repo.updateStatus("R20261009test", "archived");
    const doc = await repo.findById("R20261009test");
    expect(doc?.status).toBe("archived");
  });
});
