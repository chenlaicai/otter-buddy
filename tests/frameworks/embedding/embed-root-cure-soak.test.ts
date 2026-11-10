import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingServiceImpl } from "../../../src/frameworks/embedding/embedding-service";
import type { EmbedRequest, EmbedBatchRequest, EmbedResponse } from "../../../src/frameworks/embedding/embedding-protocol";
import type { Logger } from "../../../src/usecases/ports/logger";
import { createTestDb } from "../../helpers/db";
import { SqliteMemoryRepository } from "../../../src/frameworks/db/memory/sqlite-memory-repository";
import { EmbeddingRetryWorker } from "../../../src/usecases/memory/embedding-retry-worker";

vi.setConfig({ testTimeout: 20_000 });

const logger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => logger,
};

type WorkerMessage = EmbedRequest | EmbedBatchRequest;

class ChaosWorker extends EventEmitter {
  readonly computed: string[] = [];
  private dead = false;

  constructor(private readonly delayMs: number, ready = true) {
    super();
    if (ready) queueMicrotask(() => this.emitMessage({ type: "ready", meta: { modelId: "chaos", modelRev: "1", dim: 2 } }));
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  send(message: WorkerMessage): boolean {
    if (this.dead) return false;
    if (message.type === "embed") {
      setTimeout(() => {
        if (this.dead) return;
        this.computed.push(message.text);
        this.emitMessage({ type: "result", id: message.id, embedding: new Float32Array([1, 1]), durationMs: this.delayMs });
      }, this.delayMs);
      return true;
    }
    void this.runBatch(message);
    return true;
  }

  kill(): boolean {
    this.dead = true;
    return true;
  }

  crash(): void {
    this.dead = true;
    this.emit("exit", 1, null);
  }

  private async runBatch(message: EmbedBatchRequest): Promise<void> {
    const embeddings: Float32Array[] = [];
    for (let index = 0; index < message.texts.length; index++) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
      if (this.dead) return;
      const text = message.texts[index];
      this.computed.push(text);
      const embedding = new Float32Array(1024).fill(index + 1);
      embeddings.push(embedding);
      this.emitMessage({ type: "batch-progress", id: message.id, index, embedding, durationMs: this.delayMs });
    }
    this.emitMessage({ type: "batch-result", id: message.id, embeddings, durationMs: this.delayMs * message.texts.length });
  }

  private emitMessage(message: EmbedResponse): void {
    this.emit("message", message);
  }
}

function productionChunks(): string[] {
  return Array.from({ length: 500 }, (_, index) => {
    const length = 600 + (index * 37) % 5400;
    return `生产文档 chunk ${index}：embedding 队列、调度、进度与检索质量。`.repeat(Math.ceil(length / 30)).slice(0, length);
  });
}

function internal(service: EmbeddingServiceImpl): { watchdogTick(): void } {
  return service as unknown as { watchdogTick(): void };
}

afterEach(() => {
  EmbeddingServiceImpl.setTestTimeoutOverride(null);
  EmbeddingServiceImpl.setTestWatchdogOverride(null);
  EmbeddingServiceImpl.setTestReadyTimeoutOverride(null);
  delete process.env.OTTER_EMBED_READY_TIMEOUT_MS;
  vi.useRealTimers();
});

describe("F20261110embrc soak：生产长度分布与物理 lane 隔离", () => {
  it("500 长 chunk + 4s/条 + 中途杀 worker：live p95<2s，所有文本恰好计算一次", async () => {
    vi.useFakeTimers();
    const texts = productionChunks();
    const backfillWorkers: ChaosWorker[] = [];
    const backfillFactory = () => {
      const worker = new ChaosWorker(4_000);
      backfillWorkers.push(worker);
      return worker.asChildProcess();
    };
    const liveFactory = () => new ChaosWorker(100).asChildProcess();
    const backfill = new EmbeddingServiceImpl(backfillFactory(), logger, backfillFactory, { lane: "backfill" });
    const live = new EmbeddingServiceImpl(liveFactory(), logger, liveFactory, { lane: "live" });
    const salvaged = new Map<number, Float32Array>();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const original = backfill.embedBatch!(texts, {
        salvage: (embeddings, startIndex = 0) => {
          embeddings.forEach((embedding, offset) => salvaged.set(startIndex + offset, embedding));
        },
      });
      let originalError: unknown = null;
      void original.catch(err => { originalError = err; });

      const liveLatencies: number[] = [];
      const liveCalls: Promise<void>[] = [];
      for (let index = 0; index < 10; index++) {
        const startedAt = Date.now();
        liveCalls.push(live.embed(`实时消息 ${index}`, { waitSlot: true }).then(() => {
          liveLatencies.push(Date.now() - startedAt);
        }));
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(1_100);
      await Promise.all(liveCalls);
      liveLatencies.sort((a, b) => a - b);
      expect(liveLatencies[Math.ceil(liveLatencies.length * 0.95) - 1]).toBeLessThan(2_000);

      await vi.advanceTimersByTimeAsync(7_000);
      expect(backfillWorkers[0].computed).toHaveLength(2);
      backfillWorkers[0].crash();
      await vi.advanceTimersByTimeAsync(0);
      expect(String(originalError)).toMatch(/Worker exited/);
      expect([...salvaged.keys()].sort((a, b) => a - b)).toEqual([0, 1]);

      const remainder = backfill.embedBatch!(texts.slice(2));
      await vi.advanceTimersByTimeAsync(2_000_000);
      await remainder;
      const computed = backfillWorkers.flatMap(worker => worker.computed);
      expect(computed).toHaveLength(500);
      expect(new Set(computed).size).toBe(500);
      expect(backfillWorkers).toHaveLength(2);
      expect(backfill.stats.state).toBe("ready");
      expect(backfill.stats.perTextLatencyMs.p95).toBe(4_000);
    } finally {
      backfill.dispose();
      live.dispose();
    }
  });

  it("backfill 没有 live 的墙钟批死线，慢结果仍被采纳", async () => {
    vi.useFakeTimers();
    EmbeddingServiceImpl.setTestTimeoutOverride(10);
    const factory = () => new ChaosWorker(100).asChildProcess();
    const service = new EmbeddingServiceImpl(factory(), logger, factory, { lane: "backfill" });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const result = service.embedBatch!(["长文本一", "长文本二"]);
      await vi.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toHaveLength(2);
      const single = service.embed("backfill 单条长文本");
      await vi.advanceTimersByTimeAsync(100);
      await expect(single).resolves.toBeInstanceOf(Float32Array);
    } finally {
      service.dispose();
    }
  });
});

describe("F20261110embrc lane 生命周期", () => {
  it("!ready 超窗会 respawn；连续失败熔断并落 health/healing 信号", async () => {
    vi.useFakeTimers();
    EmbeddingServiceImpl.setTestReadyTimeoutOverride(1_000);
    const workers: ChaosWorker[] = [];
    const factory = () => {
      const worker = new ChaosWorker(10, false);
      workers.push(worker);
      return worker.asChildProcess();
    };
    const service = new EmbeddingServiceImpl(factory(), logger, factory, { lane: "backfill" });
    const failures: unknown[] = [];
    service.setHealingReporter(failure => failures.push(failure));
    try {
      for (let index = 0; index < 4; index++) {
        await vi.advanceTimersByTimeAsync(1_001);
        internal(service).watchdogTick();
      }
      expect(workers).toHaveLength(4);
      expect(service.stats.state).toBe("dead");
      expect(service.stats.circuitBroken).toBe(true);
      expect(failures).toEqual([{ lane: "backfill", reason: "4 restarts within 300000ms", attempts: 4 }]);
    } finally {
      service.dispose();
    }
  });

  it("READY_TIMEOUT env 允许 fp32 慢盘冷加载越过 60s，不在加载中误杀", async () => {
    vi.useFakeTimers();
    process.env.OTTER_EMBED_READY_TIMEOUT_MS = "120000";
    let spawns = 0;
    const factory = () => {
      spawns++;
      return new ChaosWorker(10, false).asChildProcess();
    };
    const service = new EmbeddingServiceImpl(factory(), logger, factory, { lane: "live" });
    try {
      await vi.advanceTimersByTimeAsync(61_000);
      internal(service).watchdogTick();
      expect(spawns).toBe(1);
      expect(service.stats.attempts).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      internal(service).watchdogTick();
      expect(spawns).toBe(2);
      expect(service.stats.attempts).toBe(1);
    } finally {
      service.dispose();
    }
  });

  it("未 ready 第一代被重拉后，第二代 ready 恢复服务", async () => {
    vi.useFakeTimers();
    EmbeddingServiceImpl.setTestReadyTimeoutOverride(1_000);
    let generation = 0;
    const factory = () => new ChaosWorker(10, ++generation > 1).asChildProcess();
    const service = new EmbeddingServiceImpl(factory(), logger, factory, { lane: "live" });
    try {
      await vi.advanceTimersByTimeAsync(1_001);
      internal(service).watchdogTick();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.available).toBe(true);
      expect(service.stats.attempts).toBe(1);
      const result = service.embed("恢复后的实时消息");
      await vi.advanceTimersByTimeAsync(10);
      await expect(result).resolves.toBeInstanceOf(Float32Array);
    } finally {
      service.dispose();
    }
  });
});

describe("F20261110embrc service→salvage→DB re-claim 跨层链路", () => {
  it("worker 死亡后由 retry worker 自动重领：已 salvage 条目不重算，剩余条目不丢", async () => {
    vi.useFakeTimers();
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    const workers: ChaosWorker[] = [];
    const factory = () => {
      const worker = new ChaosWorker(1_000);
      workers.push(worker);
      return worker.asChildProcess();
    };
    const service = new EmbeddingServiceImpl(factory(), logger, factory, { lane: "backfill" });
    const retry = new EmbeddingRetryWorker(repo, repo, repo, service, logger, 3_600_000, 3);
    const texts = Array.from({ length: 12 }, (_, index) => `跨层长文档 ${index} ${"内容".repeat(200)}`);
    try {
      for (const [index, content] of texts.entries()) {
        const id = `cross-${String(index).padStart(2, "0")}`;
        await repo.storeEntry({
          id, layer: "document", contentType: "feature_chunk", sourceId: id,
          sourceTable: "features", conversationId: null, granularity: "fine",
          content, metadata: null, createdAt: new Date().toISOString(),
        });
        await repo.enqueueRetry(id, new Error("soak"), 2);
      }
      await retry.tickNow();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(workers[0].computed).toHaveLength(2);
      workers[0].crash();
      await vi.advanceTimersByTimeAsync(200);
      expect(await repo.pendingTaskCount()).toBe(10);

      // 只推进 DB 退避时间，不调用 embedBatch、不手工切剩余文本；生产 retry 自动重领。
      db.prepare("UPDATE embedding_tasks SET next_retry_at = datetime('now', '-1 second')").run();
      await retry.tickNow();
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await repo.pendingTaskCount()).toBe(0);
      expect(workers).toHaveLength(2);
      expect(workers[0].computed).toEqual(texts.slice(0, 2));
      expect(workers[1].computed).toEqual(texts.slice(2));
      const computed = workers.flatMap(worker => worker.computed);
      expect(computed).toHaveLength(12);
      expect(new Set(computed).size).toBe(12);
      expect(db.prepare("SELECT COUNT(*) AS n FROM memory_vec").get()).toEqual({ n: 12 });
    } finally {
      await retry.stop();
      service.dispose();
      db.close();
    }
  });
});
