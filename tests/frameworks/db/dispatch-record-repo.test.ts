/**
 * F20260912avlb：dispatch_records repo 行为测试。
 *
 * 覆盖：①生命周期三路径（created → dispatched → dissolved）
 *      ②markDispatched 批量语义（全部 created 刷 dispatched，已 dispatched 不重复刷新）
 *      ③findByFilter 过滤
 *      ④存量迁移映射（pending→created / in_progress→dispatched+updatedAt / 全局 dissolved 覆盖 / 删旧 key）
 *      ⑤迁移事务性（坏 JSON 整体回滚，旧 key 保留）
 * 全部走 createTestDb（生产 schema，禁止手写 DDL）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteDispatchRecordRepository } from "@frameworks/db/dispatch/sqlite-dispatch-record-repository";
import { createTestDb } from "../../helpers/db";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "../../helpers/logger";

describe("SqliteDispatchRecordRepository（F20260912avlb）", () => {
  let db: Database.Database;
  let repo: SqliteDispatchRecordRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteDispatchRecordRepository(db);
    db.prepare("INSERT INTO otters (id, name, type, status) VALUES (?, ?, ?, ?)").run("ot-active", "活跃獭", "small", "active");
    db.prepare("INSERT INTO otters (id, name, type, status) VALUES (?, ?, ?, ?)").run("ot-gone", "已散獭", "small", "dissolved");
  });

  afterEach(() => {
    db.close();
  });

  function insert(id: string, otterId: string, conversationId: string, status: string, createdAt = "2026-09-01T00:00:00Z") {
    return repo.create({
      id, conversationId, otterId, otterName: `獭-${otterId}`, task: "测试任务",
      status: status as "created" | "dispatched" | "dissolved",
      createdAt, dispatchedAt: null, dissolvedAt: null,
    });
  }

  describe("生命周期状态迁移", () => {
    it("created → markDispatched → dispatched（dispatched_at 填充）", async () => {
      await insert("dr-1", "ot-active", "conv-1", "created");
      const changed = await repo.markDispatched("ot-active", "conv-1");
      expect(changed).toBe(1);

      const rows = await repo.findByFilter({ conversationId: "conv-1" });
      expect(rows[0]!.status).toBe("dispatched");
      expect(rows[0]!.dispatchedAt).not.toBeNull();
    });

    it("markDispatched 批量语义：同獭同对话多条 created 全部刷 dispatched", async () => {
      // 同一獭在同一对话可以有多条记录（重启后再创建等场景）
      await insert("dr-1", "ot-active", "conv-1", "created", "2026-09-01T00:00:00Z");
      await insert("dr-2", "ot-active", "conv-1", "created", "2026-09-02T00:00:00Z");
      const changed = await repo.markDispatched("ot-active", "conv-1");
      expect(changed).toBe(2);

      const rows = await repo.findByFilter({ conversationId: "conv-1" });
      expect(rows.every(r => r.status === "dispatched")).toBe(true);
    });

    it("markDispatched 不刷新已 dispatched 记录（首次时间戳保留）", async () => {
      await insert("dr-1", "ot-active", "conv-1", "created");
      await repo.markDispatched("ot-active", "conv-1");
      const first = (await repo.findByFilter({}))[0]!;

      // 第二次 yield（多轮交棒）不改变 dispatched_at
      const changed = await repo.markDispatched("ot-active", "conv-1");
      expect(changed).toBe(0);
      const second = (await repo.findByFilter({}))[0]!;
      expect(second.dispatchedAt).toBe(first.dispatchedAt);
    });

    it("markDispatched 不跨对话：只刷指定对话的记录", async () => {
      await insert("dr-1", "ot-active", "conv-1", "created");
      await insert("dr-2", "ot-active", "conv-2", "created");
      await repo.markDispatched("ot-active", "conv-1");

      const conv2 = await repo.findByFilter({ conversationId: "conv-2" });
      expect(conv2[0]!.status).toBe("created");
    });

    it("markDissolved 全局清算：跨对话全部非 dissolved 刷 dissolved", async () => {
      await insert("dr-1", "ot-active", "conv-1", "created");
      await insert("dr-2", "ot-active", "conv-2", "dispatched");
      const changed = await repo.markDissolved("ot-active");
      expect(changed).toBe(2);

      const rows = await repo.findByFilter({ status: "dissolved" });
      expect(rows.length).toBe(2);
      expect(rows.every(r => r.dissolvedAt !== null)).toBe(true);
    });

    it("markDissolved 幂等：已是 dissolved 的不重复刷", async () => {
      await insert("dr-1", "ot-active", "conv-1", "dissolved");
      const changed = await repo.markDissolved("ot-active");
      expect(changed).toBe(0);
    });
  });

  describe("findByFilter", () => {
    it("按状态/獭/对话过滤 + created_at 倒序", async () => {
      await insert("dr-1", "ot-active", "conv-1", "created", "2026-09-01T00:00:00Z");
      await insert("dr-2", "ot-gone", "conv-1", "dispatched", "2026-09-02T00:00:00Z");
      await insert("dr-3", "ot-active", "conv-2", "dispatched", "2026-09-03T00:00:00Z");

      const byStatus = await repo.findByFilter({ status: "dispatched" });
      expect(byStatus.length).toBe(2);

      const byOtter = await repo.findByFilter({ otterId: "ot-active" });
      expect(byOtter.length).toBe(2);

      const byConv = await repo.findByFilter({ conversationId: "conv-1" });
      expect(byConv.length).toBe(2);
      // 倒序：最新的在前
      expect(byConv[0]!.id).toBe("dr-2");

      const all = await repo.findByFilter({});
      expect(all.length).toBe(3);
    });
  });

  describe("存量迁移 migrateFromContext", () => {
    function insertContext(otterId: string, key: string, payload: Record<string, unknown>, updatedAt: string) {
      db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)")
        .run(otterId, key, JSON.stringify(payload), updatedAt);
    }

    it("pending → created（dispatched_at=NULL）；in_progress → dispatched（updatedAt 近似填充）", async () => {
      insertContext("ot-active", "dispatch:d1", {
        id: "d1", conversationId: "conv-1", otterId: "ot-active", otterName: "活跃獭",
        task: "任务一", status: "pending", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z",
      }, "2026-09-01T10:00:00Z");
      insertContext("ot-active", "dispatch:d2", {
        id: "d2", conversationId: "conv-1", otterId: "ot-active", otterName: "活跃獭",
        task: "任务二", status: "in_progress", createdAt: "2026-09-01T11:00:00Z", updatedAt: "2026-09-02T15:00:00Z",
      }, "2026-09-02T15:00:00Z");

      const result = repo.migrateFromContext();
      expect(result.migrated).toBe(2);
      expect(result.ignored).toBe(0);

      const rows = await repo.findByFilter({});
      const d1 = rows.find(r => r.id === "d1")!;
      expect(d1.status).toBe("created");
      expect(d1.dispatchedAt).toBeNull();

      const d2 = rows.find(r => r.id === "d2")!;
      expect(d2.status).toBe("dispatched");
      // dispatched_at 用原 updatedAt 近似填充（最后一次派工时间的近似）
      expect(d2.dispatchedAt).toBe("2026-09-02T15:00:00Z");

      // 旧 key 清零（数据搬家非复制）
      const remain = db.prepare("SELECT COUNT(*) AS n FROM otter_context WHERE key LIKE 'dispatch:%'").get() as { n: number };
      expect(remain.n).toBe(0);
    });

    it("全局 otters active 集覆盖：不在 active 集的记录标 dissolved（dissolved_at=NULL 如实）", async () => {
      insertContext("ot-gone", "dispatch:d3", {
        id: "d3", conversationId: "conv-1", otterId: "ot-gone", otterName: "已散獭",
        task: "任务三", status: "in_progress", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T12:00:00Z",
      }, "2026-09-01T12:00:00Z");

      repo.migrateFromContext();
      const rows = await repo.findByFilter({});
      const d3 = rows[0]!;
      // dissolved 覆盖 baseStatus；dissolved_at 历史不可知 → NULL
      expect(d3.status).toBe("dissolved");
      expect(d3.dissolvedAt).toBeNull();
    });

    it("空 otter_context（新库）零循环零副作用", () => {
      const result = repo.migrateFromContext();
      expect(result.migrated).toBe(0);
      expect(result.ignored).toBe(0);
    });

    it("坏 JSON 中断整体迁移（事务回滚：旧 key 保留，新表无行）", () => {
      insertContext("ot-active", "dispatch:good", {
        id: "d-good", conversationId: "conv-1", otterId: "ot-active", otterName: "活跃獭",
        task: "好记录", status: "pending", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z",
      }, "2026-09-01T10:00:00Z");
      db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)")
        .run("ot-active", "dispatch:bad", "{not json", "2026-09-01T10:00:00Z");

      expect(() => repo.migrateFromContext()).toThrow(/bad JSON/);
      // 事务回滚：好记录也没搬，旧 key 都在
      const remain = db.prepare("SELECT COUNT(*) AS n FROM otter_context WHERE key LIKE 'dispatch:%'").get() as { n: number };
      expect(remain.n).toBe(2);
      const migrated = db.prepare("SELECT COUNT(*) AS n FROM dispatch_records").get() as { n: number };
      expect(migrated.n).toBe(0);
    });
  });
});

describe("dispatch 迁移在启动路径的真实串联（migration.ts settings 键防重跑）", () => {
  it("migrateDatabase 幂等：重复执行不重复搬家（settings 键守卫）", () => {
    const db = createTestDb();
    try {
      // createTestDb 已跑过一次 migrateDatabase（空 otter_context → 0 迁移 + settings 键落位）
      const marker = db.prepare("SELECT value FROM settings WHERE key = 'dispatch_records_migrated'").get();
      expect(marker).toMatchObject({ value: "done" });

      // 手工塞一条伪存量（模拟「键已落但数据未搬」的异常态不会被重跑——守卫语义）
      db.prepare("INSERT INTO otters (id, name, type, status) VALUES ('ot-x', 'X', 'small', 'active')").run();
      db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)")
        .run("ot-x", "dispatch:manual", JSON.stringify({ id: "manual", conversationId: "c", otterId: "ot-x", otterName: "X", task: "t", status: "pending", createdAt: "2026-09-01T00:00:00Z" }), "2026-09-01T00:00:00Z");
      migrateDatabase(db, { info: () => undefined, warn: () => undefined, error: () => undefined } as never);
      const stillThere = db.prepare("SELECT COUNT(*) AS n FROM otter_context WHERE key LIKE 'dispatch:%'").get() as { n: number };
      expect(stillThere.n).toBe(1); // 不重跑——键守卫生效
    } finally {
      db.close();
    }
  });

  it("老库真实串联：先插伪存量再跑 migrateDatabase → 数据入新表 + 旧 key 清零", () => {
    // 构造「initSchema 后、migrateDatabase 前」的老库窗口
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      initSchema(db, createTestLogger());
      db.prepare("INSERT INTO otters (id, name, type, status) VALUES ('ot-a', 'A', 'small', 'active')").run();
      db.prepare("INSERT INTO otter_context (otter_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
        "ot-a", "dispatch:legacy-1",
        JSON.stringify({ id: "legacy-1", conversationId: "conv-l", otterId: "ot-a", otterName: "A", task: "旧任务", status: "in_progress", createdAt: "2026-08-01T10:00:00Z", updatedAt: "2026-08-01T12:00:00Z" }),
        "2026-08-01T12:00:00Z",
      );

      migrateDatabase(db, createTestLogger());

      const row = db.prepare("SELECT * FROM dispatch_records WHERE id = 'legacy-1'").get() as Record<string, unknown>;
      expect(row).toMatchObject({ status: "dispatched", dispatched_at: "2026-08-01T12:00:00Z" });
      const remain = db.prepare("SELECT COUNT(*) AS n FROM otter_context WHERE key LIKE 'dispatch:%'").get() as { n: number };
      expect(remain.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
