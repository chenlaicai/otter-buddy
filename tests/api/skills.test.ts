import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, json, createMockDeps } from "./helpers";
import type { TestDeps } from "./helpers";

/** #576（F20260901emps）：能力库真数据源端点——ResourceLoader 适配器的契约测试 */
describe("Skills API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe("GET /api/skills", () => {
    it("returns skills from the directory", async () => {
      deps.skillDirectory = {
        list: async () => [
          { name: "companion", description: "Default mode" },
          { name: "core-workflow", description: "Info queries" },
        ],
      };
      app = createTestApp(deps);

      const res = await app.request("/api/skills");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.skills).toHaveLength(2);
      expect(body.skills[0]).toEqual({ name: "companion", description: "Default mode" });
    });

    it("defaults to empty list", async () => {
      const res = await app.request("/api/skills");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.skills).toHaveLength(0);
      expect(body.total ?? body.skills.length).toBe(0);
    });
  });
});
