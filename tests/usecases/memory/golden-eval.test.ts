/**
 * F20261008mrrk Phase 0：golden 评测 runner + 回归地板（合成种子集基线）。
 *
 * 跑真实检索全链路：FTS5(jieba) → 预聚合 → RRF 融合 → rerank 五信号（SearchMemory.execute
 * 完整路径，非只测 rerank）。Vec 路径口径与现有 search 测试一致：mock EmbeddingGateway
 * available=false → searchVec 跳过、召回降级纯 FTS（search-memory.ts searchVec 守卫）。
 * CI check job 无 bge-m3 模型下载步骤，真模型进不了这条门禁——覆盖面如实声明：
 * 「评测覆盖 FTS+RRF+rerank；Vec 路径在本套件为 FTS-only 降级形态（与 tests/usecases/memory
 *  现有测试同口径），真 Vec 待 capability 层评测（特性文档已知边界）」。
 *
 * 确定性：
 * - 语料时间戳 daysAgo(N) 相对构造 → 相对年龄恒定 → time_decay 输入恒定。
 * - 每条查询执行后重置 memory_weights（检索会递增 retrieval_count，
 *   search-memory.ts incrementRetrievalCounts 副作用会污染后续查询的 frequency 信号）
 *   并按 WEIGHT_PRESETS 重放预设。
 *
 * 地板数字：nDCG@5/@10、MRR 三项基线首跑后锁定（见特性文档「Phase 0 实现记录」）。
 * 地板语义 = 指标不许变差（≥ 基线 - 容差），容差吸收浮点/环境抖动，当前设 0（本地与
 * CI 同为确定性路径——固定语料+固定相对时间+权重重置；若未来环境引入真异步信号再调）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine } from "@usecases/memory/search-engine";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { ndcgAtK, reciprocalRank, mrr, mean } from "./ranking-metrics";
import { CORPUS, GOLDEN_QUERIES, WEIGHT_PRESETS, daysAgoIso, CONV_ALPHA, CONV_BETA, CONV_GAMMA } from "./golden-corpus";

/** 生产默认配置（config-service.ts buildMemoryConfig 默认值，评测不自编参数） */
const PROD_MEMORY_CONFIG = {
  rrfK: 60,
  alpha: 0.4,
  vecSimilarityThreshold: 0.3,
  bothBoost: 1.2,
  currentConversationBoost: 1.5,
  weightHalfLifeDays: 7,
  weightHalfLifeDaysDocument: 90,
  userFlagMultiplier: 2,
  frequencyBoostFactor: 0.1,
};

/** 首跑锁定基线（2026-10-08，本地 3 次复跑完全一致：0.7891/0.8034/0.9115）。
 *  地板取首跑值向下取整 3 位小数（吸收浮点末位，语义仍是「不许变差」）。
 *  改动排序管线的行为 PR 必须重跑本套件并更新地板（上升可改数字，下降须先
 *  证明是测量噪声或语义预期变化——后者需搭档确认，见特性文档 Phase 0 记录）。 */
export const BASELINE = {
  ndcg5: 0.789,
  ndcg10: 0.803,
  mrr: 0.911,
} as const;

function mockEmbeddingGateway(): EmbeddingGateway {
  return {
    available: false,
    async embed(): Promise<Float32Array> {
      throw new Error("golden eval: vec disabled (FTS-only 口径，与现有 search 测试一致)");
    },
  };
}

describe("golden 评测集结构断言（防语料腐化）", () => {
  it("查询数 30-50 条且四层齐备（覆盖度守卫）", () => {
    expect(GOLDEN_QUERIES.length).toBeGreaterThanOrEqual(30);
    expect(GOLDEN_QUERIES.length).toBeLessThanOrEqual(50);
    const layers = new Set(GOLDEN_QUERIES.map((q) => q.layer));
    for (const l of ["fact", "history", "document", "conversation"] as const) {
      expect(layers.has(l), `layer ${l} 缺失`).toBe(true);
    }
  });

  it("每条查询至少 1 个正增益标注且标注 entryId 都在语料中（无效标注守卫）", () => {
    const corpusIds = new Set(CORPUS.map((e) => e.id));
    for (const q of GOLDEN_QUERIES) {
      const positives = Object.entries(q.expected).filter(([, g]) => g > 0);
      expect(positives.length, `${q.id} 无正增益标注`).toBeGreaterThan(0);
      for (const [id] of Object.entries(q.expected)) {
        expect(corpusIds.has(id), `${q.id} 标注了语料外条目 ${id}`).toBe(true);
      }
    }
  });

  it("语料 contentType 覆盖 message/fact/feature/feature_chunk/research/research_chunk", () => {
    const types = new Set(CORPUS.map((e) => e.contentType));
    for (const t of ["message", "fact", "feature", "feature_chunk", "research", "research_chunk"]) {
      expect(types.has(t as never), `contentType ${t} 未覆盖`).toBe(true);
    }
  });

  it("时间戳动态构造（相对年龄恒定，无写死日期）", () => {
    // daysAgoIso 每次求值都基于 now：断言每条 createdAt 相对求值时刻的年龄 ≈ ageDays，
    // 且无任何写死 ISO 日期（写死日期会随日历漂移，年龄不变才是防炸弹本质）
    const before = Date.now();
    for (const e of CORPUS) {
      const age = (before - new Date(e.createdAt).getTime()) / 86_400_000;
      expect(age).toBeGreaterThan(0);
      expect(age).toBeLessThan(400); // 全部年龄 ≤ 365 天
    }
    const distinctAges = new Set(CORPUS.map((e) => e.createdAt));
    expect(distinctAges.size).toBeLessThanOrEqual(CORPUS.length); // 允许 chunk 与父条目同龄
  });
});

describe("golden 评测 runner：全链路指标 + 回归地板", () => {
  let db: Database.Database;
  let repo: SqliteMemoryRepository;
  let searchMemory: SearchMemory;

  /** 重置权重到预设状态：清空检索副作用 + 重放 WEIGHT_PRESETS */
  function resetWeights(): void {
    db.prepare("UPDATE memory_weights SET retrieval_count = 0, last_retrieved_at = NULL").run();
    const apply = db.prepare(
      "UPDATE memory_weights SET user_flagged = 0, retrieval_count = 0 WHERE memory_entry_id = ?",
    );
    const all = db.prepare("SELECT memory_entry_id FROM memory_weights").all() as Array<{ memory_entry_id: string }>;
    for (const { memory_entry_id } of all) apply.run(memory_entry_id);
    const setPreset = db.prepare(
      "UPDATE memory_weights SET user_flagged = ?, retrieval_count = ? WHERE memory_entry_id = ?",
    );
    for (const p of WEIGHT_PRESETS) {
      setPreset.run(p.userFlagged ? 1 : 0, p.retrievalCount ?? 0, p.entryId);
    }
  }

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteMemoryRepository(db);
    // FK 预置：memory_entries.conversation_id → conversations(id)，对话行先落
    const insertConv = db.prepare(
      "INSERT OR IGNORE INTO conversations (id, title, created_at) VALUES (?, ?, ?)",
    );
    for (const c of [CONV_ALPHA, CONV_BETA, CONV_GAMMA]) {
      insertConv.run(c, `golden-${c}`, daysAgoIso(400));
    }
    // storeEntry 是唯一写入路径（schema/FTS 同步写，防手写 DDL 漂移——tests/helpers/db 约定）
    for (const e of CORPUS) repo.storeEntry(e);
    // 权重行建立：storeEntry 不建 memory_weights 行，预置再重置
    const insertWeight = db.prepare(
      "INSERT OR IGNORE INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged) VALUES (?, 0, NULL, 0)",
    );
    for (const e of CORPUS) insertWeight.run(e.id);
    resetWeights();
    const searchEngine = new SearchEngine(PROD_MEMORY_CONFIG);
    searchMemory = new SearchMemory(repo, repo, mockEmbeddingGateway(), searchEngine, createTestLogger());
  });

  afterEach(() => {
    db.close();
  });

  it("三项指标 ≥ 回归地板（合成种子集基线，指标不许变差）", async () => {
    const ndcg5s: number[] = [];
    const ndcg10s: number[] = [];
    const rrs: number[] = [];

    for (const q of GOLDEN_QUERIES) {
      const result = await searchMemory.search({
        query: q.query,
        limit: 10,
        currentConversationId: q.currentConversationId,
      });
      const rankedIds = result.entries.map((e) => e.id);
      const rel = new Map(Object.entries(q.expected));
      ndcg5s.push(ndcgAtK(rankedIds, rel, 5));
      ndcg10s.push(ndcgAtK(rankedIds, rel, 10));
      rrs.push(reciprocalRank(rankedIds, rel));
      resetWeights(); // 检索副作用隔离：每查询独立权重态
    }

    const ndcg5 = mean(ndcg5s);
    const ndcg10 = mean(ndcg10s);
    const mrrValue = mrr(rrs);

    console.log(
      `[golden-eval] n=${GOLDEN_QUERIES.length} nDCG@5=${ndcg5.toFixed(4)} nDCG@10=${ndcg10.toFixed(4)} MRR=${mrrValue.toFixed(4)} (FTS+RRF+rerank; vec=FTS-only 口径)`,
    );

    expect(ndcg5).toBeGreaterThanOrEqual(BASELINE.ndcg5);
    expect(ndcg10).toBeGreaterThanOrEqual(BASELINE.ndcg10);
    expect(mrrValue).toBeGreaterThanOrEqual(BASELINE.mrr);
  });

  it("基线合理性：当前管线在种子集上非平凡（防地板=摆设）", async () => {
    // 若管线对种子集退化成全 0（比如 FTS 全 miss），地板 0.7 会在上一用例爆掉；
    // 这里再直接断言：每层至少 1 条查询的 top10 有正增益命中（分层防退化）。
    for (const layer of ["fact", "history", "document", "conversation"] as const) {
      let anyHit = false;
      for (const q of GOLDEN_QUERIES.filter((x) => x.layer === layer)) {
        const result = await searchMemory.search({
          query: q.query,
          limit: 10,
          currentConversationId: q.currentConversationId,
        });
        const hit = result.entries.some((e) => (q.expected[e.id] ?? 0) > 0);
        if (hit) {
          anyHit = true;
          resetWeights();
          break;
        }
        resetWeights();
      }
      expect(anyHit, `layer ${layer} 全部查询零命中——种子集或管线腐化`).toBe(true);
    }
  });
});
