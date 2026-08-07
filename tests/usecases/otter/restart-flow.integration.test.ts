/**
 * F20260805rsto 端到端集成测试：重启獭生全链路。
 *
 * 刻意不 mock usecase/repo——本次事故的根因（双层 session 断裂）恰恰在所有层
 * 都被 mock 时才不可见。真 sqlite + 真 CreateOtter/ManageSession/OtterController，
 * 仅 seam 掉 pi 层（AgentGateway 假实现，不落 jsonl 文件）与记忆/对话网关。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { initSchema } from "@frameworks/db/schema";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { backfillSessionLedger } from "@frameworks/db/otter/backfill-session-ledger";
import { CreateOtter } from "@usecases/otter/create-otter";
import { ManageSession } from "@usecases/otter/manage-session";
import type { ConversationQueryGateway, MemoryLayerGateway } from "@usecases/otter/manage-session";
import type { AgentGateway } from "@usecases/otter/agent-gateway";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { QueryOtter } from "@usecases/otter/query-otter";
import { OtterController } from "@interface-adapters/http/controllers/otter-controller";
import { createTestLogger } from "../../helpers/logger";

/** 假 AgentGateway：记录 create/reset/destroy 调用，不碰 pi 文件层 */
function fakeAgentGateway() {
  const calls: Array<{ method: string; otterId: string }> = [];
  return {
    _calls: calls,
    create: vi.fn(async (otterId: string) => { calls.push({ method: "create", otterId }); }),
    reset: vi.fn(async (otterId: string) => { calls.push({ method: "reset", otterId }); }),
    destroy: vi.fn(async (otterId: string) => { calls.push({ method: "destroy", otterId }); }),
  } as unknown as AgentGateway & { _calls: Array<{ method: string; otterId: string }> };
}

describe("重启獭生全链路（F20260805rsto 集成）", () => {
  let db: Database.Database;
  let repo: SqliteOtterRepository;
  let gateway: ReturnType<typeof fakeAgentGateway>;
  let memoryTransitions: Array<{ from: string; to: string }>;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    repo = new SqliteOtterRepository(db);
    gateway = fakeAgentGateway();

    memoryTransitions = [];
    const conversationQuery: ConversationQueryGateway = {
      getIdsByOtterId: vi.fn(async () => ["conv-1"]),
    };
    const memoryLayer: MemoryLayerGateway = {
      updateLayer: vi.fn(async (_id: string, from: string, to: string) => {
        memoryTransitions.push({ from, to });
      }),
    };

    const manageSession = new ManageSession(repo, gateway, conversationQuery, memoryLayer, createTestLogger());
    const createOtter = new CreateOtter(repo, gateway, createTestLogger());
    const controller = new OtterController(
      createOtter,
      {} as DissolveOtter,
      manageSession,
      /** restart 控制器会查 otter 类型（小獭拒重启，F20260805rsto），stub 为大獭 */
      { getById: async () => ({ type: "big" }) } as unknown as QueryOtter,
      createTestLogger(),
    );
    app = new Hono();
    app.post("/api/otters/:id/restart", (c) => controller.restart(c));
    app.post("/api/otters", (c) => controller.create(c));
  });

  afterEach(() => {
    db.close();
  });

  it("CreateOtter 出生即建首世 domain session（不变量源头）", async () => {
    const res = await app.request("/api/otters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "大獭", type: "big" }),
    });
    expect(res.status).toBe(201);
    const otter = await res.json() as { id: string };

    const session = await repo.getActiveSession(otter.id);
    expect(session).not.toBeNull();
    expect(session!.previousSessionId).toBeNull();
  });

  it("restart 全链路：旧行 restarted + 记忆转历史 + agent reset + 新行建链 + summary 双写", async () => {
    const createRes = await app.request("/api/otters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "大獭", type: "big" }),
    });
    const otter = await createRes.json() as { id: string };
    const firstSession = (await repo.getActiveSession(otter.id))!;

    const res = await app.request(`/api/otters/${otter.id}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "前情摘要" }),
    });
    expect(res.status).toBe(201);

    /** 对 DB 真实状态断言，而非 mock 调用 */
    const history = await repo.getSessionHistory(otter.id);
    expect(history).toHaveLength(2);

    const oldRow = history.find((s) => s.id === firstSession.id)!;
    expect(oldRow.status).toBe("restarted");
    expect(oldRow.archiveReason).toBe("restart");
    expect(oldRow.summary).toBe("前情摘要");
    expect(oldRow.archivedAt).not.toBeNull();

    const newRow = history.find((s) => s.id !== firstSession.id)!;
    expect(newRow.status).toBe("active");
    expect(newRow.previousSessionId).toBe(firstSession.id);
    expect(newRow.summary).toBe("前情摘要");

    /** 记忆转换 + agent reset 真实发生 */
    expect(memoryTransitions).toEqual([{ from: "working", to: "historical" }]);
    expect(gateway._calls.filter((c) => c.method === "reset")).toHaveLength(1);

    /** 返回的 DTO 是新行（前端据此可感知新獭生） */
    const body = await res.json() as { id: string; summary: string };
    expect(body.id).toBe(newRow.id);
    expect(body.summary).toBe("前情摘要");
  });

  it("事故形态回归：存量獭（有 agent 会话、无 domain 行）经 backfill 后 restart 不再空操作", async () => {
    /** 手工种子：直接插 otters + agent_sessions，不建 domain 行——正是生产事故形态 */
    db.prepare(
      `INSERT INTO otters (id, name, type, status, created_at) VALUES ('legacy-otter', '存量獭', 'big', 'active', '2026-08-04T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_sessions (otter_id, pi_session_id) VALUES ('legacy-otter', 'pi-legacy')`,
    ).run();

    await backfillSessionLedger(db, repo, createTestLogger());
    const backfilled = await repo.getActiveSession("legacy-otter");
    expect(backfilled).not.toBeNull();

    const res = await app.request("/api/otters/legacy-otter/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "重启存量獭" }),
    });
    expect(res.status).toBe(201);

    const history = await repo.getSessionHistory("legacy-otter");
    expect(history).toHaveLength(2);
    expect(history.find((s) => s.id === backfilled!.id)!.status).toBe("restarted");
    expect(gateway._calls.filter((c) => c.method === "reset")).toHaveLength(1);
    expect(memoryTransitions).toHaveLength(1);
  });

  it("竞态认领：reset 等锁窗口内兜底已建行时，restart 认领该行并补 summary（不 409）", async () => {
    const createRes = await app.request("/api/otters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "大獭", type: "big" }),
    });
    const otter = await createRes.json() as { id: string };
    const firstSession = (await repo.getActiveSession(otter.id))!;

    /** 模拟竞态：reset 期间（archive 已提交 DB）invoke 兜底抢先建新行。
     *  用 fake gateway 的 reset 钩子在建行——archive 内 reset 被调时触发。 */
    gateway.reset = vi.fn(async () => {
      await repo.createSession({
        id: "backfilled-by-invoke", otterId: otter.id, status: "active",
        previousSessionId: firstSession.id, startedAt: new Date().toISOString(),
        archivedAt: null, archiveReason: null, isNegativeCase: false,
        summary: null,
      });
    });

    const res = await app.request(`/api/otters/${otter.id}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "竞态前情" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { id: string };
    expect(body.id).toBe("backfilled-by-invoke");
    /** summary 补写到认领行 */
    const adopted = await repo.getActiveSession(otter.id);
    expect(adopted!.id).toBe("backfilled-by-invoke");
    expect(adopted!.summary).toBe("竞态前情");
  });
});
