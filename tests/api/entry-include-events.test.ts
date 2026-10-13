import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, json, createMockDeps } from "./helpers";
import type { TestDeps } from "./helpers";
import { foldInvokeEvents } from "@contract/api/invoke-event-fold";
import type { InvokeEventDTO } from "@contract/api/invoke";

/**
 * F20261013csv3 T5：entries ?includeEvents=true 批量投影集成测试。
 * 锁定：①开关关闭（默认）entries 无 events 字段 + 不查 invokeRepo；
 * ②开关打开批量投影折叠步（foldInvokeEvents 同源）；③error 摘要 ≤200 字符；
 * ④每 invoke ≤20 条；⑤无 invokeId 的条目不携带 events。
 */

const entryFixture = (overrides: Record<string, unknown> = {}) => ({
  id: "entry-1",
  conversationId: "conv-1",
  sequenceNum: 1,
  entryType: "speak",
  senderType: "otter",
  senderId: "otter-1",
  body: "你好",
  invokeId: "inv-1",
  yieldTargets: null,
  status: "completed",
  source: null,
  metadata: null,
  senderName: "测试獭",
  senderColor: null,
  contextTokens: null,
  contextTokensMax: null,
  createdAt: "2026-10-13T08:00:00Z",
  completedAt: "2026-10-13T08:00:05Z",
  ...overrides,
});

const makeEvents = (invokeId: string): InvokeEventDTO[] => [
  { id: "ev-1", invokeId, eventType: "assistant_text", payload: { content: "thinking…" }, sequenceNum: 1, createdAt: "2026-10-13T08:00:01Z" },
  { id: "ev-2", invokeId, eventType: "assistant_toolcall", payload: { name: "search_memory", arguments: { q: "x" } }, sequenceNum: 2, createdAt: "2026-10-13T08:00:02Z" },
  { id: "ev-3", invokeId, eventType: "tool_result", payload: { name: "search_memory", result: "found" }, sequenceNum: 3, createdAt: "2026-10-13T08:00:03Z" },
  { id: "ev-4", invokeId, eventType: "speak", payload: { body: "发言内容" }, sequenceNum: 4, createdAt: "2026-10-13T08:00:04Z" },
];

describe("GET /api/conversations/:id/entries?includeEvents=true（F20261013csv3 T5）", () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("默认（无 includeEvents）→ 不携带 events 字段 + 不查 invokeRepo", async () => {
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    deps.entryRepo = { getEntries: async () => [entryFixture()], getEntriesAfter: async () => [entryFixture()] };
    deps.invokeRepo = { getInvokeEventsByInvokeIds: getByIdsMock };
    const app = createTestApp(deps);

    const res = await app.request("/api/conversations/conv-1/entries");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.entries[0].events).toBeUndefined();
    expect(getByIdsMock).not.toHaveBeenCalled();
  });

  it("includeEvents=true → 批量投影折叠步（call 配对 + think + speak）", async () => {
    deps.entryRepo = { getEntries: async () => [entryFixture()], getEntriesAfter: async () => [entryFixture()] };
    deps.invokeRepo = { getInvokeEventsByInvokeIds: async () => makeEvents("inv-1") };
    const app = createTestApp(deps);

    const res = await app.request("/api/conversations/conv-1/entries?includeEvents=true");
    expect(res.status).toBe(200);
    const body = await json(res);
    const events = body.entries[0].events;
    expect(Array.isArray(events)).toBe(true);
    // foldInvokeEvents 同源：think → call（配对成功 pending=false）→ speak
    expect(events.map((s: { kind: string }) => s.kind)).toEqual(["think", "call", "speak"]);
    const call = events.find((s: { kind: string }) => s.kind === "call");
    expect(call).toMatchObject({ name: "search_memory", pending: false });
  });

  it("error 摘要截断 ≤200 字符", async () => {
    const longError = "E".repeat(500);
    deps.entryRepo = { getEntries: async () => [entryFixture()], getEntriesAfter: async () => [entryFixture()] };
    deps.invokeRepo = {
      getInvokeEventsByInvokeIds: async () => [
        { id: "ev-err", invokeId: "inv-1", eventType: "error", payload: { message: longError }, sequenceNum: 1, createdAt: "2026-10-13T08:00:01Z" },
      ],
    };
    const app = createTestApp(deps);
    const res = await app.request("/api/conversations/conv-1/entries?includeEvents=true");
    const body = await json(res);
    const err = body.entries[0].events.find((s: { kind: string }) => s.kind === "error");
    expect(err.message.length).toBeLessThanOrEqual(200);
  });

  it("每 invoke ≤20 条（超出截断）", async () => {
    const manyEvents = Array.from({ length: 30 }, (_, i) => ({
      id: `ev-${i}`, invokeId: "inv-1",
      eventType: i % 2 === 0 ? "assistant_toolcall" : "tool_result",
      payload: i % 2 === 0 ? { name: `tool_${i}`, arguments: {} } : { name: `tool_${i - 1}`, result: "ok" },
      sequenceNum: i, createdAt: "2026-10-13T08:00:01Z",
    }));
    deps.entryRepo = { getEntries: async () => [entryFixture()], getEntriesAfter: async () => [entryFixture()] };
    deps.invokeRepo = { getInvokeEventsByInvokeIds: async () => manyEvents };
    const app = createTestApp(deps);
    const res = await app.request("/api/conversations/conv-1/entries?includeEvents=true");
    const body = await json(res);
    expect(body.entries[0].events.length).toBeLessThanOrEqual(20);
  });

  it("无 invokeId 的条目不携带 events", async () => {
    deps.entryRepo = {
      getEntries: async () => [entryFixture({ invokeId: null, entryType: "user" })],
      getEntriesAfter: async () => [entryFixture({ invokeId: null, entryType: "user" })],
    };
    deps.invokeRepo = { getInvokeEventsByInvokeIds: async () => [] };
    const app = createTestApp(deps);
    const res = await app.request("/api/conversations/conv-1/entries?includeEvents=true");
    const body = await json(res);
    expect(body.entries[0].events).toBeUndefined();
  });
});

describe("foldInvokeEvents contract 层（T5 前后端同源锚）", () => {
  it("message_end 快照丢弃；孤儿 result 独立成步；speak 吸收同名 start", () => {
    const steps = foldInvokeEvents([
      { id: "1", invokeId: "x", eventType: "assistant_toolcall", payload: { content: [{ name: "fake" }] }, sequenceNum: 1, createdAt: "t1" },
      { id: "2", invokeId: "x", eventType: "tool_result", payload: { name: "orphan", result: "r" }, sequenceNum: 2, createdAt: "t2" },
      { id: "3", invokeId: "x", eventType: "assistant_toolcall", payload: { name: "speak", arguments: {} }, sequenceNum: 3, createdAt: "t3" },
      { id: "4", invokeId: "x", eventType: "speak", payload: { body: "hi" }, sequenceNum: 4, createdAt: "t4" },
    ], { invokeEnded: true });
    expect(steps.map(s => s.kind)).toEqual(["call", "speak"]); // 快照丢弃；orphan call 保留；speak 吸收 start
    const call = steps[0] as { kind: string; name: string; pending: boolean; interrupted?: boolean };
    expect(call).toMatchObject({ kind: "call", name: "orphan", pending: false });
  });
});
