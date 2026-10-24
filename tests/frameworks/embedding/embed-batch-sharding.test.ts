/**
 * F20261023emct：embedBatch 分片闸门单测。
 *
 * 两层覆盖：
 * 1. 纯函数 splitBatchByTokenBudget：保序不变量、预算边界、单条超预算豁免、空输入
 * 2. service 入口行为（真 fork mock worker，与 embedding-service.test.ts 同模式）：
 *    超预算整批 → 拆成多次 embed-batch 请求，结果保序拼接，调用方无感
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BATCH_TOKEN_BUDGET,
  estimateTokens,
  resolveBatchTokenBudget,
  splitBatchByTokenBudget,
  wrapOptsForShard,
} from "../../../src/frameworks/embedding/embed-batch-sharding";
import { initEmbeddingService } from "../../../src/frameworks/embedding/embedding-init";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function writeMockWorker(name: string, body: string): string {
  const p = path.join(__dirname, name);
  fs.writeFileSync(p, body);
  return p;
}

describe("estimateTokens（CJK 敏感：中文 ~1 char/token，其余 ~4 chars/token）", () => {
  it("空串 0；ASCII 向上取整；CJK 1:1", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("ab")).toBe(1); // ceil(2/4)
    expect(estimateTokens("abc")).toBe(1); // ceil(3/4)
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
    expect(estimateTokens("中文字")).toBe(3); // CJK 1:1
    expect(estimateTokens("中文ab")).toBe(3); // 2 + ceil(2/4)
    expect(estimateTokens("，。！")).toBe(3); // 全角标点同口径
  });
});

describe("wrapOptsForShard（delta 处置严重 1：salvage 子批偏移包装）", () => {
  it("无 salvage 的 opts 原样返回（不复制）", () => {
    const opts = { waitSlot: true, salvage: undefined };
    expect(wrapOptsForShard(opts, 5)).toBe(opts);
  });
  it("undefined opts 原样返回", () => {
    expect(wrapOptsForShard(undefined, 5)).toBeUndefined();
  });
  it("有 salvage 时按 offset 注入 startIndex，其余字段保留", () => {
    const seen: Array<{ len: number; start: number | undefined }> = [];
    const opts = {
      waitSlot: true,
      salvage: (embeddings: Float32Array[], startIndex?: number) => {
        seen.push({ len: embeddings.length, start: startIndex });
      },
    };
    const wrapped = wrapOptsForShard(opts, 3);
    expect(wrapped).not.toBe(opts); // 包装是浅拷贝
    expect(wrapped?.waitSlot).toBe(true);
    wrapped?.salvage?.([new Float32Array(1), new Float32Array(1)]);
    // 子批晚到时 startIndex 指向整批第 3 条起——调用方按 3,4 写入正确 entry
    expect(seen).toEqual([{ len: 2, start: 3 }]);
  });
  it("offset=0 时 startIndex=0（与非分批路径 0 语义一致）", () => {
    let got: number | undefined = -1;
    const opts = { salvage: (_e: Float32Array[], startIndex?: number) => { got = startIndex; } };
    wrapOptsForShard(opts, 0)?.salvage?.([new Float32Array(1)]);
    expect(got).toBe(0);
  });
});

describe("resolveBatchTokenBudget", () => {
  it("未设 → 默认 8192（≈16 条 512-token chunk）", () => {
    expect(resolveBatchTokenBudget(undefined)).toBe(DEFAULT_BATCH_TOKEN_BUDGET);
    expect(DEFAULT_BATCH_TOKEN_BUDGET).toBe(8192);
  });
  it("合法值透传", () => {
    expect(resolveBatchTokenBudget("4096")).toBe(4096);
    expect(resolveBatchTokenBudget("1")).toBe(1);
  });
  it("非法值（NaN/0/负数）→ warn + 回落默认（不静默）", () => {
    expect(resolveBatchTokenBudget("abc")).toBe(DEFAULT_BATCH_TOKEN_BUDGET);
    expect(resolveBatchTokenBudget("0")).toBe(DEFAULT_BATCH_TOKEN_BUDGET);
    expect(resolveBatchTokenBudget("-5")).toBe(DEFAULT_BATCH_TOKEN_BUDGET);
  });
});

describe("splitBatchByTokenBudget", () => {
  it("空输入返回 []", () => {
    expect(splitBatchByTokenBudget([], 8192)).toEqual([]);
  });

  it("总预算内不拆（单批返回）", () => {
    // 8 条 100-char（各 50 tokens）= 400 tokens，预算 8192 不拆
    const texts = Array.from({ length: 8 }, (_, i) => `${i}${"x".repeat(99)}`);
    expect(splitBatchByTokenBudget(texts, 8192)).toEqual([texts]);
  });

  it("恰在预算边界不拆，超 1 token 即拆（边界值）", () => {
    // 2×25=50 tokens（ASCII 100 chars 各 ceil(100/4)=25）：预算 50 恰不拆；49 拆
    const a = "a".repeat(100);
    const b = "b".repeat(100);
    expect(splitBatchByTokenBudget([a, b], 50)).toEqual([[a, b]]);
    expect(splitBatchByTokenBudget([a, b], 49)).toEqual([[a], [b]]);
  });

  it("超预算按序拆分，拼接保序不变量（闸门只改怎么送，不改送什么）", () => {
    // 16 条 1024-char ASCII（各 256 tokens）= 4096 恰好预算；17 条超 → 16+1
    const texts = Array.from({ length: 17 }, (_, i) => `${i}: ${"y".repeat(1018)}`);
    const batches = splitBatchByTokenBudget(texts, 4096);
    expect(batches.length).toBe(2);
    expect(batches[0].length).toBe(16);
    expect(batches[1].length).toBe(1);
    expect(batches.flat()).toEqual(texts);
  });

  it("异构体量：巨条不吞并超出预算的后续条", () => {
    const big = "z".repeat(6000); // ASCII 1500 tokens
    const small1 = "s".repeat(100); // 25 tokens
    const small2 = "t".repeat(100);
    expect(splitBatchByTokenBudget([big, small1, small2], 8192)).toEqual([[big, small1, small2]]);
    // 预算 1524：big(1500)+small1(25)=1525 > 1524 → small1 归下一批（贪心不回头）
    expect(splitBatchByTokenBudget([big, small1, small2], 1524)).toEqual([[big], [small1, small2]]);
  });

  it("单条超预算豁免：单独成批放行（拆文本破坏语义；单条路径有截断/超时兜底）", () => {
    const huge = "h".repeat(40000); // 20000 tokens > 8192
    const normal = "n".repeat(1000); // 500 tokens
    expect(splitBatchByTokenBudget([huge, normal], 8192)).toEqual([[huge], [normal]]);
  });

  it("10-23 雪崩形态（49 条中文 6k chars 巨批）被拆成 1 条/批（CJK 1:1 真实口径）", () => {
    const texts = Array.from({ length: 49 }, (_, i) => `${i}：${"维".repeat(5997)}`);
    const batches = splitBatchByTokenBudget(texts, 8192);
    // 每条 ~6000 tokens（中文 1:1），2 条即超预算 → 每批 1 条
    expect(batches.every((b) => b.length === 1)).toBe(true);
    expect(batches.length).toBe(49);
    expect(batches.flat()).toEqual(texts);
  });

  it("budget<1 防御：整批原样返回", () => {
    expect(splitBatchByTokenBudget(["a", "b"], 0)).toEqual([["a", "b"]]);
  });
});

describe("EmbeddingServiceImpl.embedBatch 分片行为（service 层）", () => {
  it("超预算整批 → 拆成多次 embed-batch 请求，结果保序拼接，调用方无感", async () => {
    // mock worker：记录每次收到的 texts 长度，回按内容索引的向量（保序可验证）
    const mockWorkerPath = writeMockWorker(
      "mock-shard-count-worker.mjs",
      `
const batches = [];
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 1 } });
process.on("message", (msg) => {
  if (msg.type === "embed-batch") {
    batches.push(msg.texts.length);
    if (msg.texts.length > 2) {
      process.send({ type: "error", error: "batch too large for mock", id: msg.id });
      return;
    }
    // 每条文本回填它自己的首字符 code，验证保序拼接
    const embeddings = msg.texts.map((t) => {
      const arr = new Float32Array(1);
      arr[0] = t.charCodeAt(0);
      return arr;
    });
    process.send({ type: "batch-result", embeddings, id: msg.id, batchSizes: batches });
  }
});
`
    );
    const { writeService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });
    try {
      // 5 条 200-char ASCII 文本（各 50 tokens），预算压到 100：每批 2 条 → 3 批
      const { EmbeddingServiceImpl } = await import("../../../src/frameworks/embedding/embedding-service");
      EmbeddingServiceImpl.setTestBatchTokenBudgetOverride(100);
      const texts = ["Axx", "Bxx", "Cxx", "Dxx", "Exx"].map((p) => p + "z".repeat(197));
      const results = await service.embedBatch!(texts);
      expect(results).toHaveLength(5);
      // 保序：结果首元素依次是 A/B/C/D/E 的 charCode
      expect(results.map((r: Float32Array) => r[0])).toEqual(
        ["A", "B", "C", "D", "E"].map((c) => c.charCodeAt(0)),
      );
      EmbeddingServiceImpl.setTestBatchTokenBudgetOverride(null);
    } finally {
      dispose();
      fs.unlinkSync(mockWorkerPath);
    }
  });

  it("空数组直接返回 []（不触发任何 worker 交互）", async () => {
    const mockWorkerPath = writeMockWorker(
      "mock-empty-worker.mjs",
      `
process.send({ type: "ready", meta: { modelId: "test", modelRev: "1", dim: 4 } });
process.on("message", (msg) => {
  if (msg.type === "embed-batch") {
    throw new Error("should not be called for empty batch");
  }
});
`
    );
    const { writeService: service, dispose } = await initEmbeddingService({
      workerPath: mockWorkerPath,
      workerExecArgv: [],
    });
    try {
      const results = await service.embedBatch!([]);
      expect(results).toEqual([]);
    } finally {
      dispose();
      fs.unlinkSync(mockWorkerPath);
    }
  });
});
