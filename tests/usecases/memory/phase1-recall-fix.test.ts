/**
 * F20260902rcp1 单测：分词双写 + 词典词查询 + 半衰期分层 + 层配额
 */
import { describe, it, expect } from "vitest";
import { tokenizeWithJieba, tokenizeQuery } from "@frameworks/db/jieba-tokenizer";
import { SearchEngine } from "@usecases/memory/search-engine";
import type { SearchEngineConfig } from "@usecases/memory/search-engine";
import type { MemoryEntry } from "@entities/memory/memory-entry";

const CONFIG: SearchEngineConfig = {
  rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2,
  weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90,
  userFlagMultiplier: 2, frequencyBoostFactor: 0.1,
};

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "e1", layer: "working", contentType: "feature", sourceId: "F1", sourceTable: "features",
    conversationId: null, granularity: "fine", content: "x", metadata: null,
    createdAt: new Date(Date.now() - 8 * 86400_000).toISOString(), // 8 天前
    ...overrides,
  };
}

describe("F20260902rcp1 分词双写", () => {
  it("双写模式含词典词和单字两份", () => {
    const out = tokenizeWithJieba("健康面板五维雷达", { doubleWrite: true });
    // 词典词段（HMM）+ 单字段都在
    expect(out).toMatch(/健康/);
    expect(out).toMatch(/健/);
    expect(out.split(/\s+/).filter(t => t === "健康").length).toBeGreaterThanOrEqual(1);
    expect(out.split(/\s+/).filter(t => t === "健").length).toBeGreaterThanOrEqual(1);
  });

  it("非双写模式（默认）产出词典词序列", () => {
    const out = tokenizeWithJieba("健康面板五维雷达");
    expect(out.split(" ")).toContain("健康");
    expect(out.split(" ")).toContain("面板");
  });

  it("查询侧产出词典词（非单字）", () => {
    const tokens = tokenizeQuery("健康面板的架构");
    expect(tokens).toContain("健康");
    expect(tokens).not.toContain("的"); // 停用词过滤
    // 词典词存在则不应退化为纯单字
    expect(tokens.some(t => t.length >= 2)).toBe(true);
  });

  it("英文与文档 ID 不受影响", () => {
    const tokens = tokenizeQuery("F20260829hviz health-panel");
    expect(tokens.some(t => t.includes("F20260829hviz") || t.includes("health"))).toBe(true);
  });
});

describe("F20260902rcp1 半衰期分层", () => {
  it("document 层用 90 天半衰期（8 天前 feature 衰减≈0.94）", () => {
    const e = new SearchEngine(CONFIG);
    const decay = e.computeTimeDecayPublic(new Date(Date.now() - 8 * 86400_000).toISOString(), 90);
    expect(decay).toBeGreaterThan(0.9);
  });

  it("默认半衰期 7 天（8 天前 ≈0.52）", () => {
    const e = new SearchEngine(CONFIG);
    const decay = e.computeTimeDecayPublic(new Date(Date.now() - 8 * 86400_000).toISOString());
    expect(decay).toBeLessThan(0.6);
    expect(decay).toBeGreaterThan(0.4);
  });

  it("rerank：同年龄 feature 得分高于 message（半衰期差）", () => {
    const engine = new SearchEngine(CONFIG);
    const feat = makeEntry({ id: "feat", contentType: "feature" });
    const msg = makeEntry({ id: "msg", contentType: "message" });
    const hits = new Map([
      ["feat", { entryId: "feat", rrfScore: 0.01, source: "fts" as const, entry: feat }],
      ["msg", { entryId: "msg", rrfScore: 0.01, source: "fts" as const, entry: msg }],
    ]);
    const scored = engine.rerank(hits, new Map());
    const byId = new Map(scored.map(s => [s.entryId, s]));
    expect(byId.get("feat")!.finalScore).toBeGreaterThan(byId.get("msg")!.finalScore);
  });

  it("rerank：feature_chunk 也享受 document 半衰期", () => {
    const engine = new SearchEngine(CONFIG);
    const chunk = makeEntry({ id: "chunk", contentType: "feature_chunk", createdAt: new Date(Date.now() - 30 * 86400_000).toISOString() });
    const scored = engine.rerank(
      new Map([["chunk", { entryId: "chunk", rrfScore: 0.01, source: "fts" as const, entry: chunk }]]),
      new Map(),
    );
    // 30 天 / 90 天半衰期 ≈ 0.79（7 天半衰期只有 0.05）
    expect(scored[0].finalScore).toBeGreaterThan(0.01 * 0.7);
  });
});
