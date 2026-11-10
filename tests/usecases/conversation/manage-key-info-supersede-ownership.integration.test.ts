import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../helpers/db";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";

/** #1815：supersede 的旧资源写入必须经过 conversation 归属闸。 */
describe("ManageKeyInfo.supersedeResource ownership（#1815）", () => {
  it("未知或跨对话拒绝且 SQLite 不变，正确归属仍完成替代与状态机校验", async () => {
    const db = createTestDb();
    try {
      const now = new Date().toISOString();
      const insertConversation = db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
      insertConversation.run("conv-1", "supersede ownership", "active", now, now);
      insertConversation.run("conv-other", "other conversation", "active", now, now);
      const repo = new SqliteConversationRepository(db);
      await repo.linkResource({
        id: "lr-old", conversationId: "conv-1", resourceType: "url", url: "https://old.example.com",
        title: "old", content: null, category: null, userFlagged: false, metadata: null,
        linkedBy: "test", otterId: null, autoLinked: false, createdAt: now,
        status: "active", groupId: null, supersededBy: null,
      });
      const memoryIndex = { indexLinkedResource: vi.fn().mockResolvedValue(undefined) } as unknown as MemoryIndexGateway;
      const uc = new ManageKeyInfo(repo, memoryIndex);
      const newInput = {
        conversationId: "conv-1", resourceType: "url", url: "https://new.example.com",
        linkedBy: "test", autoLinked: false,
      };

      const oldResourceQuery = db.prepare("SELECT conversation_id, status, group_id, superseded_by FROM linked_resources WHERE id = 'lr-old'");
      const oldResourceBefore = oldResourceQuery.get();
      await expect(uc.supersedeResource("lr-missing", newInput)).rejects.toMatchObject({ kind: "not_found" });
      await expect(uc.supersedeResource("lr-old", { ...newInput, conversationId: "conv-other" }))
        .rejects.toMatchObject({ kind: "not_found" });
      expect(oldResourceQuery.get()).toEqual(oldResourceBefore);
      expect(db.prepare("SELECT COUNT(*) FROM linked_resources").pluck().get()).toBe(1);
      expect(memoryIndex.indexLinkedResource).not.toHaveBeenCalled();

      const replacement = await uc.supersedeResource("lr-old", newInput);
      expect(replacement.conversationId).toBe("conv-1");
      expect(replacement.status).toBe("active");
      expect(db.prepare("SELECT status FROM linked_resources WHERE id = 'lr-old'").pluck().get()).toBe("superseded");
      expect(db.prepare("SELECT superseded_by FROM linked_resources WHERE id = 'lr-old'").pluck().get()).toBe(replacement.id);
      expect(db.prepare("SELECT COUNT(*) FROM linked_resources").pluck().get()).toBe(2);
      expect(memoryIndex.indexLinkedResource).toHaveBeenCalledOnce();

      await expect(uc.supersedeResource("lr-old", newInput)).rejects.toMatchObject({ kind: "conflict" });
      expect(db.prepare("SELECT COUNT(*) FROM linked_resources").pluck().get()).toBe(2);
      expect(memoryIndex.indexLinkedResource).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});
