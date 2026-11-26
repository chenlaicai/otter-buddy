#!/usr/bin/env node
// Vec 阈值杀伤审计（Phase B 补测）：vecSimilarityThreshold 对 L2 距离的实际杀伤面
// 语义：vec0 默认 L2；门控(1-d)>=threshold 等价固定 cos 下限（0.3 → cos>=0.65）
// 产出：每查询 vec-50 候选 distance 分布 + gold(双3交集) 的 distance 与被杀统计
// 只读快照库（searchVec 是 SELECT，不触碰 memory_weights）
// 用法: node scripts/vec-threshold-audit.mjs --repo-root <repo根> --snapshot <快照db> --eval-dir <目录> [--models-dir <目录>]
//   repo-root 需含 dist/ 编译产物（先 npm run build）与 package.json；eval-dir 需含 sampled-queries/labels/q-idx
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
const { initEmbeddingService } = await import(dist("frameworks/embedding/embedding-init.js"));

const logger = { info: () => {}, warn: () => {}, error: (...a) => console.error("[error]", ...a), debug: () => {}, child: () => logger };
const db = initDatabase({ path: SNAP, walMode: false }, logger);
loadSqliteVec(db);
const repo = new SqliteMemoryRepository(db);

const services = await initEmbeddingService({
  modelPath: "bge-m3",
  localModelPath: MODELS_DIR,
  workerPath: path.join(REPO_ROOT, "dist/src/frameworks/embedding/bge-m3-worker.js"),
  workerExecArgv: [],
}, logger);
services.backfillService.dispose();
const liveEmbedding = services.liveService;

const { queries } = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "sampled-queries.json"), "utf8"));
const labelsA = JSON.parse(fs.readFileSync(`${EVAL_DIR}/labels-A.json`, "utf8"));
const labelsB = JSON.parse(fs.readFileSync(`${EVAL_DIR}/labels-B.json`, "utf8"));
const qIdx = JSON.parse(fs.readFileSync(`${EVAL_DIR}/q-idx.json`, "utf8"));
const A = new Map(labelsA.map(x => [x.queryId, x]));
const Bq = new Map(labelsB.map(x => [x.q, x]));

const THRESHOLD = 0.3; // 1-d >= 0.3 → d <= 0.7 过门
const audit = [];
let goldTotal = 0, goldInVec50 = 0, goldKilled = 0, goldPassed = 0, goldBeyond50 = 0;

for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  const emb = await liveEmbedding.embed(q.query);
  const hits = await repo.searchVec(emb, 50, {}); // 池深 50 看完整分布
  const ds = hits.map(h => h.distance);
  const sorted = [...ds].sort((a, b) => a - b);
  const pct = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;

  // gold 标注（主口径双3交集）
  const qn = i + 1;
  const a = A.get(q.queryId), b = Bq.get(qn);
  const idMap = new Map(Object.entries(qIdx[String(qn).padStart(2, '0')].idMap));
  const bById = {};
  for (const [s, g] of Object.entries(b.grades)) bById[idMap.get(s)] = g;
  const gold = Object.entries(a.grades).filter(([id, ga]) => ga === 3 && bById[id] === 3).map(([id]) => id);

  const distById = new Map(hits.map(h => [h.entryId, h.distance]));
  const goldRows = gold.map(id => {
    const d = distById.has(id) ? distById.get(id) : null;
    if (d === null) goldBeyond50++;
    else { goldInVec50++; if (d <= 0.7) goldPassed++; else goldKilled++; }
    return { id, d };
  });
  goldTotal += gold.length;

  audit.push({
    q: qn,
    nVec50: hits.length,
    dMin: sorted[0] ?? null, dP25: pct(0.25), dMed: pct(0.5), dMax: sorted[sorted.length - 1] ?? null,
    passRate: ds.length ? ds.filter(d => d <= 0.7).length / ds.length : 0,
    nGold: gold.length,
    goldDist: goldRows,
    candidates: hits.map((h, r) => ({ id: h.entryId, d: h.distance, rank: r + 1 })), // 全量：供真实融合池口径重算 r_pool
  });
  console.log(`q${String(qn).padStart(2)} vec50=${String(hits.length).padStart(2)} d: min=${ds.length?(sorted[0]??0).toFixed(3):'-'} med=${ds.length?(pct(0.5)??0).toFixed(3):'-'} max=${ds.length?(sorted[sorted.length-1]??0).toFixed(3):'-'} 过门率=${(audit.at(-1).passRate*100).toFixed(0)}% gold=${gold.length}${goldRows.length ? ' goldD=' + goldRows.map(g => g.d === null ? '池外' : g.d.toFixed(2)).join(',') : ''}`);
}

console.log(`\n===== 汇总（阈值 ${THRESHOLD}，即 L2 d<=0.7 过门 ≈ cos>=0.65） =====`);
console.log(`gold 总数=${goldTotal}  在vec50池=${goldInVec50}  过门=${goldPassed}  被阈值杀=${goldKilled}  池外(>50)=${goldBeyond50}`);
console.log(`阈值杀伤占可及 gold 比: ${goldInVec50 ? (goldKilled / goldInVec50 * 100).toFixed(1) : 0}%`);

fs.writeFileSync(path.join(EVAL_DIR, "vec-threshold-audit.json"), JSON.stringify({ threshold: THRESHOLD, semantics: "vec0 L2; pass if d<=0.7 (cos>=0.65)", audit }, null, 2));
console.log("已写入 vec-threshold-audit.json");

liveEmbedding.dispose?.();
process.exit(0);
