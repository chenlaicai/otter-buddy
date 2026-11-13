import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import { createMockDeps, createTestApp } from "../api/helpers";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import { createUpdateArtifactStatusTool } from "@interface-adapters/agent-runtime/tools/artifact-tools";
import { buildResourceClient } from "../../src/bootstrap/clients";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

/** #1804：真实 HTTP 与工具入口共用同一 usecase + SQLite 归属闸。 */
describe("resource ownership write paths（#1804）", () => {
  it("真实入口拒绝未知或跨对话资源，正确归属可写且非法状态冲突", async () => {
    const db = createTestDb();
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("conv-1", "ownership", "active", now, now);
      const repo = new SqliteConversationRepository(db);
      await repo.linkResource({
        id: "lr-1", conversationId: "conv-1", resourceType: "url", url: "https://example.com",
        title: "owned", content: null, category: null, userFlagged: false, metadata: null,
        linkedBy: "test", otterId: null, autoLinked: false, createdAt: now,
        status: "active", groupId: null, supersededBy: null,
        archivedByOtterId: null, archivedAt: null, archiveEvidence: null,
      });
      const uc = new ManageKeyInfo(repo, { indexLinkedResource: async () => {} } as unknown as MemoryIndexGateway);
      const deps = createMockDeps();
      deps.manageKeyInfo = uc;
      const app = createTestApp(deps);

      const unknownPatch = await app.request("/api/conversations/conv-1/resources/lr-missing", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flagged: true }),
      });
      expect(unknownPatch.status).toBe(404);

      const wrongPatch = await app.request("/api/conversations/conv-other/resources/lr-1", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flagged: true }),
      });
      expect(wrongPatch.status).toBe(404);
      expect(db.prepare("SELECT user_flagged FROM linked_resources WHERE id = 'lr-1'").pluck().get()).toBe(0);

      const ownedPatch = await app.request("/api/conversations/conv-1/resources/lr-1", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flagged: true }),
      });
      expect(ownedPatch.status).toBe(200);
      expect(db.prepare("SELECT user_flagged FROM linked_resources WHERE id = 'lr-1'").pluck().get()).toBe(1);

      const client = { resource: buildResourceClient({ manageKeyInfo: uc } as never) } as unknown as OtterToolClient;
      const wrongTool = createUpdateArtifactStatusTool({ client, otterId: "otter-1", conversationId: "conv-other", currentMessageId: "msg-1" } as ToolContext);
      await expect(wrongTool.execute("call-1", { artifactId: "lr-1", status: "archived" })).rejects.toMatchObject({ kind: "not_found" });
      expect(db.prepare("SELECT status FROM linked_resources WHERE id = 'lr-1'").pluck().get()).toBe("active");

      const ownedTool = createUpdateArtifactStatusTool({ client, otterId: "otter-1", conversationId: "conv-1", currentMessageId: "msg-1" } as ToolContext);
      const result = await ownedTool.execute("call-2", { artifactId: "lr-1", status: "archived" });
      expect(result.content[0].text).toContain("updated to archived");
      expect(db.prepare("SELECT status FROM linked_resources WHERE id = 'lr-1'").pluck().get()).toBe("archived");

      await expect(ownedTool.execute("call-3", { artifactId: "lr-1", status: "archived" })).rejects.toMatchObject({ kind: "conflict" });
      expect(db.prepare("SELECT status FROM linked_resources WHERE id = 'lr-1'").pluck().get()).toBe("archived");
    } finally {
      db.close();
    }
  });
});
