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
      expect(body.skills[0]).toEqual({ name: "companion", description: "Default mode", body: "" });
    });

    it("F20260929scfx: body 字段透传 SKILL.md 正文全文", async () => {
      deps.skillDirectory = {
        list: async () => [
          { name: "companion", description: "Default mode", body: "# Companion\n\n兜底模式全文。" },
        ],
      };
      app = createTestApp(deps);

      const res = await app.request("/api/skills");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.skills[0].body).toContain("兜底模式全文");
    });

    it("defaults to empty list", async () => {
      const res = await app.request("/api/skills");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.skills).toHaveLength(0);
    });
  });
});

/** F20260929scfx：能力库全书——/api/prompts（卷首心法总纲 + 卷末兵器谱）契约测试 */
describe("Prompts API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe("GET /api/prompts", () => {
    it("returns system sections and tools", async () => {
      deps.promptDirectory = {
        getSystemSections: async () => [
          { title: "第一性原理（Axioms，A 层）", content: "事实优先于一切。" },
          { title: "世界观（Worldview，W 层）", content: "海獭是有名字的唯一实体。" },
        ],
        listTools: async () => [
          { name: "speak", description: "发言工具。" },
          { name: "yield", description: "交棒工具。" },
        ],
      };
      app = createTestApp(deps);

      const res = await app.request("/api/prompts");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.system).toHaveLength(2);
      expect(body.system[0].title).toContain("第一性原理");
      expect(body.system[0].content).toContain("事实优先");
      expect(body.tools).toHaveLength(2);
      expect(body.tools[0].name).toBe("speak");
      expect(body.tools[0].description).toContain("发言");
    });

    it("defaults to empty sections and empty tools", async () => {
      const res = await app.request("/api/prompts");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.system).toHaveLength(0);
      expect(body.tools).toHaveLength(0);
    });

    it("directory failure returns 500 via handleError", async () => {
      deps.promptDirectory = {
        getSystemSections: async () => {
          throw new Error("disk exploded");
        },
        listTools: async () => [],
      };
      app = createTestApp(deps);

      const res = await app.request("/api/prompts");
      expect(res.status).toBe(500);
    });
  });
});
