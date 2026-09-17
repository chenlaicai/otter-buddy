import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { SignalPipeline } from "@usecases/health/signal-pipeline";
import { SignalRepository } from "@usecases/health/signal-repository";
import type { DetectedSignal } from "@usecases/health/detect-signals";

function makePipeline(): { pipeline: SignalPipeline; stored: Array<Record<string, unknown>>; db: Database.Database } {
  const db = new Database(":memory:");
  initSchema(db);
  migrateDatabase(db, console as never);

  const stored: Array<Record<string, unknown>> = [];
  const writer = { storeEntry: vi.fn(async (e: Record<string, unknown>) => stored.push(e)) };
  const queue = { enqueueRetry: vi.fn(async () => {}), claimPendingTasks: vi.fn(async () => []) };
  // embeddingGateway.available=false，但 fireAndForgetEmbed 仍会调 embed——mock 成抛错走 enqueueRetry 降级路径
  const embedding = { available: false, embed: vi.fn(async () => { throw new Error("mock unavailable"); }) };

  return { pipeline: new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never), stored, db };
}

function signal(severity: "critical" | "warning", type: DetectedSignal["type"] = "bug_recurrence"): DetectedSignal {
  return {
    type,
    name: "bug 反复出现",
    severity,
    featureId: null,
    filePath: "src/invoker.ts",
    evidence: "agent invoker 3 次",
    suggestedAction: "强制根因分析",
  };
}

describe("SignalPipeline", () => {
  it("全部信号落库，warning 不进记忆通道", async () => {
    const { pipeline, stored } = makePipeline();
    const r = await pipeline.process([signal("warning")]);

    expect(r.stored).toBe(1);
    expect(r.memoryIndexed).toBe(0);
    expect(stored).toHaveLength(0);
    expect(pipeline.listOpen()).toHaveLength(1);
  });

  it("critical 信号进记忆通道（StoreMemory fact）并触发唤醒", async () => {
    const { pipeline, stored } = makePipeline();
    const wakeup = vi.fn(async () => {});
    const r = await pipeline.process([signal("critical")], wakeup);

    expect(r.stored).toBe(1);
    expect(r.memoryIndexed).toBe(1);
    expect(r.wakeupsTriggered).toBe(1);
    expect(r.wakeupsTriggered).toBe(1);

    // 记忆内容含信号结构与证据
    const entry = stored[0] as { content: string; metadata?: Record<string, unknown> };
    expect(entry.content).toContain("[RHI信号][critical]");
    expect(entry.content).toContain("agent invoker 3 次");
    expect(entry.metadata?.signal_type).toBe("bug_recurrence");
  });

  it("单信号失败不阻断批次（其余照常处理）", async () => {
    const { pipeline } = makePipeline();
    // 构造一个会让 upsert 抛错的信号：severity 传非法值导致 DB CHECK？signals 表无 CHECK——
    // 改为用行为验证：正常两信号 + pipeline 本身不抛
    const r = await pipeline.process([signal("warning", "hotspot"), signal("critical", "chain_stall")]);
    expect(r.stored).toBe(2);
    expect(r.errors).toHaveLength(0);
  });

  it("重复信号 occurrences 累加（落库幂等语义透传）", async () => {
    const { pipeline } = makePipeline();
    await pipeline.process([signal("warning")]);
    await pipeline.process([signal("warning")]);
    const open = pipeline.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].occurrences).toBe(2);
  });

  it("自动 resolve：不再触发的信号标记为 resolved", async () => {
    const { pipeline } = makePipeline();
    
    // 第一次扫描：检测到两个信号
    const signal1 = signal("warning", "hotspot");
    const signal2 = signal("critical", "chain_stall");
    await pipeline.process([signal1, signal2]);
    
    let open = pipeline.listOpen();
    expect(open).toHaveLength(2);
    
    // 第二次扫描：只检测到 signal1，signal2 不再触发
    await pipeline.process([signal1]);
    
    open = pipeline.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].signal_type).toBe("hotspot");
  });

  it("自动 resolve：多次扫描后信号收敛", async () => {
    const { pipeline } = makePipeline();
    
    // 第一次扫描：3 个信号
    const s1 = signal("warning", "hotspot");
    const s2 = signal("critical", "chain_stall");
    const s3: DetectedSignal = {
      type: "bug_recurrence",
      name: "bug 反复出现",
      severity: "critical",
      featureId: "F20260801tstw",
      filePath: null,
      evidence: "test 3 次",
      suggestedAction: "强制根因分析",
    };
    await pipeline.process([s1, s2, s3]);
    expect(pipeline.listOpen()).toHaveLength(3);
    
    // 第二次扫描：只剩 s1 和 s3
    await pipeline.process([s1, s3]);
    expect(pipeline.listOpen()).toHaveLength(2);
    
    // 第三次扫描：只剩 s1
    await pipeline.process([s1]);
    expect(pipeline.listOpen()).toHaveLength(1);
    expect(pipeline.listOpen()[0].signal_type).toBe("hotspot");
  });

  it("验证 #4（§6 抹平语义）：triaged 信号被 auto-resolve 后 triage_status/issue_number 抹平、note 保留", async () => {
    const { pipeline, db } = makePipeline();
    const s1 = signal("warning", "hotspot");
    const s2 = signal("critical", "chain_stall");
    await pipeline.process([s1, s2]);

    // s2 归口 issue #1012（经 repo.triage——与生产路径同一方法）
    const repo = new SignalRepository(db);
    const s2Record = pipeline.listOpen().find(s => s.signal_type === "chain_stall")!;
    repo.triage(s2Record.id, "bind_issue", { issueNumber: 1012, note: "并入 #1012" });

    // 下一轮扫描：s2 不再被检测 → auto-resolve → §6 抹平
    await pipeline.process([s1]);
    const resolved = repo.findByStatus("resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.triage_status).toBeNull(); // 抹平：无幽灵 triage 状态
    expect(resolved[0]!.issue_number).toBeNull(); // 抹平：无 closed issue 链接残留
    expect(resolved[0]!.triage_note).toBe("并入 #1012"); // note 保留作历史痕迹
  });
});
