import { describe, expect, it } from "vitest";
import { readEmbeddingHealth } from "@usecases/memory/embedding-health";
import type { EmbeddingGateway, EmbeddingServiceStats } from "@usecases/memory/embedding-gateway";
import type { MemoryQueue } from "@usecases/memory/memory-queue";

function laneStats(overrides: Partial<EmbeddingServiceStats> = {}): EmbeddingServiceStats {
  return {
    lane: "backfill", state: "ready", inFlight: 0, pendingWaiters: 0, attempts: 0,
    lastProgressAt: null, unreadySince: null, circuitBroken: false,
    tokensPerSec: 100, meanTokensPerText: 200,
    perTextLatencyMs: { p50: 100, p95: 200, p99: 300, samples: 3 },
    ...overrides,
  };
}

function gateway(stats: EmbeddingServiceStats): EmbeddingGateway {
  return { available: true, stats, embed: async () => new Float32Array(1) };
}

function queue(pending: number): MemoryQueue {
  return {
    enqueueRetry: async () => {}, claimPendingTasks: async () => [],
    markTaskDone: async () => {}, markTaskAttemptFailed: async () => {},
    pendingTaskStats: async () => ({
      pending, oldestAgeSeconds: 500, ageP50Seconds: 100, ageP95Seconds: 400,
      byPriority: { 2: pending }, earliestNextRetryAt: null,
    }),
  };
}

describe("F20261110embrc health 观测", () => {
  it("暴露 lane 延迟/吞吐与队列年龄分位，并按实测吞吐计算 ETA", async () => {
    const health = await readEmbeddingHealth({ backfill: gateway(laneStats()) }, queue(10));

    expect(health.queue).toMatchObject({ pending: 10, ageP50Seconds: 100, ageP95Seconds: 400, etaSeconds: 20 });
    expect(health.lanes.backfill?.perTextLatencyMs.p95).toBe(200);
    expect(health.alerts).toEqual([]);
  });

  it("live waiter>10、unready>60s、ETA>4h 都成为显式告警", async () => {
    const now = Date.now();
    const health = await readEmbeddingHealth({
      live: gateway(laneStats({ lane: "live", pendingWaiters: 11 })),
      backfill: gateway(laneStats({ tokensPerSec: 0.01, unreadySince: now - 61_000, state: "unready" })),
    }, queue(10), now);

    expect(health.alerts).toHaveLength(3);
    expect(health.alerts.join(" ")).toMatch(/live waiter depth 11/);
    expect(health.alerts.join(" ")).toMatch(/backfill lane unready/);
    expect(health.alerts.join(" ")).toMatch(/ETA/);
  });
});
