/**
 * F20261008hcpa（#1356 选 A 层3）→ #1545 处置轮：healing 时间静默通道 severity 分层
 *
 * - autoStaleDismiss 排除 high（high 升级信号不被时间静默）；dismiss 落 resolution 三列（处置轮 S2）
 * - findAgedUnboundHigh 只读识别超龄 unbound high（供调度层推 alert-registry），不处置
 * - 两通道协同：low/medium 走时间静默，high 走「识别+提醒」
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

      // #1545 处置轮 S2：dismiss 终态三列齐——autoStaleDismiss 不再生产空 resolution 行
      const low = (await repo.findById("old-low"))!;
      expect(low.resolution).not.toBeNull();
      expect(low.resolution!.action).toBe("no_action");
      expect(low.resolution!.decidedBy).toBe("system");
      expect(low.resolution!.notes).toContain("超龄自动清理");
      expect(low.resolvedAt).not.toBeNull();
    });
  });

  describe("findAgedUnboundHigh（#1545 后：只读识别，不处置）", () => {
    it("取回超龄 unbound high（保持 open），未超龄 high 与低 severity 不在取回面", async () => {
      await repo.create(seedEvent({ id: "aged-high", severity: "high", createdAt: daysAgo(2), description: "aged" }));
      await repo.create(seedEvent({ id: "fresh-high", severity: "high", createdAt: daysAgo(0.5), description: "fresh" }));
      await repo.create(seedEvent({ id: "aged-low", severity: "low", createdAt: daysAgo(2) }));

      const aged = await repo.findAgedUnboundHigh(1);
      expect(aged).toHaveLength(1);
      expect(aged[0].id).toBe("aged-high");
      expect(aged[0].description).toBe("aged");

      // #1545：不处置——状态/resolution/resolved_at 均不动
      const after = (await repo.findById("aged-high"))!;
      expect(after.status).toBe("open");
      expect(after.resolvedAt).toBeNull();
      expect((await repo.findById("fresh-high"))!.status).toBe("open");
      expect((await repo.findById("aged-low"))!.status).toBe("open");
    });

    it("无超龄 unbound high 时返回空数组", async () => {
      await repo.create(seedEvent({ id: "fresh-high", severity: "high", createdAt: daysAgo(0.5) }));
      const aged = await repo.findAgedUnboundHigh(1);
      expect(aged).toEqual([]);
      expect((await repo.findById("fresh-high"))!.status).toBe("open");
    });

    it("resolved/dismissed 状态的 high 不参与（只识别待处置面）", async () => {
      await repo.create(seedEvent({ id: "resolved-high", severity: "high", status: "resolved", createdAt: daysAgo(5) }));
      const aged = await repo.findAgedUnboundHigh(1);
      expect(aged).toEqual([]);
      expect((await repo.findById("resolved-high"))!.status).toBe("resolved");
    });
  });

  describe("findAgedUnboundHigh 跨实例重复读取（#1545 后：只读，防重推依赖调度 claim 守卫）", () => {
    it("两次读取取回同一批（状态未变）——旧 UPDATE...RETURNING 的「先到者独占推送权」随处置语义一并移除，跨进程防重推由 scheduler claimAndValidateTask 拒绝并发同任务承担", async () => {
      await repo.create(seedEvent({ id: "race-high", severity: "high", createdAt: daysAgo(3) }));
      const repoB = new SqliteHealingEventRepository(db);

      const first = await repo.findAgedUnboundHigh(2);
      const second = await repoB.findAgedUnboundHigh(2);

      expect(first.map(e => e.id)).toEqual(["race-high"]);
      expect(second.map(e => e.id)).toEqual(["race-high"]); // 只读：两实例都可见（重复提醒引导归口，非重复处置）
      expect((await repo.findById("race-high"))!.status).toBe("open");
    });
  });

  describe("#1545 修复：age-out 不处置、只识别超龄 unbound high", () => {
    /** issue #1545 三缺陷回归：
     * ① bound high 被 age-out 误伤（bind≠resolve，去留应随 issue 生命周期）
     * ② unbound high 被 dismiss 后永失 bind_issue 归口通道（batch_bind 只作用 open）
     * ③ dismiss 不落 resolution（审计断链）
     * 修法：ageOutHighAndNotify 收窄为只读识别（findAgedUnboundHigh）——超龄 high 保持
     * open，提醒送达后由獭 bind_issue 归口、issue 修复后 batch_resolve 收尾。 */
    it("超龄 bound high：状态与归口列均不动（去留跟随 issue 生命周期）", async () => {
      // create() 不持久化 bound_issue（归口只走 batchBindIssue 路径），故先建再绑
      await repo.create(seedEvent({ id: "bound-aged", severity: "high", createdAt: daysAgo(3) }));
      const bind = await repo.batchBindIssue({ errorType: "guard_intercept" }, 1468);
      expect(bind.boundIds).toContain("bound-aged");
      const aged = await repo.findAgedUnboundHigh(2);
      expect(aged).toEqual([]);
      const after = (await repo.findById("bound-aged"))!;
      expect(after.status).toBe("open");
      expect(after.boundIssue).toBe(1468);
      expect(after.resolvedAt).toBeNull();
    });

    it("超龄 unbound high：保持 open、不落 resolved_at，仅被取回供提醒（可再 batch_bind）", async () => {
      await repo.create(seedEvent({ id: "unbound-aged", severity: "high", createdAt: daysAgo(3) }));
      const aged = await repo.findAgedUnboundHigh(2);
      expect(aged.map(e => e.id)).toEqual(["unbound-aged"]);
      const after = (await repo.findById("unbound-aged"))!;
      expect(after.status).toBe("open");
      expect(after.resolvedAt).toBeNull();
      expect(after.resolution).toBeNull();
      // 可继续归口（#1545 缺陷②的反证：bind 通道不被状态关闭）
      const bindResult = await repo.batchBindIssue({ errorType: "guard_intercept" }, 1468, { now: new Date() });
      expect(bindResult.boundIds).toContain("unbound-aged");
      expect((await repo.findById("unbound-aged"))!.status).toBe("open"); // bind 后仍 open（bind≠resolve）
    });

    it("幂等：同一批超龄 unbound high 连续两轮取回同一批（状态未变，提醒每日重复属预期）", async () => {
      await repo.create(seedEvent({ id: "stuck-high", severity: "high", createdAt: daysAgo(3) }));
      const first = await repo.findAgedUnboundHigh(2);
      const second = await repo.findAgedUnboundHigh(2);
      expect(first.map(e => e.id)).toEqual(["stuck-high"]);
      expect(second.map(e => e.id)).toEqual(["stuck-high"]);
    });

    it("dismiss(id, resolution)：落 status+resolution+resolved_at（#1545 缺陷③收口）", async () => {
      await repo.create(seedEvent({ id: "dism-target", severity: "medium", createdAt: daysAgo(1) }));
      await repo.dismiss("dism-target", { action: "no_action", decidedBy: "agent", decidedAt: new Date().toISOString(), notes: "48h 超龄自动 dismiss" });
      const after = (await repo.findById("dism-target"))!;
      expect(after.status).toBe("dismissed");
      expect(after.resolution).not.toBeNull();
      expect(after.resolution!.notes).toContain("超龄");
      expect(after.resolvedAt).not.toBeNull();
    });

    it("dismiss 不作用于 open 状态外的事件（fail-closed，对齐 assertUpdated 口径）", async () => {
      await repo.create(seedEvent({ id: "resolved-evt", status: "resolved", createdAt: daysAgo(1) }));
      await expect(repo.dismiss("resolved-evt", { action: "no_action", decidedBy: "agent", decidedAt: new Date().toISOString(), notes: "x" }))
        .rejects.toThrow();
    });
  });
});
