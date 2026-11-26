#!/usr/bin/env node
// Phase B 双盲标注一致性：二次加权 Cohen's Kappa（R20261126amrca 质量门 ≥0.6）
// 用法: node scripts/kappa-calc.mjs --eval-dir <目录>
//   eval-dir 需含: labels-A.json(labels-A数组) labels-B.json({q,scene,grades:#短码}) q-idx.json(短码→id 映射真相源)
//   可选 blind-pools-phaseb.json ——提供时额外校验映射与池 id 集一致；缺省时池全集从 q-idx 推导
//   （归档样本见 docs/research/2026/11/26/metma-data/，Kappa 复算无需含正文文件）
import { readFileSync } from 'fs';

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : def;
}
const EVAL_DIR = arg('--eval-dir');
if (!EVAL_DIR) {
  console.error('缺少 --eval-dir <评测数据目录>');
  process.exit(1);
}
const fsExists = (p) => { try { readFileSync(p); return true; } catch { return false; } };
const poolsPath = `${EVAL_DIR}/blind-pools-phaseb.json`;
const pools = fsExists(poolsPath) ? JSON.parse(readFileSync(poolsPath, 'utf8')) : null;
const labelsA = JSON.parse(readFileSync(`${EVAL_DIR}/labels-A.json`, 'utf8'));
const labelsB = JSON.parse(readFileSync(`${EVAL_DIR}/labels-B.json`, 'utf8'));
// #短码→id 映射真相源 = 渲染 workbench 时生成的乱序映射（B 方所见的 #xx 顺序）
const qIdx = JSON.parse(readFileSync(`${EVAL_DIR}/q-idx.json`, 'utf8'));

const nQueries = Object.keys(qIdx).length;
const problems = [];

// --- 1. 机械校验 + 短码映射 ---
const A = new Map(labelsA.map(x => [x.queryId, x]));
const B = new Map(labelsB.map(x => [x.q, x]));
const pairs = []; // {queryId, q, aGrades, bGrades, poolOrder}

for (let i = 0; i < nQueries; i++) {
  const idxEntry = qIdx[String(i + 1).padStart(2, '0')];
  if (!idxEntry) { problems.push(`q${i + 1}: q-idx 缺该查询`); continue; }
  const shortToId = new Map(Object.entries(idxEntry.idMap));
  // 池全集：优先 pools 文件；缺省时从 q-idx idMap 推导（映射恰好覆盖池全集是渲染期不变量）
  const poolIds = pools
    ? new Set(pools[i].candidates.map(c => c.id))
    : new Set(shortToId.values());
  if (pools) {
    if (shortToId.size !== pools[i].candidates.length) problems.push(`q${i + 1}: 池内短码重复`);
    if ([...shortToId.values()].some(id => !poolIds.has(id)) || shortToId.size !== poolIds.size)
      problems.push(`q${i + 1}: q-idx 映射与池 id 集不一致`);
  }

  const a = A.get(idxEntry.queryId);
  const b = B.get(i + 1);
  if (!a) problems.push(`q${i + 1}: labels-A 缺该查询`);
  if (!b) problems.push(`q${i + 1}: labels-B 缺该查询`);
  if (!a || !b) continue;

  const aIds = new Set(Object.keys(a.grades));
  if ([...aIds].some(id => !poolIds.has(id)) || aIds.size !== poolIds.size)
    problems.push(`q${i + 1}: labels-A 键集与池不一致`);
  const bKeys = new Set(Object.keys(b.grades));
  if (bKeys.size !== shortToId.size || [...bKeys].some(k => !shortToId.has(k)))
    problems.push(`q${i + 1}: labels-B 键集与池不一致`);

  for (const [src, grades] of [['A', a.grades], ['B', b.grades]]) {
    for (const [k, v] of Object.entries(grades)) {
      if (!Number.isInteger(v) || v < 0 || v > 3) problems.push(`q${i + 1} ${src}[${k}]: 非法分值 ${v}`);
    }
  }
  if (a.scene === undefined) problems.push(`q${i + 1}: labels-A 缺 scene`);
  if (b.scene === undefined) problems.push(`q${i + 1}: labels-B 缺 scene`);

  const bById = {};
  for (const [short, grade] of Object.entries(b.grades)) bById[shortToId.get(short)] = grade;
  pairs.push({ q: i + 1, queryId: idxEntry.queryId, aGrades: a.grades, bGrades: bById, sceneA: a.scene, sceneB: b.scene, n: shortToId.size });
}

if (pairs.length !== nQueries) problems.push(`覆盖不全: pairs=${pairs.length} queries=${nQueries}`);
console.log(`机械校验: ${problems.length === 0 ? 'PASS（20 查询全覆盖，键集与分值合法）' : 'FAIL'}`);
for (const p of problems) console.log('  ⚠ ' + p);
if (problems.length) process.exit(1);

// --- 2. 二次加权 Kappa ---
// w_ij = 1 - (i-j)^2/(K-1)^2, K=4
const K = 4;
const w = (i, j) => 1 - ((i - j) ** 2) / ((K - 1) ** 2);

// 总体
const O = Array.from({ length: K }, () => Array(K).fill(0));
let nTotal = 0;
for (const p of pairs) {
  const ids = Object.keys(p.aGrades);
  for (const id of ids) {
    const i = p.aGrades[id], j = p.bGrades[id];
    O[i][j]++; nTotal++;
  }
}
console.log(`\n总判定对: ${nTotal}（= 1097 预期）`);

// 混淆矩阵打印
console.log('\n混淆矩阵（行=A(记忆研究獭), 列=B(检视獭)）:');
console.log('     ' + [...Array(K)].map((_, j) => `B=${j}`).join('  '));
for (let i = 0; i < K; i++) console.log(`A=${i}: ` + O[i].map(v => String(v).padStart(3)).join('  '));

// 期望矩阵 E_ij = row_i * col_j / N
const rowS = O.map(r => r.reduce((a, b) => a + b, 0));
const colS = [...Array(K)].map((_, j) => O.reduce((a, r) => a + r[j], 0));
let obsW = 0, expW = 0;
for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
  obsW += w(i, j) * O[i][j] / nTotal;
  expW += w(i, j) * rowS[i] * colS[j] / (nTotal * nTotal);
}
const kappa = 1 - (1 - obsW) / (1 - expW); // 一致性权重约定：κ = 1 − 观察不一致/期望不一致
const exact = O.reduce((a, r, i) => a + r[i], 0);
const off1 = O.reduce((a, r, i) => a + (r[i + 1] ?? 0) + (r[i - 1] ?? 0), 0);
const off2 = O.reduce((a, r, i) => a + (r[i + 2] ?? 0) + (r[i - 2] ?? 0), 0);
const off3 = O.reduce((a, r, i) => a + (r[i + 3] ?? 0) + (r[i - 3] ?? 0), 0);
console.log(`\n二次加权 Cohen's Kappa = ${kappa.toFixed(4)}`);
console.log(`完全一致: ${exact}/${nTotal} = ${(exact / nTotal * 100).toFixed(1)}%`);
console.log(`差±1: ${off1}（${(off1 / nTotal * 100).toFixed(1)}%）  差±2: ${off2}  差≥3: ${off3}`);

// 按查询 kappa
const perQ = [];
for (const p of pairs) {
  const o = Array.from({ length: K }, () => Array(K).fill(0));
  const ids = Object.keys(p.aGrades);
  const n = ids.length;
  for (const id of ids) o[p.aGrades[id]][p.bGrades[id]]++;
  const rs = o.map(r => r.reduce((a, b) => a + b, 0));
  const cs = [...Array(K)].map((_, j) => o.reduce((a, r) => a + r[j], 0));
  let ow = 0, ew = 0;
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
    ow += w(i, j) * o[i][j] / n;
    ew += w(i, j) * rs[i] * cs[j] / (n * n);
  }
  const k = (1 - ew) === 0 ? NaN : 1 - (1 - ow) / (1 - ew);
  perQ.push({ q: p.q, kappa: k, n });
}
console.log('\n按查询 kappa（升序 8 个最低）:');
for (const { q, kappa: k, n } of [...perQ].sort((a, b) => a.kappa - b.kappa).slice(0, 8))
  console.log(`  q${String(q).padStart(2)}: κ=${Number.isNaN(k) ? 'N/A(退化)' : k.toFixed(3)}  n=${n}`);

// scene 一致性
const sceneAgree = pairs.filter(p => p.sceneA === p.sceneB).length;
console.log(`\nscene 一致: ${sceneAgree}/${pairs.length}`);
console.log('scene A 侧:', pairs.map(p => p.sceneA).join(', '));
console.log('scene B 侧:', pairs.map(p => p.sceneB).join(', '));

console.log(`\n结论: κ=${kappa.toFixed(4)} ${kappa >= 0.6 ? '≥0.6 → 质量门 PASS，可进指标计算与 Phase C' : '<0.6 → 修指南重标，不用分歧数据调参'}`);
