#!/usr/bin/env node
/**
 * F20260902rcp1 验收脚本：Phase 0 的 306 条查询在修复后的 recall 对比
 * 用法：node scripts/phase1-recall-check.mjs [--db path] [--annotations path]
 * 数据依赖：Phase 0 产物（annotate-input.jsonl + annotations-glm-v3.jsonl + system-results.jsonl）
 */
import Database from "better-sqlite3";
import { load } from "sqlite-vec";
import fs from "node:fs";
import path from "node:path";
import { tokenizeQuery } from "../dist/src/frameworks/db/jieba-tokenizer.js";

const args = process.argv.slice(2);
const dbPath = args[args.indexOf("--db") + 1] ?? "/Users/orca/ai/otter-buddy/data/otter-buddy.db";
const annDir = args[args.indexOf("--annotations") + 1] ??
  "/Users/orca/ai/otter-buddy/data/workspaces/9e709aca-dd74-42fa-9fe1-4e7bbaf24bdb";

const input = fs.readFileSync(path.join(annDir, "phase0-annotation/annotate-input.jsonl"), "utf8")
  .trim().split("\n").map(l => JSON.parse(l));
const glmV3 = new Map(fs.readFileSync(path.join(annDir, "glm-private/annotations-glm-v3.jsonl"), "utf8")
  .trim().split("\n").map(l => { const o = JSON.parse(l); return [o.query_id, o.ideal_ids]; }));
const sysOld = new Map(fs.readFileSync(path.join(annDir, "glm-private/system-results.jsonl"), "utf8")
  .trim().split("\n").map(l => { const o = JSON.parse(l); return [o.query_id, o.top_entry_ids]; }));

const db = new Database(dbPath, { readonly: true });
load(db);

const FTS_LIMIT = 50;
const rrfK = 60, alpha = 0.4;
const HL_DEFAULT = 7, HL_DOC = 90;
const DOC_TYPES = new Set(["feature", "research", "feature_chunk", "research_chunk"]);

function decay(createdAt, hl) {
  const utc = createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T") + "Z";
  const ageDays = (Date.now() - new Date(utc).getTime()) / 86400_000;
  return Math.exp(-Math.LN2 * ageDays / hl);
}

/** 复现修复后检索管线（FTS 双写索引 + 词典词查询 + 半衰期分层 + 层配额）取 top10 */
function searchFixed(query, limit = 10) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const ftsQuery = tokens.map(t => `"${t.replace(/["']/g, "")}"`).join(" OR ");
  let ftsRows;
  try {
    ftsRows = db.prepare(`
      SELECT me.id, me.content_type, me.created_at, fts.rank
      FROM memory_fts_jieba fts JOIN memory_entries me ON fts.memory_entry_id = me.id
      WHERE memory_fts_jieba MATCH ? ORDER BY fts.rank LIMIT ?`).all(ftsQuery, FTS_LIMIT);
  } catch { return []; }

  // RRF: FTS 单路（vec 不复现——脚本只验证 FTS 侧修复；vec 路径行为不变）
  const scored = ftsRows.map((r, rank) => ({
    id: r.id, contentType: r.content_type,
    score: (1 - alpha) * (1 / (rrfK + rank + 1)) *
      decay(r.created_at, DOC_TYPES.has(r.content_type) ? HL_DOC : HL_DEFAULT),
  }));
  scored.sort((a, b) => b.score - a.score);
  // 层配额（简化版：与 search-memory.applyLayerQuota 同语义）
  const DOC_SUMMARY = new Set(["feature", "research"]);
  const quota = limit < 6 ? 1 : 2;
  const top = scored.slice(0, limit);
  const docCount = top.filter(h => DOC_SUMMARY.has(h.contentType)).length;
  if (docCount < quota) {
    const cands = scored.slice(limit).filter(h => DOC_SUMMARY.has(h.contentType));
    let need = quota - docCount, from = top.length - 1;
    while (need > 0 && cands.length > 0 && from >= 0) {
      while (from >= 0 && DOC_SUMMARY.has(top[from].contentType)) from--;
      if (from < 0) break;
      top[from] = cands.shift(); from--; need--;
    }
  }
  return top.map(h => h.id);
}

let newR5 = 0, newR10 = 0, newZero = 0, oldR10 = 0, oldZero = 0, n = 0;
const docLayerQ = [];
for (const q of input) {
  const ideal = glmV3.get(q.query_id) ?? [];
  if (!ideal.length) continue;
  n++;
  const topNew = searchFixed(q.query, 10);
  const old = sysOld.get(q.query_id) ?? [];
  const hitNew5 = ideal.filter(id => topNew.slice(0, 5).includes(id)).length;
  const hitNew10 = ideal.filter(id => topNew.slice(0, 10).includes(id)).length;
  const hitOld10 = ideal.filter(id => old.slice(0, 10).includes(id)).length;
  newR5 += hitNew5 / ideal.length; newR10 += hitNew10 / ideal.length; oldR10 += hitOld10 / ideal.length;
  if (hitNew10 === 0) newZero++;
  if (hitOld10 === 0) oldZero++;
  // doc 层单独算（doc 意图查询）
  const docIdeal = ideal.filter(id => { const r = db.prepare("SELECT content_type FROM memory_entries WHERE id=?").get(id); return r && (r.content_type === "feature" || r.content_type === "research" || r.content_type.startsWith("feature_chunk")); });
  if (docIdeal.length) {
    const hit = docIdeal.filter(id => topNew.includes(id)).length;
    docLayerQ.push(hit / docIdeal.length);
  }
}
console.log(`n=${n}`);
console.log(`修复后: recall@5=${(newR5/n).toFixed(3)} recall@10=${(newR10/n).toFixed(3)} 零召回=${(newZero/n*100).toFixed(1)}%`);
console.log(`修复前: recall@10=${(oldR10/n).toFixed(3)} 零召回=${(oldZero/n*100).toFixed(1)}%`);
if (docLayerQ.length) console.log(`doc层 recall@10（文档意图子集 n=${docLayerQ.length}）= ${(docLayerQ.reduce((a,b)=>a+b,0)/docLayerQ.length).toFixed(3)}`);
