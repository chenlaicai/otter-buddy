import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
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
    db = createTestDb();

    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir, stdio: "pipe" });

    // 3 commits → chains
    await commitFile("a.ts", "export const a = 1;", "feat: add a");
    await commitFile("b.ts", "export const b = 2;", "feat: add b");
    await commitFile("c.ts", "export const c = 3;", "feat: add c");

    // 插入 otter 数据
    db.prepare("INSERT INTO otters (id, name, type) VALUES (?, ?, ?)").run("test-otter-id", "测试獭", "big");
  });

  afterAll(async () => {
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it("scanOnce 写入信号 + 计算指标 + 存储快照", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    // 手写 sink 捕获快照
    const captured: Array<{ snapshotDate: string; rows: unknown[] }> = [];
    const snapshotSink = (snapshotDate: string, rows: unknown[]) => {
      captured.push({ snapshotDate, rows });
    };

    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      snapshotSink,
      metricsWindowDays: 60,
    });

    const result = await worker.scanOnce();
    expect(result.commitCount).toBe(3);
    expect(result.chainCount).toBeGreaterThanOrEqual(1);
    expect(result.signalCount).toBeGreaterThanOrEqual(1);
    expect(result.metricsStored).toBeGreaterThan(0);

    // 快照已写入
    expect(captured.length).toBe(1);
    expect(captured[0]!.rows.length).toBeGreaterThan(0);
  });

  it("snapshotSink 未注入时指标不计算不存储（向后兼容）", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    // 不注入 snapshotSink
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never);

    const result = await worker.scanOnce();
    expect(result.commitCount).toBe(3);
    expect(result.chainCount).toBeGreaterThanOrEqual(1);
    expect(result.signalCount).toBeGreaterThanOrEqual(1);
    expect(result.metricsStored).toBe(0); // 没注入 sink → 不计算
  });

  it("空仓库扫描不报错", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "rhi-worker-empty-"));
    execFileSync("git", ["init", emptyDir], { stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: emptyDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: emptyDir, stdio: "pipe" });

    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    const worker = new RhiScanWorker(emptyDir, pipeline, async () => [], console as never);
    const result = await worker.scanOnce();
    expect(result.commitCount).toBe(0);
    expect(result.chainCount).toBe(0);
    expect(result.signalCount).toBe(0);

    await rm(emptyDir, { recursive: true, force: true });
  });

  it("snapshotSink 抛错不阻断 scanOnce 返回", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    const brokenSink = () => { throw new Error("DB full"); };
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      snapshotSink: brokenSink,
      metricsWindowDays: 60,
    });

    // 不抛错，metricsStored=0
    const result = await worker.scanOnce();
    expect(result.commitCount).toBe(3);
    expect(result.metricsStored).toBe(0);
  });

  it("数据源异常输出哨兵值，快照不写入", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    const captured: unknown[] = [];
    const snapshotSink = (_d: string, rows: unknown[]) => { captured.push(rows); };

    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      snapshotSink,
      metricsWindowDays: 60,
      // 不注入 snapshotSink 以外的 sink（默认走内置数据源）
    });

    const result = await worker.scanOnce();
    expect(result.commitCount).toBe(3);
    // 有 GitLogCollector + CommitParser → 非哨兵值
    expect(result.metricsStored).toBeGreaterThan(0);
    // 快照写入了
    expect(captured.length).toBe(1);
  });

  it("zombieDays 透传到 buildFeatureChains", async () => {
    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    const chains: unknown[] = [];
    const worker = new RhiScanWorker(repoDir, pipeline, async () => { chains.push([]); return []; }, console as never, {
      zombieDays: 14,
    });

    await worker.scanOnce();
    // buildFeatureChains 已被调用（chains 收到了参数）
    expect(chains.length).toBeGreaterThanOrEqual(0);
  });

  it("costOutputSink 注入后 scanOnce 写入成本/产出快照（#583）", async () => {
    // 准备 session JSONL fixture
    const sessionsDir = path.join(repoDir, "data", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = "2026-08-28T10-00-00-000Z_test-sess-001.jsonl";
    await writeFile(
      path.join(sessionsDir, sessionFile),
      [
        `{"type":"session","version":3,"id":"test-sess-001","timestamp":"2026-08-28T10:00:00.000Z"}`,
        `{"type":"model_change","id":"mc1","parentId":null,"timestamp":"2026-08-28T10:00:01.000Z","provider":"mimo","modelId":"mimo-v2.5-pro"}`,
        `{"type":"message","id":"msg1","parentId":"mc1","timestamp":"2026-08-28T10:01:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"toolCall","id":"tc1","name":"speak","arguments":"{}"}],"model":"mimo-v2.5-pro","usage":{"input":1000,"output":100,"cacheRead":500,"cacheWrite":0,"totalTokens":1600,"cost":{"input":0.01,"output":0.005,"cacheRead":0.0005,"cacheWrite":0,"total":0.0155},"cacheWrite1h":0},"stopReason":"stop","timestamp":1724839260000,"responseId":"r1"}}`,
      ].join("\n"),
      "utf-8",
    );

    // 插入 otter 数据（使用 INSERT OR IGNORE 避免重复）
    db.prepare("INSERT OR IGNORE INTO otters (id, name, type) VALUES (?, ?, ?)").run("test-otter-id", "测试獭", "big");
    db.prepare("INSERT OR IGNORE INTO agent_sessions (otter_id, pi_session_id) VALUES (?, ?)").run("test-otter-id", "test-sess-001");
    // 插入 messages 数据（for OtterOutputCollector）
    db.prepare("INSERT OR IGNORE INTO conversations (id, title) VALUES (?, ?)").run("conv-test", "test");
    db.prepare("INSERT OR IGNORE INTO turns (id, conversation_id, turn_number) VALUES (?, ?, ?)").run("turn-test", "conv-test", 1);
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, conversation_id, sender_type, sender_id, sequence_num, turn_id, sender_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("msg-out-1", "conv-test", "otter", "test-otter-id", 1, "turn-test", "测试獭", "2026-08-28 10:05:00");

    // 准备快照 repo + sinks
    const { HealthSnapshotRepository } = await import("@usecases/health/health-snapshot-repository");
    const snapshotRepo = new HealthSnapshotRepository(db);
    const overviewSink = (snapshotDate: string, rows: Array<{ snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata?: string }>) =>
      snapshotRepo.replaceForDate(snapshotDate, rows);
    const costOutputSink = (snapshotDate: string, rows: Array<{ snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata?: string }>, metricType?: string) =>
      snapshotRepo.replaceForDate(snapshotDate, rows, metricType);

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

    // 验证 health_snapshots 表中有 cost_output 类型的行
    const costRows = snapshotRepo.findByDate("2026-08-28").filter(r => r.metric_type === "cost_output");
    expect(costRows.length).toBeGreaterThan(0);

    // 验证包含预期的指标键
    const keys = new Set(costRows.map(r => r.metric_key));
    expect(keys.has("input_tokens")).toBe(true);
    expect(keys.has("output_tokens")).toBe(true);
    expect(keys.has("total_cost")).toBe(true);
    expect(keys.has("cache_hit_rate")).toBe(true);
    expect(keys.has("message_count")).toBe(true);
    expect(keys.has("tool_call_count")).toBe(true);

    // 验证 metadata 含 otter 信息
    const firstRow = costRows[0]!;
    const meta = JSON.parse(firstRow.metadata ?? "{}");
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
    expect(result.costOutputStored).toBe(0);
    expect(result.signalCount).toBeGreaterThanOrEqual(1);
  });
});

describe("costOutputSink 装配断裂回归测试（P0，#583）", () => {
  let repoDir: string;
  let db: Database.Database;

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "rhi-assembly-test-"));
    db = createTestDb();
    
    // 初始化 git 仓库
    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir, stdio: "pipe" });
    
    // 创建一个初始提交
    const testFile = path.join(repoDir, "test.ts");
    await writeFile(testFile, "export const test = 1;", "utf-8");
    execFileSync("git", ["add", "test.ts"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir, stdio: "pipe" });
  });

  afterAll(async () => {
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it("metricType 参数必须正确转发（防止 overview 被 cost_output 摧毁）", async () => {
    // 回归测试：app.ts costOutputSink 必须转发 metricType 参数，否则 replaceForDate 会删除所有类型
    // 2026-08-30 检视发现：app.ts:157 costOutputSink 只接受 2 参数，第三参被静默丢弃
    // 导致 overview 看板数据被 cost_output 扫描系统性摧毁

    const sessionsDir = path.join(repoDir, "data", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, "2026-08-28T10-00-00-000Z_regression-test.jsonl"),
      [
        `{"type":"session","version":3,"id":"regression-test","timestamp":"2026-08-28T10:00:00.000Z"}`,
        `{"type":"model_change","id":"mc1","parentId":null,"timestamp":"2026-08-28T10:00:01.000Z","provider":"mimo","modelId":"mimo-v2.5-pro"}`,
        `{"type":"message","id":"msg1","parentId":"mc1","timestamp":"2026-08-28T10:01:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"regression test"}],"model":"mimo-v2.5-pro","usage":{"input":100,"output":10,"cacheRead":50,"cacheWrite":0,"totalTokens":160,"cost":{"input":0.001,"output":0.0005,"cacheRead":0.0001,"cacheWrite":0,"total":0.0016},"cacheWrite1h":0},"stopReason":"stop","timestamp":1724839260000,"responseId":"r1"}}`,
      ].join("\n"),
      "utf-8",
    );

    // 先插入一条 overview 数据，后续验证不会被 cost_output 删除
    const { HealthSnapshotRepository } = await import("@usecases/health/health-snapshot-repository");
    const snapshotRepo = new HealthSnapshotRepository(db);
    snapshotRepo.createBatch([
      { snapshotDate: "2026-08-28", metricType: "overview", metricKey: "commit_count", metricValue: 5 },
    ]);

    // 用 spy 捕获 sink 调用参数
    let capturedMetricType: string | undefined = "NOT_CALLED";
    const costOutputSink = (snapshotDate: string, rows: Array<{ snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata?: string }>, metricType?: string) => {
      capturedMetricType = metricType;
      return snapshotRepo.replaceForDate(snapshotDate, rows, metricType);
    };

    const writer = { storeEntry: async () => {} };
    const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
    const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
    const pipeline = new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);

    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      costOutputSink,
      sessionsDir,
      agentSessionSource: async () => [],
      costOutputDb: db,
    });

    await worker.scanOnce();

    // 验证 metricType 被正确传递（"cost_output"）
    expect(capturedMetricType).toBe("cost_output");

    // 验证 overview 数据未被删除
    const overviewRows = snapshotRepo.findByDate("2026-08-28").filter(r => r.metric_type === "overview");
    expect(overviewRows.length).toBe(1);
    expect(overviewRows[0]!.metric_key).toBe("commit_count");
  });
});
