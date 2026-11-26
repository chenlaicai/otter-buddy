/**
 * 标注合并与完整性校验：labels-A-part*.json + q-idx.json → labels-A.json。
 * 校验：每查询 grades 键集与候选池完全相等（无增删）、grade ∈ [0,3] 整数、scene 合法。
 */
import fs from "node:fs";
import path from "node:path";

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : def;
}
const EVAL_DIR = arg('--eval-dir');
if (!EVAL_DIR) { console.error('缺少 --eval-dir <评测数据目录>（需含 label-workbench/q-idx.json 与 labels-A-part*.json）'); process.exit(1); }
const WB = path.join(EVAL_DIR, "label-workbench");
const idx = JSON.parse(fs.readFileSync(path.join(WB, "q-idx.json"), "utf8"));
let pools = null;
try { pools = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "blind-pools-phaseb.json"), "utf8")); } catch { /* 缺省时池全集从 q-idx idMap 推导 */ }

const parts = fs.readdirSync(EVAL_DIR).filter((f) => /^labels-A-part\d+\.json$/.test(f)).sort();
const rows = parts.flatMap((f) => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), "utf8")));
const SCENES = new Set(["time-update", "cross-conv-followup", "confusable", "doc-locate", "multi-evidence", "current-conv", "no-answer", "generic"]);
const seenQ = new Set();
const out = [];
for (const row of rows) {
  const qNo = String(row.q).padStart(2, "0");
  if (seenQ.has(qNo)) throw new Error(`重复标注 q${qNo}`);
  seenQ.add(qNo);
  const meta = idx[qNo];
  if (!meta) throw new Error(`q${qNo} 无索引`);
  if (!SCENES.has(row.scene)) throw new Error(`q${qNo} 非法场景 ${row.scene}`);
  const poolIds = pools
    ? new Set(pools[Number(qNo) - 1].candidates.map((c) => c.id))
    : new Set(Object.values(idx[String(Number(qNo)).padStart(2, "0")].idMap));
  for (const g of Object.values(row.grades)) {
    if (!Number.isInteger(g) || g < 0 || g > 3) throw new Error(`q${qNo} 非法 grade ${g}`);
  }
  const mapped = {};
  for (const [key, g] of Object.entries(row.grades)) {
    const id = meta.idMap[key];
    if (!id) throw new Error(`q${qNo} 短码 ${key} 无映射`);
    mapped[id] = g;
  }
  const missing = [...poolIds].filter((id) => !(id in mapped));
  const extra = Object.keys(mapped).filter((id) => !poolIds.has(id));
  if (missing.length) throw new Error(`q${qNo} 缺标 ${missing.length} 条: ${missing.slice(0, 3).join(",")}`);
  if (extra.length) throw new Error(`q${qNo} 池外标注 ${extra.length} 条`);
  out.push({ queryId: meta.queryId, scene: row.scene, grades: mapped });
}
if (seenQ.size !== 20) throw new Error(`仅标注 ${seenQ.size}/20 查询`);
fs.writeFileSync(path.join(EVAL_DIR, "labels-A.json"), JSON.stringify(out, null, 2));
const dist = { 0: 0, 1: 0, 2: 0, 3: 0 };
for (const r of out) for (const g of Object.values(r.grades)) dist[g]++;
console.log(`labels-A.json OK: 20 queries, ${out.reduce((n, r) => n + Object.keys(r.grades).length, 0)} grades, dist=${JSON.stringify(dist)}`);
console.log("scenes:", out.map((r) => r.scene).join(","));
