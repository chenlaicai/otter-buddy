/**
 * Phase B 固定快照基线评测（M-1239dd29）。
 * 设计真相源：R20261126amrca Phase B——固定快照、生产默认口径、
 * 指标素材：recall@5/10、MRR、nDCG、r_pool、r_slate、延迟分解（embed/FTS/vec）。
 *
 * 架构：Proxy 装饰器包装 SqliteMemoryRepository（不改任何 private 逻辑）——
 *   - searchVec 拦截：vec 池深覆盖为配置 K（生产默认 10；K=20 做池加深对照）
 *   - searchFTSWithHighlight/searchFTS 拦截：计时 + 记录候选 IDs（rank 序）
 *   - incrementRetrievalCounts 拦截：记录权重增量，跑完统一恢复（防频率信号污染）
 * EmbeddingGateway 装饰器：按查询文本缓存（同一查询 K=10/K=20 共享 embed）。
 * 配置：生产默认（additive + config-service.ts:659 缺省）× {K=10, K=20, FTS-only 对照}。
 *
 * 产出：
 *   runs-phaseb.json         —— 全层候选 IDs + slate + 延迟（指标计算输入）
 *   blind-pools-phaseb.json  —— 盲标池（K=20 两路并集 ∪ slate-only 兜底，乱序，含全文）
 *
 * 用法：node scripts/phaseb-eval.mjs --snapshot <db> --eval-dir <目录>   # 正常跑
 *       追加 --rerun-baseline <runs.json> 复跑并与基线对比（方差=0 验收）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const RERUN_BASELINE = arg("--rerun-baseline", null);
function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : def;
}
const REPO_ROOT = arg('--repo-root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SNAP = arg('--snapshot');
const EVAL_DIR = arg('--eval-dir');
const MODELS_DIR = arg('--models-dir', path.join(REPO_ROOT, 'models'));
if (!SNAP || !EVAL_DIR) {
  console.error('缺少 --snapshot <快照db> 或 --eval-dir <评测数据目录>（--rerun X 为方差验收模式）');
  process.exit(1);
}

const require2 = createRequire(path.join(REPO_ROOT, "package.json"));
const { load: loadSqliteVec } = require2("sqlite-vec");

const dist = (p) => path.join(REPO_ROOT, "dist/src", p);
const { initDatabase } = await import(dist("frameworks/db/database.js"));
const { SqliteMemoryRepository } = await import(dist("frameworks/db/memory/sqlite-memory-repository.js"));
const { SqliteTerminologyRepository } = await import(dist("frameworks/db/memory/sqlite-terminology-repository.js"));
const { initEmbeddingService } = await import(dist("frameworks/embedding/embedding-init.js"));
const { SearchMemory } = await import(dist("usecases/memory/search-memory.js"));
const { SearchEngine } = await import(dist("usecases/memory/search-engine.js"));

/** 生产默认配置 = config-service.ts buildMemoryConfig 缺省（2026-11-26 @ origin/main） */
const PROD_CONFIG = {
  rrfK: 60,
  alpha: 0.4,
  vecSimilarityThreshold: 0.3,
  bothBoost: 1.2,
  currentConversationBoost: 1.5,
  weightHalfLifeDays: 7,
  weightHalfLifeDaysDocument: 90,
  userFlagMultiplier: 2.0,
  frequencyBoostFactor: 0.1,
  // rerankMode 缺省 additive（SearchEngine 构造回填），rerank 缺省 DEFAULT_RERANK_WEIGHTS
};

const logger = { info: () => {}, warn: (...a) => console.error("[warn]", ...a), error: (...a) => console.error("[error]", ...a), debug: () => {}, child: () => logger };

function makeTrace(vecK) {
  return { vecK, ftsMs: 0, vecMs: 0, embedMs: 0, ftsIds: [], vecIds: [], weightTouched: [] };
}

/** Proxy 装饰器：不改 private 逻辑，只计时/记录/覆盖 vec 池深 */
function instrumentRepo(repo, trace) {
  return new Proxy(repo, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig !== "function") return orig;
      if (prop === "searchFTSWithHighlight" || prop === "searchFTS") {
        return (...args) => {
          const t0 = performance.now();
          const p = orig.apply(target, args);
          return Promise.resolve(p).then((hits) => {
            trace.ftsMs += performance.now() - t0;
            trace.ftsIds.push(...hits.map((h) => h.entryId));
            return hits;
          });
        };
      }
      if (prop === "searchVec") {
        return (...args) => {
          const t0 = performance.now();
          const [emb, , filters] = args;
          const p = orig.call(target, emb, trace.vecK, filters);
          return Promise.resolve(p).then((hits) => {
            trace.vecMs += performance.now() - t0;
            trace.vecIds.push(...hits.map((h) => h.memory_entry_id ?? h.entryId));
            return hits;
          });
        };
      }
      if (prop === "incrementRetrievalCounts") {
        return (...args) => {
          trace.weightTouched.push(...(args[0] ?? []));
          return orig.apply(target, args);
        };
      }
      return (...args) => orig.apply(target, args);
    },
  });
}

/** EmbeddingGateway 装饰器：缓存 + 计时；ftsOnly=true 时走 FTS-only 降级（embed throw → embed_failed → FTS 继续） */
function makeEmbedding(gateway, trace, cache, ftsOnly) {
  return {
    available: ftsOnly ? false : gateway.available,
    async embed(text) {
      if (!ftsOnly && cache.has(text)) return cache.get(text);
      if (ftsOnly) throw new Error("phaseb eval: FTS-only 对照");
      const t0 = performance.now();
      const vec = await gateway.embed(text);
      trace.embedMs += performance.now() - t0;
      cache.set(text, vec);
      return vec;
    },
  };
}

const db = initDatabase({ path: SNAP, walMode: false }, logger);
loadSqliteVec(db); // 必须在构造 repo 前加载：checkVecTable 探测 memory_vec 失败会静默关闭 vec 路径
const repo = new SqliteMemoryRepository(db);
const terminology = new SqliteTerminologyRepository(db);

// 权重快照（跑完恢复，防频率信号污染）
const initialWeights = new Map(
  db.prepare("SELECT memory_entry_id, retrieval_count, last_retrieved_at FROM memory_weights")
    .all().map((r) => [r.memory_entry_id, { count: r.retrieval_count, at: r.last_retrieved_at }]),
);

const { queries } = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "sampled-queries.json"), "utf8"));

const embedCache = new Map();
const runs = [];
const touchedIds = new Set();

const services = await initEmbeddingService({
  modelPath: "bge-m3",
  localModelPath: MODELS_DIR,
  workerPath: path.join(REPO_ROOT, "dist/src/frameworks/embedding/bge-m3-worker.js"),
  workerExecArgv: [],
}, logger);
services.backfillService.dispose();
const liveEmbedding = services.liveService;

try {
  for (const q of queries) {
    const configs = {};
    for (const [name, vecK, ftsOnly] of [["k10", 10, false], ["k20", 20, false], ["ftsonly", 10, true]]) {
      const trace = makeTrace(vecK);
      const iRepo = instrumentRepo(repo, trace);
      const gateway = makeEmbedding(liveEmbedding, trace, embedCache, ftsOnly);
      const engine = new SearchEngine({ ...PROD_CONFIG });
      const sm = new SearchMemory(iRepo, iRepo, gateway, engine, logger, terminology);
      const t0 = performance.now();
      const result = await sm.search({
        query: q.query,
        limit: 10,
        detailLevel: "summary", // 生产 Agent 默认口径
        currentConversationId: q.conversationId,
      });
      for (const id of trace.weightTouched) touchedIds.add(id);
      configs[name] = {
        vecState: result.vecState,
        fts: trace.ftsIds.map((id, i) => ({ id, rank: i + 1 })),
        vec: trace.vecIds.map((id, i) => ({ id, rank: i + 1 })),
        slate: result.entries.map((e) => ({ id: e.id, contentType: e.contentType, sourceId: e.sourceId, createdAt: e.createdAt })),
        latency: { embedMs: Math.round(trace.embedMs * 10) / 10, ftsMs: Math.round(trace.ftsMs * 10) / 10, vecMs: Math.round(trace.vecMs * 10) / 10, totalMs: Math.round((performance.now() - t0) * 10) / 10 },
      };
    }
    runs.push({ queryId: q.queryId, query: q.query, conversationId: q.conversationId, createdAt: q.createdAt, heurTags: q.allTags, context: q.context, configs });
    const k10 = configs.k10;
    console.log(`[${runs.length}/${queries.length}] ${q.query.slice(0, 40)} | k10 slate=${k10.slate.length} vec=${k10.vec.length} fts=${k10.fts.length} total=${k10.latency.totalMs}ms (embed ${k10.latency.embedMs}/fts ${k10.latency.ftsMs}/vec ${k10.latency.vecMs})`);
  }
} finally {
  services.dispose();
  const update = db.prepare("UPDATE memory_weights SET retrieval_count = ?, last_retrieved_at = ? WHERE memory_entry_id = ?");
  let restored = 0;
  for (const id of touchedIds) {
    const w = initialWeights.get(id);
    if (w) { update.run(w.count, w.at, id); restored++; }
  }
  console.log(`weights restored: ${restored}/${touchedIds.size}`);
}

// ─── 盲标池组装（K=20 两路并集 ∪ slate 兜底；乱序；附全文） ───
const entryStmt = db.prepare("SELECT id, content_type, source_table, source_id, created_at, content FROM memory_entries WHERE id = ?");
const pools = [];
for (const r of runs) {
  const seen = new Set();
  const cands = [];
  const k20 = r.configs.k20;
  for (const src of [k20.fts, k20.vec]) {
    for (const { id } of src) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = entryStmt.get(id);
      if (!row) { console.error(`missing entry ${id} — 不应发生（快照已清孤儿）`); continue; }
      cands.push({ id: row.id, contentType: row.content_type, sourceTable: row.source_table, sourceId: row.source_id, createdAt: row.created_at, content: row.content });
    }
  }
  // slate-only 兜底（anchor 短路/术语库条目等不经 fts/vec 池的结果也须可标）
  for (const c of [...r.configs.k10.slate, ...r.configs.k20.slate, ...r.configs.ftsonly.slate]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const row = entryStmt.get(c.id);
    if (row) cands.push({ id: row.id, contentType: row.content_type, sourceTable: row.source_table, sourceId: row.source_id, createdAt: row.created_at, content: row.content });
  }
  const shuffled = cands
    .map((c) => ({ c, h: createHash("sha256").update(`${r.queryId}:${c.id}`).digest("hex") }))
    .sort((a, b) => a.h.localeCompare(b.h))
    .map((x) => x.c);
  pools.push({ queryId: r.queryId, query: r.query, context: r.context, candidates: shuffled });
}

fs.writeFileSync(path.join(EVAL_DIR, "runs-phaseb.json"), JSON.stringify({
  protocol: { prodConfig: PROD_CONFIG, detailLevel: "summary", limit: 10, configs: { k10: "生产默认 vec 池=10", k20: "vec 池=20 对照", ftsonly: "FTS-only 对照" }, snapshot: SNAP, note: "快照=清理前备份副本+对副本 apply 清孤儿（2026-11-26T06:28），与线上清理后状态对齐" },
  runs,
}, null, 2));
fs.writeFileSync(path.join(EVAL_DIR, "blind-pools-phaseb.json"), JSON.stringify(pools, null, 2));
console.log(`runs -> runs-phaseb.json, pools(${pools.reduce((n, p) => n + p.candidates.length, 0)} candidates) -> blind-pools-phaseb.json`);

// ─── 复跑方差验收（--rerun <baseline>） ───
if (RERUN_BASELINE) {
  const base = JSON.parse(fs.readFileSync(RERUN_BASELINE, "utf8")).runs;
  const strip = (rs) => JSON.stringify(rs.map((r) => ({ ...r, configs: Object.fromEntries(Object.entries(r.configs).map(([k, v]) => [k, { ...v, latency: undefined }])) })));
  const identical = strip(base) === strip(runs);
  console.log(`[rerun] 结果一致性（忽略 latency）：${identical ? "PASS（方差=0）" : "FAIL——检查权重恢复/缓存干扰"}`);
  process.exitCode = identical ? 0 : 1;
}
db.close();
