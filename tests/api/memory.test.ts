import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, json, createMockDeps, makeMemoryEntry } from "./helpers";
import type { TestDeps } from "./helpers";

describe("Memory API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── GET /api/memory/search ───

  describe("GET /api/memory/search", () => {
    it("returns 400 when query is missing", async () => {
      const res = await app.request("/api/memory/search");
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("query");
    });

    it("returns search results", async () => {
      const entry = makeMemoryEntry();
      deps.searchMemory.search.mockResolvedValue({
        entries: [{ ...entry, score: 0.95, source: "fts", snippet: "match" }],
        total: 1,
      });

      const res = await app.request("/api/memory/search?query=test&limit=5");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.entries).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.entries[0].score).toBe(0.95);
      expect(body.entries[0].source).toBe("fts");
      expect(body.entries[0].snippet).toBe("match");
    });

    it("passes all optional query params", async () => {
      deps.searchMemory.search.mockResolvedValue({ entries: [], total: 0 });

      const res = await app.request(
        "/api/memory/search?query=hello&limit=3&granularity=fine&conversationId=conv-1&detail_level=summary&library=conversation",
      );
      expect(res.status).toBe(200);
      expect(deps.searchMemory.search).toHaveBeenCalledWith({
        query: "hello",
        limit: 3,
        granularity: "fine",
        conversationId: "conv-1",
        detailLevel: "summary",
        library: "conversation",
      });
    });

    it("F20260803fbit: passes content_type filter to search", async () => {
      deps.searchMemory.search.mockResolvedValue({ entries: [], total: 0 });

      const res = await app.request(
        "/api/memory/search?query=hello&content_type=feature_chunk,feature",
      );
      expect(res.status).toBe(200);
      expect(deps.searchMemory.search).toHaveBeenCalledWith({
        query: "hello",
        limit: 10,
        contentType: ["feature_chunk", "feature"],
      });
    });

    it("F20260803fbit: returns 400 for invalid content_type", async () => {
      const res = await app.request(
        "/api/memory/search?query=hello&content_type=invalid_type",
      );
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("invalid content_type");
    });
  });

  // ─── POST /api/memory/search/similar ───

  describe("POST /api/memory/search/similar", () => {
    it("returns similar memories", async () => {
      const entry = makeMemoryEntry({ id: "mem-2" });
      deps.searchMemory.searchSimilar.mockResolvedValue({
        entries: [{ ...entry, score: 0.8, source: "vec" }],
        total: 1,
      });

      const res = await app.request("/api/memory/search/similar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryEntryId: "mem-1", limit: 5 }),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.entries).toHaveLength(1);
    });

    it("uses default limit of 10", async () => {
      deps.searchMemory.searchSimilar.mockResolvedValue({ entries: [], total: 0 });

      await app.request("/api/memory/search/similar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryEntryId: "mem-1" }),
      });

      expect(deps.searchMemory.searchSimilar).toHaveBeenCalledWith("mem-1", 10);
    });
  });

  // ─── GET /api/memory/batch ───

  describe("GET /api/memory/batch", () => {
    it("returns 400 when ids is missing", async () => {
      const res = await app.request("/api/memory/batch");
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("ids");
    });

    it("returns 400 when ids is empty string", async () => {
      const res = await app.request("/api/memory/batch?ids=");
      expect(res.status).toBe(400);
    });

    it("returns batch details", async () => {
      deps.manageMemory.getDetails.mockResolvedValue([
        makeMemoryEntry({ id: "mem-1" }),
        makeMemoryEntry({ id: "mem-2" }),
      ]);

      const res = await app.request("/api/memory/batch?ids=mem-1,mem-2");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("trims whitespace in ids", async () => {
      deps.manageMemory.getDetails.mockResolvedValue([makeMemoryEntry()]);

      await app.request("/api/memory/batch?ids= mem-1 , mem-2 ");

      expect(deps.manageMemory.getDetails).toHaveBeenCalledWith(["mem-1", "mem-2"]);
    });
  });

  // ─── GET /api/memory/:id ───

  describe("GET /api/memory/:id", () => {
    it("returns memory entry by id", async () => {
      deps.manageMemory.getById.mockResolvedValue(makeMemoryEntry());

      const res = await app.request("/api/memory/mem-1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBe("mem-1");
      expect(body.contentType).toBe("message");
    });

    it("returns 404 when not found", async () => {
      deps.manageMemory.getById.mockResolvedValue(null);

      const res = await app.request("/api/memory/missing");
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /api/memory/:id/flag ───

  describe("PATCH /api/memory/:id/flag", () => {
    it("flags a memory entry", async () => {
      deps.manageMemory.flagMemory.mockResolvedValue(undefined);

      const res = await app.request("/api/memory/mem-1/flag", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: true }),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("flagged");
      expect(body.flagged).toBe(true);
    });

    it("unflags a memory entry", async () => {
      deps.manageMemory.flagMemory.mockResolvedValue(undefined);

      const res = await app.request("/api/memory/mem-1/flag", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: false }),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.flagged).toBe(false);
    });
  });
});
