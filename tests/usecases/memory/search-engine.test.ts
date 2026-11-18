import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SearchEngine,
  normalizeRrfPool,
  normalizeFrequency,
  normalizeRerankWeights,
} from "@usecases/memory/search-engine";
import type { SearchEngineConfig, RrfHit } from "@usecases/memory/search-engine";
import type { MemoryEntry, MemoryWeight } from "@entities/memory/memory-entry";
import type { FTSHit, VecHit } from "@usecases/memory/memory-repository";

/** 标准测试配置 */
const TEST_CONFIG: SearchEngineConfig = {
  rrfK: 60,
  alpha: 0.4,
  vecSimilarityThreshold: 0.3,
  bothBoost: 1.2,
  currentConversationBoost: 1.5,
  weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90,
  userFlagMultiplier: 2,
  frequencyBoostFactor: 0.5,
};

/** 创建测试用 MemoryEntry */
function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "entry-default",
    layer: "working",
    contentType: "message",
    sourceId: "src-1",
    sourceTable: "messages",
    conversationId: null,
    granularity: "fine",
    content: "测试内容",
    metadata: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 创建 FTS 命中 */
function makeFtsHit(entryId: string, entry: MemoryEntry): FTSHit {
  return { entryId, ftsRank: 0, entry };
}

/** 创建 Vec 命中 */
function makeVecHit(
  entryId: string,
  entry: MemoryEntry,
  distance: number,
): VecHit {
  return { entryId, distance, entry };
}

describe("SearchEngine - RRF 融合与单源构建", () => {
  let engine: SearchEngine;

  beforeEach(() => {
    engine = new SearchEngine(TEST_CONFIG);
  });

  // ─── rrfFusion ───────────────────────────────────────────

  describe("rrfFusion()", () => {
    it("仅 FTS 命中时 source='fts'，分数 = ftsWeight * 1/(k+rank+1)", () => {
      const e1 = makeEntry({ id: "e1" });
      const e2 = makeEntry({ id: "e2" });
      const ftsHits = [makeFtsHit("e1", e1), makeFtsHit("e2", e2)];

      const result = engine.rrfFusion(ftsHits, []);

      expect(result.size).toBe(2);

      // rank 0: ftsWeight * 1/(60+0+1) = 0.6 * 1/61
      const hit1 = result.get("e1")!;
      expect(hit1.source).toBe("fts");
      expect(hit1.rrfScore).toBeCloseTo(0.6 * (1 / 61));

      // rank 1: ftsWeight * 1/(60+1+1) = 0.6 * 1/62
      const hit2 = result.get("e2")!;
      expect(hit2.source).toBe("fts");
      expect(hit2.rrfScore).toBeCloseTo(0.6 * (1 / 62));
    });

    it("仅 Vec 命中时 source='vec'，分数 = vecWeight * 1/(k+rank+1)", () => {
      const e1 = makeEntry({ id: "e1" });
      const e2 = makeEntry({ id: "e2" });
      const vecHits = [
        makeVecHit("e1", e1, 0.3),
        makeVecHit("e2", e2, 0.5),
      ];

      const result = engine.rrfFusion([], vecHits);

      expect(result.size).toBe(2);

      // rank 0: vecWeight * 1/(60+0+1) = 0.4 * 1/61
      const hit1 = result.get("e1")!;
      expect(hit1.source).toBe("vec");
      expect(hit1.rrfScore).toBeCloseTo(0.4 * (1 / 61));

      // rank 1: vecWeight * 1/(60+1+1) = 0.4 * 1/62
      const hit2 = result.get("e2")!;
      expect(hit2.source).toBe("vec");
      expect(hit2.rrfScore).toBeCloseTo(0.4 * (1 / 62));
    });

    it("重叠命中时 source='both'，分数累加并乘以 bothBoost", () => {
      const e1 = makeEntry({ id: "e1" });
      // FTS 中 e1 排名第 0，Vec 中 e1 也排名第 0
      const ftsHits = [makeFtsHit("e1", e1)];
      const vecHits = [makeVecHit("e1", e1, 0.2)];

      const result = engine.rrfFusion(ftsHits, vecHits);

      expect(result.size).toBe(1);
      const hit = result.get("e1")!;
      expect(hit.source).toBe("both");
      // FTS 分数：0.6 * 1/61
      // Vec 分数：0.4 * 1/61
      // 累加：(0.6 + 0.4) * 1/61 = 1/61
      // bothBoost：1/61 * 1.2
      expect(hit.rrfScore).toBeCloseTo((1 / 61) * 1.2);
    });

    it("空输入返回空结果 Map", () => {
      const result = engine.rrfFusion([], []);
      expect(result.size).toBe(0);
    });

    it("部分重叠：仅在一路命中的条目保持单一 source", () => {
      const e1 = makeEntry({ id: "e1" });
      const e2 = makeEntry({ id: "e2" });
      const ftsHits = [makeFtsHit("e1", e1)];
      const vecHits = [makeVecHit("e2", e2, 0.4)];

      const result = engine.rrfFusion(ftsHits, vecHits);

      expect(result.get("e1")!.source).toBe("fts");
      expect(result.get("e2")!.source).toBe("vec");
    });

    it("alpha 权重：FTS 权重 = 1-alpha，Vec 权重 = alpha", () => {
      const e1 = makeEntry({ id: "e1" });
      const e2 = makeEntry({ id: "e2" });
      const ftsHits = [makeFtsHit("e1", e1)];
      const vecHits = [makeVecHit("e2", e2, 0.2)];

      // alpha=0.4 时：ftsWeight=0.6, vecWeight=0.4
      const result = engine.rrfFusion(ftsHits, vecHits);

      const hit1 = result.get("e1")!;
      const hit2 = result.get("e2")!;

      // e1 仅 FTS 命中：0.6 * 1/61
      expect(hit1.rrfScore).toBeCloseTo(0.6 * (1 / 61));
      expect(hit1.source).toBe("fts");

      // e2 仅 Vec 命中：0.4 * 1/61
      expect(hit2.rrfScore).toBeCloseTo(0.4 * (1 / 61));
      expect(hit2.source).toBe("vec");
    });

    it("vecSimilarityThreshold 门控：过滤低相似度 Vec 结果", () => {
      const e1 = makeEntry({ id: "e1" });
      const e2 = makeEntry({ id: "e2" });
      // e1 的 similarity = 1 - 0.8 = 0.2 < 0.3，应被过滤
      // e2 的 similarity = 1 - 0.5 = 0.5 >= 0.3，应保留
      const vecHits = [
        makeVecHit("e1", e1, 0.8),
        makeVecHit("e2", e2, 0.5),
      ];

      const result = engine.rrfFusion([], vecHits);

      // e1 被过滤，只有 e2 保留
      expect(result.size).toBe(1);
      expect(result.has("e1")).toBe(false);
      expect(result.has("e2")).toBe(true);
    });

    it("bothBoost：两路命中时分数乘以 bothBoost", () => {
      const e1 = makeEntry({ id: "e1" });
      const ftsHits = [makeFtsHit("e1", e1)];
      const vecHits = [makeVecHit("e1", e1, 0.2)];

      const result = engine.rrfFusion(ftsHits, vecHits);

      const hit = result.get("e1")!;
      expect(hit.source).toBe("both");

      // FTS 分数：0.6 * 1/61
      // Vec 分数：0.4 * 1/61
      // 累加：(0.6 + 0.4) * 1/61 = 1/61
      // bothBoost：1/61 * 1.2
      const expectedScore = (1 / 61) * 1.2;
      expect(hit.rrfScore).toBeCloseTo(expectedScore);
    });
  });

  // ─── buildSingleSourceRrfHits ─────────────────────────────

  describe("buildSingleSourceRrfHits()", () => {
    it("为每个 Vec 命中分配 rrfScore = 1/(k+rank+1)，source='vec'", () => {
      const e1 = makeEntry({ id: "e1" });
      const e2 = makeEntry({ id: "e2" });
      const e3 = makeEntry({ id: "e3" });
      const vecHits = [
        makeVecHit("e1", e1, 0.1),
        makeVecHit("e2", e2, 0.2),
        makeVecHit("e3", e3, 0.3),
      ];

      const result = engine.buildSingleSourceRrfHits(vecHits);

      expect(result.size).toBe(3);

      const h1 = result.get("e1")!;
      expect(h1.source).toBe("vec");
      expect(h1.rrfScore).toBeCloseTo(1 / 61); // k=60, rank=0

      const h2 = result.get("e2")!;
      expect(h2.source).toBe("vec");
      expect(h2.rrfScore).toBeCloseTo(1 / 62); // k=60, rank=1

      const h3 = result.get("e3")!;
      expect(h3.source).toBe("vec");
      expect(h3.rrfScore).toBeCloseTo(1 / 63); // k=60, rank=2
    });

    it("空输入返回空 Map", () => {
      const result = engine.buildSingleSourceRrfHits([]);
      expect(result.size).toBe(0);
    });
  });
});

describe("SearchEngine - rerank 重排序", () => {
  let engine: SearchEngine;

  beforeEach(() => {
    engine = new SearchEngine(TEST_CONFIG);
  });

  // ─── rerank ───────────────────────────────────────────────

  describe("rerank()", () => {
    /** 固定时间以消除 timeDecay 的不确定性 */
    const NOW = "2026-07-22T12:00:00Z";

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("应用 timeDecay：刚创建的条目 timeDecay ≈ 1.0", () => {
      const e1 = makeEntry({ id: "e1", createdAt: NOW });
      const hits = new Map([
        [
          "e1",
          {
            entryId: "e1",
            rrfScore: 0.5,
            source: "fts" as const,
            entry: e1,
          },
        ],
      ]);
      const weights = new Map<string, MemoryWeight>();

      const result = engine.rerank(hits, weights);

      expect(result).toHaveLength(1);
      // 当前时间的条目：ageDays ≈ 0，timeDecay ≈ exp(0) = 1
      // frequencyBoost = log(1+0)*0.5 + 1 = 1
      // userFlag = false → 1.0
      // finalScore = 0.5 * 1 * 1 * 1 = 0.5
      expect(result[0].finalScore).toBeCloseTo(0.5);
    });

    it("应用 frequencyBoost：retrievalCount 越大分数越高", () => {
      const e1 = makeEntry({ id: "e1", createdAt: NOW });
      const e2 = makeEntry({ id: "e2", createdAt: NOW });

      const hits = new Map([
        [
          "e1",
          {
            entryId: "e1",
            rrfScore: 0.5,
            source: "fts" as const,
            entry: e1,
          },
        ],
        [
          "e2",
          {
            entryId: "e2",
            rrfScore: 0.5,
            source: "fts" as const,
            entry: e2,
          },
        ],
      ]);

      const weights = new Map<string, MemoryWeight>([
        [
          "e1",
          {
            memoryEntryId: "e1",
            retrievalCount: 0,
            lastRetrievedAt: null,
            userFlagged: false,
          },
        ],
        [
          "e2",
          {
            memoryEntryId: "e2",
            retrievalCount: 10,
            lastRetrievedAt: NOW,
            userFlagged: false,
          },
        ],
      ]);

      const result = engine.rerank(hits, weights);
      const score1 = result.find((r) => r.entryId === "e1")!.finalScore;
      const score2 = result.find((r) => r.entryId === "e2")!.finalScore;

      // e2 有 retrievalCount=10，frequencyBoost = log(11)*0.5 + 1 > 1
      expect(score2).toBeGreaterThan(score1);
    });
  });
});

describe("SearchEngine - rerank 用户标记与时间衰减", () => {
  let engine: SearchEngine;

  beforeEach(() => {
    engine = new SearchEngine(TEST_CONFIG);
  });

  describe("rerank()", () => {
    /** 固定时间以消除 timeDecay 的不确定性 */
    const NOW = "2026-07-22T12:00:00Z";

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("userFlagged=true 时乘以 userFlagMultiplier", () => {
      const e1 = makeEntry({ id: "e1", createdAt: NOW });
      const e2 = makeEntry({ id: "e2", createdAt: NOW });

      const hits = new Map([
        [
          "e1",
          {
            entryId: "e1",
            rrfScore: 0.5,
            source: "fts" as const,
            entry: e1,
          },
        ],
        [
          "e2",
          {
            entryId: "e2",
            rrfScore: 0.5,
            source: "fts" as const,
            entry: e2,
          },
        ],
      ]);

      const weights = new Map<string, MemoryWeight>([
        [
          "e1",
          {
            memoryEntryId: "e1",
            retrievalCount: 0,
            lastRetrievedAt: null,
            userFlagged: false,
          },
        ],
        [
          "e2",
          {
            memoryEntryId: "e2",
            retrievalCount: 0,
            lastRetrievedAt: null,
            userFlagged: true,
          },
        ],
      ]);

      const result = engine.rerank(hits, weights);
      const score1 = result.find((r) => r.entryId === "e1")!.finalScore;
      const score2 = result.find((r) => r.entryId === "e2")!.finalScore;

      // userFlagMultiplier=2 → flagged 条目分数是 unflagged 的 2 倍
      expect(score2).toBeCloseTo(score1 * 2);
    });

    it("缺失 weight 时使用默认值（retrievalCount=0, userFlagged=false）", () => {
      const e1 = makeEntry({ id: "e1", createdAt: NOW });

      const hits = new Map([
        [
          "e1",
          {
            entryId: "e1",
            rrfScore: 0.5,
            source: "fts" as const,
            entry: e1,
          },
        ],
      ]);

      // 不传入任何 weight
      const weights = new Map<string, MemoryWeight>();

      const result = engine.rerank(hits, weights);

      expect(result).toHaveLength(1);
      // 默认：timeDecay≈1, frequencyBoost=log(1)*0.5+1=1, userFlag=1
      // finalScore = 0.5 * 1 * 1 * 1 = 0.5
      expect(result[0].finalScore).toBeCloseTo(0.5);
    });

    it("timeDecay 随时间衰减：较老条目分数较低", () => {
      const recentEntry = makeEntry({ id: "recent", createdAt: NOW });
      const oldEntry = makeEntry({
        id: "old",
        createdAt: "2026-06-01T12:00:00Z",
      });

      const hits = new Map([
        [
          "recent",
          {
            entryId: "recent",
            rrfScore: 0.5,
            source: "fts" as const,
            entry: recentEntry,
          },
        ],
        [
          "old",
          {
            entryId: "old",
            rrfScore: 0.5,
            source: "fts" as const,
            entry: oldEntry,
          },
        ],
      ]);

      const weights = new Map<string, MemoryWeight>();

      const result = engine.rerank(hits, weights);
      const recentScore = result.find(
        (r) => r.entryId === "recent",
      )!.finalScore;
      const oldScore = result.find((r) => r.entryId === "old")!.finalScore;

      // 较老条目的 timeDecay 更小，因此 finalScore 更低
      expect(oldScore).toBeLessThan(recentScore);
    });
  });
});

describe("F20260917cvid: 本对话来源加权（currentConversationBoost）", () => {
  let engine: SearchEngine;

  beforeEach(() => {
    engine = new SearchEngine(TEST_CONFIG);
  });

  it("rerank 传入 currentConversationId 时，本对话条目分数 ×1.5，其他对话条目不变", () => {
    // CI flaky 修复（turn PR #1053 顺带）：默认 createdAt=now 使 boosted/baseline 两次
    // rerank 之间真实时间流逝 → timeDecay 漂移 → 5.7e-10 差击穿 10 位精度断言（慢机
    // 器 CI 实证）。固定 createdAt + vi.setSystemTime 钉死时间源，双保险。
    const NOW = "2026-09-20T00:00:00Z";
    vi.setSystemTime(new Date(NOW));
    const sameConv = makeEntry({ id: "same", conversationId: "conv-A", createdAt: NOW });
    const otherConv = makeEntry({ id: "other", conversationId: "conv-B", createdAt: NOW });
    const noConv = makeEntry({ id: "none", conversationId: null, createdAt: NOW });
    const hits = new Map<string, import("@usecases/memory/search-engine").RrfHit>([
      ["same", { entryId: "same", rrfScore: 0.5, source: "fts", entry: sameConv }],
      ["other", { entryId: "other", rrfScore: 0.5, source: "fts", entry: otherConv }],
      ["none", { entryId: "none", rrfScore: 0.5, source: "fts", entry: noConv }],
    ]);

    const boosted = engine.rerank(hits, new Map(), "conv-A");
    const baseline = engine.rerank(hits, new Map());

    const score = (arr: ReturnType<SearchEngine["rerank"]>, id: string) =>
      arr.find(r => r.entryId === id)!.finalScore;

    // toBeCloseTo 默认 10 位精度会被 ×1.5 浮点往返击穿（CI 实证差 5.7e-10），用比例断言；
    // 交叉对话断言降 8 位精度——即便时间钉死，浮点次序差异仍可能引入远小于业务意义的抖动
    expect(score(boosted, "same") / score(baseline, "same")).toBeCloseTo(1.5, 9);
    expect(score(boosted, "other")).toBeCloseTo(score(baseline, "other"), 8);
    expect(score(boosted, "none")).toBeCloseTo(score(baseline, "none"), 8);
    vi.useRealTimers();
  });

  it("不传 currentConversationId 时排序与旧行为一致（零影响）", () => {
    // 与上一测试同款 flaky（F20260922txre PR 顺带修，CI run 35687806624 实证）：
    // 默认 createdAt=now + 双次 rerank 跨毫秒 → timeDecay 漂移 → 5.7e-10 差击穿
    // 10 位精度断言。固定 createdAt + vi.setSystemTime 钉死时间源（同款双保险）。
    const NOW = "2026-09-20T00:00:00Z";
    vi.setSystemTime(new Date(NOW));
    const e1 = makeEntry({ id: "a", conversationId: "conv-A", createdAt: NOW });
    const hits = new Map<string, import("@usecases/memory/search-engine").RrfHit>([
      ["a", { entryId: "a", rrfScore: 0.5, source: "fts", entry: e1 }],
    ]);
    const withUndef = engine.rerank(hits, new Map(), undefined);
    const plain = engine.rerank(hits, new Map());
    expect(withUndef[0].finalScore).toBeCloseTo(plain[0].finalScore, 10);
    vi.useRealTimers();
  });
});

describe("SearchEngine - Phase 1 段 1：归一化纯函数与加法融合路径", () => {
  describe("normalizeRrfPool（池内 min-max）", () => {
    it("空池返回空数组", () => {
      expect(normalizeRrfPool([])).toEqual([]);
    });

    it("单候选池记 1.0", () => {
      expect(normalizeRrfPool([0.42])).toEqual([1.0]);
    });

    it("全并列退化为常量 1.0（单调变换，排序与 raw RRF 一致）", () => {
      expect(normalizeRrfPool([0.3, 0.3, 0.3])).toEqual([1.0, 1.0, 1.0]);
    });

    it("min-max 线性映射到 [0,1]，极值锚定 0/1", () => {
      const norm = normalizeRrfPool([0.1, 0.5, 0.3]);
      expect(norm[0]).toBe(0);
      expect(norm[1]).toBe(1);
      expect(norm[2]).toBeCloseTo(0.5, 12);
    });
  });

  describe("normalizeFrequency（饱和截断 CAP=log(1+countCap)）", () => {
    it("0 次检索归一为 0", () => {
      expect(normalizeFrequency(0, 10)).toBe(0);
    });

    it("达到 countCap 时饱和为 1", () => {
      expect(normalizeFrequency(10, 10)).toBeCloseTo(1, 12);
    });

    it("超过 countCap 截断为 1（不随检索数无界增长）", () => {
      expect(normalizeFrequency(100, 10)).toBeCloseTo(1, 12);
    });
  });

  describe("normalizeRerankWeights（连续权重和归一）", () => {
    it("权重和已为 1 时不变", () => {
      const w = normalizeRerankWeights({ wRrf: 0.6, wTime: 0.3, wFreq: 0.1, bUserFlag: 0.05, bConv: 0.05, freqCap: 10 });
      expect(w.wRrf).toBeCloseTo(0.6, 12);
      expect(w.wTime).toBeCloseTo(0.3, 12);
      expect(w.wFreq).toBeCloseTo(0.1, 12);
      expect(w.bUserFlag).toBe(0.05);
      expect(w.bConv).toBe(0.05);
    });

    it("权重和≠1 时按比例归一（不静默采用坏配置）", () => {
      const w = normalizeRerankWeights({ wRrf: 2, wTime: 1, wFreq: 1, bUserFlag: 0, bConv: 0, freqCap: 10 });
      expect(w.wRrf).toBeCloseTo(0.5, 12);
      expect(w.wTime).toBeCloseTo(0.25, 12);
      expect(w.wFreq).toBeCloseTo(0.25, 12);
    });

    it("权重和为 0（纯偏置配置）时不做除法", () => {
      const w = normalizeRerankWeights({ wRrf: 0, wTime: 0, wFreq: 0, bUserFlag: 0.1, bConv: 0.1, freqCap: 10 });
      expect(w.wRrf).toBe(0);
      expect(w.wTime).toBe(0);
      expect(w.wFreq).toBe(0);
      expect(w.bUserFlag).toBe(0.1);
    });
  });

  describe("rerankAdditive（加法融合）", () => {
    function makeRrfHit(id: string, rrfScore: number, conversationId: string | null): RrfHit {
      return {
        entryId: id,
        rrfScore,
        source: "fts",
        entry: makeEntry({ id, conversationId, createdAt: "2026-09-20T00:00:00Z" }),
      };
    }

    it("全中性化矩阵（w_rrf=1 其余 0）下，finalScore = norm(rrf)，排序与 raw RRF 一致", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
      try {
        const engine = new SearchEngine({
          ...TEST_CONFIG,
          rerankMode: "additive",
          rerank: { wRrf: 1, wTime: 0, wFreq: 0, bUserFlag: 0, bConv: 0, freqCap: 10 },
        });
        const hits = new Map<string, RrfHit>([
          ["low", makeRrfHit("low", 0.1, null)],
          ["high", makeRrfHit("high", 0.5, null)],
          ["mid", makeRrfHit("mid", 0.3, null)],
        ]);
        const result = engine.rerankAdditive(hits, new Map());
        const scores = new Map(result.map(r => [r.entryId, r.finalScore]));
        // 全中性：norm(rrf) = min-max(rrf)，排序与 raw rrf 一致
        expect(scores.get("low")).toBe(0);
        expect(scores.get("high")).toBe(1);
        expect(scores.get("mid")).toBeCloseTo(0.5, 12);
      } finally {
        vi.useRealTimers();
      }
    });

    it("偏置项只做加法抬升：flag/同对话 +b，不参与连续权重", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
      try {
        const engine = new SearchEngine({
          ...TEST_CONFIG,
          rerankMode: "additive",
          rerank: { wRrf: 1, wTime: 0, wFreq: 0, bUserFlag: 0.1, bConv: 0.2, freqCap: 10 },
        });
        const hits = new Map<string, RrfHit>([
          ["plain", makeRrfHit("plain", 0.5, null)],
          ["flagged", makeRrfHit("flagged", 0.5, null)],
          ["conv", makeRrfHit("conv", 0.5, "conv-A")],
        ]);
        const weights = new Map<string, MemoryWeight>([
          ["flagged", { memoryEntryId: "flagged", retrievalCount: 0, lastRetrievedAt: null, userFlagged: true }],
        ]);
        const result = engine.rerankAdditive(hits, weights, "conv-A");
        const score = (id: string) => result.find(r => r.entryId === id)!.finalScore;
        expect(score("plain")).toBeCloseTo(1, 10); // 三候选同分 → 全并列常量 1.0
        expect(score("flagged")).toBeCloseTo(1 + 0.1, 10);
        expect(score("conv")).toBeCloseTo(1 + 0.2, 10);
      } finally {
        vi.useRealTimers();
      }
    });

    it("段 2：透出逐信号贡献分量，五项之和 = 去重前 finalScore 且各分量可手工复算", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
      try {
        const engine = new SearchEngine({
          ...TEST_CONFIG,
          rerankMode: "additive",
          rerank: { wRrf: 0.5, wTime: 0.3, wFreq: 0.2, bUserFlag: 0.1, bConv: 0.15, freqCap: 10 },
        });
        // rrfScore: flagged=0.1（norm 0） conv=0.3（norm 0.5） plain=0.5（norm 1）；createdAt=now → timeDecay=1
        const hits = new Map<string, RrfHit>([
          ["plain", makeRrfHit("plain", 0.5, null)],
          ["flagged", makeRrfHit("flagged", 0.1, null)],
          ["conv", makeRrfHit("conv", 0.3, "conv-A")],
        ]);
        const weights = new Map<string, MemoryWeight>([
          ["flagged", { memoryEntryId: "flagged", retrievalCount: 0, lastRetrievedAt: null, userFlagged: true }],
        ]);
        const result = engine.rerankAdditive(hits, weights, "conv-A");
        for (const r of result) {
          const sum = (r.contribRrf ?? 0) + (r.contribTime ?? 0) + (r.contribFreq ?? 0)
            + (r.biasFlag ?? 0) + (r.biasConv ?? 0);
          expect(sum, `entryId=${r.entryId} 贡献分量之和应等于 finalScore`).toBeCloseTo(r.finalScore, 12);
        }
        const hit = (id: string) => result.find(r => r.entryId === id)!;
        // plain: 0.5*1 + 0.3*1 + 0.2*0 + 0 + 0 = 0.8
        const plain = hit("plain");
        expect(plain.contribRrf).toBeCloseTo(0.5, 12);
        expect(plain.contribTime).toBeCloseTo(0.3, 12);
        expect(plain.contribFreq).toBeCloseTo(0, 12);
        expect(plain.biasFlag).toBe(0);
        expect(plain.biasConv).toBe(0);
        // flagged（norm 0 + b_flag 0.1）
        const flagged = hit("flagged");
        expect(flagged.biasFlag).toBeCloseTo(0.1, 12);
        expect(flagged.biasConv).toBe(0);
        // conv（norm 0.5 → 0.25 + time 0.3 + conv 0.15 = 0.7）
        const conv = hit("conv");
        expect(conv.contribRrf).toBeCloseTo(0.25, 12);
        expect(conv.biasConv).toBeCloseTo(0.15, 12);
        expect(conv.biasFlag).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
