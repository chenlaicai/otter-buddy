import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, json, createMockDeps } from "./helpers";
import type { TestDeps } from "./helpers";

describe("Settings API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── GET /api/settings ───

  describe("GET /api/settings", () => {
    it("returns settings with stored overrides", async () => {
      deps.settingsRepo.getAll.mockResolvedValue({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      });

      const res = await app.request("/api/settings");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.provider).toBe("anthropic");
      expect(body.model).toBe("claude-sonnet-4-20250514");
      expect(body.port).toBe(3000);
      expect(body.dbPath).toBe("./otter-buddy.db");
    });

    it("falls back to config defaults when no stored values", async () => {
      deps.settingsRepo.getAll.mockResolvedValue({});

      const res = await app.request("/api/settings");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.provider).toBe("openai");
      expect(body.model).toBe("gpt-4o");
    });

    it("merges partial stored values with defaults", async () => {
      deps.settingsRepo.getAll.mockResolvedValue({
        provider: "anthropic",
      });

      const res = await app.request("/api/settings");
      const body = await json(res);
      expect(body.provider).toBe("anthropic");
      expect(body.model).toBe("gpt-4o"); // fallback
    });
  });

  // ─── PUT /api/settings ───

  describe("PUT /api/settings", () => {
    it("updates provider", async () => {
      deps.settingsRepo.update.mockResolvedValue(undefined);
      deps.settingsRepo.getAll.mockResolvedValue({
        provider: "anthropic",
        model: "gpt-4o",
      });

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.provider).toBe("anthropic");
    });

    it("updates model", async () => {
      deps.settingsRepo.update.mockResolvedValue(undefined);
      deps.settingsRepo.getAll.mockResolvedValue({
        provider: "openai",
        model: "gpt-4o-mini",
      });

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini" }),
      });

      expect(res.status).toBe(200);
    });

    it("updates both provider and model", async () => {
      deps.settingsRepo.update.mockResolvedValue(undefined);
      deps.settingsRepo.getAll.mockResolvedValue({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      });

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-20250514" }),
      });

      expect(res.status).toBe(200);
    });

    it("does not update when fields are falsy", async () => {
      deps.settingsRepo.getAll.mockResolvedValue({});

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(deps.settingsRepo.update).not.toHaveBeenCalled();
    });
  });
});
