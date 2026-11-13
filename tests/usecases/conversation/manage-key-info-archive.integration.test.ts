import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../../helpers/db";
import { createMockDeps, createTestApp } from "../../api/helpers";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : file.endsWith(".ts") ? [file] : [];
  });
}

/** #1793：真实 HTTP controller + usecase + SQLite，覆盖事故实际经过的完整路径。 */
describe("DELETE → archiveResource → SQLite（#1793）", () => {
  it("跨对话 404、正确归属 204 且行归档保留、重复 DELETE 409", async () => {
    const db = createTestDb();
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("conv-1", "archive integration", "active", now, now);
      const repo = new SqliteConversationRepository(db);
      const memoryIndex = { indexLinkedResource: async () => {} } as unknown as MemoryIndexGateway;
      await repo.linkResource({
        id: "lr-1", conversationId: "conv-1", resourceType: "url", url: "https://example.com",
        title: "keep me", content: null, category: null, userFlagged: false, metadata: null,
        linkedBy: "test", otterId: null, autoLinked: false, createdAt: now,
        status: "active", groupId: null, supersededBy: null,
        archivedByOtterId: null, archivedAt: null, archiveEvidence: null,
      });
      const deps = createMockDeps();
      deps.manageKeyInfo = new ManageKeyInfo(repo, memoryIndex);
      const app = createTestApp(deps);

      const wrongOwner = await app.request("/api/conversations/conv-other/resources/lr-1", { method: "DELETE" });
      expect(wrongOwner.status).toBe(404);
      expect(db.prepare("SELECT status FROM linked_resources WHERE id = 'lr-1'").pluck().get()).toBe("active");

      const archived = await app.request("/api/conversations/conv-1/resources/lr-1", { method: "DELETE" });
      expect(archived.status).toBe(204);
      const row = await repo.getLinkedResourceById("lr-1");
      expect(row?.status).toBe("archived");
      expect(row?.title).toBe("keep me");
      expect(db.prepare("SELECT COUNT(*) AS count FROM linked_resources WHERE id = 'lr-1'").pluck().get()).toBe(1);

      const repeated = await app.request("/api/conversations/conv-1/resources/lr-1", { method: "DELETE" });
      expect(repeated.status).toBe(409);
      expect(db.prepare("SELECT status FROM linked_resources WHERE id = 'lr-1'").pluck().get()).toBe("archived");
      await expect(repo.updateResourceStatus("lr-1", "archived")).rejects.toMatchObject({ kind: "conflict" });
    } finally {
      db.close();
    }
  });

  it("src 全树无物理删除 SQL，usecases/frameworks 无 repository 删除接口", () => {
    const sources = sourceFiles("src");
    expect(sources.filter(file => readFileSync(file, "utf8").includes("DELETE FROM linked_resources"))).toEqual([]);
    const implementationSources = [...sourceFiles("src/usecases"), ...sourceFiles("src/frameworks")];
    expect(implementationSources.filter(file => readFileSync(file, "utf8").includes("deleteLinkedResource"))).toEqual([]);
  });
});
