import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { RhiScanWorker } from "@usecases/health/rhi-scan-worker";
import { SignalPipeline } from "@usecases/health/signal-pipeline";
import type { HealthIndexSnapshot } from "@usecases/health/snapshot-shift";

/** Issue #645 环比骤变的 worker 集成测试（独立文件：主测试文件超 lint 单函数行数上限） */

function makePipeline(db: Database.Database): SignalPipeline {
  const writer = { storeEntry: async () => {} };
  const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
  const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
  return new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);
}

describe("RhiScanWorker 环比骤变（Issue #645）", () => {
  let repoDir: string;
  let db: Database.Database;

  function git(args: string[]): void {
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "rhi-shift-test-"));
    db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, console as never);

    git(["init"]);
    git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "RHI Shift Test"]);

    // 最小 fixture：1 feature commit + 文档（有 commit 才有 health_index 行 = 骤变「今日」侧）
    const file = path.join(repoDir, "src/a.ts");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "v1", "utf-8");
    git(["add", "src/a.ts"]);
    git(["commit", "-m", "[F20260801shft][agent][New Feature] 建", "--date", "2026-08-30T10:00:00+08:00"]);

    const docDir = path.join(repoDir, "docs/features/2026/08/01");
    await mkdir(docDir, { recursive: true });
    await writeFile(
      path.join(docDir, "F20260801shft.md"),
      "---\nid: F20260801shft\ntitle: 骤变测试\nsummary: x\nchange_type: feature\nstatus: development\n---\n\nbody\n",
      "utf-8",
    );
    git(["add", "docs/"]);
    git(["commit", "-m", "[F20260801shft][agent][Feature Update] 加文档", "--date", "2026-08-30T11:00:00+08:00"]);
  });

  afterAll(async () => {
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it("prevDayHealthIndexSource 注入后环比骤变产出 snapshot_shift 信号", async () => {
    const pipeline = makePipeline(db);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 昨日五维+综合全部 80；今日 fixture 无 bugfix → bugfixRatio=0 → D1 质量成本 100（Δ+20），
    // 流程合规率 1/1 满分 → D4 流程合规 100（Δ+20）——双维度同时触发，断言锁 D4 文案
    const prevRows: HealthIndexSnapshot[] = [
      { snapshotDate: yesterday, metricKey: "D1", metricValue: 80 },
      { snapshotDate: yesterday, metricKey: "D2", metricValue: 80 },
      { snapshotDate: yesterday, metricKey: "D3", metricValue: 80 },
      { snapshotDate: yesterday, metricKey: "D4", metricValue: 80 },
      { snapshotDate: yesterday, metricKey: "D5", metricValue: 80 },
      { snapshotDate: yesterday, metricKey: "overall", metricValue: 80 },
    ];

    // 首扫：今日 health_index 缓存为空 → 骤变检测跳过（设计语义：日粒度信号，次轮生效）。
    // 注：缓存产生于 persistSnapshot 的快照计算内，需注入 snapshotSink（生产两 sink 同注）
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      snapshotSink: () => {},
      prevDayHealthIndexSource: () => prevRows,
    });
    const first = await worker.scanOnce();
    expect(first.snapshotShiftCount).toBe(0);

    // 二扫：缓存已是今日行 → 对比昨日源触发
    const result = await worker.scanOnce();
    expect(result.snapshotShiftCount).toBe(1);

    const shift = pipeline.listOpen().find(s => s.signal_type === "snapshot_shift");
    expect(shift).toBeDefined();
    expect(shift!.evidence).toContain(`${yesterday}→${today}`);
    expect(shift!.evidence).toContain("质量成本 80→100"); // D1 维度名 + 前后值（今日无 bugfix → D1 满分）
    expect(shift!.evidence).toContain("流程合规 80→100"); // D4 维度名 + 前后值（1/1 合规 → D4 满分）——两维度断言各自独立锁，
    // 避免审视 A1 指出的「双触发碰巧通过」：任一维度的计算回归都会被各自断言捕获
    expect(shift!.severity).toBe("warning");
    expect(shift!.suggested_action).toContain("深挖"); // SignalRecord 是 snake_case
  });

  it("未注入 / 数据源 null / 源抛异常时不产出信号且不报错（传感器分离）", async () => {
    const pipeline = makePipeline(db);

    // 未注入：恒 0
    const workerNone = new RhiScanWorker(repoDir, pipeline, async () => [], console as never);
    const r1 = await workerNone.scanOnce();
    expect(r1.snapshotShiftCount).toBe(0);

    // 注入但数据源返回 null（今日首扫，无可比数据）：跳过
    const workerNull = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      prevDayHealthIndexSource: () => null,
    });
    const r2 = await workerNull.scanOnce();
    expect(r2.snapshotShiftCount).toBe(0);
    expect(r2.stored).toBe(r2.signalCount);

    // 源抛异常不炸主管道
    const workerThrow = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      prevDayHealthIndexSource: () => {
        throw new Error("source boom");
      },
    });
    const r3 = await workerThrow.scanOnce();
    expect(r3.snapshotShiftCount).toBe(0);
    expect(r3.stored).toBe(r3.signalCount);
  });
});
