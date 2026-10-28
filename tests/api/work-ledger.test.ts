/**
 * F20261027hwl1 工作账本 API 测试：真实 Hono 应用 + 真实 DB（createTestDb）——
 * 走生产路由装配（workLedger 控制器注入），断言 HTTP 状态码与响应体（非 mock 调用参数）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers/db";
import { createRouter } from "@interface-adapters/http/router";
import { WorkLedgerController } from "@interface-adapters/http/controllers/work-ledger-controller";
import { SqliteWorkLedgerRepository } from "@frameworks/db/health/sqlite-work-ledger-repository";
import { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";
import { WorkLedgerReportBuilder } from "@usecases/health/work-ledger-report";
import { WorkDetailReportBuilder } from "@usecases/health/work-detail-report";
import { ModelEfficiencyReportBuilder } from "@usecases/health/model-efficiency-report";
import { WorkLedgerBinder } from "@usecases/health/work-ledger-binder";
import { createTestLogger } from "../helpers/logger";

let db: Database.Database;
let app: ReturnType<typeof createRouter>;
let repo: SqliteWorkLedgerRepository;
const logger = createTestLogger();

beforeEach(() => {
  db = createTestDb();
  repo = new SqliteWorkLedgerRepository(db);
  db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('o1', '獭', 'big', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('c1', '对话', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  const snapshotRepo = new HealthSnapshotRepository(db);
  const ctrl = new WorkLedgerController(
    new WorkLedgerReportBuilder(repo, logger),
    new WorkDetailReportBuilder(repo),
    new ModelEfficiencyReportBuilder(snapshotRepo, () => new Date("2026-10-27T20:00:00+08:00")),
    logger,
  );
  app = createRouter({ workLedger: ctrl } as never, logger);
});

afterEach(() => {
  db.close();
});

describe("GET /api/health/work-ledger", () => {
  it("真空态：200 + works 空数组 + coverage null + pricingAvailable false", async () => {
    const res = await app.request("/api/health/work-ledger", { headers: { "X-Otter-User-Id": "test", "X-Otter-User-Role": "admin" } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.works).toEqual([]);
    expect(body.attributionCoverage).toBeNull();
    expect(body.pricingAvailable).toBe(false);
  });

  it("登记工作后：列表返回工作与归属覆盖率", async () => {
    const binder = new WorkLedgerBinder(repo, logger, () => "2026-10-27T10:00:00Z");
    await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-1", title: "API 工作" });
    db.prepare(`INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, token_usage_input, token_usage_output, metadata) VALUES ('i1', 'c1', 'o1', 'completed', '2026-10-27T09:00:00Z', 10, 5, ?)`).run(JSON.stringify({ traceId: "t-1" }));

    const res = await app.request("/api/health/work-ledger", { headers: { "X-Otter-User-Id": "test", "X-Otter-User-Role": "admin" } });
    const body = await res.json() as { works: Array<{ title: string }>; attributionCoverage: number };
    expect(body.works.length).toBe(1);
    expect(body.works[0]!.title).toBe("API 工作");
    expect(body.attributionCoverage).toBe(1);
  });
});

describe("GET /api/health/work-ledger/:id", () => {
  it("不存在的 id → 404（不返回演示对象）", async () => {
    const res = await app.request("/api/health/work-ledger/nonexistent", { headers: { "X-Otter-User-Id": "test", "X-Otter-User-Role": "admin" } });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("存在的工作 → 200 + tokens/participants/traces", async () => {
    const binder = new WorkLedgerBinder(repo, logger, () => "2026-10-27T10:00:00Z");
    const w = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-1", title: "详情工作" });
    db.prepare(`INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, token_usage_input, token_usage_output, metadata) VALUES ('i1', 'c1', 'o1', 'completed', '2026-10-27T09:00:00Z', 10, 5, ?)`).run(JSON.stringify({ traceId: "t-1" }));

    const res = await app.request(`/api/health/work-ledger/${w.id}`, { headers: { "X-Otter-User-Id": "test", "X-Otter-User-Role": "admin" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { tokens: { totalTokens: number }; participants: unknown[]; traces: unknown[] };
    expect(body.tokens.totalTokens).toBe(15);
    expect(body.participants.length).toBe(1);
    expect(body.traces.length).toBe(1);
  });
});

describe("GET /api/health/model-efficiency", () => {
  it("无快照 → 200 + snapshotDays 0 + rows 空数组（空态真实）", async () => {
    const res = await app.request("/api/health/model-efficiency", { headers: { "X-Otter-User-Id": "test", "X-Otter-User-Role": "admin" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { snapshotDays: number; rows: unknown[]; timezone: string };
    expect(body.snapshotDays).toBe(0);
    expect(body.rows).toEqual([]);
    expect(body.timezone).toBe("Asia/Shanghai");
  });
});

describe("track_work 工具注册", () => {
  it("binder 注入时 track_work 在工具集中（真实 tool-factory 注册路径）", async () => {
    // 装配级：platforms.ts 注入 binder → tool-factory createTools 注册 track_work
    const { createTools } = await import("@interface-adapters/agent-runtime/tools/tool-factory");
    const binder = new WorkLedgerBinder(repo, logger, () => "2026-10-27T10:00:00Z");
    const tools = createTools({
      otterId: "o1",
      conversationId: "c1",
      workLedgerBinder: binder,
    } as never);
    const names = tools.map(t => t.name);
    expect(names).toContain("track_work");
  });

  it("track_work start 在 trace scope 内绑定成功；scope 外返回错误文本（不静默假成功）", async () => {
    const { runWithTrace } = await import("@usecases/ports/trace-context");
    const { createTools } = await import("@interface-adapters/agent-runtime/tools/tool-factory");
    const binder = new WorkLedgerBinder(repo, logger, () => "2026-10-27T10:00:00Z");
    const tools = createTools({ otterId: "o1", conversationId: "c1", workLedgerBinder: binder } as never);
    const trackWork = tools.find(t => t.name === "track_work")!;

    // scope 外：错误文本（归属无从谈起）
    const outside = await trackWork.execute("call-1", { action: "start", title: "scope 外" });
    expect(JSON.stringify(outside)).toContain("trace");

    // scope 内：登记成功 + 工作落库
    const inside = await runWithTrace({ traceId: "trace-tool-test" }, async () => {
      return trackWork.execute("call-2", { action: "start", title: "工具登记的工作" });
    });
    const text = JSON.stringify(inside);
    expect(text).toContain("已登记");
    const works = await repo.listWorks();
    expect(works.some(w => w.title === "工具登记的工作")).toBe(true);
  });
});
