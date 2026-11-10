/** alpha.sh 实例的真实服务冒烟：文档洪峰回填 + HTTP 实时消息 + health 回读。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, ".otter-alpha.json"), "utf8"));
const db = new Database(path.join(lock.alpha_root, "otter-buddy.db"), { readonly: true });
loadSqliteVec(db);
const headers = {
  "content-type": "application/json",
  "X-Otter-User-Id": "script:embrc-alpha-smoke",
  "X-Otter-User-Role": "admin",
};

function scalar(sql, ...params) {
  return db.prepare(sql).get(...params).n;
}

async function waitFor(label, predicate, timeoutMs = 15 * 60 * 1000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${label} 超时`);
    await sleep(100);
  }
}

async function request(route, options = {}) {
  const response = await fetch(`${lock.base_url}${route}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) throw new Error(`${route} → ${response.status}: ${await response.text()}`);
  return response;
}

function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function sendLiveMessages(count) {
  const conversationResponse = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: `embrc-alpha-${Date.now()}`, otterIds: [] }),
  });
  const conversation = await conversationResponse.json();
  const started = new Map();
  for (let index = 0; index < count; index++) {
    const body = `回填洪峰中的实时消息 ${index} ${Date.now()}`;
    started.set(body, Date.now());
    const response = await request(`/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ senderId: "alpha-smoke", body, talkingStonePassedTo: [] }),
    });
    // entry 已在响应前持久化；不消费 LLM SSE，验证目标是 embedding 而不是生成质量。
    await response.body?.cancel();
  }
  const latencies = [];
  for (const [body, startedAt] of started) {
    await waitFor(`live ${body}`, () => scalar(
      "SELECT COUNT(*) AS n FROM memory_vec mv JOIN memory_entries me ON me.id = mv.memory_entry_id WHERE me.content = ?",
      body,
    ) === 1, 30_000);
    latencies.push(Date.now() - startedAt);
  }
  return latencies;
}

async function main() {
  console.log(`[alpha] ${lock.base_url} db=${lock.alpha_root}`);
  await waitFor("backfill pending", () => scalar(
    "SELECT COUNT(*) AS n FROM embedding_tasks WHERE status = 'pending'",
  ) > 0, 120_000);
  const initialChunkVecs = scalar(
    "SELECT COUNT(*) AS n FROM memory_vec mv JOIN memory_entries me ON me.id = mv.memory_entry_id WHERE me.content_type IN ('feature_chunk', 'research_chunk')",
  );
  const livePromise = sendLiveMessages(10);
  await waitFor("120 backfill chunk vectors", () => scalar(
    "SELECT COUNT(*) AS n FROM memory_vec mv JOIN memory_entries me ON me.id = mv.memory_entry_id WHERE me.content_type IN ('feature_chunk', 'research_chunk')",
  ) - initialChunkVecs >= 120);
  const liveLatencies = await livePromise;
  const liveP95 = percentile95(liveLatencies);
  const health = await (await request("/api/health/memory")).json();
  const pending = scalar("SELECT COUNT(*) AS n FROM embedding_tasks WHERE status = 'pending'");
  const result = {
    backfillCompleted: 120,
    liveCount: liveLatencies.length,
    liveP95Ms: liveP95,
    liveLatenciesMs: liveLatencies,
    pendingRemaining: pending,
    lanes: health.embedding?.lanes,
    queue: health.embedding?.queue,
    alerts: health.embedding?.alerts,
  };
  console.log(JSON.stringify(result, null, 2));
  if (liveP95 >= 2000) throw new Error(`live p95 ${liveP95}ms >= 2000ms`);
  if (!health.embedding?.lanes?.backfill || !health.embedding?.lanes?.live) {
    throw new Error("health 缺 live/backfill lane");
  }
  console.log("=== ALPHA SMOKE PASS ===");
}

main().catch(err => { console.error("=== ALPHA SMOKE FAIL ===", err); process.exitCode = 1; })
  .finally(() => db.close());
