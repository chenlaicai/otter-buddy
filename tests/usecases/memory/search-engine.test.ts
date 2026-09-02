import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SearchEngine } from "@usecases/memory/search-engine";
import type { SearchEngineConfig } from "@usecases/memory/search-engine";
import type { MemoryEntry, MemoryWeight } from "@entities/memory/memory-entry";
import type { FTSHit, VecHit } from "@usecases/memory/memory-repository";

/** 标准测试配置 */
const TEST_CONFIG: SearchEngineConfig = {
  rrfK: 60,
  alpha: 0.4,
  vecSimilarityThreshold: 0.3,
  bothBoost: 1.2,
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
