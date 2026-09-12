/**
 * F20260912avlb：活动页三域台账 API 测试（真 sqlite + 真 controller）。
 *
 * 覆盖：三读端点返回结构与过滤参数；无写端点为架构断言（纯展示承诺——
 * 搭档拍板「不需要处理事件」，处置走对话内）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { ActivityController } from "@interface-adapters/http/controllers/activity-controller";
import { SqliteHealingEventRepository } from "@frameworks/db/healing/sqlite-healing-event-repository";
import { SqliteSignalEventRepository } from "@frameworks/db/signal/sqlite-signal-repository";
import { SqliteDispatchRecordRepository } from "@frameworks/db/dispatch/sqlite-dispatch-record-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Context } from "hono";
import { createTestLogger } from "../helpers/logger";

function makeCtx(query: Record<string, string>): Context {
  return {
    req: { query: (k: string) => query[k] },
    json: (data: unknown, status?: number) => new Response(JSON.stringify(data), { status: status ?? 200 }),
  } as never;
}

describe("活动页 API（F20260912avlb，三域只读）", () => {
  let db: Database.Database;
  let controller: ActivityController;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());
    migrateDatabase(db, createTestLogger());
    controller = new ActivityController(
      new SqliteHealingEventRepository(db),
      new SqliteSignalEventRepository(db),
      new SqliteDispatchRecordRepository(db),
      new SqliteConversationRepository(db, createTestLogger()),
      createTestLogger(),
    );
  });

  afterEach(() => {
    db.close();
  });

  function seedConversation(convId: string, otterIds: string[]) {
    db.prepare("INSERT INTO conversations (id, title, status, created_at) VALUES (?, ?, 'active', datetime('now'))").run(convId, `对话${convId}`);
    db.prepare("INSERT INTO turns (id, conversation_id, turn_number, created_at) VALUES (?, ?, 1, datetime('now'))").run(`turn-${convId}`, convId);
    for (const otterId of otterIds) {
      db.prepare("INSERT INTO otters (id, name, type, status) VALUES (?, ?, 'small', 'active')").run(otterId, `獭-${otterId}`);
      db.prepare(
        "INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id, joined_at_turn_number, status, created_at) VALUES (?, ?, ?, ?, 0, 'active', datetime('now'))",
      ).run(`p-${convId}-${otterId}`, convId, otterId, `turn-${convId}`);
    }
  }

  describe("GET /api/activity/healing", () => {
    it("默认 status=open，返回 DTO 结构（含 count）", async () => {
      const ins = db.prepare(
        "INSERT INTO healing_events (id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      ins.run("h1", "m1", "conv-1", "ot-1", "tool_failure", "medium", "工具 X 失败", "重试", null, "open", "2026-09-12T10:00:00Z");
      ins.run("h2", "m2", "conv-1", "ot-1", "rate_limit", "low", "配额耗尽", "换模型", null, "resolved", "2026-09-12T11:00:00Z");

      const res = await controller.healing(makeCtx({}) as never as Context);
      const body = await res.json() as { events: Array<{ id: string; status: string }>; count: number };
      expect(body.count).toBe(1);
      expect(body.events[0]!.id).toBe("h1");
      // DTO 字段断言（契约面）
      expect(body.events[0]).toMatchObject({ errorType: "tool_failure", severity: "medium", otterId: "ot-1" });
    });

    it("conversationId 过滤走 findByConversation 路径 + status 内存过滤", async () => {
      const ins = db.prepare(
        "INSERT INTO healing_events (id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      ins.run("h1", "m1", "conv-1", "ot-1", "tool_failure", "medium", "d1", "s", null, "open", "2026-09-12T10:00:00Z");
      ins.run("h2", "m2", "conv-2", "ot-1", "tool_failure", "medium", "d2", "s", null, "open", "2026-09-12T10:00:00Z");
      ins.run("h3", "m3", "conv-1", "ot-1", "rate_limit", "low", "d3", "s", null, "resolved", "2026-09-12T10:00:00Z");

      const res = await controller.healing(makeCtx({ conversationId: "conv-1", status: "open" }) as never as Context);
      const body = await res.json() as { events: Array<{ id: string }>; count: number };
      expect(body.count).toBe(1);
      expect(body.events[0]!.id).toBe("h1");
    });
  });

  describe("GET /api/activity/signals", () => {
    function insertSignal(id: string, type: string, status: string, createdAt: string) {
      db.prepare(
        "INSERT INTO signal_events (id, conversation_id, message_id, from_otter_id, target_otter_id, type, severity, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, "conv-1", `msg-${id}`, "ot-from", "ot-to", type, "high", "异议正文", status, createdAt);
    }

    it("findAll 全表 + status/type 过滤", async () => {
      insertSignal("s1", "objection", "pending", "2026-09-12T10:00:00Z");
      insertSignal("s2", "blocked", "resolved", "2026-09-12T11:00:00Z");
      insertSignal("s3", "halt", "pending", "2026-09-12T12:00:00Z");

      const all = await (await controller.signals(makeCtx({}) as never as Context)).json() as { signals: unknown[]; count: number };
      expect(all.count).toBe(3);

      const pending = await (await controller.signals(makeCtx({ status: "pending" }) as never as Context)).json() as { signals: Array<{ id: string }>; count: number };
      expect(pending.count).toBe(2);

      const objections = await (await controller.signals(makeCtx({ type: "objection" }) as never as Context)).json() as { signals: Array<{ id: string }>; count: number };
      expect(objections.count).toBe(1);
      expect(objections.signals[0]!.id).toBe("s1");
    });

    it("DTO 契约字段（from/target/type/severity/payload/resolution）", async () => {
      insertSignal("s1", "objection", "pending", "2026-09-12T10:00:00Z");
      const body = await (await controller.signals(makeCtx({}) as never as Context)).json() as { signals: Array<Record<string, unknown>> };
      expect(body.signals[0]).toMatchObject({
        fromOtterId: "ot-from", targetOtterId: "ot-to", type: "objection", severity: "high", payload: "异议正文", status: "pending",
      });
    });
  });

  describe("GET /api/activity/dispatch", () => {
    function insertRecord(id: string, conversationId: string, otterId: string, status: string) {
      db.prepare(
        "INSERT INTO dispatch_records (id, conversation_id, otter_id, otter_name, task, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, conversationId, otterId, `獭-${otterId}`, "任务摘要", status, `2026-09-01T0${id.slice(-1)}:00:00Z`);
    }

    it("status 过滤 + present 实时 join 参与者表", async () => {
      seedConversation("conv-1", ["ot-a"]);
      insertRecord("dr-1", "conv-1", "ot-a", "dispatched");
      insertRecord("dr-2", "conv-1", "ot-b", "created");
      insertRecord("dr-3", "conv-2", "ot-a", "dissolved");

      const body = await (await controller.dispatch(makeCtx({}) as never as Context)).json() as {
        records: Array<{ id: string; present: boolean; conversationId: string }>; count: number;
      };
      expect(body.count).toBe(3);
      const dr1 = body.records.find(r => r.id === "dr-1")!;
      // ot-a 在 conv-1 在场
      expect(dr1.present).toBe(true);
      // ot-b 不在 conv-1 参与者表
      const dr2 = body.records.find(r => r.id === "dr-2")!;
      expect(dr2.present).toBe(false);
    });

    it("status=created 过滤", async () => {
      insertRecord("dr-1", "conv-1", "ot-a", "created");
      insertRecord("dr-2", "conv-1", "ot-b", "dispatched");

      const body = await (await controller.dispatch(makeCtx({ status: "created" }) as never as Context)).json() as { records: Array<{ id: string }>; count: number };
      expect(body.count).toBe(1);
      expect(body.records[0]!.id).toBe("dr-1");
    });

    it("对话不存在时 present 降级 false 不炸（getActiveParticipants 失败路径）", async () => {
      // conv-x 未 seed——SqliteConversationRepository 可能返回空数组而非抛错，两者都是降级语义
      insertRecord("dr-x", "conv-x", "ot-a", "created");
      const body = await (await controller.dispatch(makeCtx({}) as never as Context)).json() as { records: Array<{ present: boolean }>; count: number };
      expect(body.count).toBe(1);
      expect(body.records[0]!.present).toBe(false);
    });
  });

  describe("架构断言：无写端点（纯展示承诺）", () => {
    it("ActivityController 只有 healing/signals/dispatch 三个只读方法，无任何写方法", () => {
      const methods = Object.getOwnPropertyNames(ActivityController.prototype)
        .filter(n => n !== "constructor");
      expect(methods.sort()).toEqual(["dispatch", "healing", "signals"]);
    });

    it("路由表无 /api/activity/* 的 POST/PATCH/DELETE（router 源码级断言）", async () => {
      const routerSrc = await import("node:fs").then(fs =>
        fs.readFileSync("src/interface-adapters/http/router.ts", "utf-8"));
      const activityRoutes = routerSrc.split("\n").filter(l => l.includes("/api/activity"));
      expect(activityRoutes.length).toBe(3);
      expect(activityRoutes.every(l => l.includes("app.get("))).toBe(true);
    });
  });
});
