/**
 * 真实 bge-m3 验证：默认跑 120 chunk drain + live 并发；--benchmark 跑 fp32/Q8 对照。
 * 所有语料来自本仓 Markdown，经生产 chunk/清洗路径；模型只读主仓或 os.tmpdir()。
 */
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { initEmbeddingService } from "../dist/src/frameworks/embedding/embedding-init.js";
import { estimateTokens } from "../dist/src/frameworks/embedding/embed-batch-sharding.js";
import { initSchema } from "../dist/src/frameworks/db/schema.js";
import { SqliteMemoryRepository } from "../dist/src/frameworks/db/memory/sqlite-memory-repository.js";
import { EmbeddingRetryWorker } from "../dist/src/usecases/memory/embedding-retry-worker.js";
import { StoreMemory } from "../dist/src/usecases/memory/store-memory.js";
import { chunkMarkdown } from "../dist/src/usecases/document/markdown-chunker.js";
import { cleanMarkdownForFts } from "../dist/src/usecases/document/markdown-noise-cleaner.js";
import { parseFrontmatterFromContent } from "../dist/src/usecases/document/frontmatter-parse.js";

const MAIN_ROOT = "/Users/orca/ai/otter-buddy";
const WORKTREE_ROOT = process.cwd();
const Q8_ROOT = process.env.OTTER_EMBED_Q8_ROOT ?? path.join(os.tmpdir(), "otter-buddy-embed-root-cure-q8");
const Q8_SIZE = 569_694_530;
const logger = {
  info: (...a) => console.log("[info]", ...a),
  warn: (...a) => console.warn("[warn]", ...a),
  error: (...a) => console.error("[error]", ...a),
  debug: () => {},
  child() { return this; },
};

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
  });
}

/** 确定性抽样：先按路径/hash 排序，再等距取样，避免最近文档或长文档垄断分布。 */
function loadRealCorpus(count) {
  const roots = [path.join(WORKTREE_ROOT, "docs/features"), path.join(WORKTREE_ROOT, "docs/research")];
  const files = roots.flatMap(markdownFiles).sort();
  const chunks = [];
  for (const file of files) {
    const parsed = parseFrontmatterFromContent(fs.readFileSync(file, "utf8"));
    const title = String(parsed.frontmatter.title ?? path.basename(file, ".md"));
    for (const [index, chunk] of chunkMarkdown(parsed.content).entries()) {
      const content = cleanMarkdownForFts(chunk.content).slice(0, 6000);
      if (content.length < 300) continue;
      chunks.push({
        id: `${path.relative(WORKTREE_ROOT, file)}#${index}`,
        title,
        headingPath: chunk.headingPath,
        content,
      });
    }
  }
  chunks.sort((a, b) => a.id.localeCompare(b.id));
  if (chunks.length < count) throw new Error(`真实长 chunk 不足：${chunks.length} < ${count}`);
  const step = chunks.length / count;
  return Array.from({ length: count }, (_, index) => chunks[Math.floor(index * step)]);
}

function makeGoldenQueries(chunks, count = 50) {
  const step = chunks.length / count;
  return Array.from({ length: count }, (_, index) => {
    const relevantIndex = Math.floor(index * step);
    const chunk = chunks[relevantIndex];
    const firstSentence = chunk.content.split(/[。！？\n]/).find(line => line.trim().length >= 20)?.trim() ?? "";
    return {
      relevantIndex,
      query: `${chunk.title} ${chunk.headingPath.join(" ")} ${firstSentence}`.slice(0, 240),
    };
  });
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] * 100) / 100;
}

function distribution(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
}

async function waitReady(service, label) {
  for (let i = 0; i < 180 && !service.available; i++) await sleep(1000);
  if (!service.available) throw new Error(`${label} worker 未就绪（180s）`);
}

function ensureQ8Model() {
  const modelDir = path.join(Q8_ROOT, "bge-m3");
  const target = path.join(modelDir, "onnx/model_quantized.onnx");
  if (!fs.existsSync(target) || fs.statSync(target).size !== Q8_SIZE) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = spawnSync("curl", [
      "-sSL", "-C", "-", "--retry", "3", "--connect-timeout", "10", "--max-time", "900",
      "-o", target, "https://hf-mirror.com/Xenova/bge-m3/resolve/main/onnx/model_quantized.onnx",
    ], { stdio: "inherit" });
    if (result.status !== 0 || !fs.existsSync(target) || fs.statSync(target).size !== Q8_SIZE) {
      throw new Error("Q8 模型下载/大小校验失败");
    }
  }
  for (const name of ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]) {
    const link = path.join(modelDir, name);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(MAIN_ROOT, "models/bge-m3", name), link);
  }
  return Q8_ROOT;
}

async function createBenchmarkService(dtype) {
  process.env.OTTER_EMBED_DTYPE = dtype;
  const localModelPath = dtype === "q8" ? ensureQ8Model() : path.join(MAIN_ROOT, "models");
  const services = await initEmbeddingService({ modelPath: "bge-m3", localModelPath }, logger);
  services.liveService.dispose();
  await waitReady(services.backfillService, dtype);
  return services.backfillService;
}

async function embedTimed(service, text) {
  const startedAt = Date.now();
  const [embedding] = await service.embedBatch([text]);
  return { embedding, durationMs: Date.now() - startedAt };
}

function dot(a, b) {
  let value = 0;
  for (let i = 0; i < a.length; i++) value += a[i] * b[i];
  return value;
}

function recallAtK(chunkVectors, queryVectors, golden, k) {
  let hits = 0;
  for (let q = 0; q < queryVectors.length; q++) {
    const ranking = chunkVectors.map((vector, index) => ({ index, score: dot(queryVectors[q], vector) }))
      .sort((a, b) => b.score - a.score).slice(0, k);
    if (ranking.some(item => item.index === golden[q].relevantIndex)) hits++;
  }
  return hits / queryVectors.length;
}

async function runModelBenchmark(dtype, corpus, golden) {
  console.log(`[benchmark:${dtype}] 加载真实模型，corpus=${corpus.length}, queries=${golden.length}`);
  const service = await createBenchmarkService(dtype);
  try {
    const latencies = [];
    const chunkVectors = [];
    let tokens = 0;
    const startedAt = Date.now();
    for (const [index, chunk] of corpus.entries()) {
      const result = await embedTimed(service, chunk.content);
      chunkVectors.push(result.embedding);
      latencies.push(result.durationMs);
      tokens += estimateTokens(chunk.content);
      if ((index + 1) % 25 === 0) console.log(`[benchmark:${dtype}] corpus ${index + 1}/${corpus.length}`);
    }
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const queryVectors = [];
    for (const item of golden) queryVectors.push((await embedTimed(service, item.query)).embedding);
    return {
      dtype,
      texts: corpus.length,
      queries: golden.length,
      tokens,
      elapsedSec: Math.round(elapsedSec * 100) / 100,
      textsPerSec: Math.round(corpus.length / elapsedSec * 1000) / 1000,
      tokensPerSec: Math.round(tokens / elapsedSec * 100) / 100,
      latencyMs: distribution(latencies),
      recallAt5: recallAtK(chunkVectors, queryVectors, golden, 5),
      recallAt10: recallAtK(chunkVectors, queryVectors, golden, 10),
      stats: service.stats,
    };
  } finally {
    service.dispose();
  }
}

async function mainBenchmark() {
  const corpusCount = Number.parseInt(process.env.OTTER_EMBED_BENCH_COUNT ?? "200", 10);
  const queryCount = Number.parseInt(process.env.OTTER_EMBED_BENCH_QUERIES ?? "50", 10);
  const corpus = loadRealCorpus(corpusCount);
  const golden = makeGoldenQueries(corpus, queryCount);
  console.log(`[benchmark] 真实语料字符分布：${JSON.stringify(distribution(corpus.map(c => c.content.length)))}`);
  const fp32 = await runModelBenchmark("fp32", corpus, golden);
  const q8 = await runModelBenchmark("q8", corpus, golden);
  const result = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    corpus: {
      source: "worktree docs/features + docs/research",
      count: corpus.length,
      charLength: distribution(corpus.map(c => c.content.length)),
      goldenQueries: golden.length,
      labeling: "deterministic title+heading+first-sentence; one relevant chunk/query",
    },
    fp32,
    q8,
    recallDelta: {
      at5: Math.round((fp32.recallAt5 - q8.recallAt5) * 10000) / 10000,
      at10: Math.round((fp32.recallAt10 - q8.recallAt10) * 10000) / 10000,
    },
    decision: fp32.recallAt5 - q8.recallAt5 <= 0.02 && fp32.recallAt10 - q8.recallAt10 <= 0.02
      ? "q8-quality-pass" : "keep-fp32",
  };
  const output = process.env.OTTER_EMBED_BENCH_OUTPUT ?? path.join(os.tmpdir(), "embrc-quantization-benchmark.json");
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`[benchmark] output=${output}`);
}

async function liveProbe(store, db) {
  const latencies = [];
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const startedAt = Date.now();
    const id = await store.execute({
      layer: "working", contentType: "message", sourceId: `live-${i}`, sourceTable: "entries",
      granularity: "fine", content: `回填洪峰中的实时记忆 ${i}，需要独立 lane 低延迟完成向量化。`,
    });
    ids.push({ id, startedAt });
  }
  for (const item of ids) {
    for (;;) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM memory_vec WHERE memory_entry_id = ?").get(item.id);
      if (row.n === 1) {
        latencies.push(Date.now() - item.startedAt);
        break;
      }
      if (Date.now() - item.startedAt > 30_000) throw new Error(`live ${item.id} 30s 未完成`);
      await sleep(10);
    }
  }
  return latencies;
}

async function mainThroughput() {
  console.log("=== 真实模型 120 chunk drain + live 隔离验证 ===");
  const corpus = loadRealCorpus(120);
  const { liveService, backfillService, dispose } = await initEmbeddingService({
    modelPath: "bge-m3", localModelPath: path.join(MAIN_ROOT, "models"),
  }, logger);
  const db = new Database(":memory:");
  let worker;
  try {
    await Promise.all([waitReady(liveService, "live"), waitReady(backfillService, "backfill")]);
    loadSqliteVec(db);
    initSchema(db);
    const repo = new SqliteMemoryRepository(db);
    const store = new StoreMemory(repo, repo, liveService, logger);
    const inputs = corpus.map(chunk => ({
      layer: "document", contentType: "feature_chunk", sourceId: "doc-real-model", sourceTable: "features",
      granularity: "fine", content: chunk.content,
    }));
    await store.replaceChunksBySource(inputs);
    if (await repo.pendingTaskCount() !== 120) throw new Error("120 chunk 未全部落库");
    if (backfillService.stats.inFlight !== 0) throw new Error("洪峰预占 backfill RAM");
    worker = new EmbeddingRetryWorker(repo, repo, repo, backfillService, logger, 3_600_000, 3);
    const startedAt = Date.now();
    await worker.tickNow();
    const probing = liveProbe(store, db);
    for (;;) {
      const pending = await repo.pendingTaskCount();
      if (pending === 0) break;
      if (Date.now() - startedAt > 30 * 60 * 1000) throw new Error("drain 30min 未完成");
      await sleep(1000);
    }
    const liveLatencies = await probing;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const liveP95 = percentile(liveLatencies, 0.95);
    console.log(`[drain] 120 条/${elapsedSec.toFixed(1)}s=${(120 / elapsedSec).toFixed(2)}条/s; live p95=${liveP95}ms`);
    console.log(`[drain] backfill stats=${JSON.stringify(backfillService.stats)}`);
    if (liveP95 >= 2000) throw new Error(`live p95 ${liveP95}ms >= 2000ms`);
    console.log("=== PASS ===");
  } finally {
    if (worker) await worker.stop();
    dispose();
    db.close();
  }
}

if (process.argv.includes("--benchmark")) {
  mainBenchmark().catch(err => { console.error("=== BENCHMARK FAIL ===", err); process.exitCode = 1; });
} else {
  mainThroughput().catch(err => { console.error("=== FAIL ===", err); process.exitCode = 1; });
}
