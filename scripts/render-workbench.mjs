/**
 * 标注工作台渲染器：blind-pools-phaseb.json → 每查询紧凑文本（q01-q20.txt）+ 序号映射（q-idx.json）。
 * 标注者输出 {q, scene, grades}（grades 键为井号序号短码、值为 0-3 整数），由 merge-labels.mjs 映射回 entryId。
 */
import fs from "node:fs";
import path from "node:path";

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : def;
}
const EVAL_DIR = arg('--eval-dir');
if (!EVAL_DIR) { console.error('缺少 --eval-dir <评测数据目录>（需含 blind-pools-phaseb.json）'); process.exit(1); }
const OUT_DIR = path.join(EVAL_DIR, "label-workbench");
fs.mkdirSync(OUT_DIR, { recursive: true });

const pools = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "blind-pools-phaseb.json"), "utf8"));
const idx = {};
pools.forEach((p, pi) => {
  const qNo = String(pi + 1).padStart(2, "0");
  const idMap = {};
  const lines = [];
  lines.push(`# Q${qNo}  queryId=${p.queryId}`);
  lines.push(`QUERY: ${p.query}`);
  const ctx = (p.context ?? []).slice(-5).map((m) => {
    const role = m?.role ?? m?.sender ?? "?";
    const text = String(m?.content ?? m?.text ?? m ?? "").replace(/\s+/g, " ").slice(0, 160);
    return `  (${role}) ${text}`;
  });
  if (ctx.length) lines.push(`CONTEXT:\n${ctx.join("\n")}`);
  lines.push(`CANDIDATES (${p.candidates.length}):`);
  p.candidates.forEach((c, ci) => {
    const key = `#${String(ci + 1).padStart(2, "0")}`;
    idMap[key] = c.id;
    const content = String(c.content ?? "").replace(/\s+/g, " ").slice(0, 340);
    lines.push(`${key} [${c.contentType}/${c.sourceTable}] (${String(c.createdAt).slice(0, 10)}) ${content}`);
  });
  idx[qNo] = { queryId: p.queryId, idMap };
  fs.writeFileSync(path.join(OUT_DIR, `q${qNo}.txt`), lines.join("\n"));
});
fs.writeFileSync(path.join(OUT_DIR, "q-idx.json"), JSON.stringify(idx));
console.log(`rendered ${pools.length} queries -> ${OUT_DIR}, sizes=` + pools.map((p, i) => `q${String(i + 1).padStart(2, "0")}:${p.candidates.length}`).join(","));
