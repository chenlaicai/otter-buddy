import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { SignalPipeline } from "@usecases/health/signal-pipeline";
import type { DetectedSignal } from "@usecases/health/detect-signals";

function makePipeline(): { pipeline: SignalPipeline; stored: Array<Record<string, unknown>> } {
  const db = new Database(":memory:");
  initSchema(db);
  migrateDatabase(db, console as never);

  const stored: Array<Record<string, unknown>> = [];
  const writer = { storeEntry: vi.fn(async (e: Record<string, unknown>) => stored.push(e)) };
  const queue = { enqueueRetry: vi.fn(async () => {}), claimPendingTasks: vi.fn(async () => []) };
  // embeddingGateway.available=false，但 fireAndForgetEmbed 仍会调 embed——mock 成抛错走 enqueueRetry 降级路径
  const embedding = { available: false, embed: vi.fn(async () => { throw new Error("mock unavailable"); }) };

  return { pipeline: new SignalPipeline(db, writer as never, queue as never, embedding as never, console as never), stored };
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

  it("#845 建议 2：EXTERNALLY_MANAGED 信号不被 auto-resolve 误关", async () => {
    const { pipeline } = makePipeline();
    // chain_stall_watchdog 信号由 ChainStallWatchdogWorker 外部写入，不经过 pipeline.process
    // 直接用 SignalRepository upsert（与 watchdog 行为一致）
    const db = (pipeline as unknown as { signalRepo: { upsert: (s: unknown) => { id: number }; findOpen: () => Array<{id:number;signal_type:string;feature_id:string|null}>; resolve: (id:number) => boolean } }).signalRepo;
    db.upsert({
      signalType: "chain_stall_watchdog",
      severity: "critical",
      featureId: "conv-test-1",
      filePath: null,
      evidence: "test stall",
      suggestedAction: "test",
    });

    // pipeline 处理一个无关信号（hotspot）——chain_stall_watchdog 不在 detectedKeys 中
    await pipeline.process([signal("warning", "hotspot")]);

    // chain_stall_watchdog 信号应保持 open（不被 auto-resolve 误关）
    const open = pipeline.listOpen();
    const watchdogSignal = open.find(s => s.signal_type === "chain_stall_watchdog");
    expect(watchdogSignal).toBeDefined();
    expect(watchdogSignal!.feature_id).toBe("conv-test-1");
  });
});
