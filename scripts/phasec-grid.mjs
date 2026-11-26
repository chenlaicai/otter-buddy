#!/usr/bin/env node
// Phase C 参数网格（真实集，M-1239dd29）
// 依据 Phase B 发现：vecSimilarityThreshold=0.3 使 vec 路融合前被杀光（过门率≤4%，gold 杀伤 96.4%）
// 网格：阈值 {0.05,0.1,0.15,0.2} × vec 池深 {10,20} × 消息半衰期 {7,14,21} = 24 组合 + 现状基线（同进程对照）
// 全链路真实 search（RRF→rerank→dedup→quota→slice），每组合跑完恢复权重（防频率信号污染）
// 采用门槛（R20261126amrca）：recall@10/r_pool 不下降；nDCG@5 或 MRR 稳定提升；合成回归另验
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : def;
}
const REPO_ROOT = arg('--repo-root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SNAP = arg('--snapshot');
const EVAL_DIR = arg('--eval-dir');
const MODELS_DIR = arg('--models-dir', path.join(REPO_ROOT, 'models'));
if (!SNAP || !EVAL_DIR) {
  console.error('缺少 --snapshot <快照db> 或 --eval-dir <评测数据目录>');
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

const PROD_CONFIG = {
  rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2,
  currentConversationBoost: 1.5, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90,
  userFlagMultiplier: 2.0, frequencyBoostFactor: 0.1,
};
const logger = { info: () => {}, warn: () => {}, error: (...a) => console.error("[error]", ...a), debug: () => {}, child: () => logger };

const db = initDatabase({ path: SNAP, walMode: false }, logger);
loadSqliteVec(db);
const repo = new SqliteMemoryRepository(db);
const terminology = new SqliteTerminologyRepository(db);

// 全局权重快照（每组合跑完按此恢复 touched 行）
const initialWeights = new Map(
  db.prepare("SELECT memory_entry_id, retrieval_count, last_retrieved_at FROM memory_weights")
    .all().map((r) => [r.memory_entry_id, { count: r.retrieval_count, at: r.last_retrieved_at }]),
);
const updateWeight = db.prepare("UPDATE memory_weights SET retrieval_count = ?, last_retrieved_at = ? WHERE memory_entry_id = ?");

const { queries } = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "sampled-queries.json"), "utf8"));
const labelsA = JSON.parse(fs.readFileSync(`${EVAL_DIR}/labels-A.json`, "utf8"));
const labelsB = JSON.parse(fs.readFileSync(`${EVAL_DIR}/labels-B.json`, "utf8"));
const qIdx = JSON.parse(fs.readFileSync(`${EVAL_DIR}/q-idx.json`, "utf8"));
const A = new Map(labelsA.map(x => [x.queryId, x]));
const Bq = new Map(labelsB.map(x => [x.q, x]));

// gold + 连续 gain（双标均值），nDCG 用
const Q = runs_prepare();
function runs_prepare() {
  const out = [];
  queries.forEach((q, i) => {
    const qn = i + 1;
    const a = A.get(q.queryId), b = Bq.get(qn);
    const idMap = new Map(Object.entries(qIdx[String(qn).padStart(2, '0')].idMap));
    const bById = {};
    for (const [s, g] of Object.entries(b.grades)) bById[idMap.get(s)] = g;
    const grades = {};
    for (const [id, ga] of Object.entries(a.grades)) grades[id] = { a: ga, b: bById[id], mean: (ga + bById[id]) / 2 };
    const gold = Object.entries(grades).filter(([, g]) => g.a === 3 && g.b === 3).map(([id]) => id);
    out.push({ qn, queryId: q.queryId, query: q.query, conv: q.conversationId, gold, grades });
  });
  return out;
}

// instrument：记录两路候选 + 权重 touched
function makeTrace(vecK) {
  return { vecK, ftsIds: [], vecIds: [], weightTouched: [] };
}
function instrumentRepo(repo, trace) {
  return new Proxy(repo, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig !== "function") return orig;
      if (prop === "searchFTSWithHighlight" || prop === "searchFTS") {
        return (...args) => Promise.resolve(orig.apply(target, args)).then((hits) => {
          trace.ftsIds.push(...hits.map((h) => h.entryId));
          return hits;
        });
      }
      if (prop === "searchVec") {
        return (...args) => Promise.resolve(orig.call(target, args[0], trace.vecK, args[2])).then((hits) => {
          trace.vecIds.push(...hits.map((h) => h.memory_entry_id ?? h.entryId));
          return hits;
        });
      }
      if (prop === "incrementRetrievalCounts") {
        return (...args) => { trace.weightTouched.push(...(args[0] ?? [])); return orig.apply(target, args); };
      }
      return (...args) => orig.apply(target, args);
    },
  });
}

const services = await initEmbeddingService({
  modelPath: "bge-m3", localModelPath: MODELS_DIR,
  workerPath: path.join(REPO_ROOT, "dist/src/frameworks/embedding/bge-m3-worker.js"),
  workerExecArgv: [],
}, logger);
services.backfillService.dispose();
const liveEmbedding = services.liveService;
const embedCache = new Map();
const gateway = {
  available: liveEmbedding.available,
  async embed(text) {
    if (embedCache.has(text)) return embedCache.get(text);
    const vec = await liveEmbedding.embed(text);
    embedCache.set(text, vec);
    return vec;
  },
};

// 指标
const dcg = gains => gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
const ideal5 = qry => dcg(Object.values(qry.grades).map(g => g.mean).sort((x, y) => y - x).slice(0, 5));

function evalSlate(qry, slate, poolIds) {
  const res = { nGold: qry.gold.length };
  if (qry.gold.length === 0) { res.noGold = true; return res; }
  res.noGold = false;
  const pool = new Set(poolIds);
  const slateSet = new Set(slate);
  res.r_pool = qry.gold.every(id => pool.has(id));
  res.r_slate = qry.gold.every(id => slateSet.has(id));
  for (const k of [5, 10]) {
    const top = new Set(slate.slice(0, k));
    res[`recall@${k}`] = qry.gold.filter(id => top.has(id)).length / qry.gold.length;
  }
  res.MRR = 0;
  slate.forEach((id, i) => { if (res.MRR === 0 && qry.gold.includes(id)) res.MRR = 1 / (i + 1); });
  const gains5 = slate.slice(0, 5).map(id => qry.grades[id]?.mean ?? 0);
  const idcg = ideal5(qry);
  res.nDCG5 = idcg > 0 ? dcg(gains5) / idcg : null;
  return res;
}

const GRID = [];
for (const t of [0.05, 0.1, 0.15, 0.2]) for (const k of [10, 20]) for (const h of [7, 14, 21])
  GRID.push({ name: `t${t}-k${k}-h${h}`, threshold: t, vecK: k, halfLife: h });
GRID.push({ name: "BASELINE-k10(现状)", threshold: 0.3, vecK: 10, halfLife: 7 });

const results = [];
for (const g of GRID) {
  const trace = makeTrace(g.vecK);
  const iRepo = instrumentRepo(repo, trace);
  const engine = new SearchEngine({ ...PROD_CONFIG, vecSimilarityThreshold: g.threshold, weightHalfLifeDays: g.halfLife });
  const sm = new SearchMemory(iRepo, iRepo, gateway, engine, logger, terminology);

  const per = [];
  for (const qry of Q) {
    const result = await sm.search({ query: qry.query, limit: 10, detailLevel: "summary", currentConversationId: qry.conv });
    const slate = result.entries.map(e => e.id);
    per.push(evalSlate(qry, slate, [...trace.ftsIds, ...trace.vecIds]));
    // 池是每查询累计的 trace——重置
    trace.ftsIds = []; trace.vecIds = [];
  }
  // 恢复权重
  const touched = new Set();
  // weightTouched 在组合级累计（trace.weightTouched 未清空）
  for (const id of trace.weightTouched) touched.add(id);
  for (const id of touched) {
    const init = initialWeights.get(id);
    if (init) updateWeight.run(init.count, init.at, id);
  }

  const valid = per.filter(p => !p.noGold);
  const agg = f => valid.map(f).reduce((a, b) => a + b, 0) / valid.length;
  results.push({
    name: g.name, threshold: g.threshold, vecK: g.vecK, halfLife: g.halfLife,
    r_pool: agg(p => (p.r_pool ? 1 : 0)), r_slate: agg(p => (p.r_slate ? 1 : 0)),
    'recall@5': agg(p => p['recall@5']), 'recall@10': agg(p => p['recall@10']),
    MRR: agg(p => p.MRR), nDCG5: agg(p => p.nDCG5 ?? 0),
    slateLen: per.reduce((a, p) => a + p.nGold * 0 + 10, 0) / per.length, // slate 定长 10（limit）
  });
  console.log(`${g.name.padEnd(20)} r_pool=${results.at(-1).r_pool.toFixed(2)} r_slate=${results.at(-1).r_slate.toFixed(2)} r@10=${results.at(-1)['recall@10'].toFixed(3)} r@5=${results.at(-1)['recall@5'].toFixed(3)} MRR=${results.at(-1).MRR.toFixed(3)} nDCG5=${results.at(-1).nDCG5.toFixed(3)}`);
}

fs.writeFileSync(path.join(EVAL_DIR, "phasec-grid-results.json"), JSON.stringify({ grid: GRID, results }, null, 2));

// 对照表：按 nDCG5 排序，标注 vs 基线
console.log("\n===== 按 nDCG5 排序（基线=BASELINE-k10 现状） =====");
const base = results.find(r => r.name.startsWith("BASELINE"));
for (const r of [...results].sort((a, b) => b.nDCG5 - a.nDCG5)) {
  const dN = r.nDCG5 - base.nDCG5, dM = r.MRR - base.MRR, dR = r['recall@10'] - base['recall@10'];
  const pass = (r['recall@10'] >= base['recall@10'] && r.r_pool >= base.r_pool && (dN > 0.01 || dM > 0.01)) ? '✓过门候选' : '';
  console.log(`${r.name.padEnd(20)} nDCG5=${r.nDCG5.toFixed(3)}(${dN >= 0 ? '+' : ''}${dN.toFixed(3)}) MRR=${r.MRR.toFixed(3)}(${dM >= 0 ? '+' : ''}${dM.toFixed(3)}) r@10=${r['recall@10'].toFixed(3)}(${dR >= 0 ? '+' : ''}${dR.toFixed(3)}) r_pool=${r.r_pool.toFixed(2)} r_slate=${r.r_slate.toFixed(2)} ${pass}`);
}

services.dispose();
process.exit(0);
