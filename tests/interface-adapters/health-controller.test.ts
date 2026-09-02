/**
 * F20260803mval: HealthController 行为测试
 * 覆盖聚合字段、healthy 判定、DB 异常返回 200 + healthy:false
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { HealthController } from "@interface-adapters/http/controllers/health-controller";
import type { FeatureRepository } from "@usecases/document/feature-repository";
import type { ResearchRepository } from "@usecases/document/research-repository";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { FileSystemGateway } from "@usecases/ports/file-system-gateway";
import { createTestLogger } from "../helpers/logger";

function makeRepos(opts: { dbFeatureIds?: string[]; diskIds?: string[] }) {
  const dbFeatureIds = opts.dbFeatureIds ?? [];
  const featureRepo = {
    findById: vi.fn(async () => null),
    findByFilePath: vi.fn(async () => null),
    findAll: vi.fn(async () => dbFeatureIds.map(id => ({ id, status: "draft", supersedes: [] as string[] }))),
    insert: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(),
  } as unknown as FeatureRepository;
  const researchRepo = {
    findById: vi.fn(async () => null), findByFilePath: vi.fn(async () => null),
    findAll: vi.fn(async () => []),
    insert: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(),
  } as unknown as ResearchRepository;
  const diskIds = opts.diskIds ?? [];
  const fs: FileSystemGateway = {
    readFile: vi.fn(async (p: string) => {
      for (const id of diskIds) {
        if (p.includes(id)) return `---\nid: ${id}\ntitle: t\nsummary: s\nchange_type: feature\nstatus: draft\n---\n`;
      }
      throw new Error("not found");
    }),
    readDir: vi.fn(async (dir: string) => {
      if (dir.includes("docs/research")) return []; // research 测试场景无文档
      if (dir.endsWith("docs/features"))
        return [{ name: "2026", isDirectory: () => true, isFile: () => false }];
      if (dir.endsWith("2026") || dir.endsWith("08"))
        return [{ name: dir.endsWith("2026") ? "08" : "03", isDirectory: () => true, isFile: () => false }];
      if (dir.endsWith("03"))
        return diskIds.map(id => ({ name: `${id}.md`, isDirectory: () => false, isFile: () => true }));
      return [];
    }),
    exists: vi.fn(async () => true),
  };
  return { featureRepo, researchRepo, fs };
}

function makeEmbedding(available: boolean): EmbeddingGateway {
  return { available, embed: vi.fn(async () => new Float32Array(1024)) };
}

function makeApp(ctrl: HealthController): Hono {
  const app = new Hono();
  app.get("/api/health/memory", (c) => ctrl.memory(c));
  return app;
}

describe("HealthController - F20260803mval", () => {
  it("磁盘=DB + embedding 可用 -> healthy=true", async () => {
    const { featureRepo, researchRepo, fs } = makeRepos({ dbFeatureIds: ["F1"], diskIds: ["F1"] });
    const ctrl = new HealthController(featureRepo, researchRepo, makeEmbedding(true), fs, "/root", createTestLogger());
    const res = await makeApp(ctrl).request("/api/health/memory");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.healthy).toBe(true);
    expect(body.embeddingAvailable).toBe(true);
    expect(body.reconcileGaps).toEqual([]);
  });

  it("磁盘有 DB 无 -> reconcileGaps + healthy=false", async () => {
    const { featureRepo, researchRepo, fs } = makeRepos({ dbFeatureIds: [], diskIds: ["Forphan"] });
    const ctrl = new HealthController(featureRepo, researchRepo, makeEmbedding(true), fs, "/root", createTestLogger());
    const res = await makeApp(ctrl).request("/api/health/memory");
    const body = await res.json() as Record<string, unknown>;
    expect(body.healthy).toBe(false);
    expect((body.reconcileGaps as string[]).length).toBeGreaterThan(0);
  });

  it("F20260804dcnv: gap 文档跑 validator，gapReasons 返回失败原因", async () => {
    // 让 mock 返回 summary 超长的 frontmatter（违反 ≤500 规则）
    const featureRepo = {
      findById: vi.fn(), findAll: vi.fn(async () => []),
      insert: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(),
    } as unknown as FeatureRepository;
    const researchRepo = {
      findById: vi.fn(), findAll: vi.fn(async () => []),
      insert: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(),
    } as unknown as ResearchRepository;
    const longSummary = "x".repeat(600);
    const fs: FileSystemGateway = {
      readFile: vi.fn(async () => `---\nid: F20260804long\ntitle: t\nsummary: ${longSummary}\n---\n`),
      readDir: vi.fn(async (dir: string) => {
        if (dir.endsWith("docs/features")) return [{ name: "2026", isDirectory: () => true, isFile: () => false }];
        if (dir.endsWith("2026")) return [{ name: "08", isDirectory: () => true, isFile: () => false }];
        if (dir.endsWith("08")) return [{ name: "04", isDirectory: () => true, isFile: () => false }];
        if (dir.endsWith("04")) return [{ name: "F20260804long-x.md", isDirectory: () => false, isFile: () => true }];
        return [];
      }),
      exists: vi.fn(async () => true),
    };
    const ctrl = new HealthController(featureRepo, researchRepo, makeEmbedding(true), fs, "/root", createTestLogger());
    const res = await makeApp(ctrl).request("/api/health/memory");
    const body = await res.json() as Record<string, unknown>;
    expect(body.healthy).toBe(false);
    const gaps = body.gapReasons as Array<{ id: string; errors: string[] }>;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].id).toBe("F20260804long");
    expect(gaps[0].errors.join(" ")).toMatch(/Summary length 600 out of range/);
  });

  it("F20260804dcnv: frontmatter 缺失 -> gapReasons 含 Missing frontmatter", async () => {
    const featureRepo = {
      findById: vi.fn(), findAll: vi.fn(async () => []),
      insert: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(),
    } as unknown as FeatureRepository;
    const researchRepo = {
      findById: vi.fn(), findAll: vi.fn(async () => []),
      insert: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(),
    } as unknown as ResearchRepository;
    const fs: FileSystemGateway = {
      readFile: vi.fn(async () => "# F20260804nometa: 标题\n\nbody\n"),
      readDir: vi.fn(async (dir: string) => {
        if (dir.endsWith("docs/features")) return [{ name: "2026", isDirectory: () => true, isFile: () => false }];
        if (dir.endsWith("2026")) return [{ name: "08", isDirectory: () => true, isFile: () => false }];
        if (dir.endsWith("08")) return [{ name: "04", isDirectory: () => true, isFile: () => false }];
        if (dir.endsWith("04")) return [{ name: "F20260804nometa-x.md", isDirectory: () => false, isFile: () => true }];
        return [];
      }),
      exists: vi.fn(async () => true),
    };
    const ctrl = new HealthController(featureRepo, researchRepo, makeEmbedding(true), fs, "/root", createTestLogger());
    const res = await makeApp(ctrl).request("/api/health/memory");
    const body = await res.json() as Record<string, unknown>;
    // 文件名兜底提 ID -> F20260804nometa 进 diskIds，但 DB 没有 -> gap
    expect((body.reconcileGaps as string[])).toContain("F20260804nometa");
    const gaps = body.gapReasons as Array<{ id: string; errors: string[] }>;
    const gap = gaps.find(g => g.id === "F20260804nometa");
    expect(gap).toBeDefined();
    expect(gap!.errors.join(" ")).toMatch(/Missing frontmatter/);
  });

  it("embedding 不可用 -> healthy=false", async () => {
    const { featureRepo, researchRepo, fs } = makeRepos({ dbFeatureIds: ["F1"], diskIds: ["F1"] });
    const ctrl = new HealthController(featureRepo, researchRepo, makeEmbedding(false), fs, "/root", createTestLogger());
    const res = await makeApp(ctrl).request("/api/health/memory");
    const body = await res.json() as Record<string, unknown>;
    expect(body.healthy).toBe(false);
    expect(body.embeddingAvailable).toBe(false);
  });

  it("DB 异常 -> 返回 200 + healthy:false（非 500）", async () => {
    const { fs } = makeRepos({ dbFeatureIds: [], diskIds: [] });
    const featureRepo = {
      findById: vi.fn(), findAll: vi.fn(async () => { throw new Error("DB locked"); }),
      insert: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(),
    } as unknown as FeatureRepository;
    const researchRepo = {
      findById: vi.fn(), findAll: vi.fn(async () => []),
      insert: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(),
    } as unknown as ResearchRepository;
    const ctrl = new HealthController(featureRepo, researchRepo, makeEmbedding(true), fs, "/root", createTestLogger());
    const res = await makeApp(ctrl).request("/api/health/memory");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.healthy).toBe(false);
    expect(body.error).toContain("DB locked");
  });
});
