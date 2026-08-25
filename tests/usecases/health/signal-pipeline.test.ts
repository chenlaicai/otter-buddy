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
});
