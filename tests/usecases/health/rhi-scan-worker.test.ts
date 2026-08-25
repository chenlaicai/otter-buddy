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

/** 临时 git 仓库 + 真 sqlite 的端到端冒烟：采集→链→信号→落库 */
describe("RhiScanWorker（临时仓库 + 真 sqlite）", () => {
  let repoDir: string;
  let db: Database.Database;

  function git(args: string[]): void {
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  }

  async function commitFile(file: string, content: string, message: string): Promise<void> {
    const fullPath = path.join(repoDir, file);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    git(["add", file]);
    git(["commit", "-m", message]);
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "rhi-worker-test-"));
    db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, console as never);

    git(["init"]);
    git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "RHI Test"]);

    // 构造触发信号的历史：同文件 3 次 bugfix（bug_recurrence）+ 热点文件（hotspot）
    await commitFile("src/invoker.ts", "v1", "[F20260801wwww][agent][New Feature] 建链");
    await commitFile("src/invoker.ts", "v2", "[F20260801wwww][agent][BugFix] 修 1 (#11)");
    await commitFile("src/invoker.ts", "v3", "[F20260801wwww][agent][BugFix] 修 2 (#12)");
    await commitFile("src/invoker.ts", "v4", "[F20260801wwww][agent][BugFix] 修 3 (#13)");
    // F 文档：在途状态（stalled 候选——4 天前最后 commit，不触发；改用 20 天前的另一条链测 stalled 需要旧日期 commit，这里略）
    await mkdir(path.join(repoDir, "docs/features/2026/08/01"), { recursive: true });
    await writeFile(
      path.join(repoDir, "docs/features/2026/08/01/F20260801wwww.md"),
      `---\nid: F20260801wwww\ntitle: 测试链\nsummary: 冒烟测试用 F 文档\nchange_type: feature\nstatus: development\n---\n\nbody\n`,
      "utf-8",
    );
    git(["add", "docs/"]);
    git(["commit", "-m", "[F20260801wwww][agent][Feature Update] 加文档"]);
  });

  afterAll(async () => {
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it("scanOnce 跑通全管道并落库信号", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never);

    const result = await worker.scanOnce();

    // 5 个 commit 全部采集
    expect(result.commitCount).toBe(5);
    // 1 条链（F20260801wwww，最新 commit 是 BugFix 且触碰链内文件 → regressed）
    expect(result.chainCount).toBe(1);
    // bug_recurrence 触发（同文件 4 次 bugfix ≥3）；regressed 的 chain_stall 不触发（不是 stalled）
    expect(result.signalCount).toBeGreaterThanOrEqual(1);
    expect(result.stored).toBe(result.signalCount);

    // 落库可查
    const open = pipeline.listOpen();
    const rec = open.find(s => s.signal_type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.evidence).toContain("src/invoker.ts");
    expect(rec!.severity).toBe("critical");
  });

  it("重复扫描 occurrences 累加不重复开行", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never);

    await worker.scanOnce();
    const before = pipeline.listOpen().find(s => s.signal_type === "bug_recurrence")!.occurrences;
    await worker.scanOnce();
    const after = pipeline.listOpen().find(s => s.signal_type === "bug_recurrence")!.occurrences;
    expect(after).toBe(before + 1);
  });
});
