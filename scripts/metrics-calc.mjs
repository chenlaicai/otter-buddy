#!/usr/bin/env node
// Phase B 指标计算（评测方法论文档口径）
// 输入：runs-phaseb.json（k10/k20/ftsonly 三配置）+ labels-A/B（κ=0.8544 过门）
// 口径：
//   gold(主) = 双标均判 3；gold(敏感) = 任一判 3（敏感性对照）
//   gain(连续) = 双标均值
//   pool = fts ∪ vec（该配置两路并集）；slate = 最终返回
//   r_pool = gold 全部入池的查询比例；r_slate = gold 全部入 slate
//   标注可见性边界：盲标池=k20 并集∪slate 兜底，池外漏召回测不到（真实 r_pool ≤ 测量值）
import { readFileSync, writeFileSync } from 'fs';

// 用法: node scripts/metrics-calc.mjs --eval-dir <目录> [--runs <runs-phaseb.json路径>]
//   eval-dir 需含: labels-A.json labels-B.json q-idx.json；runs 默认 <eval-dir>/runs-phaseb.json
//   （runs 含查询与上下文原文，不进 git——重跑 phaseb-eval.mjs 重新生成）
function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : def;
}
const DIR = arg('--eval-dir');
if (!DIR) { console.error('缺少 --eval-dir <评测数据目录>'); process.exit(1); }
const runsPath = arg('--runs', `${DIR}/runs-phaseb.json`);
const runs = JSON.parse(readFileSync(runsPath, 'utf8'));
const labelsA = JSON.parse(readFileSync(`${DIR}/labels-A.json`, 'utf8'));
const labelsB = JSON.parse(readFileSync(`${DIR}/labels-B.json`, 'utf8'));
const qIdx = JSON.parse(readFileSync(`${DIR}/q-idx.json`, 'utf8'));

const A = new Map(labelsA.map(x => [x.queryId, x]));
const Bq = new Map(labelsB.map(x => [x.q, x]));

// 每查询：合并标注
const Q = runs.runs.map((r, i) => {
  const q = i + 1;
  const a = A.get(r.queryId), b = Bq.get(q);
  const idMap = new Map(Object.entries(qIdx[String(q).padStart(2, '0')].idMap));
  const grades = {}; // id -> {a, b, mean}
  const bById = {};
  for (const [short, g] of Object.entries(b.grades)) bById[idMap.get(short)] = g;
  for (const [id, ga] of Object.entries(a.grades)) {
    const gb = bById[id];
    grades[id] = { a: ga, b: gb, mean: (ga + gb) / 2 };
  }
  const scene = a.scene === b.scene ? a.scene : `${a.scene}/${b.scene}`;
  return { q, queryId: r.queryId, query: r.query, scene, grades };
});

// gold 集合（两种口径）
const goldOf = (qry, strict) => Object.entries(qry.grades)
  .filter(([, g]) => strict ? (g.a === 3 && g.b === 3) : (g.a === 3 || g.b === 3))
  .map(([id]) => id);

const idSet = arr => new Set(arr.map(x => x.id));

// ---- 指标函数 ----
function dcg(gains) {
  return gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
}

function evalConfig(qry, cfg, strict) {
  const gold = goldOf(qry, strict);
  const pool = idSet([...cfg.fts, ...cfg.vec]);
  const slate = cfg.slate.map(x => x.id);
  const slateSet = new Set(slate);
  const res = { nGold: gold.length };

  if (gold.length === 0) {
    res.noGold = true;
    // 排序仍可测：池内最优条目是否进 slate 前 5（用 mean gain）
    return res;
  }
  res.noGold = false;

  // r_pool / r_slate
  res.r_pool = gold.every(id => pool.has(id));
  res.r_slate = gold.every(id => slateSet.has(id));

  // recall@5/10 基于 slate
  for (const k of [5, 10]) {
    const top = new Set(slate.slice(0, k));
    res[`recall@${k}`] = gold.filter(id => top.has(id)).length / gold.length;
  }

  // MRR：slate 中第一个 gold
  res.MRR = 0;
  slate.forEach((id, i) => { if (res.MRR === 0 && gold.includes(id)) res.MRR = 1 / (i + 1); });

  // nDCG@5：gain=双标均值，IDCG=池内理想前5
  const gains5 = slate.slice(0, 5).map(id => qry.grades[id]?.mean ?? 0);
  const ideal = Object.values(qry.grades).map(g => g.mean).sort((x, y) => y - x).slice(0, 5);
  const idcg = dcg(ideal);
  res.nDCG5 = idcg > 0 ? dcg(gains5) / idcg : null;

  // gold 条目级归因
  res.goldDetail = gold.map(id => {
    const inFts = cfg.fts.some(x => x.id === id);
    const inVec = cfg.vec.some(x => x.id === id);
    const inSlate = slateSet.has(id);
    return { inFts, inVec, inSlate };
  });
  return res;
}

// ---- 汇总 ----
const CONFIGS = ['k10', 'k20', 'ftsonly'];
const report = {};

for (const strict of [true, false]) {
  const name = strict ? '主口径(双3交集)' : '敏感口径(任一3)';
  report[name] = {};
  for (const cname of CONFIGS) {
    const per = [];
    for (const qry of Q) {
      const cfg = runs.runs[qry.q - 1].configs[cname];
      per.push({ q: qry.q, scene: qry.scene, ...evalConfig(qry, cfg, strict) });
    }
    const valid = per.filter(p => !p.noGold);
    const noGold = per.filter(p => p.noGold);
    const agg = (fn) => valid.map(fn);
    report[name][cname] = {
      nQueries: per.length,
      nGoldQueries: valid.length,
      noGoldQueries: noGold.map(p => ({ q: p.q, scene: p.scene })),
      r_pool: agg(p => p.r_pool ? 1 : 0).reduce((a, b) => a + b, 0) / valid.length,
      r_slate: agg(p => p.r_slate ? 1 : 0).reduce((a, b) => a + b, 0) / valid.length,
      'recall@5': agg(p => p['recall@5']).reduce((a, b) => a + b, 0) / valid.length,
      'recall@10': agg(p => p['recall@10']).reduce((a, b) => a + b, 0) / valid.length,
      MRR: agg(p => p.MRR).reduce((a, b) => a + b, 0) / valid.length,
      nDCG5: agg(p => p.nDCG5 ?? 0).reduce((a, b) => a + b, 0) / valid.length,
    };
    // 延迟分解
    const lat = runs.runs.map(r => r.configs[cname].latency);
    const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    report[name][cname].latency = {
      embedMs: { med: med(lat.map(l => l.embedMs)), mean: lat.reduce((a, l) => a + l.embedMs, 0) / lat.length },
      ftsMs: { med: med(lat.map(l => l.ftsMs)), mean: lat.reduce((a, l) => a + l.ftsMs, 0) / lat.length },
      vecMs: { med: med(lat.map(l => l.vecMs)), mean: lat.reduce((a, l) => a + l.vecMs, 0) / lat.length },
      totalMs: { med: med(lat.map(l => l.totalMs)), mean: lat.reduce((a, l) => a + l.totalMs, 0) / lat.length },
    };
    // 失败分类（gold 条目级，主表按查询级归因）
    const fail = { bothMiss: 0, ftsOnly: 0, vecOnly: 0, poolHit_slateMiss: 0, fullHit: 0, slateOnlyDirect: 0 };
    for (const p of valid) {
      for (const g of p.goldDetail) {
        if (!g.inFts && !g.inVec && g.inSlate) fail.slateOnlyDirect++;
        else if (!g.inFts && !g.inVec) fail.bothMiss++;
        else if (g.inFts && !g.inVec) fail.ftsOnly++;
        else if (!g.inFts && g.inVec) fail.vecOnly++;
        else if (g.inSlate) fail.fullHit++;
        else fail.poolHit_slateMiss++;
      }
    }
    report[name][cname].goldAttribution = fail;
  }
}

// ---- 输出 ----
const fmt = v => typeof v === 'number' ? v.toFixed(3) : v;
for (const [name, cfgs] of Object.entries(report)) {
  console.log(`\n===== ${name} =====`);
  console.log('指标          k10      k20      ftsonly');
  for (const m of ['r_pool', 'r_slate', 'recall@5', 'recall@10', 'MRR', 'nDCG5']) {
    console.log(`${m.padEnd(11)} ${fmt(cfgs.k10[m]).padEnd(8)} ${fmt(cfgs.k20[m]).padEnd(8)} ${fmt(cfgs.ftsonly[m])}`);
  }
  for (const cname of CONFIGS) {
    const l = cfgs[cname].latency;
    console.log(`${cname} 延迟(ms): embed ${l.embedMs.med.toFixed(0)}/${l.embedMs.mean.toFixed(0)}  fts ${l.ftsMs.med.toFixed(0)}/${l.ftsMs.mean.toFixed(0)}  vec ${l.vecMs.med.toFixed(0)}/${l.vecMs.mean.toFixed(0)}  total ${l.totalMs.med.toFixed(0)}/${l.totalMs.mean.toFixed(0)}  (中位/均值)`);
  }
  const f10 = cfgs.k10.goldAttribution;
  console.log(`gold 条目归因(k10): 两路漏=${f10.bothMiss} 仅FTS路=${f10.ftsOnly} 仅Vec路=${f10.vecOnly} 池内被压出=${f10.poolHit_slateMiss} 全链命中=${f10.fullHit} 直通=${f10.slateOnlyDirect}`);
  const f20 = cfgs.k20.goldAttribution;
  console.log(`gold 条目归因(k20): 两路漏=${f20.bothMiss} 仅FTS路=${f20.ftsOnly} 仅Vec路=${f20.vecOnly} 池内被压出=${f20.poolHit_slateMiss} 全链命中=${f20.fullHit} 直通=${f20.slateOnlyDirect}`);
  const noG = cfgs.k10.noGoldQueries;
  console.log(`无 gold 查询: ${noG.length} 条 → ${noG.map(p => `q${p.q}(${p.scene})`).join(', ')}`);
}

// k20 相对 k10 的每查询差（池加深的价值点）
console.log('\n===== 池加深逐查询对照（主口径） =====');
const strict = true;
for (const qry of Q) {
  const r10 = evalConfig(qry, runs.runs[qry.q - 1].configs.k10, strict);
  const r20 = evalConfig(qry, runs.runs[qry.q - 1].configs.k20, strict);
  if (r10.noGold || r20.noGold) continue;
  const diffs = [];
  if (r10.r_pool !== r20.r_pool) diffs.push(`r_pool ${r10.r_pool ? 1 : 0}→${r20.r_pool ? 1 : 0}`);
  if (r10.r_slate !== r20.r_slate) diffs.push(`r_slate ${r10.r_slate ? 1 : 0}→${r20.r_slate ? 1 : 0}`);
  if (Math.abs((r10.nDCG5 ?? 0) - (r20.nDCG5 ?? 0)) > 0.01) diffs.push(`nDCG5 ${(r10.nDCG5 ?? 0).toFixed(2)}→${(r20.nDCG5 ?? 0).toFixed(2)}`);
  if (diffs.length) console.log(`q${String(qry.q).padStart(2)} [${qry.scene}]: ${diffs.join('; ')}`);
}

writeFileSync(`${DIR}/metrics-phaseb.json`, JSON.stringify({ report, note: { gold: '主=双3交集, 敏感=任一3; gain=双标均值; 池=fts∪vec; 标注可见边界=盲标池为k20并集∪slate兜底' } }, null, 2));
console.log('\n已写入 metrics-phaseb.json');
