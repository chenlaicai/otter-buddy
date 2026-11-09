/**
 * F20261109epqst：后台 embedding 统一持久化队列——service 层等待有界性测试。
 *
 * 根因（2026-11-09 生产实锤）：waitSlot 循环无任何超时——doc 洪峰把 ~2000 条
 * bulk waiter 堆进 slotWaiters 后，retry worker 的第一条 embed(waitSlot) 挂在
 * 队尾无限等待，tick 永久 inflightTick，旧任务 0 出队。
 *
 * 本文件固化两条失败用例（修复前红、修复后绿）：
 * - F1: waitSlot 等待必须有界（waitTimeoutMs 到期 reject EmbedSlotTimeoutError）
 * - F2: 超时的 waiter 必须从队列摘除——worker 恢复后新请求不被死 waiter 拖累
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { EmbeddingServiceImpl } from "../../../src/frameworks/embedding/embedding-service";
import { EmbedSlotTimeoutError } from "../../../src/usecases/memory/embedding-gateway";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { fork, type ChildProcess } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

vi.setConfig({ testTimeout: 20_000 });

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

/** 恒定慢响应 worker（500ms/条）——足够制造 waitSlot 排队窗口与超时窗口 */
const SLOW_WORKER = `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type === "embed") {
    setTimeout(() => {
      process.send({ type: "result", id: msg.id, embedding: new Float32Array([0.1, 0.2]) });
    }, 500);
  } else if (msg.type === "embed-batch") {
    setTimeout(() => {
      process.send({ type: "batch-result", id: msg.id, embeddings: msg.texts.map(() => new Float32Array([0.1, 0.2])) });
    }, 500);
  }
});
`;

describe("F20261109epqst：waitSlot 等待有界性（修复前：无界挂起）", () => {
  let workerPath: string;

  afterEach(() => {
    try { fs.unlinkSync(workerPath); } catch { /* 已清理 */ }
    EmbeddingServiceImpl.setTestMaxInFlightOverride(null);
  });

  it("F1: waitSlot 挂起超过 waitTimeoutMs 后 reject EmbedSlotTimeoutError（不再无限等待）", async () => {
    workerPath = writeMockWorker("epqst-slow.mjs", SLOW_WORKER);
    const factory = () => forkMock(workerPath);
    const service = new EmbeddingServiceImpl(factory(), noopLogger, factory);
    try {
      await waitFor(() => service.available, "ready");

      // 第一条 embed 占住唯一槽位（500ms 慢响应）
      const occupier = service.embed("occupy-slow", { waitSlot: true });
      await new Promise((r) => setTimeout(r, 80)); // 等 occupier 真正进入 in-flight

      // 排队者要求 200ms 等待上界——修复前该调用无限挂起（opts 未知字段被忽略，
      // 200ms 后仍 pending；occupier 500ms 完成后它才被唤醒，若等待上界生效
      // 则应在 occupier 完成之前就 reject）
      const waiter = service.embed("queued-live-msg", {
        waitSlot: true,
        priority: 0,
        waitTimeoutMs: 200,
      });

      // 修复后：~200ms reject（occupier 500ms 才完成，reject 必须先于它）
      const t0 = Date.now();
      await expect(waiter).rejects.toBeInstanceOf(EmbedSlotTimeoutError);
      expect(Date.now() - t0).toBeLessThan(450); // 早于 occupier 完成（500ms）
      // occupier 吸收完结果再 dispose（rejectAllPending 会把它变成未处理 rejection）
      await occupier;
    } finally {
      service.dispose();
    }
  });

  it("F2: 超时 waiter 从 slotWaiters 摘除——worker 恢复吞吐后新请求正常完成（死 waiter 不拖累）", async () => {
    workerPath = writeMockWorker("eppq-slow.mjs", SLOW_WORKER);
    const factory = () => forkMock(workerPath);
    const service = new EmbeddingServiceImpl(factory(), noopLogger, factory);
    try {
      await waitFor(() => service.available, "ready");

      const occupier = service.embed("occupy-slow", { waitSlot: true });
      await new Promise((r) => setTimeout(r, 80));
      const waiter = service.embed("queued-then-timeout", {
        waitSlot: true,
        waitTimeoutMs: 150,
      });
      await expect(waiter).rejects.toBeInstanceOf(EmbedSlotTimeoutError);

      // occupier ~500ms 完成、槽位释放时，超时的 waiter 必须已被摘除——
      // 之后的新请求（waitSlot + 宽松等待上界）能正常入槽并在 worker 响应后完成
      await occupier;
      const after = service.embed("fresh-after-drain", {
        waitSlot: true,
        waitTimeoutMs: 5_000,
      });
      const vec = await after;
      expect(vec).toBeInstanceOf(Float32Array);
    } finally {
      service.dispose();
    }
  });
});
