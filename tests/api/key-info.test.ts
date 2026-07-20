import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, json, createMockDeps, makeKeyFact, makeLinkedResource } from "./helpers";
import type { TestDeps } from "./helpers";
import { DomainError } from "../../src/entities/errors";

describe("KeyInfo API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── GET /api/conversations/:id/key-info ───

  describe("GET /api/conversations/:id/key-info", () => {
    it("returns key facts and linked resources", async () => {
      deps.manageKeyInfo.getKeyInfo.mockResolvedValue({
        keyFacts: [makeKeyFact()],
        linkedResources: [makeLinkedResource()],
      });

      const res = await app.request("/api/conversations/conv-1/key-info");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.keyFacts).toHaveLength(1);
      expect(body.linkedResources).toHaveLength(1);
      expect(body.keyFacts[0].content).toBe("Important fact");
      expect(body.linkedResources[0].url).toBe("https://example.com");
    });

    it("returns empty arrays when no key info", async () => {
      deps.manageKeyInfo.getKeyInfo.mockResolvedValue({
        keyFacts: [],
        linkedResources: [],
      });

      const res = await app.request("/api/conversations/conv-1/key-info");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.keyFacts).toEqual([]);
      expect(body.linkedResources).toEqual([]);
    });
  });

  // ─── POST /api/conversations/:id/key-facts ───

  describe("POST /api/conversations/:id/key-facts", () => {
    it("adds a key fact", async () => {
      const fact = makeKeyFact({ id: "new-kf", content: "New fact" });
      deps.manageKeyInfo.addKeyFact.mockResolvedValue(fact);

      const res = await app.request("/api/conversations/conv-1/key-facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "New fact",
          category: "decision",
          createdBy: "otter-1",
          otterId: "otter-1",
        }),
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("new-kf");
      expect(body.content).toBe("New fact");
      expect(deps.manageKeyInfo.addKeyFact).toHaveBeenCalledWith({
        conversationId: "conv-1",
        content: "New fact",
        category: "decision",
        createdBy: "otter-1",
        otterId: "otter-1",
      });
    });

    it("works without optional fields", async () => {
      const fact = makeKeyFact();
      deps.manageKeyInfo.addKeyFact.mockResolvedValue(fact);

      const res = await app.request("/api/conversations/conv-1/key-facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Fact", createdBy: "user-1" }),
      });

      expect(res.status).toBe(201);
      expect(deps.manageKeyInfo.addKeyFact).toHaveBeenCalledWith({
        conversationId: "conv-1",
        content: "Fact",
        category: undefined,
        createdBy: "user-1",
        otterId: undefined,
      });
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
      expect(deps.manageKeyInfo.linkResource).toHaveBeenCalledWith({
        conversationId: "conv-1",
        resourceType: "url",
        url: "https://example.com",
        title: "Example",
        metadata: undefined,
        linkedBy: "otter-1",
        otterId: undefined,
        autoLinked: false,
      });
    });

    it("passes metadata and optional fields", async () => {
      const resource = makeLinkedResource();
      deps.manageKeyInfo.linkResource.mockResolvedValue(resource);

      const res = await app.request("/api/conversations/conv-1/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceType: "doc",
          url: "https://doc.example.com",
          title: "Doc",
          metadata: { pages: 10 },
          linkedBy: "otter-1",
          otterId: "otter-1",
          autoLinked: true,
        }),
      });

      expect(res.status).toBe(201);
      expect(deps.manageKeyInfo.linkResource).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { pages: 10 },
          autoLinked: true,
        }),
      );
    });
  });

  // ─── DELETE /api/conversations/:id/key-facts/:factId ───

  describe("DELETE /api/conversations/:id/key-facts/:factId", () => {
    it("deletes a key fact and returns 204", async () => {
      deps.manageKeyInfo.deleteKeyFact.mockResolvedValue(undefined);

      const res = await app.request("/api/conversations/conv-1/key-facts/kf-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(204);
      expect(deps.manageKeyInfo.deleteKeyFact).toHaveBeenCalledWith("kf-1");
    });

    it("returns error when delete fails", async () => {
      deps.manageKeyInfo.deleteKeyFact.mockRejectedValue(
        new DomainError("Key fact not found: kf-missing", "not_found"),
      );

      const res = await app.request("/api/conversations/conv-1/key-facts/kf-missing", {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /api/conversations/:id/key-facts/:factId ───

  describe("PATCH /api/conversations/:id/key-facts/:factId", () => {
    it("flags a key fact", async () => {
      deps.manageKeyInfo.flagKeyFact.mockResolvedValue(undefined);

      const res = await app.request("/api/conversations/conv-1/key-facts/kf-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: true }),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("ok");
      expect(deps.manageKeyInfo.flagKeyFact).toHaveBeenCalledWith("kf-1", true);
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
  });
});
