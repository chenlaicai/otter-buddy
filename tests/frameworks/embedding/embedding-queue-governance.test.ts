/**
 * F20261105embqg：队列治理三件套测试——S1 respawn / S2a 槽位优先级 / S2b 任务优先级 / S3 水位闸门。
 * S1/S2a 在 embedding-service（进程级 mock worker）；S2b/S3 在 embedding-task-queue（纯 SQL）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EmbeddingServiceImpl } from "../../../src/frameworks/embedding/embedding-service";
import { EmbedBackpressureError } from "../../../src/usecases/memory/embedding-gateway";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { fork, type ChildProcess } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function writeMockWorker(name: string, body: string): string {
  const p = path.join(__dirname, name);
  fs.writeFileSync(p, body);
  return p;
}

function forkMock(mockPath: string): ChildProcess {
  return fork(mockPath, [], { execArgv: [], serialization: "advanced" });
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

async function waitFor(cond: () => boolean, label: string, maxMs = 5000): Promise<void> {
  for (let i = 0; i < maxMs / 5; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** 响应 embed 的标准 mock worker（启动即握手 ready，收到 embed 即回向量；纯 JS 无 TS 语法） */
const RESPONSIVE_WORKER = `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type === "embed" || msg.type === "embed-batch") {
    setTimeout(() => {
      if (msg.type === "embed") {
        process.send({ type: "result", id: msg.id, embedding: new Float32Array([0.1, 0.2]) });
      } else {
        process.send({ type: "batch-result", id: msg.id, embeddings: msg.texts.map(() => new Float32Array([0.1, 0.2])) });
      }
    }, RESPOND_DELAY_MS);
  }
});
`;

describe("F20261105embqg S1：worker 意外 exit 自动 respawn", () => {
  let workerPath: string;

  beforeEach(() => {
    workerPath = writeMockWorker("mock-embq-respawn.mjs", RESPONSIVE_WORKER.replace("RESPOND_DELAY_MS", "20"));
  });

  afterEach(() => {
    EmbeddingServiceImpl.setTestTimeoutOverride(null);
    EmbeddingServiceImpl.setTestWatchdogOverride(null);
    EmbeddingServiceImpl.setTestMaxInFlightOverride(null);
  });

  it("外部 SIGTERM 后自动重建，新 worker ready 恢复 available 并可 embed", async () => {
    let spawnCount = 0;
    const factory = () => {
      spawnCount++;
      return forkMock(workerPath);
    };
    const service = new EmbeddingServiceImpl(factory(), noopLogger, factory);
    try {
      await waitFor(() => service.available, "initial ready");
      expect(spawnCount).toBe(1);

      // 模拟外部运维终止（restart-service kill-by-pid 场景）
      (service as unknown as { worker: ChildProcess }).worker.kill("SIGTERM");
      // respawn 的新 worker 需要重新加载——等 spawn 且 ready
      await waitFor(() => spawnCount === 2, "respawn after external kill");
      await waitFor(() => service.available, "new worker ready");

      // 写 lane 恢复：embed 正常返回
      const emb = await service.embed("hello");
      expect(emb).toBeInstanceOf(Float32Array);
    } finally {
      service.dispose();
    }
  });

  it("窗口内 3 次死亡后熔断打开，不再无限重建（共享熔断防风暴）", async () => {
    let spawnCount = 0;
    const factory = () => {
      spawnCount++;
      return forkMock(workerPath);
    };
    const service = new EmbeddingServiceImpl(factory(), noopLogger, factory);
    try {
      await waitFor(() => service.available, "initial ready");
      const getWorker = () => (service as unknown as { worker: ChildProcess }).worker;
      // 连杀 3 次（RESTART_MAX_IN_WINDOW=3，窗口 5min）
      getWorker().kill("SIGTERM");
      await waitFor(() => spawnCount === 2, "respawn 1");
      await waitFor(() => service.available, "ready 1");
      getWorker().kill("SIGTERM");
      await waitFor(() => spawnCount === 3, "respawn 2");
      await waitFor(() => service.available, "ready 2");
      getWorker().kill("SIGTERM");
      await waitFor(() => spawnCount === 4, "respawn 3");
      await waitFor(() => service.available, "ready 3");
      // 第 4 次死亡 → 记账后 4 > 3 → 熔断，不再 spawn
      getWorker().kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      expect(spawnCount).toBe(4);
      expect(service.available).toBe(false);
    } finally {
      service.dispose();
    }
  });
});

describe("F20261105embqg S2a：槽位优先级唤醒", () => {
  let workerPath: string;

  beforeEach(() => {
    // MAX_IN_FLIGHT=1 默认即串行；响应延迟 150ms 保证 waiter 队列有积压窗口
    workerPath = writeMockWorker(
      "mock-embq-priority.mjs",
      RESPONSIVE_WORKER.replace("RESPOND_DELAY_MS", "150"),
    );
  });

  afterEach(() => {
    EmbeddingServiceImpl.setTestMaxInFlightOverride(null);
  });

  it("P0 waiter 先于 P2 waiter 被唤醒（非 FIFO）", async () => {
    const factory = () => forkMock(workerPath);
    const service = new EmbeddingServiceImpl(factory(), noopLogger, factory);
    try {
      await waitFor(() => service.available, "ready");

      // 占住唯一槽位（慢响应 150ms）
      const first = service.embed("occupy", { waitSlot: true });
      await new Promise((r) => setTimeout(r, 30)); // 等 first 真正进 pendingRequests

      // 依次挂起：bulk(2) 先排队，live(0) 后排队——FIFO 会先唤醒 bulk
      const wakeOrder: string[] = [];
      const bulk = service
        .embed("bulk-chunk", { waitSlot: true, priority: 2 })
        .then(() => wakeOrder.push("bulk"));
      await new Promise((r) => setTimeout(r, 20));
      const live = service
        .embed("live-msg", { waitSlot: true, priority: 0 })
        .then(() => wakeOrder.push("live"));

      await Promise.all([first, bulk, live]);
      // live 先完成（P0 插队），bulk 后完成
      expect(wakeOrder).toEqual(["live", "bulk"]);
    } finally {
      service.dispose();
    }
  });

  it("默认 priority（1）行为不变：两个默认请求 FIFO", async () => {
    const factory = () => forkMock(workerPath);
    const service = new EmbeddingServiceImpl(factory(), noopLogger, factory);
    try {
      await waitFor(() => service.available, "ready");
      const first = service.embed("occupy", { waitSlot: true });
      await new Promise((r) => setTimeout(r, 30));
      const wakeOrder: string[] = [];
      const a = service.embed("a", { waitSlot: true }).then(() => wakeOrder.push("a"));
      await new Promise((r) => setTimeout(r, 20));
      const b = service.embed("b", { waitSlot: true }).then(() => wakeOrder.push("b"));
      await Promise.all([first, a, b]);
      expect(wakeOrder).toEqual(["a", "b"]);
    } finally {
      service.dispose();
    }
  });
});

describe("F20261105embqg S2a：背压语义不回归（优先级不改变 reject 行为）", () => {
  it("无 waitSlot 时槽满仍 reject（EmbedBackpressureError）", async () => {
    const workerPath = writeMockWorker(
      "mock-embq-backpressure.mjs",
      RESPONSIVE_WORKER.replace("RESPOND_DELAY_MS", "150"),
    );
    const factory = () => forkMock(workerPath);
    const service = new EmbeddingServiceImpl(factory(), noopLogger, factory);
    try {
      await waitFor(() => service.available, "ready");
      const first = service.embed("occupy", { waitSlot: true });
      await new Promise((r) => setTimeout(r, 30));
      // 无 waitSlot + 槽满 → reject（查询路径 fail-fast 语义保留）
      await expect(service.embed("no-wait")).rejects.toThrow(EmbedBackpressureError);
      await first;
    } finally {
      service.dispose();
    }
  });
});
