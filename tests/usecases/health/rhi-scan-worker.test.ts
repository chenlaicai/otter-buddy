import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
/** 共享 mock pipeline 工厂：writer/queue/embedding 全空实现（各 describe 通用） */
function makePipeline(db: Database.Database): SignalPipeline {
  const writer = { storeEntry: async () => {} };
  const queue = { enqueueRetry: async () => {}, claimPendingTasks: async () => [] };
  const embedding = { available: false, embed: async () => { throw new Error("mock"); } };
  return new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never);
}


/** 时钟冻结点（Issue #605）：真实时钟在模块加载时的快照。两点理由：
 *  1) 冻结——fixture 种子「now - offset」随真实运行时刻漂移，不同时段跑出不同种子、
 *     用例间真实时钟流逝也会引入偏差（#605/#601/#595 同族 flaky 的共同土壤）。
 *     冻结后单次运行内全部 Date.now() 派生值恒定，该类非确定性物理上不可能发生。
 *  2) 快照而非绝对固定时间——采集窗口 git log --since 按 committer date（真实时钟）过滤，
 *     fixture 的 --date 只设 author date；冻结点偏离真实时钟超过 60 天窗口会把 fixture 整体滤空
 *     （实测冻结在 2026-12-31 时 commitCount=0、7 用例翻红）。快照信真实时钟、又消除运行期间流逝。 */
const CLOCK_SNAPSHOT = new Date();


/** 测试仓库句柄：目录 + git 快捷方法（模块级工厂，避免 describe 体膨胀过 eslint 行限） */
class TestRepo {
  dir: string;
  private commitSeq = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.git(["init"]);
    this.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    this.git(["config", "user.email", "test@example.com"]);
    this.git(["config", "user.name", "RHI Test"]);
  }

  git(args: string[]): void {
    execFileSync("git", args, { cwd: this.dir, stdio: "pipe" });
  }

  /** 日期基点：5 天前，每个 commit 递增 1 小时——避免同秒创建导致秒级日期字符串并列、
   *  链内排序不稳定（曾致 active/regressed 随机翻转的 flaky，issue #595 PR1 修复） */
  nextCommitDate(): string {
    const d = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + this.commitSeq * 60 * 60 * 1000);
    this.commitSeq++;
    return d.toISOString();
  }

  async commitFile(file: string, content: string, message: string): Promise<void> {
    const fullPath = path.join(this.dir, file);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    this.git(["add", file]);
    this.git(["commit", "-m", message, "--date", this.nextCommitDate()]);
  }

  /** 写 F 文档并单独 commit */
  async commitDoc(docPath: string, content: string, message: string): Promise<void> {
    await mkdir(path.dirname(path.join(this.dir, docPath)), { recursive: true });
    await writeFile(path.join(this.dir, docPath), content, "utf-8");
    this.git(["add", "docs/"]);
    this.git(["commit", "-m", message, "--date", this.nextCommitDate()]);
  }
}

describe("RhiScanWorker（临时仓库 + 真 sqlite）", () => {
  let repo: TestRepo;
  let repoDir: string;
  let db: Database.Database;

  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK_SNAPSHOT);
    repoDir = await mkdtemp(path.join(tmpdir(), "rhi-worker-test-"));
    db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, console as never);

    repo = new TestRepo(repoDir);
    await seedFixture();
  });

  /** 种子历史：同文件 3 次 bugfix（bug_recurrence）+ F 文档（链路信号模型下 docStatus 不参与判定，仅保证链非 orphan） */
  async function seedFixture(): Promise<void> {
    for (const [content, message] of [
      ["v1", "[F20260801wwww][agent][New Feature] 建链"],
      ["v2", "[F20260801wwww][agent][BugFix] 修 1 (#11)"],
      ["v3", "[F20260801wwww][agent][BugFix] 修 2 (#12)"],
      ["v4", "[F20260801wwww][agent][BugFix] 修 3 (#13)"],
    ] as const) {
      await repo.commitFile("src/invoker.ts", content, message);
    }
    await repo.commitDoc("docs/features/2026/08/01/F20260801wwww.md", "---\nid: F20260801wwww\ntitle: 测试链\nsummary: 冒烟测试用 F 文档\nchange_type: feature\nstatus: development\n---\n\nbody\n", "[F20260801wwww][agent][Feature Update] 加文档");
  }


  afterAll(async () => {
    vi.useRealTimers();
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it("scanOnce 跑通全管道并落库信号", async () => {
    const pipeline = makePipeline(db);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, { prSource: async () => [] });

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
    const pipeline = makePipeline(db);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, { prSource: async () => [] });

    await worker.scanOnce();
    const before = pipeline.listOpen().find(s => s.signal_type === "bug_recurrence")!.occurrences;
    await worker.scanOnce();
    const after = pipeline.listOpen().find(s => s.signal_type === "bug_recurrence")!.occurrences;
    expect(after).toBe(before + 1);
  });

  it("prSource 注入后 pr-stalled 判定生效（F20260902sigm 端到端验证）", async () => {
    // 构造一条链：旧日期 commit + 对应 F 文档 + 关联停滞 open PR
    const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const oldDocDir = path.join(repoDir, "docs/features/2026/07/01");
    await mkdir(oldDocDir, { recursive: true });
    await writeFile(
      path.join(oldDocDir, "F20260701zzzz.md"),
      "---\nid: F20260701zzzz\ntitle: 旧链\nsummary: pr-stalled 测试\nchange_type: feature\nstatus: development\n---\n\nbody\n",
      "utf-8",
    );
    repo.git(["add", "docs/"]);
    repo.git(["commit", "-m", "[F20260701zzzz][agent][Feature Update] 旧链文档", "--date", oldDate]);

    const pipeline = makePipeline(db);

    // 未注入 prSource 的 worker 用默认 collectOpenPrs（测试 repo 无 gh remote，降级空数组）
    // → pr-stalled 信号缺席。显式空 prSource 模拟同一降级路径
    const workerNoPr = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      prSource: async () => [],
    });
    await workerNoPr.scanOnce();
    expect(pipeline.listOpen().find(s => s.evidence.includes("F20260701zzzz") && s.signal_type === "chain_stall")).toBeUndefined();

    // 注入停滞 open PR（20 天无推进 > 阈值 7 天）：pr-stalled 判定生效
    const workerWithPr = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      prSource: async () => [{
        number: 77, title: "旧链 PR", headRefName: "feature/old",
        body: null, url: "https://example.com/pr/77",
        createdAt: new Date(Date.now() - 25 * 86400000).toISOString(),
        lastActivityAt: new Date(Date.now() - 20 * 86400000).toISOString(),
        featureIds: ["F20260701zzzz"],
      }],
    });
    await workerWithPr.scanOnce();
    const stalled = pipeline.listOpen().find(s => s.evidence.includes("F20260701zzzz"));
    expect(stalled?.evidence).toContain("#77");
    expect(stalled?.evidence).toContain("无推进");
    expect(stalled?.confidence).toBe("normal");
  });

  it("snapshotSink 注入后 scanOnce 写入指标快照（F20260829hviz Fix A）", async () => {
    const pipeline = makePipeline(db);

    const sinkCalls: Array<{ date: string; rows: import("@usecases/health/snapshot-rows").CreateSnapshotRow[] }> = [];
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      prSource: async () => [],
      snapshotSink: (date, rows) => sinkCalls.push({ date, rows }),
    });

    const result = await worker.scanOnce();

    // 19 行：11 标准行 + 1 chain_states 行 + 6 health_index 行（issue #595 PR1）
    //        + 1 fix_interval 行（修复半衰期，Issue #645）
    expect(result.metricsStored).toBe(19);
    expect(sinkCalls).toHaveLength(1);
    const { date, rows } = sinkCalls[0]!;
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const byKey = new Map(rows.map(r => [r.metricKey, r]));
    expect(byKey.get("total_commits")!.metricValue).toBe(6);
    expect(byKey.get("bugfix_count")!.metricValue).toBe(3); // 60 天窗口内 3 个 BugFix commit（测试仓库历史全在窗口内）
    const chainStates = byKey.get("chain_states")!;
    // F20260902sigm：链路信号模型——链尾是 Feature Update（加文档）非 BugFix → 不 regressed；
    // 无 open PR（测试仓库无 gh remote，降级缺席）→ 无 stalled。旧断言 { stalled: 1, active: 1 } 已过时
    expect(JSON.parse(chainStates.metadata!)).toEqual({ active: 2 });

    // 3 个 bugfix 间隔固定 1h（时钟冻结，无写文件耗时） → 中位严格 1/24 天；metadata 带窗口参数。
    // 注：toBe 而非 toBeCloseTo 是浮点安全的——间隔恰为 3,600,000ms，3600000/86400000 = 1/24
    // 在 IEEE 754 double 中精确表示（分母 86400000 = 2^7×3^3×5^6，商为有限二进制小数，无舍入）
    const fixInterval = byKey.get("bugfix_median_interval_days")!;
    expect(fixInterval.metricType).toBe("fix_interval");
    expect(fixInterval.metricValue).toBe(1 / 24);
    const fiMeta = JSON.parse(fixInterval.metadata!);
    expect(fiMeta).toEqual({ windowDays: 60, bugfixCount: 3, intervalCount: 2, stat: "median" });

    // health_index 行：metricType 统一，5 维度 + overall 全在（D5 零信号满分）
    const hiRows = rows.filter(r => r.metricType === "health_index");
    expect(hiRows.map(r => r.metricKey).sort()).toEqual(["D1", "D2", "D3", "D4", "D5", "overall"]);
    const overall = hiRows.find(r => r.metricKey === "overall")!;
    const meta = JSON.parse(overall.metadata!);
    expect(meta).toHaveProperty("overallStatus");
    expect(typeof overall.metricValue).toBe("number");
  });

  it("snapshotSink 未注入时快照跳过且不报错（向后兼容）", async () => {
    const pipeline = makePipeline(db);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, { prSource: async () => [] });

    const result = await worker.scanOnce();
    expect(result.metricsStored).toBe(0);
    expect(result.signalCount).toBeGreaterThanOrEqual(1); // 主管道不受影响
  });

  it("snapshotSink 抛异常不影响信号落库（旁路隔离）", async () => {
    const pipeline = makePipeline(db);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      prSource: async () => [],
      snapshotSink: () => {
        throw new Error("sink boom");
      },
    });

    const result = await worker.scanOnce();
    expect(result.metricsStored).toBe(0); // 快照失败被吞，返回 0
    expect(result.stored).toBe(result.signalCount); // 信号正常落库
  });

  it("buildChainsOnce 与 scanOnce 同源且不落库（审视发现 3 补测：/api/health/chains 专用方法）", async () => {
    const pipeline = makePipeline(db);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, { prSource: async () => [] });

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
    const costOutputSink = (snapshotDate: string, rows: Array<{ snapshotDate: string; metricType: string; metricKey: string; metricValue: number; metadata?: string }>, metricType?: string) =>
      snapshotRepo.replaceForDate(snapshotDate, rows, metricType);

    const pipeline = makePipeline(db);

    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      prSource: async () => [],
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
    expect(keys.has("cache_hit_rate")).toBe(false); // #602：死键已删
    expect(keys.has("message_count")).toBe(true);
    expect(keys.has("tool_call_count")).toBe(true);

    // 验证 metadata 含 otter 信息
    const firstRow = costRows[0]!;
    const meta = JSON.parse(firstRow.metadata);
    expect(meta.otterId).toBe("test-otter-id");
    expect(meta.otterName).toBe("测试獭");
  });
  it("costOutputSink 未注入时快照跳过且不报错（向后兼容，#583）", async () => {
    const pipeline = makePipeline(db);
    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, { prSource: async () => [] });

    const result = await worker.scanOnce();
    expect(result.costOutputStored).toBe(0); expect(result.signalCount).toBeGreaterThanOrEqual(1);
  });
});

describe("costOutputSink 装配断裂回归测试（P0，#583）", () => {
  let repoDir: string;
  let db: Database.Database;

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "rhi-assembly-test-"));
    db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, console as never);

    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "RHI Test"], { cwd: repoDir, stdio: "pipe" });

    // 创建一个初始提交（符合仓库模板格式）
    const testFile = path.join(repoDir, "src", "test.ts");
    await mkdir(path.dirname(testFile), { recursive: true });
    await writeFile(testFile, "export const test = 1;", "utf-8");
    execFileSync("git", ["add", "src/test.ts"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "[F20260828tstt][health][New Feature] 初始提交"], { cwd: repoDir, stdio: "pipe" });
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

    const pipeline = makePipeline(db);

    const worker = new RhiScanWorker(repoDir, pipeline, async () => [], console as never, {
      prSource: async () => [],
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
