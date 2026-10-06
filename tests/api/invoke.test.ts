import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, json, createMockDeps } from "./helpers";
import type { TestDeps } from "./helpers";

/** F20260913ctlv Phase 4：invoke 只读查询端点（Session 弹窗数据源） */

const invokeFixture = {
  id: "inv-1",
  conversationId: "conv-1",
  otterId: "otter-1",
  status: "completed",
  triggerEntryId: null,
  talkingStonePassedTo: ["otter-2"],
  startedAt: "2026-09-10T06:00:00Z",
  endedAt: "2026-09-10T06:01:00Z",
  toolCallCount: 3,
  tokenUsageInput: 12000,
  tokenUsageOutput: 3400,
  ctxWindowUsed: null,
  pid: null,
  metadata: null,
};

function makeInvokeRepo(overrides: Record<string, unknown> = {}) {
  return {
    getInvokes: vi.fn().mockResolvedValue([invokeFixture]),
    getInvokeById: vi.fn().mockImplementation(async (id: string) =>
      id === "inv-1" ? invokeFixture : null),
    getInvokeEvents: vi.fn().mockResolvedValue([
      { id: "ev-1", invokeId: "inv-1", eventType: "speak", payload: { body: "hi" }, sequenceNum: 1, createdAt: "2026-09-10T06:00:30Z" },
      { id: "ev-2", invokeId: "inv-1", eventType: "assistant_toolcall", payload: { content: [{ name: "search_memory" }] }, sequenceNum: 2, createdAt: "2026-09-10T06:00:40Z" },
    ]),
    ...overrides,
  };
}



describe("Invoke API（F20260913ctlv）", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe("GET /api/conversations/:id/invokes", () => {
    it("返回 invoke 列表 + hasMore", async () => {
      deps.invokeRepo = makeInvokeRepo();
      app = createTestApp(deps);

      const res = await app.request("/api/conversations/conv-1/invokes");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.invokes).toHaveLength(1);
      expect(body.invokes[0]).toMatchObject({ id: "inv-1", otterId: "otter-1", status: "completed", toolCallCount: 3 });
      expect(body.hasMore).toBe(false);
    });

    it("多取 1 条判 hasMore=true", async () => {
      deps.invokeRepo = makeInvokeRepo({
        getInvokes: vi.fn().mockResolvedValue(Array.from({ length: 51 }, (_, i) => ({ ...invokeFixture, id: `inv-${i}` }))),
      });
      app = createTestApp(deps);

      const res = await app.request("/api/conversations/conv-1/invokes?limit=50");
      const body = await json(res);
      expect(body.invokes).toHaveLength(50);
      expect(body.hasMore).toBe(true);
    });

    it("未覆写 invokeRepo 时返回空列表（默认 stub，不 500）", async () => {
      const res = await app.request("/api/conversations/conv-1/invokes");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.invokes).toEqual([]);
    });
  });

  describe("GET /api/invokes/:id/events", () => {
    it("返回 invoke + 事件（按 sequence_num 序）", async () => {
      deps.invokeRepo = makeInvokeRepo();
      app = createTestApp(deps);

      const res = await app.request("/api/invokes/inv-1/events");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.invoke.id).toBe("inv-1");
      expect(body.events).toHaveLength(2);
      expect(body.events[0].eventType).toBe("speak");
    });

    it("不存在的 invoke 返回 404", async () => {
      deps.invokeRepo = makeInvokeRepo();
      app = createTestApp(deps);

      const res = await app.request("/api/invokes/inv-none/events");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/invokes/:id/abort", () => {
    const runningInvoke = { ...invokeFixture, id: "inv-target", status: "running" };

    function makeRepoFor(invoke: Record<string, unknown> | null) {
      return {
        getInvokes: vi.fn().mockResolvedValue([]),
        getInvokeById: vi.fn().mockImplementation(async (id: string) =>
          invoke && id === "inv-target" ? invoke : null),
        getInvokeEvents: vi.fn().mockResolvedValue([]),
      };
    }

    it("running invoke → 202 且调用 agentInvoker.abort", async () => {
      deps.invokeRepo = makeRepoFor(runningInvoke);
      deps.agentInvoker = { invokeConversation: vi.fn(), abort: vi.fn() };
      app = createTestApp(deps);

      const res = await app.request("/api/invokes/inv-target/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otterId: "otter-1" }),
      });
      expect(res.status).toBe(202);
      expect(deps.agentInvoker.abort).toHaveBeenCalledWith("otter-1", "inv-target");
    });

    it("invoke 不存在 → 404", async () => {
      deps.invokeRepo = makeRepoFor(null);
      deps.agentInvoker = { invokeConversation: vi.fn(), abort: vi.fn() };
      app = createTestApp(deps);

      const res = await app.request("/api/invokes/inv-missing/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otterId: "otter-1" }),
      });
      expect(res.status).toBe(404);
    });

    // F20260930s1x0（issue #1251）：假「行动中」（孤儿 invoke，#1241 场景）abort 必须 409 + 机读码，
    // 前端据此提示「该行动并非真实运行」而非静默无效果——本案修复的服务端契约
    it.each(["completed", "failed", "aborted"] as const)(
      "非 running invoke（%s，含假行动中的孤儿）→ 409 + code=invoke_not_running，且不调 agentInvoker.abort",
      async (status) => {
        deps.invokeRepo = makeRepoFor({ ...invokeFixture, id: "inv-target", status });
        deps.agentInvoker = { invokeConversation: vi.fn(), abort: vi.fn() };
        app = createTestApp(deps);

        const res = await app.request("/api/invokes/inv-target/abort", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ otterId: "otter-1" }),
        });
        expect(res.status).toBe(409);
        const body = await json(res);
        expect(body.code).toBe("invoke_not_running");
        expect(body.invoke_status).toBe(status);
        expect(String(body.error)).toContain(status);
        expect(deps.agentInvoker.abort).not.toHaveBeenCalled();
      },
    );
  });
});
