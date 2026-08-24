import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, json, createMockDeps } from "./helpers";
import type { TestDeps } from "./helpers";
import { createTestLogger } from "../helpers/logger";

describe("Settings API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;
  const writeDefaultModelMock = vi.fn();

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── GET /api/settings ───

  describe("GET /api/settings", () => {
    it("returns models list and default alias from ModelPool", async () => {
      deps.settingsRepo.getAll.mockResolvedValue({});

      const res = await app.request("/api/settings");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.models).toHaveLength(1);
      expect(body.models[0]).toMatchObject({ alias: "main", provider: "openai", model: "gpt-4o" });
      expect(body.defaultModelAlias).toBe("main");
      expect(body.port).toBe(3000);
      expect(body.dbPath).toBe("./otter-buddy.db");
    });

    it("does not expose apiKey/apiBaseUrl in models", async () => {
      const res = await app.request("/api/settings");
      const body = await json(res);
      expect(body.models[0]).not.toHaveProperty("apiKey");
      expect(body.models[0]).not.toHaveProperty("apiBaseUrl");
    });
  });

  // ─── PUT /api/settings ───

  describe("PUT /api/settings", () => {
    it("switches default model alias and persists override", async () => {
      // deps.modelPool has only "main" — create a multi-model pool for this test
      const { buildModelPool } = await import("../../src/frameworks/llm/model-pool");
      const pool = buildModelPool("fast", [
        { config: { alias: "fast", provider: "openai", model: "gpt-4o-mini" }, model: { id: "mini" } as never },
        { config: { alias: "powerful", provider: "anthropic", model: "claude-sonnet-4-20250514" }, model: { id: "claude" } as never },
      ]);
      // Swap the mock deps' modelPool — use a new test app instance with the multi-model pool
      const { SettingsController } = await import("../../src/interface-adapters/http/controllers/settings-controller");
      const { Hono } = await import("hono");
      const multiPoolApp = new Hono();
      const ctrl = new SettingsController(
        { port: 3000, dbPath: "/tmp/db", embeddingModelPath: "bge-m3", embeddingDim: 1024 },
        deps.settingsRepo,
        pool,
        createTestLogger(),
        writeDefaultModelMock,
      );
      multiPoolApp.put("/api/settings", (c) => ctrl.updateSettings(c));

      deps.settingsRepo.update.mockResolvedValue(undefined);

      const res = await multiPoolApp.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModelAlias: "powerful" }),
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.defaultModelAlias).toBe("powerful");
      expect(pool.getDefaultAlias()).toBe("powerful");
      // Why: config.yaml is the single source of truth, not DB settings table
      expect(writeDefaultModelMock).toHaveBeenCalledWith("powerful", pool, expect.anything());
      expect(deps.settingsRepo.update).not.toHaveBeenCalledWith("llm.defaultModelAlias", "powerful");
    });

    it("rejects unknown alias with 400", async () => {
      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModelAlias: "nonexistent" }),
      });

      expect(res.status).toBe(400);
    });

    it("does not update when no fields provided", async () => {
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
