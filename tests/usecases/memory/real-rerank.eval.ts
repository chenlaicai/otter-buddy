/**
 * 真实查询 rerank 对比台架。
 *
 * 输入为数据库副本；抽样、检索计数副作用和原始上下文均留在调用方指定的工作目录。
 * export 模式生成乱序盲标池与私有排序快照；score 模式只读标注和排序快照计算指标。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { initDatabase } from "@frameworks/db/database";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SqliteTerminologyRepository } from "@frameworks/db/memory/sqlite-terminology-repository";
import { initEmbeddingService } from "@frameworks/embedding/embedding-init";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine, type SearchEngineConfig } from "@usecases/memory/search-engine";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { Logger } from "@usecases/ports/logger";
import { ndcgAtK, reciprocalRank, mrr, mean } from "./ranking-metrics";

const SAMPLE_SIZE = 20;
const POOL_K = 10;
const RECENT_FROM = "2026-11-01T00:00:00Z";
const ANCHOR_QUERY = /(?:^|[^\w])[FR]\d{8}-?[a-z0-9]{4,10}(?:[^\w]|$)/i;

const BASE_CONFIG = {
  rrfK: 60,
  alpha: 0.4,
  vecSimilarityThreshold: 0.3,
  bothBoost: 1.2,
  currentConversationBoost: 1.5,
  weightHalfLifeDays: 7,
  weightHalfLifeDaysDocument: 90,
  userFlagMultiplier: 2,
  frequencyBoostFactor: 0.1,
  rerank: {
    wRrf: 0.6,
    wTime: 0.3,
    wFreq: 0.1,
    bUserFlag: 0.05,
    bConv: 0.05,
    freqCap: 10,
  },
} satisfies Partial<SearchEngineConfig>;

const logger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => logger,
};

interface QueryLog {
  queryId: string;
  query: string;
  conversationId: string;
  createdAt: string;
  detailLevel: "summary" | "snippet" | "full";
  context: unknown[];
}

interface RankedEntry {
  id: string;
  contentType: string;
  sourceId: string;
  createdAt: string;
  content: string;
}

interface QueryRun {
  query: QueryLog;
  multiply: string[];
  additive: string[];
  candidates: RankedEntry[];
}

interface LabelRow {
  queryId: string;
  grades: Record<string, number>;
  notes?: string;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function loadQueryLogs(db: Database.Database): QueryLog[] {
  const rows = db.prepare(`
    SELECT id, query, conversation_id, created_at, detail_level, context_messages
    FROM search_query_logs
    WHERE created_at >= ? AND total >= 5 AND library IS NULL
    ORDER BY created_at
  `).all(RECENT_FROM) as Array<Record<string, unknown>>;
  const seenQueries = new Set<string>();
  const conversationCounts = new Map<string, number>();
  const eligible = rows.filter((row) => {
    const query = String(row.query);
    const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
    const conversationId = String(row.conversation_id);
    if (ANCHOR_QUERY.test(query) || seenQueries.has(normalized)) return false;
    if ((conversationCounts.get(conversationId) ?? 0) >= 2) return false;
    seenQueries.add(normalized);
    conversationCounts.set(conversationId, (conversationCounts.get(conversationId) ?? 0) + 1);
    return true;
  });
  // 哈希排序提供固定但非时间/主题聚集的样本；每对话最多两条，防单线任务淹没全集。
  return eligible.map((row) => ({
    queryId: String(row.id),
    query: String(row.query),
    conversationId: String(row.conversation_id),
    createdAt: String(row.created_at),
    detailLevel: String(row.detail_level) as QueryLog["detailLevel"],
    context: JSON.parse(String(row.context_messages)) as unknown[],
  })).sort((a, b) => hash(a.queryId).localeCompare(hash(b.queryId)));
}

function ftsOnlyEmbedding(): EmbeddingGateway {
  return {
    available: false,
    async embed(): Promise<Float32Array> {
      throw new Error("offline rerank eval: FTS-only");
    },
  };
}

async function createEmbedding(): Promise<{ gateway: EmbeddingGateway; dispose: () => void }> {
  if (process.env.OTTER_REAL_EVAL_VEC !== "1") return { gateway: ftsOnlyEmbedding(), dispose: () => {} };
  const root = path.resolve(process.cwd());
  const services = await initEmbeddingService({
    modelPath: "bge-m3",
    localModelPath: env("OTTER_REAL_EVAL_MODELS"),
    workerPath: path.join(root, "dist/src/frameworks/embedding/bge-m3-worker.js"),
    workerExecArgv: [],
  }, logger);
  services.backfillService.dispose();
  return { gateway: services.liveService, dispose: services.dispose };
}

function createSearch(repo: SqliteMemoryRepository, terminology: SqliteTerminologyRepository,
  embedding: EmbeddingGateway, mode: "multiply" | "additive"): SearchMemory {
  return new SearchMemory(
    repo,
    repo,
    embedding,
    new SearchEngine({ ...BASE_CONFIG, rerankMode: mode } as SearchEngineConfig),
    logger,
    terminology,
  );
}

function restoreWeights(db: Database.Database, ids: string[], initial: Map<string, { count: number; at: string | null }>): void {
  const update = db.prepare(
    "UPDATE memory_weights SET retrieval_count = ?, last_retrieved_at = ? WHERE memory_entry_id = ?",
  );
  for (const id of ids) {
    const weight = initial.get(id);
    if (weight) update.run(weight.count, weight.at, id);
  }
}

async function exportRuns(db: Database.Database, outputDir: string): Promise<void> {
  const repo = new SqliteMemoryRepository(db);
  const terminology = new SqliteTerminologyRepository(db);
  const embedding = await createEmbedding();
  const sampleFrom = process.env.OTTER_REAL_EVAL_SAMPLE_FROM;
  let queries = loadQueryLogs(db);
  if (sampleFrom) {
    const sample = JSON.parse(fs.readFileSync(sampleFrom, "utf8")) as { runs: QueryRun[] };
    const byId = new Map(queries.map((query) => [query.queryId, query]));
    queries = sample.runs.map((run) => {
      const query = byId.get(run.query.queryId);
      if (!query) throw new Error(`sample query not eligible: ${run.query.queryId}`);
      return query;
    });
  }
  expect(queries.length).toBeGreaterThanOrEqual(SAMPLE_SIZE);
  const initialRows = db.prepare(
    "SELECT memory_entry_id, retrieval_count, last_retrieved_at FROM memory_weights",
  ).all() as Array<{ memory_entry_id: string; retrieval_count: number; last_retrieved_at: string | null }>;
  const initial = new Map(initialRows.map((row) => [row.memory_entry_id, {
    count: row.retrieval_count,
    at: row.last_retrieved_at,
  }]));
  const runs: QueryRun[] = [];
  try {
    for (const query of queries) {
      if (runs.length >= SAMPLE_SIZE) break;
      const ranked: Record<"multiply" | "additive", string[]> = { multiply: [], additive: [] };
      const candidateMap = new Map<string, RankedEntry>();
      for (const mode of ["multiply", "additive"] as const) {
        const result = await createSearch(repo, terminology, embedding.gateway, mode).search({
          query: query.query,
          limit: POOL_K,
          detailLevel: "full",
          currentConversationId: query.conversationId,
        });
        ranked[mode] = result.entries.map((entry) => entry.id);
        restoreWeights(db, ranked[mode], initial);
        for (const entry of result.entries) {
          candidateMap.set(entry.id, {
            id: entry.id,
            contentType: entry.contentType,
            sourceId: entry.sourceId,
            createdAt: entry.createdAt,
            content: entry.content,
          });
        }
      }
      // 候选顺序不含算法来源与分数，避免标注者被当前排序锚定。
      const candidates = Array.from(candidateMap.values())
        .sort((a, b) => hash(`${query.queryId}:${a.id}`).localeCompare(hash(`${query.queryId}:${b.id}`)));
      // 当前快照只有 0/1 个候选时无排序可比较；在盲标前剔除并按固定哈希序补样。
      if (!sampleFrom && candidates.length < 2) continue;
      runs.push({ query, ...ranked, candidates });
    }
  } finally {
    embedding.dispose();
  }
  expect(runs).toHaveLength(SAMPLE_SIZE);
  fs.writeFileSync(path.join(outputDir, "runs.json"), JSON.stringify({
    protocol: { sampleSize: SAMPLE_SIZE, poolK: POOL_K, recentFrom: RECENT_FROM, vec: process.env.OTTER_REAL_EVAL_VEC === "1" },
    runs,
  }, null, 2));
  const blindPools = runs.map((run) => ({ query: run.query, candidates: run.candidates }));
  fs.writeFileSync(path.join(outputDir, "blind-pools.json"), JSON.stringify(blindPools, null, 2));
  console.log(`[real-rerank] exported ${runs.length} queries / ${runs.reduce((n, r) => n + r.candidates.length, 0)} labels to ${outputDir}`);
}

function scoreRuns(outputDir: string): void {
  const payload = JSON.parse(fs.readFileSync(path.join(outputDir, "runs.json"), "utf8")) as { runs: QueryRun[] };
  const labels = JSON.parse(fs.readFileSync(path.join(outputDir, "labels.json"), "utf8")) as LabelRow[];
  const labelMap = new Map(labels.map((row) => [row.queryId, row]));
  expect(labels).toHaveLength(SAMPLE_SIZE);
  const scores = { multiply: { ndcg5: [] as number[], ndcg10: [] as number[], rr: [] as number[] },
    additive: { ndcg5: [] as number[], ndcg10: [] as number[], rr: [] as number[] } };
  const perQuery: unknown[] = [];
  for (const run of payload.runs) {
    const label = labelMap.get(run.query.queryId);
    expect(label, `missing labels for ${run.query.queryId}`).toBeDefined();
    const candidateIds = new Set(run.candidates.map((entry) => entry.id));
    for (const id of candidateIds) expect(label!.grades[id], `unlabeled ${run.query.queryId}/${id}`).toBeDefined();
    for (const [id, grade] of Object.entries(label!.grades)) {
      expect(candidateIds.has(id), `label outside pool ${id}`).toBe(true);
      expect(Number.isInteger(grade) && grade >= 0 && grade <= 3, `invalid grade ${id}`).toBe(true);
    }
    const relevance = new Map(Object.entries(label!.grades));
    const row: Record<string, unknown> = { queryId: run.query.queryId, query: run.query.query };
    for (const mode of ["multiply", "additive"] as const) {
      const ranked = run[mode];
      const ndcg5 = ndcgAtK(ranked, relevance, 5);
      const ndcg10 = ndcgAtK(ranked, relevance, 10);
      const rr = reciprocalRank(ranked, relevance);
      scores[mode].ndcg5.push(ndcg5);
      scores[mode].ndcg10.push(ndcg10);
      scores[mode].rr.push(rr);
      row[mode] = { ndcg5, ndcg10, rr };
    }
    perQuery.push(row);
  }
  const result = Object.fromEntries(["multiply", "additive"].map((mode) => {
    const value = scores[mode as "multiply" | "additive"];
    return [mode, { ndcg5: mean(value.ndcg5), ndcg10: mean(value.ndcg10), mrr: mrr(value.rr) }];
  }));
  fs.writeFileSync(path.join(outputDir, "metrics.json"), JSON.stringify({ summary: result, perQuery }, null, 2));
  console.log(`[real-rerank] ${JSON.stringify(result)}`);
}

describe("real query rerank evaluation", () => {
  it("exports blind pools or scores completed labels", { timeout: 300_000 }, async () => {
    const outputDir = env("OTTER_REAL_EVAL_OUT");
    fs.mkdirSync(outputDir, { recursive: true });
    if (process.env.OTTER_REAL_EVAL_MODE === "score") {
      scoreRuns(outputDir);
      return;
    }
    const db = initDatabase({ path: env("OTTER_REAL_EVAL_DB"), walMode: false }, logger);
    try {
      await exportRuns(db, outputDir);
    } finally {
      db.close();
    }
  });
});
