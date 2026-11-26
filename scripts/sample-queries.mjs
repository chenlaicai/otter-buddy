/**
 * Phase B 首轮分层采样：从快照 search_query_logs 抽 20 条真实查询。
 * 设计真相源：R20261126amrca Phase B（分层覆盖 7 类场景；保留查询发生时上下文）。
 * 口径沿用 real-rerank.eval.ts 基础过滤 + 哈希序固定选样；场景标签为启发式粗分，
 * 供抽样覆盖用，不替代标注指南里的场景判定。
 * 「无答案」类无法可靠启发式识别 → 留给标注阶段标记（报告注明），不进抽样配额。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : def;
}
const REPO_ROOT = arg('--repo-root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SNAP = arg('--snapshot');
const EVAL_DIR = arg('--eval-dir');
if (!SNAP || !EVAL_DIR) {
  console.error('缺少 --snapshot <快照db> 或 --eval-dir <评测数据目录>');
  process.exit(1);
}
fs.mkdirSync(EVAL_DIR, { recursive: true });
const OUT = path.join(EVAL_DIR, "sampled-queries.json");

const require2 = createRequire(path.join(REPO_ROOT, "package.json"));
const Database = require2("better-sqlite3");

const RECENT_FROM = "2026-11-01T00:00:00Z";
const ANCHOR_QUERY = /(?:^|[^\w])[FR]\d{8}-?[a-z0-9]{4,10}(?:[^\w]|$)/i;
const SAMPLE_SIZE = 20;

/** 场景标签优先覆盖序（每标签先保 2 条；无答案类不进抽样，见头注） */
const TAG_ORDER = ["time-update", "cross-conv-followup", "confusable", "doc-locate", "multi-evidence", "current-conv"];
const TAG_MIN = 2;

/** 启发式场景标签（多标签按优先级取主标签） */
function classify(query, convRecentCount) {
  const q = query;
  const tags = [];
  if (/(最新|现在|今天|最近|刚刚|目前|当前版本|这个版本|latest|now|today|recent)/iu.test(q)) tags.push("time-update");
  if (/(上次|之前|刚才|那天|先前|早前|前面说的|上面提到|上次说的|previously|earlier)/iu.test(q)) tags.push("cross-conv-followup");
  if (/(区别|对比|差异|哪个好|还是.{0,12}好|有什么不同|不一样|vs\.?\s)/iu.test(q)) tags.push("confusable");
  if (/(文档|特性|skill|设计方案|研究报告|实现细节|源码|代码|哪个文件|在哪定义|PR\s*#|issue)/iu.test(q)) tags.push("doc-locate");
  if (/(怎么|如何|为什么|原因|影响|哪些|所有|证据|来源|方案|机制|流程|架构)/iu.test(q)) tags.push("multi-evidence");
  if (convRecentCount >= 2) tags.push("current-conv");
  return tags;
}

const db = new Database(SNAP, { readonly: true, fileMustExist: true });
try {
  const rows = db.prepare(`
    SELECT id, query, conversation_id, created_at, detail_level, context_messages, total, top_entry_ids
    FROM search_query_logs
    WHERE created_at >= ? AND total >= 5 AND library IS NULL
    ORDER BY created_at
  `).all(RECENT_FROM);

  // 每对话时间窗口计数（当前对话优先判定：该查询前 7 天内同对话已有查询次数）
  const convTimes = new Map();
  for (const r of rows) {
    if (!convTimes.has(r.conversation_id)) convTimes.set(r.conversation_id, []);
    convTimes.get(r.conversation_id).push(r.created_at);
  }
  const recentCount = (convId, t) => {
    const cutoff = new Date(new Date(t).getTime() - 7 * 86400_000).toISOString();
    return convTimes.get(convId).filter((x) => x >= cutoff && x <= t).length - 1;
  };

  const seen = new Set();
  const perConv = new Map();
  const eligible = [];
  for (const r of rows) {
    const normalized = String(r.query).trim().toLowerCase().replace(/\s+/g, " ");
    if (ANCHOR_QUERY.test(String(r.query)) || seen.has(normalized)) continue;
    if ((perConv.get(r.conversation_id) ?? 0) >= 2) continue;
    seen.add(normalized);
    perConv.set(r.conversation_id, (perConv.get(r.conversation_id) ?? 0) + 1);
    const tags = classify(String(r.query), recentCount(r.conversation_id, r.created_at));
    eligible.push({
      queryId: String(r.id),
      query: String(r.query),
      conversationId: String(r.conversation_id),
      createdAt: String(r.created_at),
      detailLevel: r.detail_level,
      total: r.total,
      context: JSON.parse(String(r.context_messages)).slice(-5),
      primaryTag: tags[0] ?? "generic",
      allTags: tags,
    });
  }

  // 多标签贪心覆盖：每标签先保 TAG_MIN 条（哈希序），允许多标签查询同时服务多标签，再哈希序补齐
  const byHash = (a, b) => createHash("sha256").update(a.queryId).digest("hex")
    .localeCompare(createHash("sha256").update(b.queryId).digest("hex"));
  const picked = [];
  const usedIds = new Set();
  const tagCovered = new Map(TAG_ORDER.map((t) => [t, 0]));
  for (const tag of TAG_ORDER) {
    for (const e of eligible.filter((e) => e.allTags.includes(tag) && !usedIds.has(e.queryId)).sort(byHash)) {
      if ((tagCovered.get(tag) ?? 0) >= TAG_MIN) break;
      if (picked.includes(e)) continue;
      picked.push(e); usedIds.add(e.queryId);
      for (const t of e.allTags) tagCovered.set(t, (tagCovered.get(t) ?? 0) + 1);
    }
  }
  for (const e of eligible.filter((e) => !usedIds.has(e.queryId)).sort(byHash)) {
    if (picked.length >= SAMPLE_SIZE) break;
    picked.push(e); usedIds.add(e.queryId);
  }

  const tagDist = {};
  for (const e of picked) for (const t of e.allTags) tagDist[t] = (tagDist[t] ?? 0) + 1;
  fs.writeFileSync(OUT, JSON.stringify({ protocol: { sampleSize: SAMPLE_SIZE, recentFrom: RECENT_FROM, tagMin: TAG_MIN, eligibleTotal: eligible.length }, tagDist, queries: picked }, null, 2));
  console.log(`eligible=${eligible.length} picked=${picked.length} tagDist=${JSON.stringify(tagDist)} -> ${OUT}`);
  for (const e of picked) console.log(`  [${e.primaryTag}] ${e.query.slice(0, 60)}`);
} finally {
  db.close();
}
