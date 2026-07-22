import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, json, createMockDeps, makeLinkedResource } from "./helpers";
import type { TestDeps } from "./helpers";
import { DomainError } from "../../src/entities/errors";

describe("KeyInfo API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── GET /api/conversations/:id/key-resources ───

  describe("GET /api/conversations/:id/key-resources", () => {
    it("returns linked resources", async () => {
      deps.manageKeyInfo.getLinkedResources.mockResolvedValue([
        makeLinkedResource({ id: "lr-1", resourceType: "url" }),
        makeLinkedResource({ id: "lr-2", resourceType: "fact", content: "Important" }),
      ]);

      const res = await app.request("/api/conversations/conv-1/key-resources");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.resources).toHaveLength(2);
      expect(body.resources[0].id).toBe("lr-1");
      expect(body.resources[1].id).toBe("lr-2");
      expect(deps.manageKeyInfo.getLinkedResources).toHaveBeenCalledWith("conv-1");
    });

    it("returns empty array when no resources", async () => {
      deps.manageKeyInfo.getLinkedResources.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/key-resources");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.resources).toEqual([]);
    });
  });

  // ─── POST /api/conversations/:id/resources ───

  describe("POST /api/conversations/:id/resources", () => {
    it("links a resource", async () => {
      const resource = makeLinkedResource({ id: "new-lr" });
      deps.manageKeyInfo.linkResource.mockResolvedValue(resource);

      const res = await app.request("/api/conversations/conv-1/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceType: "url",
          url: "https://example.com",
          title: "Example",
          linkedBy: "otter-1",
          autoLinked: false,
        }),
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("new-lr");
      expect(deps.manageKeyInfo.linkResource).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-1",
          resourceType: "url",
          url: "https://example.com",
          title: "Example",
          linkedBy: "otter-1",
          autoLinked: false,
        }),
      );
    });

    it("links a fact resource with content", async () => {
      const resource = makeLinkedResource({ id: "new-fact", resourceType: "fact" });
      deps.manageKeyInfo.linkResource.mockResolvedValue(resource);

      const res = await app.request("/api/conversations/conv-1/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceType: "fact",
          content: "Important fact",
          category: "decision",
          linkedBy: "otter-1",
          autoLinked: false,
        }),
      });

      expect(res.status).toBe(201);
      expect(deps.manageKeyInfo.linkResource).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: "fact",
          content: "Important fact",
          category: "decision",
        }),
      );
    });
  });

  // ─── PATCH /api/conversations/:id/resources/:resourceId ───

  describe("PATCH /api/conversations/:id/resources/:resourceId", () => {
    it("flags a resource", async () => {
      deps.manageKeyInfo.flagResource.mockResolvedValue(undefined);

      const res = await app.request("/api/conversations/conv-1/resources/lr-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: true }),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("ok");
      expect(deps.manageKeyInfo.flagResource).toHaveBeenCalledWith("lr-1", true);
    });
  });

  // ─── DELETE /api/conversations/:id/resources/:resourceId ───

  describe("DELETE /api/conversations/:id/resources/:resourceId", () => {
    it("deletes a linked resource and returns 204", async () => {
      deps.manageKeyInfo.deleteLinkedResource.mockResolvedValue(undefined);

      const res = await app.request("/api/conversations/conv-1/resources/lr-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(204);
      expect(deps.manageKeyInfo.deleteLinkedResource).toHaveBeenCalledWith("lr-1");
    });

    it("returns 404 when resource not found", async () => {
      deps.manageKeyInfo.deleteLinkedResource.mockRejectedValue(
        new DomainError("LinkedResource missing not found", "not_found"),
      );

      const res = await app.request("/api/conversations/conv-1/resources/missing", {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
    });

    it("returns 500 for generic errors", async () => {
      deps.manageKeyInfo.deleteLinkedResource.mockRejectedValue(
        new Error("Database connection failed"),
      );

      const res = await app.request("/api/conversations/conv-1/resources/lr-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(500);
    });
  });
});
