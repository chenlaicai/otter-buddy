/**
 * F20261008hcpa（#1356 选 A 层3）：healing 时间静默通道 severity 分层
 *
 * - autoStaleDismiss 排除 high（high 升级信号不被时间静默）
 * - ageOutHighAndNotify 取回超龄 high 并置 dismissed（供调度层推 alert-registry）
 * - 两通道协同：low/medium 走静默，high 走提醒
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { SqliteHealingEventRepository } from "@frameworks/db/healing/sqlite-healing-event-repository";
import type { HealingEvent } from "@entities/healing/healing-event";

const DAY_MS = 24 * 60 * 60 * 1000;

function seedEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return {
    id: `he-${Math.random().toString(36).slice(2, 8)}`,
    messageId: "msg-1", conversationId: "conv-1", otterId: "otter-1",
    errorType: "guard_intercept", severity: "low", description: "test event",
    suggestion: "", context: null, status: "open", resolution: null,
    createdAt: new Date().toISOString(), resolvedAt: null,
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

describe("SqliteHealingEventRepository severity 分层（#1356）", () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;

  beforeEach(() => { db = createTestDb(); repo = new SqliteHealingEventRepository(db); });
  afterEach(() => { db.close(); });

  describe("autoStaleDismiss 排除 high", () => {
    it("超龄 low/medium 被 dismiss，超龄 high 不被 dismiss", async () => {
      await repo.create(seedEvent({ id: "old-low", severity: "low", createdAt: daysAgo(40) }));
      await repo.create(seedEvent({ id: "old-medium", severity: "medium", createdAt: daysAgo(40) }));
      await repo.create(seedEvent({ id: "old-high", severity: "high", createdAt: daysAgo(40) }));
      await repo.create(seedEvent({ id: "new-high", severity: "high", createdAt: daysAgo(1) }));

      const dismissed = await repo.autoStaleDismiss(30);
      expect(dismissed).toBe(2);

      expect((await repo.findById("old-low"))!.status).toBe("dismissed");
      expect((await repo.findById("old-medium"))!.status).toBe("dismissed");
      expect((await repo.findById("old-high"))!.status).toBe("open");
      expect((await repo.findById("new-high"))!.status).toBe("open");
    });
  });

  describe("ageOutHighAndNotify", () => {
    it("取回超龄 high 并置 dismissed，未超龄 high 不动", async () => {
      await repo.create(seedEvent({ id: "aged-high", severity: "high", createdAt: daysAgo(2), description: "aged" }));
      await repo.create(seedEvent({ id: "fresh-high", severity: "high", createdAt: daysAgo(0.5), description: "fresh" }));
      await repo.create(seedEvent({ id: "aged-low", severity: "low", createdAt: daysAgo(2) }));

      const aged = await repo.ageOutHighAndNotify(1);
      expect(aged).toHaveLength(1);
      expect(aged[0].id).toBe("aged-high");
      expect(aged[0].description).toBe("aged");

      expect((await repo.findById("aged-high"))!.status).toBe("dismissed");
      expect((await repo.findById("aged-high"))!.resolvedAt).not.toBeNull();
      expect((await repo.findById("fresh-high"))!.status).toBe("open");
      expect((await repo.findById("aged-low"))!.status).toBe("open");
    });

    it("无超龄 high 时返回空数组且无副作用", async () => {
      await repo.create(seedEvent({ id: "fresh-high", severity: "high", createdAt: daysAgo(0.5) }));
      const aged = await repo.ageOutHighAndNotify(1);
      expect(aged).toEqual([]);
      expect((await repo.findById("fresh-high"))!.status).toBe("open");
    });

    it("幂等：第二次调用不再返回同一批事件（已 dismissed）", async () => {
      await repo.create(seedEvent({ id: "aged-high", severity: "high", createdAt: daysAgo(2) }));
      const first = await repo.ageOutHighAndNotify(1);
      expect(first).toHaveLength(1);
      const second = await repo.ageOutHighAndNotify(1);
      expect(second).toEqual([]);
    });

    it("resolved 状态的 high 不参与", async () => {
      await repo.create(seedEvent({ id: "resolved-high", severity: "high", status: "resolved", createdAt: daysAgo(5) }));
      const aged = await repo.ageOutHighAndNotify(1);
      expect(aged).toEqual([]);
      expect((await repo.findById("resolved-high"))!.status).toBe("resolved");
    });
  });

  describe("ageOutHighAndNotify 二次调用幂等视图（审视 D 修复验证面）", () => {
    it("先后两次 age-out：第二次取回空，不重复推送提醒", async () => {
      // 注意：better-sqlite3 同连接内事务顺序执行，本用例验证的是「取回与置 dismissed 原子化后，
      // 二次调用拿到空集」的幂等视图，不是真正的跨进程并发判别（旧 SELECT+UPDATE 实现在本用例
      // 形态下同样能过——真并发需两进程同时进入 SELECT 与 UPDATE 之间的窗口）。
      // RETURNING 改造的跨进程 race 消除是机制层面的：UPDATE 的 WHERE status='open' 匹配
      // 与行更新在同一 SQL 语句内原子完成，不存在两步窗口。
      await repo.create(seedEvent({ id: "race-high", severity: "high", createdAt: daysAgo(3) }));
      const repoB = new SqliteHealingEventRepository(db); // 同库第二实例（同连接池，顺序调用）

      const first = await repo.ageOutHighAndNotify(2);
      const second = await repoB.ageOutHighAndNotify(2);

      expect(first.map(e => e.id)).toEqual(["race-high"]); // 先到者拿到提醒推送权
      expect(second).toEqual([]); // 后到者空
      expect((await repo.findById("race-high"))!.status).toBe("dismissed");
    });
  });
});
