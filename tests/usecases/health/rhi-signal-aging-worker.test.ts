import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { SignalRepository } from "@usecases/health/signal-repository";
import { RhiSignalAgingWorker } from "@usecases/health/rhi-signal-aging-worker";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingEvent, HealingResolution } from "@entities/healing/healing-event";
import type { Logger } from "@usecases/ports/logger";

/** F20260917trig §3 验收 #5/#9：老化 worker 聚合限流 + 孤儿 healing 清理 + triaged 停滞告警 */

function makeDeps(): { repo: SignalRepository; healing: HealingEventRepository & { events: HealingEvent[] } } {
  const db = new Database(":memory:");
  initSchema(db);
  migrateDatabase(db, console as never);
  const repo = new SignalRepository(db);
  const events: HealingEvent[] = [];
  const healing: HealingEventRepository & { events: HealingEvent[] } = {
    events,
    async create(e: HealingEvent) { events.push(e); },
    async findById(id: string) { return events.find(e => e.id === id) ?? null; },
    async findOpen() { return events.filter(e => e.status === "open"); },
    async findAll(status: string) { return events.filter(e => e.status === status); },
    async findByConversation() { return []; },
    async findRecentByOtter() { return []; },
    async updateStatus(id: string, status: "open" | "resolved" | "dismissed") {
      const e = events.find(x => x.id === id);
      if (e) e.status = status;
    },
    async resolve(id: string, resolution: HealingResolution) {
      const e = events.find(x => x.id === id);
      if (e) {
        e.status = "resolved";
        e.resolution = resolution;
        e.resolvedAt = new Date().toISOString();
      }
    },
    async getStats() { return { total: events.length, open: events.filter(e => e.status === "open").length } as never; },
    async autoStaleDismiss() { return 0; },
    async batchResolveByFilter() { return { matched: 0, resolved: 0, resolvedIds: [] }; },
  };
  return { repo, healing };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

// 固定 now：让所有 first_seen 相对它可精确控制超龄/未超龄
const NOW = new Date("2026-09-17T00:00:00Z");

function seedAged(repo: SignalRepository, opts: { count: number; type?: string; hoursAgo: number; severity?: string }) {
  for (let i = 0; i < opts.count; i++) {
    const seenAt = new Date(NOW.getTime() - opts.hoursAgo * 3600000);
    repo.upsert({
      signalType: opts.type ?? "bug_recurrence",
      severity: opts.severity ?? "critical",
      featureId: null,
      filePath: `src/f${i}.ts`,
      evidence: "e",
      suggestedAction: null,
    }, seenAt);
  }
}

describe("RhiSignalAgingWorker（F20260917trig §3）", () => {
  it("验证 #5：同 signal_type 超龄信号聚合落 1 条 healing（非逐条）", async () => {
    const { repo, healing } = makeDeps();
    seedAged(repo, { count: 40, hoursAgo: 24 * 23 }); // 40 条全部超 72h
    const worker = new RhiSignalAgingWorker(() => repo, () => healing, logger);
    const r = await worker.scanOnce(NOW);
    expect(r.agedCount).toBe(40);
    expect(r.alertsCreated).toBe(1); // 聚合限流：同 type 一轮 1 条
    const evt = healing.events[0]!;
    expect(evt.severity).toBe("medium");
    expect(evt.errorType).toBe("other");
    expect((evt.context as { signalIds: number[] }).signalIds).toHaveLength(40);
    expect((evt.context as { signalType: string }).signalType).toBe("bug_recurrence");
    expect(evt.description).toContain("最老挂 23 天");
  });

  it("验证 #5：同 signal_type 去重——已有未销号 aging 告警则该类型整组跳过", async () => {
    const { repo, healing } = makeDeps();
    seedAged(repo, { count: 3, hoursAgo: 24 * 10 });
    const worker = new RhiSignalAgingWorker(() => repo, () => healing, logger);
    const r1 = await worker.scanOnce(NOW);
    expect(r1.alertsCreated).toBe(1);
    const r2 = await worker.scanOnce(NOW);
    expect(r2.agedCount).toBe(3); // 仍超龄
    expect(r2.alertsCreated).toBe(0); // 但同 type 已有 open 告警，不重复落
  });

  it("验证 #9：triaged 超 7 天停滞告警（按 triaged_at 计时）；未超龄不落", async () => {
    const { repo, healing } = makeDeps();
    // 种子：first_seen 10 天前（未接单口径不超 warning 7d 临界——但 severity=critical 72h 会超；
    // 为隔离「归口停滞」语义，先 bind 再调 back triaged_at）
    repo.upsert({
      signalType: "bug_recurrence", severity: "critical", featureId: null,
      filePath: "src/a.ts", evidence: "e", suggestedAction: null,
    }, new Date(NOW.getTime() - 24 * 10 * 3600000));
    repo.triage(1, "bind_issue", { issueNumber: 1012, now: new Date(NOW.getTime() - 24 * 10 * 3600000) });
    // triaged_at 是 10 天前 → 超 7 天停滞阈值
    const worker = new RhiSignalAgingWorker(() => repo, () => healing, logger);
    const r = await worker.scanOnce(NOW);
    expect(r.agedCount).toBe(1);
    expect(r.alertsCreated).toBe(1);
    expect(healing.events[0]!.description).toContain("停滞超 7 天");

    // 未超龄对照：triaged_at 3 天前 → 不落
    const { repo: repo2, healing: healing2 } = makeDeps();
    repo2.upsert({
      signalType: "bug_recurrence", severity: "critical", featureId: null,
      filePath: "src/a.ts", evidence: "e", suggestedAction: null,
    }, new Date(NOW.getTime() - 24 * 30 * 3600000));
    repo2.triage(1, "bind_issue", { issueNumber: 1012, now: new Date(NOW.getTime() - 24 * 3 * 3600000) });
    const worker2 = new RhiSignalAgingWorker(() => repo2, () => healing2, logger);
    const r2 = await worker2.scanOnce(NOW);
    expect(r2.alertsCreated).toBe(0);
  });

  it("验证 #5：信号终态化后对应 aging healing 自动销号（孤儿清理，单条+聚合格式兼容）", async () => {
    const { repo, healing } = makeDeps();
    seedAged(repo, { count: 2, hoursAgo: 24 * 10 });
    const worker = new RhiSignalAgingWorker(() => repo, () => healing, logger);
    await worker.scanOnce(NOW);
    expect(healing.events.filter(e => e.status === "open")).toHaveLength(1);
    // 两条信号都 resolve → 下一轮扫描应自动销号该聚合告警
    repo.resolve(1, NOW);
    repo.resolve(2, NOW);
    const r2 = await worker.scanOnce(NOW);
    expect(r2.orphanHealingsResolved).toBe(1);
    expect(healing.events.filter(e => e.status === "open")).toHaveLength(0);
    expect(healing.events[0]!.resolution!.notes).toContain("信号已终态");
  });

  it("验证 #5：组内任一信号仍 open → 聚合告警不销号", async () => {
    const { repo, healing } = makeDeps();
    seedAged(repo, { count: 2, hoursAgo: 24 * 10 });
    const worker = new RhiSignalAgingWorker(() => repo, () => healing, logger);
    await worker.scanOnce(NOW);
    repo.resolve(1, NOW); // 只 resolve 一条
    const r2 = await worker.scanOnce(NOW);
    expect(r2.orphanHealingsResolved).toBe(0); // 另一条还 open，告警保留
  });

  it("warning 超 7d 落告警；critical 未超 72h 不落", async () => {
    const { repo, healing } = makeDeps();
    seedAged(repo, { count: 1, hoursAgo: 24 * 8, severity: "warning" });
    seedAged(repo, { count: 1, type: "hotspot", hoursAgo: 24 * 2, severity: "critical" });
    const worker = new RhiSignalAgingWorker(() => repo, () => healing, logger);
    const r = await worker.scanOnce(NOW);
    expect(r.agedCount).toBe(1); // 只有 warning 超龄
    expect(r.alertsCreated).toBe(1);
    expect(healing.events[0]!.description).toContain("bug_recurrence");
  });

  it("in_progress 不扫：修复中信号超龄也不落告警", async () => {
    const { repo, healing } = makeDeps();
    seedAged(repo, { count: 1, hoursAgo: 24 * 30 });
    repo.triage(1, "bind_issue", { issueNumber: 1012, now: new Date(NOW.getTime() - 24 * 30 * 3600000) });
    repo.triage(1, "in_progress");
    const worker = new RhiSignalAgingWorker(() => repo, () => healing, logger);
    const r = await worker.scanOnce(NOW);
    expect(r.agedCount).toBe(0);
    expect(r.alertsCreated).toBe(0);
  });
});
