import { describe, it, expect } from "vitest";
import { SearchEngine, type SearchEngineConfig } from "@domain/memory/_internal/search-engine";
import type { FTSHit, MemoryEntry, MemoryWeight, VecHit } from "@domain/memory/model";

const defaultConfig: SearchEngineConfig = {
  rrfK: 60,
  weightHalfLifeDays: 7,
  samePathBoost: 1.5,
  crossPathDecay: 0.8,
  userFlagMultiplier: 2.0,
  frequencyBoostFactor: 0.1,
};

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "entry-1",
    layer: "working",
    contentType: "message",
    sourceId: "src-1",
    sourceTable: "messages",
    conversationId: null,
    treePath: null,
    granularity: "fine",
    content: "test content",
    metadata: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeWeight(overrides: Partial<MemoryWeight> = {}): MemoryWeight {
  return {
    memoryEntryId: "entry-1",
    retrievalCount: 0,
    lastRetrievedAt: null,
    userFlagged: false,
    ...overrides,
  };
}

describe("SearchEngine", () => {
  describe("rrfFusion", () => {
    it("仅 FTS 命中时 source='fts'", () => {
      const engine = new SearchEngine(defaultConfig);
      const ftsHits: FTSHit[] = [
        { memoryEntryId: "a", bm25Score: -1, entry: makeEntry({ id: "a" }) },
        { memoryEntryId: "b", bm25Score: -2, entry: makeEntry({ id: "b" }) },
      ];

      const result = engine.rrfFusion(ftsHits, []);

      expect(result.size).toBe(2);
      expect(result.get("a")!.source).toBe("fts");
      expect(result.get("b")!.source).toBe("fts");
    });

    it("仅 vec 命中时 source='vec'", () => {
      const engine = new SearchEngine(defaultConfig);
      const vecHits: VecHit[] = [
        { memoryEntryId: "a", distance: 0.1, entry: makeEntry({ id: "a" }) },
      ];

      const result = engine.rrfFusion([], vecHits);

      expect(result.size).toBe(1);
      expect(result.get("a")!.source).toBe("vec");
    });

    it("双源命中时 source='both' 且 score 更高", () => {
      const engine = new SearchEngine(defaultConfig);
      const entry = makeEntry({ id: "a" });
      const ftsHits: FTSHit[] = [
        { memoryEntryId: "a", bm25Score: -1, entry },
      ];
      const vecHits: VecHit[] = [
        { memoryEntryId: "a", distance: 0.1, entry },
      ];

      const result = engine.rrfFusion(ftsHits, vecHits);

      expect(result.get("a")!.source).toBe("both");
      /** 双源命中 score = 1/(60+0+1) + 1/(60+0+1) = 2/61 */
      const expectedScore = 2 / 61;
      expect(result.get("a")!.rrfScore).toBeCloseTo(expectedScore, 6);
    });

    it("k=60 默认值验证", () => {
      const engine = new SearchEngine(defaultConfig);
      const ftsHits: FTSHit[] = [
        { memoryEntryId: "a", bm25Score: -1, entry: makeEntry({ id: "a" }) },
      ];

      const result = engine.rrfFusion(ftsHits, []);

      /** rank=0: score = 1/(60+0+1) = 1/61 */
      expect(result.get("a")!.rrfScore).toBeCloseTo(1 / 61, 6);
    });

    it("rank 越高 score 越低", () => {
      const engine = new SearchEngine(defaultConfig);
      const ftsHits: FTSHit[] = [
        { memoryEntryId: "a", bm25Score: -1, entry: makeEntry({ id: "a" }) },
        { memoryEntryId: "b", bm25Score: -2, entry: makeEntry({ id: "b" }) },
      ];

      const result = engine.rrfFusion(ftsHits, []);

      expect(result.get("a")!.rrfScore).toBeGreaterThan(result.get("b")!.rrfScore);
    });
  });

  describe("buildSingleSourceRrfHits", () => {
    it("保留 vec 距离排序信息", () => {
      const engine = new SearchEngine(defaultConfig);
      const vecHits: VecHit[] = [
        { memoryEntryId: "a", distance: 0.1, entry: makeEntry({ id: "a" }) },
        { memoryEntryId: "b", distance: 0.5, entry: makeEntry({ id: "b" }) },
      ];

      const result = engine.buildSingleSourceRrfHits(vecHits);

      /** rank=0 的 score 应高于 rank=1 */
      expect(result.get("a")!.rrfScore).toBeGreaterThan(result.get("b")!.rrfScore);
      expect(result.get("a")!.source).toBe("vec");
    });
  });

  describe("computeFinalScore - time_decay", () => {
    it("新条目权重高于旧条目", () => {
      const engine = new SearchEngine(defaultConfig);
      const weight = makeWeight();
      const now = new Date();
      const recent = new Date(now.getTime() - 1000).toISOString();
      const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const recentScore = engine.computeFinalScore(0.01, weight, recent, null, null);
      const oldScore = engine.computeFinalScore(0.01, weight, old, null, null);

      expect(recentScore).toBeGreaterThan(oldScore);
    });

    it("7 天半衰期验证", () => {
      const engine = new SearchEngine(defaultConfig);
      const weight = makeWeight();
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const freshScore = engine.computeFinalScore(1.0, weight, now.toISOString(), null, null);
      const decayedScore = engine.computeFinalScore(1.0, weight, sevenDaysAgo, null, null);

      /** 7 天后 time_decay ≈ 0.5 */
      expect(decayedScore / freshScore).toBeCloseTo(0.5, 1);
    });
  });

  describe("computeFinalScore - frequency_boost", () => {
    it("retrieval_count 高的条目权重高", () => {
      const engine = new SearchEngine(defaultConfig);
      const now = new Date().toISOString();
      const lowFreq = makeWeight({ retrievalCount: 0 });
      const highFreq = makeWeight({ retrievalCount: 100 });

      const lowScore = engine.computeFinalScore(0.01, lowFreq, now, null, null);
      const highScore = engine.computeFinalScore(0.01, highFreq, now, null, null);

      expect(highScore).toBeGreaterThan(lowScore);
    });
  });

  describe("computeFinalScore - task_relevance", () => {
    it("同路径加成 samePathBoost=1.5", () => {
      const engine = new SearchEngine(defaultConfig);
      const weight = makeWeight();
      const now = new Date().toISOString();

      const score = engine.computeFinalScore(1.0, weight, now, "/a/b", "/a/b/c");

      /** task_relevance = 1.5, 其他因子 = 1.0（新条目、无频率加成、无标记） */
      expect(score).toBeCloseTo(1.5, 1);
    });

    it("跨路径衰减 crossPathDecay=0.8", () => {
      const engine = new SearchEngine(defaultConfig);
      const weight = makeWeight();
      const now = new Date().toISOString();

      const score = engine.computeFinalScore(1.0, weight, now, "/a/b", "/x/y");

      expect(score).toBeCloseTo(0.8, 1);
    });

    it("无路径时不加成不衰减 = 1.0", () => {
      const engine = new SearchEngine(defaultConfig);
      const weight = makeWeight();
      const now = new Date().toISOString();

      const score = engine.computeFinalScore(1.0, weight, now, null, null);

      expect(score).toBeCloseTo(1.0, 1);
    });

    it("单侧无路径时 = 1.0", () => {
      const engine = new SearchEngine(defaultConfig);
      const weight = makeWeight();
      const now = new Date().toISOString();

      const score = engine.computeFinalScore(1.0, weight, now, "/a/b", null);

      expect(score).toBeCloseTo(1.0, 1);
    });

    it("父子路径关系视为同路径", () => {
      const engine = new SearchEngine(defaultConfig);
      const weight = makeWeight();
      const now = new Date().toISOString();

      /** entryTreePath 是 currentTreePath 的父路径 */
      const score = engine.computeFinalScore(1.0, weight, now, "/a/b", "/a/b/c");
      expect(score).toBeCloseTo(1.5, 1);

      /** currentTreePath 是 entryTreePath 的父路径 */
      const score2 = engine.computeFinalScore(1.0, weight, now, "/a/b/c", "/a/b");
      expect(score2).toBeCloseTo(1.5, 1);
    });

    it("路径段边界：/conv/1 与 /conv/10 不是同路径", () => {
      const engine = new SearchEngine(defaultConfig);
      const weight = makeWeight();
      const now = new Date().toISOString();

      /** /conv/10 不应匹配 /conv/1 的前缀（路径段边界） */
      const score = engine.computeFinalScore(1.0, weight, now, "/conv/10", "/conv/1");
      expect(score).toBeCloseTo(0.8, 1);

      /** 反向也成立 */
      const score2 = engine.computeFinalScore(1.0, weight, now, "/conv/1", "/conv/10");
      expect(score2).toBeCloseTo(0.8, 1);
    });
  });

  describe("computeFinalScore - user_flag_multiplier", () => {
    it("flagged=true 时 ×2.0", () => {
      const engine = new SearchEngine(defaultConfig);
      const now = new Date().toISOString();
      const unflagged = makeWeight({ userFlagged: false });
      const flagged = makeWeight({ userFlagged: true });

      const unflaggedScore = engine.computeFinalScore(1.0, unflagged, now, null, null);
      const flaggedScore = engine.computeFinalScore(1.0, flagged, now, null, null);

      expect(flaggedScore / unflaggedScore).toBeCloseTo(2.0, 1);
    });
  });

  describe("rerank 综合排序", () => {
    it("多因子组合后排序正确", () => {
      const engine = new SearchEngine(defaultConfig);
      const now = new Date().toISOString();

      /** entry-a: 高频率、用户标记、同路径 -- 应排第一 */
      const entryA = makeEntry({ id: "a", createdAt: now, treePath: "/conv/1" });
      const weightA = makeWeight({ memoryEntryId: "a", retrievalCount: 50, userFlagged: true });

      /** entry-b: 新但无加成 -- 排第二 */
      const entryB = makeEntry({ id: "b", createdAt: now, treePath: "/conv/2" });
      const weightB = makeWeight({ memoryEntryId: "b", retrievalCount: 0, userFlagged: false });

      const rrfHits = new Map();
      rrfHits.set("a", { memoryEntryId: "a", rrfScore: 0.01, entry: entryA, source: "fts" as const });
      rrfHits.set("b", { memoryEntryId: "b", rrfScore: 0.02, entry: entryB, source: "fts" as const });

      const weights = new Map();
      weights.set("a", weightA);
      weights.set("b", weightB);

      const scored = engine.rerank(rrfHits, weights, "/conv/1");

      expect(scored[0].memoryEntryId).toBe("a");
      expect(scored[1].memoryEntryId).toBe("b");
    });

    it("权重缺失时使用默认值", () => {
      const engine = new SearchEngine(defaultConfig);
      const now = new Date().toISOString();
      const entry = makeEntry({ id: "a", createdAt: now });

      const rrfHits = new Map();
      rrfHits.set("a", { memoryEntryId: "a", rrfScore: 0.01, entry, source: "fts" as const });

      const scored = engine.rerank(rrfHits, new Map(), null);

      expect(scored.length).toBe(1);
      expect(scored[0].finalScore).toBeGreaterThan(0);
    });
  });
});
