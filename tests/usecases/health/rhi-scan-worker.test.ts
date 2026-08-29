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

  it("fidMentionSource 注入后 zombie 判定生效（审视发现 2 的端到端验证）", async () => {
    // 构造一条 35 天前的在途链：旧日期 commit + 对应 F 文档（无文档判 orphan 不判 stalled）
    const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const oldDocDir = path.join(repoDir, "docs/features/2026/07/01");
    await mkdir(oldDocDir, { recursive: true });
    await writeFile(
      path.join(oldDocDir, "F20260701zzzz.md"),
      "---\nid: F20260701zzzz\ntitle: 旧链\nsummary: zombie 测试\nchange_type: feature\nstatus: development\n---\n\nbody\n",
      "utf-8",
    );
    execFileSync("git", ["-C", repoDir, "add", "docs/"], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "[F20260701zzzz][agent][Feature Update] 旧链文档", "--date", oldDate], { stdio: "pipe" });

    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    // 未注入 fidMentionSource：zombie 不判（降级 stalled）
    const workerNoMention = new RhiScanWorker(repoDir, pipeline, async () => [], console as never);
    await workerNoMention.scanOnce();
    const stalled = pipeline.listOpen().find(s => s.evidence.includes("F20260701zzzz"));
    expect(stalled?.evidence).toContain("滞留");

    // 注入提及源（空 Map = 查过全部 0 提及）：zombie 判定生效
    const workerWithMention = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      fidMentionSource: async () => new Map(),
    });
    await workerWithMention.scanOnce();
    const zombie = pipeline.listOpen().find(s => s.evidence.includes("F20260701zzzz"));
    expect(zombie?.evidence).toContain("僵尸链");
  });

  it("snapshotSink 注入后 scanOnce 写入指标快照（F20260829hviz Fix A）", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    const sinkCalls: Array<{ date: string; rows: import("@usecases/health/snapshot-rows").CreateSnapshotRow[] }> = [];
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      snapshotSink: (date, rows) => sinkCalls.push({ date, rows }),
    });

    const result = await worker.scanOnce();

    // 12 行：11 标准行 + 1 chain_states 行
    expect(result.metricsStored).toBe(12);
    expect(sinkCalls).toHaveLength(1);
    const { date, rows } = sinkCalls[0]!;
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const byKey = new Map(rows.map(r => [r.metricKey, r]));
    expect(byKey.get("total_commits")!.metricValue).toBe(6);
    expect(byKey.get("bugfix_count")!.metricValue).toBe(3); // 60 天窗口内 3 个 BugFix commit（测试仓库历史全在窗口内）
    const chainStates = byKey.get("chain_states")!;
    expect(JSON.parse(chainStates.metadata!)).toEqual({ stalled: 1, active: 1 });
  });

  it("snapshotSink 未注入时快照跳过且不报错（向后兼容）", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never);

    const result = await worker.scanOnce();
    expect(result.metricsStored).toBe(0);
    expect(result.signalCount).toBeGreaterThanOrEqual(1); // 主管道不受影响
  });

  it("snapshotSink 抛异常不影响信号落库（旁路隔离）", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      snapshotSink: () => {
        throw new Error("sink boom");
      },
    });

    const result = await worker.scanOnce();
    expect(result.metricsStored).toBe(0); // 快照失败被吞，返回 0
    expect(result.stored).toBe(result.signalCount); // 信号正常落库
  });

  it("buildChainsOnce 与 scanOnce 同源且不落库（审视发现 3 补测：/api/health/chains 专用方法）", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never);

    const before = pipeline.listOpen().length;
    const chains = await worker.buildChainsOnce();

    // 与 scanOnce 同源：同样的仓库能构建出链（含 F20260801wwww / F20260701zzzz）
    const fids = chains.map(c => c.featureId);
    expect(fids).toContain("F20260801wwww");
    expect(fids).toContain("F20260701zzzz");
    // 每条链携带五态字段（面板 stateCounts 依赖）
    for (const c of chains) {
      expect(c.state).toMatch(/^(active|stalled|regressed|zombie|orphan)$/);
    }
    // 纯读：不检测信号不落库（signals 数不变）
    expect(pipeline.listOpen().length).toBe(before);
  });

  it("costOutputSink 注入后 scanOnce 写入成本/产出快照（#583）", async () => {
    // 准备 session JSONL fixture
    const sessionsDir = path.join(repoDir, "data", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = `2026-08-28T10-00-00-000Z_test-sess-001.jsonl`;
    await writeFile(
      path.join(sessionsDir, sessionFile),
      [
        `{"type":"session","version":3,"id":"test-sess-001","timestamp":"2026-08-28T10:00:00.000Z"}`,
        `{"type":"model_change","id":"mc1","parentId":null,"timestamp":"2026-08-28T10:00:01.000Z","provider":"mimo","modelId":"mimo-v2.5-pro"}`,
        `{"type":"message","id":"msg1","parentId":"mc1","timestamp":"2026-08-28T10:01:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"toolCall","id":"tc1","name":"speak","arguments":"{}"}],"model":"mimo-v2.5-pro","usage":{"input":1000,"output":100,"cacheRead":500,"cacheWrite":0,"totalTokens":1600,"cost":{"input":0.01,"output":0.005,"cacheRead":0.0005,"cacheWrite":0,"total":0.0155},"cacheWrite1h":0},"stopReason":"stop","timestamp":1724839260000,"responseId":"r1"}}`,
      ].join("\n"),
      "utf-8",
    );

    // 插入 otter 数据
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("test-otter-id", "测试獭", "big");
    db.prepare("INSERT INTO agent_sessions (otter_id, pi_session_id) VALUES (?, ?)").run("test-otter-id", "test-sess-001");
    // 插入 messages 数据（for OtterOutputCollector）
    db.prepare("INSERT INTO conversations (id, title) VALUES (?, ?)").run("conv-test", "test");
    db.prepare("INSERT INTO turns (id, conversation_id, turn_number) VALUES (?, ?, ?)").run("turn-test", "conv-test", 1);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, sender_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("msg-out-1", "conv-test", "otter", "test-otter-id", 1, "turn-test", "测试獭", "2026-08-28 10:05:00");

    // 准备快照 repo + sinks
    const { HealthSnapshotRepository } = await import("@usecases/health/health-snapshot-repository");
    const snapshotRepo = new HealthSnapshotRepository(db);
    const overviewSink = (snapshotDate: string, rows: Array<{ snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata?: string }>) =>
      snapshotRepo.replaceForDate(snapshotDate, rows);
    const costOutputSink = (snapshotDate: string, rows: Array<{ snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata?: string }>) =>
      snapshotRepo.replaceForDate(snapshotDate, rows);

    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      snapshotSink: overviewSink,
      costOutputSink,
      sessionsDir,
      agentSessionSource: async () => [
        { piSessionId: "test-sess-001", otterId: "test-otter-id", otterName: "测试獭", otterType: "big" },
      ],
      costOutputDb: db,
    });

    const result = await worker.scanOnce();
    expect(result.costOutputStored).toBeGreaterThan(0);

    // 验证数据写入 health_snapshots
    const costRows = db.prepare("SELECT * FROM health_snapshots WHERE metric_type = 'cost_output' AND snapshot_date = ?")
      .all(new Date().toISOString().slice(0, 10)) as Array<{ metric_key: string; metric_value: number; metadata: string }>;
    expect(costRows.length).toBeGreaterThan(0);

    // 验证含 expected 指标键
    const keys = new Set(costRows.map(r => r.metric_key));
    expect(keys.has("input_tokens")).toBe(true);
    expect(keys.has("cost_total")).toBe(true);
    expect(keys.has("cache_hit_rate")).toBe(true);
    expect(keys.has("message_count")).toBe(true);
    expect(keys.has("tool_call_count")).toBe(true);

    // 验证 metadata 含 otter 信息
    const firstRow = costRows[0]!;
    const meta = JSON.parse(firstRow.metadata);
    expect(meta.otterId).toBe("test-otter-id");
    expect(meta.otterName).toBe("测试獭");
  });

  it("costOutputSink 未注入时快照跳过且不报错（向后兼容，#583）", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never);

    const result = await worker.scanOnce();
    expect(result.costOutputStored).toBe(0); // 未注入 sink，返回 0
    expect(result.signalCount).toBeGreaterThanOrEqual(1); // 主管道不受影响
  });
});
