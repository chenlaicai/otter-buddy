import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingServiceImpl } from "../../../src/frameworks/embedding/embedding-service";
import type { EmbedRequest, EmbedBatchRequest, EmbedResponse } from "../../../src/frameworks/embedding/embedding-protocol";
import type { Logger } from "../../../src/usecases/ports/logger";

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
      const embedding = new Float32Array([index, text.length]);
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
