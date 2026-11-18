/**
 * F20261112rnkph Phase 1 段 3：合成集网格标定 + 逐信号反事实表（不切默认）。
 *
 * 本文件不是回归测试（不进 npm test 默认套件，扩展名非 .test.ts），由 `npm run eval:grid`
 * 显式执行。复用 golden-corpus（44 查询/50 语料）+ ranking-metrics，与 golden-eval 同口径
 * （FTS+RRF+rerank；Vec 路径 FTS-only 降级，见 golden-eval.test.ts 头部声明）。
 *
 * 产出：
 * - 逐信号反事实表（multiply 生产默认 / additive 全开 / 全中性 / 逐单关 × 三项指标）
 * - 网格搜索结果全集 → data/metrics/golden-grid-results.jsonl
 * - 候选系数矩阵（选择准则见 F20261112rnkph 第 5 节：三项均不劣于地板，取 nDCG@5 最高，
 *   并列取参数更少偏离默认）
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine } from "@usecases/memory/search-engine";
import type { RerankWeights } from "@usecases/memory/search-engine";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { ndcgAtK, reciprocalRank, mrr, mean } from "./ranking-metrics";
import {
  CORPUS,
  GOLDEN_QUERIES,
  WEIGHT_PRESETS,
  daysAgoIso,
  CONV_ALPHA,
  CONV_BETA,
  CONV_GAMMA,
} from "./golden-corpus";

function mockEmbeddingGateway(): EmbeddingGateway {
  return {
    available: false,
    async embed(): Promise<Float32Array> {
      throw new Error("golden grid: vec disabled (FTS-only 口径，与 golden-eval 一致)");
    },
  };
}

/** 三项指标 */
interface MetricResult {
  ndcg5: number;
  ndcg10: number;
  mrr: number;
}

/** 地板（golden-eval BASELINE，向下取整 3 位，见 F20261008mrrk） */
const FLOOR = { ndcg5: 0.673, ndcg10: 0.707, mrr: 0.811 } as const;

/** 设计回填默认系数（段 1 已入配置缺省） */
const DEFAULT_ADDITIVE: RerankWeights = { wRrf: 0.6, wTime: 0.3, wFreq: 0.1, bUserFlag: 0.05, bConv: 0.05, freqCap: 10 };

const PROD_MULTIPLY_CONFIG = {
  rrfK: 60,
  alpha: 0.4,
  vecSimilarityThreshold: 0.3,
  bothBoost: 1.2,
  currentConversationBoost: 1.5,
  weightHalfLifeDays: 7,
  weightHalfLifeDaysDocument: 90,
  userFlagMultiplier: 2,
  frequencyBoostFactor: 0.1,
  rerankMode: "multiply" as const,
  rerank: { ...DEFAULT_ADDITIVE },
};

describe("golden grid + 反事实（段 3 标定，不切默认）", () => {
  it("逐信号反事实表 + 网格候选矩阵", { timeout: 300_000 }, async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);

    // FK 预置 + 语料 + 权重行（与 golden-eval.test.ts beforeEach 同构）
    const insertConv = db.prepare(
      "INSERT OR IGNORE INTO conversations (id, title, created_at) VALUES (?, ?, ?)",
    );
    for (const c of [CONV_ALPHA, CONV_BETA, CONV_GAMMA]) insertConv.run(c, `golden-${c}`, daysAgoIso(400));
    for (const e of CORPUS) repo.storeEntry(e);
    const insertWeight = db.prepare(
      "INSERT OR IGNORE INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged) VALUES (?, 0, NULL, 0)",
    );
    for (const e of CORPUS) insertWeight.run(e.id);

    function resetWeights(): void {
      db.prepare("UPDATE memory_weights SET user_flagged = 0, retrieval_count = 0, last_retrieved_at = NULL").run();
      const setPreset = db.prepare(
        "UPDATE memory_weights SET user_flagged = ?, retrieval_count = ? WHERE memory_entry_id = ?",
      );
      for (const p of WEIGHT_PRESETS) setPreset.run(p.userFlagged ? 1 : 0, p.retrievalCount ?? 0, p.entryId);
    }

    async function runConfig(engineConfig: Record<string, unknown>): Promise<MetricResult> {
      const engine = new SearchEngine(engineConfig as never);
      const sm = new SearchMemory(repo, repo, mockEmbeddingGateway(), engine, createTestLogger());
      const ndcg5s: number[] = [];
      const ndcg10s: number[] = [];
      const rrs: number[] = [];
      for (const q of GOLDEN_QUERIES) {
        const result = await sm.search({
          query: q.query,
          limit: 10,
          currentConversationId: q.currentConversationId,
        });
        const rankedIds = result.entries.map((e) => e.id);
        const rel = new Map(Object.entries(q.expected));
        ndcg5s.push(ndcgAtK(rankedIds, rel, 5));
        ndcg10s.push(ndcgAtK(rankedIds, rel, 10));
        rrs.push(reciprocalRank(rankedIds, rel));
        resetWeights();
      }
      return { ndcg5: mean(ndcg5s), ndcg10: mean(ndcg10s), mrr: mrr(rrs) };
    }

    // ── A. 逐信号反事实表 ──────────────────────────────────────────────
    const additiveBase = (overrides: Partial<RerankWeights> = {}) => ({
      ...PROD_MULTIPLY_CONFIG,
      rerankMode: "additive",
      rerank: { ...DEFAULT_ADDITIVE, ...overrides },
    });
    const counterfactuals: Array<{ name: string; config: Record<string, unknown> }> = [
      { name: "multiply 生产默认（全开）", config: { ...PROD_MULTIPLY_CONFIG } },
      { name: "additive 全开（设计回填）", config: additiveBase() },
      { name: "additive 全中性（w_rrf=1 其余 0）", config: additiveBase({ wRrf: 1, wTime: 0, wFreq: 0, bUserFlag: 0, bConv: 0 }) },
      { name: "additive 关 rrf", config: additiveBase({ wRrf: 0 }) },
      { name: "additive 关 time", config: additiveBase({ wTime: 0 }) },
      { name: "additive 关 freq", config: additiveBase({ wFreq: 0 }) },
      { name: "additive 关 flag", config: additiveBase({ bUserFlag: 0 }) },
      { name: "additive 关 conv", config: additiveBase({ bConv: 0 }) },
    ];
    const cfRows: Array<{ name: string } & MetricResult> = [];
    console.log("\n=== 逐信号反事实表（n=44，FTS-only 口径）===");
    for (const cf of counterfactuals) {
      const m = await runConfig(cf.config);
      cfRows.push({ name: cf.name, ...m });
      console.log(
        `${cf.name}\t nDCG@5=${m.ndcg5.toFixed(4)}\t nDCG@10=${m.ndcg10.toFixed(4)}\t MRR=${m.mrr.toFixed(4)}`,
      );
    }

    // ── B. 网格搜索 ──────────────────────────────────────────────────
    const wRrfSpace = [0.4, 0.5, 0.6, 0.7, 0.8];
    const wTimeSpace = [0, 0.1, 0.2, 0.3, 0.4];
    const biasSpace = [0, 0.02, 0.05, 0.1];
    const grid: Array<{ wRrf: number; wTime: number; wFreq: number; bFlag: number; bConv: number } & MetricResult> = [];

    for (const wRrf of wRrfSpace) {
      for (const wTime of wTimeSpace) {
        const wFreq = Number((1 - wRrf - wTime).toFixed(10));
        if (wFreq < 0) continue;
        for (const bFlag of biasSpace) {
          for (const bConv of biasSpace) {
            const m = await runConfig(
              additiveBase({ wRrf, wTime, wFreq, bUserFlag: bFlag, bConv }),
            );
            grid.push({ wRrf, wTime, wFreq, bFlag, bConv, ...m });
          }
        }
      }
    }

    // 选择准则：三项均不劣于地板 → nDCG@5 最高 → 并列取参数更少偏离默认（更保守）
    const eligible = grid.filter(
      (r) => r.ndcg5 >= FLOOR.ndcg5 && r.ndcg10 >= FLOOR.ndcg10 && r.mrr >= FLOOR.mrr,
    );
    const distanceFromDefault = (r: (typeof grid)[number]) =>
      Math.abs(r.wRrf - DEFAULT_ADDITIVE.wRrf)
      + Math.abs(r.wTime - DEFAULT_ADDITIVE.wTime)
      + Math.abs(r.wFreq - DEFAULT_ADDITIVE.wFreq)
      + Math.abs(r.bFlag - DEFAULT_ADDITIVE.bUserFlag)
      + Math.abs(r.bConv - DEFAULT_ADDITIVE.bConv);
    const ranked = [...eligible].sort(
      (a, b) => b.ndcg5 - a.ndcg5 || distanceFromDefault(a) - distanceFromDefault(b),
    );
    const candidate = ranked[0];

    console.log(`\n=== 网格搜索（${grid.length} 个合法组合，达标 ${eligible.length} 个）===`);
    console.log("候选矩阵（前三）：");
    for (const r of ranked.slice(0, 3)) {
      console.log(
        `w_rrf=${r.wRrf} w_time=${r.wTime} w_freq=${r.wFreq} b_flag=${r.bFlag} b_conv=${r.bConv}`
        + ` → nDCG@5=${r.ndcg5.toFixed(4)} nDCG@10=${r.ndcg10.toFixed(4)} MRR=${r.mrr.toFixed(4)}`,
      );
    }

    // 写结果文件（审计 + 检视獭可复跑）
    const outPath = path.join(process.cwd(), "data", "metrics", "golden-grid-results.jsonl");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, grid.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    console.log(`\n网格结果已写: ${outPath}（${grid.length} 行）`);

    // ── 断言（eval 自检，不弱化）───────────────────────────────────
    expect(counterfactuals.length).toBe(8);
    expect(grid.length).toBeGreaterThan(300);
    expect(candidate, "网格应存在三项均不劣于地板的组合").toBeDefined();
    expect(candidate.ndcg5).toBeGreaterThanOrEqual(FLOOR.ndcg5);
    expect(candidate.ndcg10).toBeGreaterThanOrEqual(FLOOR.ndcg10);
    expect(candidate.mrr).toBeGreaterThanOrEqual(FLOOR.mrr);

    db.close();
  });
});
