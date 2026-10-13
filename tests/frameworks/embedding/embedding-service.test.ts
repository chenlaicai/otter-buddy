import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initEmbeddingService, EmbeddingServiceImpl } from "../../../src/frameworks/embedding/embedding-service";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      const mockWorkerPath = path.join(__dirname, "mock-silent-worker.mjs");
      fs.writeFileSync(
        mockWorkerPath,
        `
import { parentPort } from "worker_threads";

// 模拟 ready 状态
parentPort.postMessage({ 
  type: "ready", 
  meta: { modelId: "test", modelRev: "1", dim: 128 } 
});

// 不响应 embed 请求，模拟 worker 卡死
parentPort.on("message", () => {
  // 故意不回复
});
`
      );

      const { service, dispose } = await initEmbeddingService({
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
      const mockWorkerPath = path.join(__dirname, "mock-responsive-worker.mjs");
      fs.writeFileSync(
        mockWorkerPath,
        `
import { parentPort } from "worker_threads";

// 模拟 ready 状态
parentPort.postMessage({ 
  type: "ready", 
  meta: { modelId: "test", modelRev: "1", dim: 128 } 
});

// 正常响应 embed 请求
parentPort.on("message", (msg) => {
  if (msg.type === "embed") {
    parentPort.postMessage({
      type: "result",
      embedding: new Float32Array(128),
      id: msg.id,
    });
  }
});
`
      );

      const { service, dispose } = await initEmbeddingService({
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
      const mockWorkerPath = path.join(__dirname, "mock-slow-worker.mjs");
      fs.writeFileSync(
        mockWorkerPath,
        `
import { parentPort } from "worker_threads";
parentPort.postMessage({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
parentPort.on("message", (msg) => {
  if (msg.type === "embed") {
    // 延迟 200ms 回复，模拟慢 worker
    setTimeout(() => {
      parentPort.postMessage({ type: "result", embedding: new Float32Array(4), id: msg.id });
    }, 200);
  }
});
`
      );

      const { service, dispose } = await initEmbeddingService({
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
      const mockWorkerPath = path.join(__dirname, "mock-batch-worker.mjs");
      fs.writeFileSync(
        mockWorkerPath,
        `
import { parentPort } from "worker_threads";
parentPort.postMessage({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
parentPort.on("message", (msg) => {
  if (msg.type === "embed-batch") {
    const embeddings = msg.texts.map(() => new Float32Array(4));
    parentPort.postMessage({ type: "batch-result", embeddings, id: msg.id });
  }
});
`
      );

      const { service, dispose } = await initEmbeddingService({
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
      const mockWorkerPath = path.join(__dirname, "mock-slow-batch.mjs");
      fs.writeFileSync(
        mockWorkerPath,
        `
import { parentPort } from "worker_threads";
parentPort.postMessage({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
parentPort.on("message", (msg) => {
  if (msg.type === "embed") {
    setTimeout(() => parentPort.postMessage({ type: "result", embedding: new Float32Array(4), id: msg.id }), 200);
  }
});
`
      );

      const { service, dispose } = await initEmbeddingService({
        workerPath: mockWorkerPath,
        workerExecArgv: [],
      });

      try {
        const p1 = service.embed("x");
        await expect(service.embedBatch!("a b".split(" "))).rejects.toThrow(/backpressure/i);
        await expect(p1).resolves.toBeInstanceOf(Float32Array);
      } finally {
        EmbeddingServiceImpl.setTestMaxInFlightOverride(null);
        dispose();
        fs.unlinkSync(mockWorkerPath);
      }
    });
  });
});
