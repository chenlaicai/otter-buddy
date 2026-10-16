import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initEmbeddingService, EmbeddingServiceImpl } from "../../../src/frameworks/embedding/embedding-service";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { fork, type ChildProcess } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** F20261015kill：mock worker 统一走 fork + process.send（与生产 bge-m3-worker 同通道） */
function writeMockWorker(name: string, body: string): string {
  const p = path.join(__dirname, name);
  fs.writeFileSync(p, body);
  return p;
}

function forkMock(mockPath: string, env: Record<string, string> = {}): ChildProcess {
  return fork(mockPath, [], {
    execArgv: [],
    env: { ...process.env, ...env },
    serialization: "advanced",
  });
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as never;

/** 等到条件成立或超时（轮询 5ms） */
async function waitFor(cond: () => boolean, label: string, maxMs = 2000): Promise<void> {
  for (let i = 0; i < maxMs / 5; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

describe("EmbeddingServiceImpl", () => {
  describe("embed() timeout", () => {
    beforeEach(() => {
      // 设置测试超时为 100ms
      EmbeddingServiceImpl.setTestTimeoutOverride(100);
    });

    afterEach(() => {
      // 清除测试超时覆盖
      EmbeddingServiceImpl.setTestTimeoutOverride(null);
    });
    it("should reject with timeout error when worker does not respond", async () => {
      // 创建一个模拟 worker 脚本，不响应 embed 请求
      const mockWorkerPath = writeMockWorker(
        "mock-silent-worker.mjs",
        `
process.send({
  type: "ready",
  meta: { modelId: "test", modelRev: "1", dim: 128 },
});

// 不响应 embed 请求，模拟 worker 卡死
process.on("message", () => {
  // 故意不回复
});
`
      );

      const { writeService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        // 应该超时（30s），但在测试中我们会缩短超时
        await expect(service.embed("test")).rejects.toThrow(/timeout/i);
      } finally {
        dispose();
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("should succeed when worker responds normally", async () => {
      // 创建一个模拟 worker 脚本，正常响应 embed 请求
      const mockWorkerPath = writeMockWorker(
        "mock-responsive-worker.mjs",
        `
process.send({
  type: "ready",
  meta: { modelId: "test", modelRev: "1", dim: 128 },
});

// 正常响应 embed 请求
process.on("message", (msg) => {
  if (msg.type === "embed") {
    process.send({
      type: "result",
      embedding: new Float32Array(128),
      id: msg.id,
    });
  }
});
`
      );

      const { writeService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        const result = await service.embed("test");
        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(128);
      } finally {
        dispose();
        fs.unlinkSync(mockWorkerPath);
      }
    });
  });

  describe("F20261013ebps backpressure", () => {
    beforeEach(() => {
      EmbeddingServiceImpl.setTestMaxInFlightOverride(3);
    });

    afterEach(() => {
      EmbeddingServiceImpl.setTestMaxInFlightOverride(null);
    });

    it("should reject when in-flight requests exceed limit", async () => {
      const mockWorkerPath = writeMockWorker(
        "mock-slow-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type === "embed") {
    // 延迟 200ms 回复，模拟慢 worker
    setTimeout(() => {
      process.send({ type: "result", embedding: new Float32Array(4), id: msg.id });
    }, 200);
  }
});
`
      );

      const { writeService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        // 打满 3 个 in-flight
        const p1 = service.embed("a");
        const p2 = service.embed("b");
        const p3 = service.embed("c");
        // 第 4 个应该被背压拒绝
        await expect(service.embed("d")).rejects.toThrow(/backpressure/i);
        // 前 3 个正常完成
        await expect(p1).resolves.toBeInstanceOf(Float32Array);
        await expect(p2).resolves.toBeInstanceOf(Float32Array);
        await expect(p3).resolves.toBeInstanceOf(Float32Array);
      } finally {
        dispose();
        fs.unlinkSync(mockWorkerPath);
      }
    });
  });

  describe("F20261013ebps embedBatch", () => {
    it("should return batch embeddings when worker supports embed-batch", async () => {
      const mockWorkerPath = writeMockWorker(
        "mock-batch-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type === "embed-batch") {
    const embeddings = msg.texts.map(() => new Float32Array(4));
    process.send({ type: "batch-result", embeddings, id: msg.id });
  }
});
`
      );

      const { writeService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        const results = await service.embedBatch!("hello world test".split(" "));
        expect(results).toHaveLength(3);
        results.forEach(r => expect(r).toBeInstanceOf(Float32Array));
      } finally {
        dispose();
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("should reject batch when backpressure limit reached", async () => {
      EmbeddingServiceImpl.setTestMaxInFlightOverride(1);
      const mockWorkerPath = writeMockWorker(
        "mock-slow-batch.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type === "embed") {
    setTimeout(() => process.send({ type: "result", embedding: new Float32Array(4), id: msg.id }), 200);
  }
});
`
      );

      const { writeService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        const p1 = service.embed("x");
        await expect(service.embedBatch!(["a", "b"])).rejects.toThrow(/backpressure/i);
        await expect(p1).resolves.toBeInstanceOf(Float32Array);
      } finally {
        EmbeddingServiceImpl.setTestMaxInFlightOverride(null);
        dispose();
        fs.unlinkSync(mockWorkerPath);
      }
    });
  });

});

describe("F20261013ebps acquireSlot 槽位流速控制（检视 #1465 严重发现 1）", () => {
  beforeEach(() => {
    EmbeddingServiceImpl.setTestMaxInFlightOverride(2);
  });

  afterEach(() => {
    EmbeddingServiceImpl.setTestMaxInFlightOverride(null);
  });

  it("should suspend acquireSlot when slots full and wake FIFO after completion", async () => {
    const mockWorkerPath = writeMockWorker(
      "mock-slow-worker-slot.mjs",
      `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type === "embed") {
    setTimeout(() => {
      process.send({ type: "result", embedding: new Float32Array(4), id: msg.id });
    }, 100);
  }
});
`
    );

    const { writeService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });

    try {
      // 先等 worker ready——否则 embed 内的 await waitForReady() 会让槽位占用延后一个 microtask，
      // 后面的 acquireSlot 会插队看到空槽（测试时序缺陷，非实现 bug）
      await service.acquireSlot!();
      // 打满 2 个槽位
      const p1 = service.embed("a");
      const p2 = service.embed("b");
      // embed 体内部 await waitForReady() 是异步断点——哪怕 ready 已置位，占槽也发生在后续 microtask；
      // 必须等两个 embed 真正入 pendingRequests——ready 消息经 worker IPC，到达时机不确定，
      // 轮询 in-flight 计数到 2 为止（否则后续 acquireSlot 看到空槽插队，测试时序缺陷，非实现 bug）
      const svcInternal = service as unknown as { pendingRequests: Map<number, unknown> };
      for (let i = 0; i < 200 && svcInternal.pendingRequests.size < 2; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(svcInternal.pendingRequests.size).toBe(2);
      // 槽满——两个 acquire 都应挂起
      const order: string[] = [];
      const a1 = service.acquireSlot!().then(() => order.push("first"));
      const a2 = service.acquireSlot!().then(() => order.push("second"));
      // 槽满时立即再 acquire 也挂起（不 resolve）
      let resolvedEarly = false;
      service.acquireSlot!().then(() => { resolvedEarly = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(resolvedEarly).toBe(false);

      await Promise.all([p1, p2, a1, a2]);
      // FIFO：先注册的先唤醒
      expect(order).toEqual(["first", "second"]);
    } finally {
      dispose();
      fs.unlinkSync(mockWorkerPath);
    }
  });

  it("should resolve immediately when slots available", async () => {
    const mockWorkerPath = writeMockWorker(
      "mock-ready-worker.mjs",
      `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
`
    );

    const { writeService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });

    try {
      await expect(service.acquireSlot!()).resolves.toBeUndefined();
    } finally {
      dispose();
      fs.unlinkSync(mockWorkerPath);
    }
  });
});

// F20261015selfheal：embed 超时自愈——timeout 后 SIGKILL 假死 worker 并重建
describe("worker 超时自愈", () => {
    it("embed 超时后 SIGKILL 假死 worker 并重建，重建后 embed 恢复正常", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(200);
      const mockWorkerPath = writeMockWorker(
        "mock-hang-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
if (process.env.OTTER_EMBED_TEST_GENERATION === "1") {
  process.on("message", (msg) => {
    if (msg.type === "embed") {
      process.send({ type: "result", embedding: new Float32Array(4), id: msg.id });
    }
  });
} else {
  // gen=0：监听但不回——模拟假死
  process.on("message", () => {});
}
`
      );

      // workerFactory 注入：重建时 spawn 新一代（generation=1 正常 worker）
      let generation = 0;
      const service = new EmbeddingServiceImpl(
        forkMock(mockWorkerPath, { OTTER_EMBED_TEST_GENERATION: "0" }),
        noopLogger,
        () => forkMock(mockWorkerPath, { OTTER_EMBED_TEST_GENERATION: String(++generation) }),
      );

      try {
        // 等 gen=0 worker ready
        const svcInternal = service as unknown as { readyState: { ready: boolean }; restartTimestamps: number[] };
        await waitFor(() => svcInternal.readyState.ready, "gen0 ready");

        // gen=0 假死 → embed 超时 → 触发自愈重建（spawn gen=1）
        await expect(service.embed("hang")).rejects.toThrow("Embed timeout");
        expect(svcInternal.restartTimestamps.length).toBe(1);

        // 等 gen=1 worker ready（新 worker 正常回消息）
        await waitFor(() => svcInternal.readyState.ready, "gen1 ready");

        // 核心断言（检视发现 2）：重建后 embed 恢复正常——服务真正恢复可用，不是只发生了重启动作
        const result = await service.embed("hello");
        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(4);
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("窗口内重启超限时熔断：available 变 false，embed 直接 reject", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(100);
      const mockWorkerPath = writeMockWorker(
        "mock-hang-worker2.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {});
`
      );

      const { writeService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        const svcInternal = service as unknown as { readyState: { ready: boolean }; restartTimestamps: number[]; circuitBroken: boolean };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        // 连续触发 4 次超时（超过 RESTART_MAX_IN_WINDOW=3）
        for (let i = 0; i < 4; i++) {
          // 每次重建后等新 worker ready 再发下一次
          await waitFor(() => svcInternal.readyState.ready, `ready before hang ${i}`);
          await expect(service.embed("hang")).rejects.toThrow();
        }

        expect(svcInternal.circuitBroken).toBe(true);
        expect(service.available).toBe(false);
        // 熔断后 embed 直接 reject（不再超时等待）
        await expect(service.embed("any")).rejects.toThrow("circuit breaker");
      } finally {
        dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("embedBatch 超时同样触发自愈重建（检视 #1493 发现 1：批量路径闭合泄漏家族）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(200);
      const mockWorkerPath = writeMockWorker(
        "mock-hang-batch-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {});
`
      );

      const { writeService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        const svcInternal = service as unknown as { readyState: { ready: boolean }; restartTimestamps: number[] };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        // batch 超时 → 同样触发 restartWorker（发现 1：批量路径与单条路径同等自愈）
        await expect(service.embedBatch!(["a", "b"])).rejects.toThrow("Embed batch timeout");
        expect(svcInternal.restartTimestamps.length).toBe(1);
      } finally {
        dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("超时重启落结构化现场快照（观测增强：worker 画像 + 超时请求画像 + 宿主快照）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(150);
      const mockWorkerPath = writeMockWorker(
        "mock-hang-observe-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {});
`
      );

      // 捕获 logger.warn 的结构化 context
      const warnCalls: Array<{ message: string; context?: Record<string, unknown> }> = [];
      const captureLogger = {
        info: () => {},
        warn: (message: string, context?: Record<string, unknown>) => { warnCalls.push({ message, context }); },
        error: () => {},
        debug: () => {},
        child: () => captureLogger,
      };

      const workerFactory = () => forkMock(mockWorkerPath);
      const service = new EmbeddingServiceImpl(workerFactory(), captureLogger as never, workerFactory);

      try {
        const svcInternal = service as unknown as { readyState: { ready: boolean } };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        await expect(service.embed("观测增强验证文本")).rejects.toThrow("Embed timeout");

        // 断言结构化快照落账
        const restartLog = warnCalls.find(c => c.message === "embedding_worker_restart");
        expect(restartLog).toBeDefined();
        const ctx = restartLog!.context!;
        expect(ctx.action).toBe("embedding_worker_restart");
        expect(ctx.restartsInWindow).toBe(1);
        expect(typeof ctx.workerAgeMs).toBe("number");
        // 超时请求画像：文本长度/token 估算/前缀摘要
        const timeoutCtx = ctx.timeoutContext as Record<string, unknown>;
        expect(timeoutCtx.path).toBe("embed");
        expect((timeoutCtx.text as Record<string, unknown>).chars).toBe(8);
        expect((timeoutCtx.text as Record<string, unknown>).head).toBe("观测增强验证文本");
        // 检视 #1493 delta 存量发现：inflight 在 delete 自身之前读（本请求已超时但还在队列里，=1）
        expect(timeoutCtx.inflight).toBe(1);
        // 宿主快照：rss/heap/loadavg 齐全
        const host = ctx.host as Record<string, unknown>;
        expect(typeof host.rssMb).toBe("number");
        expect(typeof host.heapUsedMb).toBe("number");
        expect(typeof host.loadavg1m).toBe("number");
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    // F20261015kill：旧 worker exit 滞后事件不得污染新一代 readyState
    it("重建后旧 worker 滞后 exit 不得把新 worker 打回未就绪（代际隔离）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(150);
      const mockWorkerPath = writeMockWorker(
        "mock-gen-isolate-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
if (process.env.OTTER_EMBED_TEST_GENERATION === "1") {
  process.on("message", (msg) => {
    if (msg.type === "embed") {
      process.send({ type: "result", embedding: new Float32Array(4), id: msg.id });
    }
  });
} else {
  process.on("message", () => {});
}
`
      );

      let generation = 0;
      const service = new EmbeddingServiceImpl(
        forkMock(mockWorkerPath, { OTTER_EMBED_TEST_GENERATION: "0" }),
        noopLogger,
        () => forkMock(mockWorkerPath, { OTTER_EMBED_TEST_GENERATION: String(++generation) }),
      );

      try {
        const svcInternal = service as unknown as {
          readyState: { ready: boolean; loadError: Error | null };
          restartTimestamps: number[];
        };
        await waitFor(() => svcInternal.readyState.ready, "gen0 ready");

        await expect(service.embed("hang")).rejects.toThrow("Embed timeout");
        await waitFor(() => svcInternal.readyState.ready, "gen1 ready");

        // 给旧 worker 的 exit/error 滞后事件留一个事件循环窗口
        await new Promise((r) => setTimeout(r, 50));

        // 核心断言：新 worker 的 ready 不能被旧 worker 的 exit 打掉
        expect(svcInternal.readyState.ready).toBe(true);
        expect(svcInternal.readyState.loadError).toBeNull();

        const result = await service.embed("still works");
        expect(result).toBeInstanceOf(Float32Array);
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });
});

// F20261016ebrt：慢≠死语义收窄——超时只杀真死锁，不杀慢 worker
describe("超时语义收窄（慢≠死）", () => {
    // F20261016ebrt：慢≠死——本代有成功记录的 worker 超时不得被杀
    it("本代有成功记录时超时只 reject 不杀 worker（慢≠死）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(150);
      const mockWorkerPath = writeMockWorker(
        "mock-slow-not-dead-worker.mjs",
        `
let count = 0;
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type !== "embed") return;
  count++;
  if (count === 1) {
    // 第一条立即成功——让本代有 workerEmbedSucceeded 记录
    process.send({ type: "result", embedding: new Float32Array(4), id: msg.id });
  }
  // 后续不回——模拟慢/卡，但本代已证明 worker 活着
});
`
      );

      const workerFactory = () => forkMock(mockWorkerPath);
      const service = new EmbeddingServiceImpl(workerFactory(), noopLogger, workerFactory);

      try {
        const svcInternal = service as unknown as {
          readyState: { ready: boolean };
          restartTimestamps: number[];
        };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        // 第一条成功
        const first = await service.embed("fast one");
        expect(first).toBeInstanceOf(Float32Array);
        expect(svcInternal.restartTimestamps.length).toBe(0);

        // 第二条超时——但本代有成功记录，不得触发 restartWorker
        await expect(service.embed("slow one")).rejects.toThrow("Embed timeout");
        expect(svcInternal.restartTimestamps.length).toBe(0);

        // worker 还活着：ready 仍为 true（没被杀掉重建）
        expect(svcInternal.readyState.ready).toBe(true);
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    // F20261016ebrt：本代零成功 + 超时 = 真死锁，仍要自愈
    it("本代零成功时超时触发自愈重建（真死锁逃生通道保留）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(150);
      const mockWorkerPath = writeMockWorker(
        "mock-true-hang-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {}); // 全不回——真死锁
`
      );

      let generation = 0;
      const service = new EmbeddingServiceImpl(
        forkMock(mockWorkerPath, { OTTER_EMBED_TEST_GENERATION: "0" }),
        noopLogger,
        () => forkMock(mockWorkerPath, { OTTER_EMBED_TEST_GENERATION: String(++generation) }),
      );

      try {
        const svcInternal = service as unknown as {
          readyState: { ready: boolean };
          restartTimestamps: number[];
        };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        await expect(service.embed("hang")).rejects.toThrow("Embed timeout");
        // 零成功 + 超时 = 死锁，必须重建
        expect(svcInternal.restartTimestamps.length).toBe(1);
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });
});

// F20261016ebrt：读写双 lane——查询不排在回填后面
describe("读写双 lane 隔离", () => {
  it("queryService 与 writeService 是独立实例，互不排队", async () => {
    const mockWorkerPath = writeMockWorker(
      "mock-lane-worker.mjs",
      `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type !== "embed") return;
  if (msg.text === "write one") {
    // 写入请求永不回——把 write lane 永久占住
    return;
  }
  process.send({ type: "result", embedding: new Float32Array(4), id: msg.id });
});
`
    );

    const { queryService, writeService, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });

    try {
      await waitFor(() => queryService.available && writeService.available, "both lanes ready");

      // 两 lane 是独立实例（各自 fork 的 worker 进程）
      expect(queryService).not.toBe(writeService);

      // write lane 被一个永不返回的请求占住
      void writeService.embed("write one").catch(() => "hung" as const);
      const svcWrite = writeService as unknown as { pendingRequests: Map<number, unknown> };
      await waitFor(() => svcWrite.pendingRequests.size >= 1, "write lane busy");

      // query lane 不受影响——write 卡死时 query 仍能立刻拿到结果
      const queryResult = await Promise.race([
        queryService.embed("query one"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("query blocked by write")), 1000)),
      ]);
      expect(queryResult).toBeInstanceOf(Float32Array);
      expect(queryResult.length).toBe(4);

      // write 确实还在挂着（没被误当成已完成）
      expect(svcWrite.pendingRequests.size).toBeGreaterThanOrEqual(1);
      // 不 await writePending——它要 30s 才超时，dispose 时会 reject（已 catch）
    } finally {
      dispose();
      fs.unlinkSync(mockWorkerPath);
    }
  });
});
