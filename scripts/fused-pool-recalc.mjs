#!/usr/bin/env node
// 真实融合池口径重算 + 阈值放宽模拟（Phase B 补充分析）
// 事实：rrfFusion 在融合前用 vecSimilarityThreshold 过滤 vec 候选（search-engine.ts:187-190）
//  → runs-phaseb.json 的 r_pool（fts∪vec 原始并集）高估融合层池；本脚本按 d<=1-t 重算
// 阈值放宽模拟只在「候选可达性」层面，排序效应（RRF→rerank→slate）需 Phase C 网格实测
import { readFileSync } from 'fs';

// 用法: node scripts/fused-pool-recalc.mjs --eval-dir <目录>
//   eval-dir 需含: runs-phaseb.json(含正文，不进 git) vec-threshold-audit.json labels-A/B q-idx
//   归档样本(vec-threshold-audit/labels/q-idx)在 docs/research/2026/11/26/metma-data/；runs 重跑 phaseb-eval 生成
function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : def;
}
const DIR = arg('--eval-dir');
const runsPath = arg('--runs', `${DIR}/runs-phaseb.json`);
if (!DIR) { console.error('缺少 --eval-dir <评测数据目录>'); process.exit(1); }
const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
const audit = JSON.parse(readFileSync(`${DIR}/vec-threshold-audit.json`, 'utf8'));
const labelsA = JSON.parse(readFileSync(`${DIR}/labels-A.json`, 'utf8'));
const labelsB = JSON.parse(readFileSync(`${DIR}/labels-B.json`, 'utf8'));
const qIdx = JSON.parse(readFileSync(`${DIR}/q-idx.json`, 'utf8'));

const A = new Map(labelsA.map(x => [x.queryId, x]));
const Bq = new Map(labelsB.map(x => [x.q, x]));

// 每查询 gold（主口径双3交集）与 vec50 的 id→distance
const Q = runs.runs.map((r, i) => {
  const qn = i + 1;
  const a = A.get(r.queryId), b = Bq.get(qn);
  const idMap = new Map(Object.entries(qIdx[String(qn).padStart(2, '0')].idMap));
  const bById = {};
  for (const [s, g] of Object.entries(b.grades)) bById[idMap.get(s)] = g;
  const gold = Object.entries(a.grades).filter(([id, ga]) => ga === 3 && bById[id] === 3).map(([id]) => id);
  const distById = new Map(audit.audit[qn - 1].candidates.map(c => [c.id, c.d]));
  return { qn, gold, fts: runs.runs[i].configs.k10.fts.map(x => x.id), vec10: runs.runs[i].configs.k10.vec.map(x => x.id), vec20: runs.runs[i].configs.k20.vec.map(x => x.id), distById };
});

// 一致性验证：audit vec50 前 K 与 runs k10/k20 vec 一致（同 embedding 同库应逐条一致）
let mismatch = 0;
for (const q of Q) {
  const a10 = audit.audit[q.qn - 1].candidates.slice(0, 10).map(c => c.id);
  if (a10.join() !== q.vec10.join()) { mismatch++; console.log(`q${q.qn}: vec10 与 audit 前10不一致`); }
  const a20 = audit.audit[q.qn - 1].candidates.slice(0, 20).map(c => c.id);
  if (a20.join() !== q.vec20.join()) { mismatch++; console.log(`q${q.qn}: vec20 与 audit 前20不一致`); }
}
console.log(`vec 池一致性（runs vs audit）: ${mismatch === 0 ? 'PASS（audit 前10/20 与 k10/k20 逐条一致）' : mismatch + ' 条不一致'}`);

// 真实融合池 r_pool（t=0.3 现状）+ 阈值放宽模拟
const THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.3];
console.log('\n===== 真实融合池口径：r_pool 与 gold 融合池覆盖率（双3 gold，20 查询） =====');
console.log('阈值   k10_r_pool  k20_r_pool  fts_r_pool | k10_gold覆盖  k20_gold覆盖  fts_gold覆盖 | 融合池均值 k10/k20');
for (const t of THRESHOLDS) {
  const dMax = 1 - t; // L2
  const stats = { k10: { rp: 0, cov: 0, size: 0 }, k20: { rp: 0, cov: 0, size: 0 }, fts: { rp: 0, cov: 0, size: 0 } };
  let nG = 0;
  for (const q of Q) {
    if (q.gold.length === 0) continue;
    nG++;
    const pass = id => { const d = q.distById.get(id); return d !== undefined && d <= dMax; };
    const poolOf = (name) => {
      const vecIds = name === 'fts' ? [] : (name === 'k10' ? q.vec10 : q.vec20);
      return new Set([...q.fts, ...vecIds.filter(pass)]);
    };
    for (const name of ['k10', 'k20', 'fts']) {
      const pool = poolOf(name);
      const inPool = q.gold.filter(id => pool.has(id));
      if (inPool.length === q.gold.length) stats[name].rp++;
      stats[name].cov += inPool.length / q.gold.length;
      stats[name].size += pool.size;
    }
  }
  for (const s of Object.values(stats)) { s.rp /= nG; s.cov /= nG; s.size /= nG; }
  console.log(`${t.toFixed(2)}   ${stats.k10.rp.toFixed(2)}        ${stats.k20.rp.toFixed(2)}        ${stats.fts.rp.toFixed(2)}      | ${stats.k10.cov.toFixed(3)}         ${stats.k20.cov.toFixed(3)}         ${stats.fts.cov.toFixed(3)}       | ${stats.k10.size.toFixed(0)}/${stats.k20.size.toFixed(0)}`);
}

// K=50 增量（t=0.1 假设下）：vec20 → vec50 能多捞多少 gold
console.log('\n===== K=50 相对 K=20 的 vec 路 gold 增量（阈值放宽到 0.1/0.15/0.2 假设下） =====');
for (const t of [0.1, 0.15, 0.2]) {
  const dMax = 1 - t;
  let goldIn20 = 0, goldIn50 = 0, extra = 0, total = 0;
  for (const q of Q) {
    const v50 = audit.audit[q.qn - 1].candidates;
    const in20 = new Set(v50.slice(0, 20).filter(c => c.d <= dMax).map(c => c.id));
    const in50 = new Set(v50.filter(c => c.d <= dMax).map(c => c.id));
    for (const g of q.gold) {
      total++;
      if (in50.has(g)) { goldIn50++; if (in20.has(g)) goldIn20++; else extra++; }
    }
  }
  console.log(`t=${t.toFixed(2)} (d<=${dMax.toFixed(2)}, cos>=${(0.5 + t / 2).toFixed(3)}): gold 在 vec20=${goldIn20}  在 vec50=${goldIn50}  K50 独占增量=${extra}（占总 gold ${(extra / total * 100).toFixed(1)}%）`);
}
