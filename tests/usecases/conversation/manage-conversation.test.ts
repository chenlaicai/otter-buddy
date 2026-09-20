/**
 * ManageConversation 单元测试（真 sqlite）。
 * getById 是纯委托，按 F20260806tstr Part 4 标准删除。
 * CreateOtter 保留 stub（其真实行为由 create-otter.test.ts 与能力层覆盖），
 * 但 stub 会真实写 otters 行以满足参与者 FK。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { ManageConversation } from "@usecases/conversation/manage-conversation";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { Otter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";
import { createTestDb } from "../../helpers/db";

describe("ManageConversation（真 sqlite）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let mc: ManageConversation;

  function stubCreateOtter(otterId = "big-otter-1"): CreateOtter {
    return {
      execute: async (params: { name?: string; type?: string; modelAlias?: string }) => {
        /** 新建对话选大獭模型：记录调用参数供透传断言 */
        lastCreateOtterParams = params
        const otter: Otter = {
          id: otterId, name: "大獭", type: "big", status: "active",
          role: null, parentOtterId: null,
          createdAt: new Date().toISOString(), dissolvedAt: null,
        };
        /** 参与者有 otter FK：stub 也真实写行 */
        db.prepare(
          "INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES (?, ?, 'big', 'active', ?)",
        ).run(otter.id, otter.name, otter.createdAt);
        return otter;
      },
    } as unknown as CreateOtter;
  }

  /** stubCreateOtter 最近一次收到的参数（透传断言用） */
  let lastCreateOtterParams: { name?: string; type?: string; modelAlias?: string } | undefined;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    mc = new ManageConversation(repo, stubCreateOtter());
  });

  afterEach(() => {
    db.close();
  });

  async function seedConversation(id: string, status: "active" | "completed"): Promise<void> {
    await repo.create({
      id, title: "存量对话", status, summary: null, pinned: false, kind: "normal", workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: status === "completed" ? "2026-01-01T01:00:00Z" : null,
      archivedAt: null,
    });
  }

  describe("create", () => {
    it("创建对话：active 状态 + 字段正确 + 落库", async () => {
      const conv = await mc.create({ title: "新对话" });

      expect(conv.status).toBe("active");
      expect(conv.title).toBe("新对话");
      expect(conv.summary).toBeNull();
      expect(conv.completedAt).toBeNull();
      expect(conv.archivedAt).toBeNull();
      expect(conv.id).toMatch(/^[0-9a-f-]{36}$/);

      const stored = await repo.getById(conv.id);
      expect(stored?.title).toBe("新对话");
    });

    it("为大獭创建初始参与者记录（开场即在场）", async () => {
      const conv = await mc.create({ title: "对话" });

      const participants = await repo.getActiveParticipants(conv.id);
      expect(participants).toHaveLength(1);
      expect(participants[0].otterId).toBe("big-otter-1");
      expect(participants[0].status).toBe("active");
    });

    it("新建对话选大獭模型：modelAlias 透传给 CreateOtter", async () => {
      const conv = await mc.create({ title: "新对话", modelAlias: "glm" });

      expect(conv.id).toBeTruthy();
      expect(lastCreateOtterParams?.name).toBe("大獭");
      expect(lastCreateOtterParams?.type).toBe("big");
      expect(lastCreateOtterParams?.modelAlias).toBe("glm");
    });

    it("不选模型：modelAlias 不下发（undefined，CreateOtter 层走默认模型）", async () => {
      await mc.create({ title: "新对话" });

      expect(lastCreateOtterParams?.modelAlias).toBeUndefined();
    });
  });

  describe("complete", () => {
    it("active 对话 -> completed", async () => {
      await seedConversation("conv-1", "active");

      await mc.complete("conv-1");

      expect((await repo.getById("conv-1"))?.status).toBe("completed");
    });    it("不存在 -> not_found", async () => {
      await expect(mc.complete("nonexistent")).rejects.toThrow(DomainError);
      await expect(mc.complete("nonexistent")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "not_found",
      );
    });

    it("已完成 -> validation", async () => {
      await seedConversation("conv-1", "completed");

      await expect(mc.complete("conv-1")).rejects.toThrow(DomainError);
      await expect(mc.complete("conv-1")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });
  });

  describe("rename（F20260920imax 助理名称）", () => {
    it("改名成功——返回新实体，库中 title 更新", async () => {
      await seedConversation("conv-1", "active");
      const renamed = await mc.rename("conv-1", " 朵朵的助理 ");
      expect(renamed.title).toBe("朵朵的助理"); // trim 后落库
      expect((await repo.getById("conv-1"))?.title).toBe("朵朵的助理");
    });

    it("空字符串 / 超长 -> validation", async () => {
      await seedConversation("conv-1", "active");
      await expect(mc.rename("conv-1", "   ")).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
      await expect(mc.rename("conv-1", "a".repeat(61))).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });

    it("不存在 -> not_found", async () => {
      await expect(mc.rename("nonexistent", "x")).rejects.toSatisfy((err: DomainError) => err.kind === "not_found");
    });
  });

  describe("archive", () => {
    it("completed 对话 -> archived", async () => {
      await seedConversation("conv-1", "completed");

      await mc.archive("conv-1");

      expect((await repo.getById("conv-1"))?.status).toBe("archived");
    });

    it("active 对话 -> 拒绝归档", async () => {
      await seedConversation("conv-1", "active");

      await expect(mc.archive("conv-1")).rejects.toThrow(DomainError);
    });

    it("不存在 -> not_found", async () => {
      await expect(mc.archive("nonexistent")).rejects.toThrow(DomainError);
      await expect(mc.archive("nonexistent")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "not_found",
      );
    });
  });

  describe("pin / unpin", () => {
    it("pin 存在的对话 -> pinned=true", async () => {
      await seedConversation("conv-1", "active");

      await mc.pin("conv-1");

      expect((await repo.getById("conv-1"))?.pinned).toBe(true);
    });

    it("pin 不存在的对话 -> not_found", async () => {
      await expect(mc.pin("nonexistent")).rejects.toThrow(DomainError);
      await expect(mc.pin("nonexistent")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "not_found",
      );
    });

    it("unpin 存在的对话 -> pinned=false", async () => {
      await seedConversation("conv-1", "active");
      await mc.pin("conv-1");

      await mc.unpin("conv-1");

      expect((await repo.getById("conv-1"))?.pinned).toBe(false);
    });

    it("unpin 不存在的对话 -> not_found", async () => {
      await expect(mc.unpin("nonexistent")).rejects.toThrow(DomainError);
      await expect(mc.unpin("nonexistent")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "not_found",
      );
    });
  });
});
