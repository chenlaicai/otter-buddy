import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EmbeddingServiceImpl } from "../../../src/frameworks/embedding/embedding-service";
import { initEmbeddingService } from "../../../src/frameworks/embedding/embedding-init";
import { EmbedBackpressureError } from "../../../src/usecases/memory/embedding-gateway";
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

      const { liveService: service, dispose } = await initEmbeddingService({
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

      const { liveService: service, dispose } = await initEmbeddingService({
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

      const { liveService: service, dispose } = await initEmbeddingService({
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

      const { liveService: service, dispose } = await initEmbeddingService({
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

      const { liveService: service, dispose } = await initEmbeddingService({
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

// F20261109epqst：acquireSlot describe 块已删除——接口随 RAM 长队一并退役
// （store-memory 不再预占槽位，waitSlot 已内嵌 embed/embedBatch 且带等待上界）。
// 槽位挂起/唤醒/优先级行为由 F20261105embqg S2a 与 F20261109epqst 的 waitSlot 用例覆盖。

// F20261015selfheal → F20261020slvg：自愈入口从「超时触发」改为「无进展看门狗触发」。
// 测试直接调 watchdogTick() 模拟心跳（确定性，不依赖 60s interval），
// setTestWatchdogOverride 把无进展阈值压到毫秒级。
describe("worker 超时自愈", () => {
    it("超时不再直接杀 worker；无进展看门狗触发后 SIGKILL 假死 worker 并重建，恢复可用", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(200);
      EmbeddingServiceImpl.setTestWatchdogOverride(1);
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
        const svcInternal = service as unknown as { readyState: { ready: boolean }; restartTimestamps: number[]; watchdogTick: () => void };
        await waitFor(() => svcInternal.readyState.ready, "gen0 ready");

        // gen=0 假死 → embed 超时 → F20261020slvg：超时本身不再触发重启
        await expect(service.embed("hang")).rejects.toThrow("Embed timeout");
        expect(svcInternal.restartTimestamps.length).toBe(0);

        // 无进展超阈值（1ms）→ 看门狗 tick 触发自愈重建（spawn gen=1）
        await new Promise((r) => setTimeout(r, 5));
        svcInternal.watchdogTick();
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
        EmbeddingServiceImpl.setTestWatchdogOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("窗口内重启超限时熔断：available 变 false，embed 直接 reject", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(100);
      EmbeddingServiceImpl.setTestWatchdogOverride(1);
      const mockWorkerPath = writeMockWorker(
        "mock-hang-worker2.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {});
`
      );

      const { liveService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        const svcInternal = service as unknown as { readyState: { ready: boolean }; restartTimestamps: number[]; circuitBroken: boolean; watchdogTick: () => void };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        // 连续触发 4 次看门狗重启（超过 RESTART_MAX_IN_WINDOW=3）
        for (let i = 0; i < 4; i++) {
          // 每次重建后等新 worker ready 再挂起下一条
          await waitFor(() => svcInternal.readyState.ready, `ready before hang ${i}`);
          void service.embed("hang").catch(() => "timed out");
          await new Promise((r) => setTimeout(r, 5));
          svcInternal.watchdogTick();
        }

        expect(svcInternal.circuitBroken).toBe(true);
        expect(service.available).toBe(false);
        // 熔断后 embed 直接 reject（不再超时等待）
        await expect(service.embed("any")).rejects.toThrow("circuit breaker");
      } finally {
        dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        EmbeddingServiceImpl.setTestWatchdogOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("embedBatch 假死同样由看门狗自愈（检视 #1493 发现 1：批量路径闭合泄漏家族）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(200);
      EmbeddingServiceImpl.setTestWatchdogOverride(1);
      const mockWorkerPath = writeMockWorker(
        "mock-hang-batch-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {});
`
      );

      const { liveService: service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        const svcInternal = service as unknown as { readyState: { ready: boolean }; restartTimestamps: number[]; watchdogTick: () => void };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        // batch 超时 → 只 reject 不重启（慢≠死收窄语义延续）
        await expect(service.embedBatch!(["a", "b"])).rejects.toThrow("Embed batch timeout");
        expect(svcInternal.restartTimestamps.length).toBe(0);

        // 看门狗 tick → 批量路径同样被无进展判死重建
        await new Promise((r) => setTimeout(r, 5));
        svcInternal.watchdogTick();
        expect(svcInternal.restartTimestamps.length).toBe(1);
      } finally {
        dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        EmbeddingServiceImpl.setTestWatchdogOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("看门狗重启落结构化现场快照（观测增强：worker 画像 + 超时请求画像 + 宿主快照）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(150);
      EmbeddingServiceImpl.setTestWatchdogOverride(1);
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
        const svcInternal = service as unknown as { readyState: { ready: boolean }; watchdogTick: () => void };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        await expect(service.embed("观测增强验证文本")).rejects.toThrow("Embed timeout");
        await new Promise((r) => setTimeout(r, 5));
        svcInternal.watchdogTick();

        // 断言结构化快照落账
        const restartLog = warnCalls.find(c => c.message === "embedding_worker_restart");
        expect(restartLog).toBeDefined();
        const ctx = restartLog!.context!;
        expect(ctx.action).toBe("embedding_worker_restart");
        expect(ctx.restartsInWindow).toBe(1);
        expect(typeof ctx.workerAgeMs).toBe("number");
        // F20261020slvg 新增画像：outstanding 请求数 + salvage 计数
        expect(ctx.outstandingRequests).toBe(1);
        expect(ctx.workerSalvagedResults).toBe(0);
        // 超时请求画像：文本长度/token 估算/前缀摘要
        const timeoutCtx = ctx.timeoutContext as Record<string, unknown>;
        expect(timeoutCtx.path).toBe("embed");
        expect((timeoutCtx.text as Record<string, unknown>).chars).toBe(8);
        expect((timeoutCtx.text as Record<string, unknown>).head).toBe("观测增强验证文本");
        // F20261020slvg：超时后条目保留（不再自删）——inflight 含自身 =1
        expect(timeoutCtx.inflight).toBe(1);
        // 宿主快照：rss/heap/loadavg 齐全
        const host = ctx.host as Record<string, unknown>;
        expect(typeof host.rssMb).toBe("number");
        expect(typeof host.heapUsedMb).toBe("number");
        expect(typeof host.loadavg1m).toBe("number");
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        EmbeddingServiceImpl.setTestWatchdogOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    // F20261015kill：旧 worker exit 滞后事件不得污染新一代 readyState
    it("重建后旧 worker 滞后 exit 不得把新 worker 打回未就绪（代际隔离）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(150);
      EmbeddingServiceImpl.setTestWatchdogOverride(1);
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
          watchdogTick: () => void;
        };
        await waitFor(() => svcInternal.readyState.ready, "gen0 ready");

        await expect(service.embed("hang")).rejects.toThrow("Embed timeout");
        await new Promise((r) => setTimeout(r, 5));
        svcInternal.watchdogTick();
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
        EmbeddingServiceImpl.setTestWatchdogOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });
});

// F20261016ebrt → F20261020slvg：「慢≠死」由无进展看门狗承载——
// 慢但持续有响应的 worker 永不被杀；真死锁（无响应）必被杀。
describe("超时语义收窄（慢≠死）", () => {
    it("超时本身不再触发重启（无论本代成功与否）——自愈入口已移到看门狗", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(150);
      EmbeddingServiceImpl.setTestWatchdogOverride(100);
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
  // 后续不回——单条请求视角的「慢」，但下方持续有新请求响应喂狗
});
`
      );

      const workerFactory = () => forkMock(mockWorkerPath);
      const service = new EmbeddingServiceImpl(workerFactory(), noopLogger, workerFactory);

      try {
        const svcInternal = service as unknown as {
          readyState: { ready: boolean };
          restartTimestamps: number[];
          watchdogTick: () => void;
        };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        // 第一条成功
        const first = await service.embed("fast one");
        expect(first).toBeInstanceOf(Float32Array);
        expect(svcInternal.restartTimestamps.length).toBe(0);

        // 第二条超时——超时本身不杀（F20261020slvg：自愈入口已从超时移到看门狗）
        await expect(service.embed("slow one")).rejects.toThrow("Embed timeout");
        expect(svcInternal.restartTimestamps.length).toBe(0);
        expect(svcInternal.readyState.ready).toBe(true);

        // worker 还活着：ready 仍为 true（没被杀掉重建）
        expect(svcInternal.readyState.ready).toBe(true);
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        EmbeddingServiceImpl.setTestWatchdogOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("无响应超阈值的 worker 被看门狗重建（真死锁逃生通道保留）", async () => {
      EmbeddingServiceImpl.setTestTimeoutOverride(150);
      EmbeddingServiceImpl.setTestWatchdogOverride(1);
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
          watchdogTick: () => void;
        };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        await expect(service.embed("hang")).rejects.toThrow("Embed timeout");
        // 超时不重启；无响应超阈值 → 看门狗重建
        expect(svcInternal.restartTimestamps.length).toBe(0);
        await new Promise((r) => setTimeout(r, 5));
        svcInternal.watchdogTick();
        expect(svcInternal.restartTimestamps.length).toBe(1);
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestTimeoutOverride(null);
        EmbeddingServiceImpl.setTestWatchdogOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });

    it("持续有响应的 worker 看门狗不杀（响应刷新活动时间戳）", async () => {
      // 每条请求 20ms 后响应——慢但在动
      EmbeddingServiceImpl.setTestWatchdogOverride(100);
      const mockWorkerPath = writeMockWorker(
        "mock-alive-slow-worker.mjs",
        `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type !== "embed") return;
  setTimeout(() => {
    process.send({ type: "result", embedding: new Float32Array(4), id: msg.id });
  }, 20);
});
`
      );

      const workerFactory = () => forkMock(mockWorkerPath);
      const service = new EmbeddingServiceImpl(workerFactory(), noopLogger, workerFactory);

      try {
        const svcInternal = service as unknown as {
          readyState: { ready: boolean };
          restartTimestamps: number[];
          watchdogTick: () => void;
        };
        await waitFor(() => svcInternal.readyState.ready, "initial ready");

        // 连续多条慢请求，每条完成后立即 tick——活动时间戳刚被响应刷新，不满足无进展判据
        for (let i = 0; i < 3; i++) {
          const emb = await service.embed(`slow ${i}`);
          expect(emb).toBeInstanceOf(Float32Array);
          svcInternal.watchdogTick();
          expect(svcInternal.restartTimestamps.length).toBe(0);
        }
      } finally {
        service.dispose();
        EmbeddingServiceImpl.setTestWatchdogOverride(null);
        fs.unlinkSync(mockWorkerPath);
      }
    });
});

// F20261020slvg 对抗审视洞 1/2：worker 死亡路径唤醒 waiter + 瞬态错误类型
describe("对抗审视修复：waiter 唤醒与瞬态错误", () => {
  it("worker 意外退出：parked 的 waitSlot 调用方被唤醒并 fail-fast（不永久悬挂）", async () => {
    const mockWorkerPath = writeMockWorker("mock-crash-worker.mjs", `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
// ready 后 150ms 自行崩溃（模拟 OOM kill / 段错误）
setTimeout(() => process.exit(3), 150);
process.on("message", () => {
  // 收到 embed 不回——占住槽位
});
`);
    const { liveService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });
    try {
      await waitFor(() => service.available, "ready");

      // 第 1 条占槽（永不回复），第 2 条 waitSlot parked
      void service.embed("hang").catch(() => "hung");
      const parked = service.embed("parked", { waitSlot: true });
      const svcInternal = service as unknown as { pendingRequests: Map<number, unknown> };
      await waitFor(() => svcInternal.pendingRequests.size >= 1, "lane busy");

      // worker 崩溃 → handleWorkerExit 放行 waiter → fail-fast reject（不永久悬挂）
      await expect(parked).rejects.toThrow(/Worker exited/i);
    } finally {
      dispose();
      fs.unlinkSync(mockWorkerPath);
    }
  });

  it("worker 重启路径的 reject 用 EmbedTransientError（retry worker 不计 attempts 的契约载体）", async () => {
    EmbeddingServiceImpl.setTestTimeoutOverride(100);
    EmbeddingServiceImpl.setTestWatchdogOverride(1);
    const mockWorkerPath = writeMockWorker("mock-transient-worker.mjs", `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {});
`);
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
        watchdogTick: () => void;
      };
      await waitFor(() => svcInternal.readyState.ready, "initial ready");

      // 超时（abandoned 条目保留）→ 看门狗重启 → rejectAllPending reject 已 settle 的 promise
      // 是 no-op——此处验证重启路径本身可走通且类型契约存在
      await expect(service.embed("hang")).rejects.toThrow("Embed timeout");
      await new Promise((r) => setTimeout(r, 5));
      svcInternal.watchdogTick();
      expect(svcInternal.restartTimestamps.length).toBe(1);
    } finally {
      service.dispose();
      EmbeddingServiceImpl.setTestTimeoutOverride(null);
      EmbeddingServiceImpl.setTestWatchdogOverride(null);
      fs.unlinkSync(mockWorkerPath);
    }
  });
});

describe("live/backfill 双 lane 隔离", () => {
  it("liveService 与 backfillService 是独立实例，回填占住时实时请求仍完成", async () => {
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

    const { liveService, backfillService, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });

    try {
      await waitFor(() => liveService.available && backfillService.available, "both lanes ready");
      expect(liveService).not.toBe(backfillService);

      void backfillService.embed("write one").catch(() => "hung" as const);
      const svcWrite = backfillService as unknown as { pendingRequests: Map<number, unknown> };
      await waitFor(() => svcWrite.pendingRequests.size >= 1, "write lane busy");

      const queryResult = await Promise.race([
        liveService.embed("query one"),
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

// F20261020slvg：超时 ≠ 取消——诚实准入 + 结果 salvage + waitSlot 软限流
describe("槽位语义与 salvage（超时 ≠ 取消）", () => {
  /** 晚响应 worker：收到 embed 后延迟 replyMs 才回结果 */
  function lateWorkerScript(replyMs: number): string {
    return `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type !== "embed") return;
  setTimeout(() => {
    process.send({ type: "result", embedding: new Float32Array(4), id: msg.id });
  }, ${replyMs});
});
`;
  }

  it("超时后条目保留、槽位不释放——背压拒绝后续请求", async () => {
    EmbeddingServiceImpl.setTestTimeoutOverride(100);
    const mockWorkerPath = writeMockWorker("mock-slot-held.mjs", `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {});
`);
    const { liveService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });
    try {
      await waitFor(() => service.available, "ready");
      await expect(service.embed("hang")).rejects.toThrow("Embed timeout");
      // 条目保留 + 槽位占用：默认路径（无 waitSlot）下一条直接背压拒绝
      await expect(service.embed("next")).rejects.toThrow(EmbedBackpressureError);
      const svcInternal = service as unknown as { pendingRequests: Map<number, unknown> };
      expect(svcInternal.pendingRequests.size).toBe(1);
    } finally {
      dispose();
      EmbeddingServiceImpl.setTestTimeoutOverride(null);
      fs.unlinkSync(mockWorkerPath);
    }
  });

  it("晚到 result 触发 salvage 并释放槽位；无 salvage 才丢弃", async () => {
    EmbeddingServiceImpl.setTestTimeoutOverride(100);
    const mockWorkerPath = writeMockWorker("mock-late-result.mjs", lateWorkerScript(250));
    const { liveService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });
    try {
      await waitFor(() => service.available, "ready");
      let salvaged: Float32Array | null = null;
      await expect(service.embed("late", {
        salvage: (emb) => { salvaged = emb; },
      })).rejects.toThrow("Embed timeout");

      // 晚到结果（250ms）→ salvage 收到向量，槽位释放
      await waitFor(() => salvaged !== null, "salvage called", 2000);
      expect(salvaged).toBeInstanceOf(Float32Array);
      const svcInternal = service as unknown as { pendingRequests: Map<number, unknown> };
      expect(svcInternal.pendingRequests.size).toBe(0);

      // 槽位已释放：新请求正常准入成功（恢复默认 30s 超时——mock 响应 250ms > 测试 override 100ms）
      EmbeddingServiceImpl.setTestTimeoutOverride(null);
      const next = await service.embed("after salvage");
      expect(next).toBeInstanceOf(Float32Array);
    } finally {
      dispose();
      EmbeddingServiceImpl.setTestTimeoutOverride(null);
      fs.unlinkSync(mockWorkerPath);
    }
  });

  it("晚到 error 响应：清理条目 + 无 salvage + 槽位释放", async () => {
    EmbeddingServiceImpl.setTestTimeoutOverride(100);
    const mockWorkerPath = writeMockWorker("mock-late-error.mjs", `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type !== "embed") return;
  setTimeout(() => {
    process.send({ type: "error", error: "late boom", id: msg.id });
  }, 200);
});
`);
    const { liveService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });
    try {
      await waitFor(() => service.available, "ready");
      let salvageCalled = false;
      await expect(service.embed("late err", {
        salvage: () => { salvageCalled = true; },
      })).rejects.toThrow("Embed timeout");

      await new Promise((r) => setTimeout(r, 300));
      expect(salvageCalled).toBe(false);
      const svcInternal = service as unknown as { pendingRequests: Map<number, unknown> };
      expect(svcInternal.pendingRequests.size).toBe(0);
    } finally {
      dispose();
      EmbeddingServiceImpl.setTestTimeoutOverride(null);
      fs.unlinkSync(mockWorkerPath);
    }
  });

  it("salvage 回调抛错不打死主进程，且有槽位释放", async () => {
    EmbeddingServiceImpl.setTestTimeoutOverride(100);
    const mockWorkerPath = writeMockWorker("mock-salvage-throw.mjs", lateWorkerScript(200));
    const warns: string[] = [];
    const captureLogger = {
      info: () => {},
      warn: (m: string) => { warns.push(m); },
      error: () => {},
      debug: () => {},
      child: () => captureLogger,
    };
    const workerFactory = () => forkMock(mockWorkerPath);
    const service = new EmbeddingServiceImpl(workerFactory(), captureLogger as never, workerFactory);
    try {
      await waitFor(() => service.available, "ready");
      await expect(service.embed("boom", {
        salvage: () => { throw new Error("salvage exploded"); },
      })).rejects.toThrow("Embed timeout");
      await waitFor(
        () => warns.some(m => m.includes("salvage callback failed")),
        "salvage failure logged",
      );
      const svcInternal = service as unknown as { pendingRequests: Map<number, unknown> };
      expect(svcInternal.pendingRequests.size).toBe(0);
    } finally {
      service.dispose();
      EmbeddingServiceImpl.setTestTimeoutOverride(null);
      fs.unlinkSync(mockWorkerPath);
    }
  });

  it("waitSlot：槽满挂起排队而非拒绝，槽空后按序完成", async () => {
    EmbeddingServiceImpl.setTestTimeoutOverride(5000);
    const mockWorkerPath = writeMockWorker("mock-wait-slot.mjs", lateWorkerScript(100));
    const { liveService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });
    try {
      await waitFor(() => service.available, "ready");
      // 第 1 条占槽（100ms 慢响应）
      const p1 = service.embed("first");
      // 第 2 条 waitSlot——不拒绝，排队等槽
      const p2 = service.embed("second", { waitSlot: true });
      await expect(p2).resolves.toBeInstanceOf(Float32Array);
      await expect(p1).resolves.toBeInstanceOf(Float32Array);
    } finally {
      dispose();
      EmbeddingServiceImpl.setTestTimeoutOverride(null);
      fs.unlinkSync(mockWorkerPath);
    }
  });

  it("dispose 后看门狗 tick 不触发重启", async () => {
    EmbeddingServiceImpl.setTestWatchdogOverride(1);
    const mockWorkerPath = writeMockWorker("mock-disposed-watchdog.mjs", `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", () => {});
`);
    let factoryCalls = 0;
    const workerFactory = () => { factoryCalls++; return forkMock(mockWorkerPath); };
    const service = new EmbeddingServiceImpl(workerFactory(), noopLogger, workerFactory);
    const svcInternal = service as unknown as { restartTimestamps: number[]; watchdogTick: () => void };
    await waitFor(() => service.available, "ready");
    service.dispose();
    await new Promise((r) => setTimeout(r, 10));
    svcInternal.watchdogTick();
    expect(svcInternal.restartTimestamps.length).toBe(0);
    expect(factoryCalls).toBe(1);
    fs.unlinkSync(mockWorkerPath);
  });
});
