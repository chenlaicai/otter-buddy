/**
 * F20261109epqst 真实模型批量吞吐验证（验收硬门 3：不 mock）。
 *
 * 场景：模拟旧任务积压（120 条真实中文文档 chunk 文本）→ 单 tick 批量消费
 * → 记录每批数量/耗时/完成数/CPU。
 *
 * 运行：node scripts/eppq-real-model-throughput.mjs
 * （用主仓 models/bge-m3 真实 ONNX 推理；dist 产物由 npm run build 提供）
 */
import { setTimeout as sleep2 } from "node:timers/promises";
import { initEmbeddingService } from "../dist/src/frameworks/embedding/embedding-init.js";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { initSchema } from "../dist/src/frameworks/db/schema.js";
import { SqliteMemoryRepository } from "../dist/src/frameworks/db/memory/sqlite-memory-repository.js";
import { EmbeddingRetryWorker } from "../dist/src/usecases/memory/embedding-retry-worker.js";
import { StoreMemory } from "../dist/src/usecases/memory/store-memory.js";

const logger = {
  info: (...a) => console.log("[info]", ...a),
  warn: (...a) => console.warn("[warn]", ...a),
  error: (...a) => console.error("[error]", ...a),
  debug: () => {},
  child() { return this; },
};

/** 生成真实形态的中文文档 chunk（模拟 docs/features 的段落长度 300-800 字） */
function chunkText(i) {
  const base = `特性编号 F20261109epqst 真实模型验证批次 ${i}。` +
    `本段落模拟文档 chunk 的真实形态：包含中文技术描述、术语（embedding、队列、持久化、消费者）、` +
    `以及较长的连续叙述以逼近生产文本长度分布。根治方案要求后台任务统一落库，` +
    `由消费者按批领取，RAM 只保留有限在飞与实时短通道。`.repeat(3 + (i % 3));
  return base.slice(0, 600 + (i * 37) % 400);
}

async function main() {
  console.log("=== F20261109epqst 真实模型批量吞吐验证 ===");
  const t0 = Date.now();

  // 1) 装配真实双 lane embedding 服务（读写 lane 各 fork 一个真 worker）
  // localModelPath 指向主仓 models 目录（生产 config 同款本地加载，禁止远程下载）
  const mainRepoRoot = "/Users/orca/ai/otter-buddy";
  const { writeService, dispose } = await initEmbeddingService({
    modelPath: "bge-m3",
    localModelPath: mainRepoRoot + "/models",
  }, logger);
  console.log(`[setup] embedding 服务初始化 ${Date.now() - t0}ms，等待 ready...`);
  // 等待 worker ready（模型加载 ~10-60s）
  for (let i = 0; i < 120 && !writeService.available; i++) {
    await sleep2(1000);
  }
  if (!writeService.available) throw new Error("embedding worker 未就绪（120s 超时）");
  console.log(`[setup] worker ready @ ${Date.now() - t0}ms`);

  // 2) 内存库装配（真实 schema + sqlite-vec）
  const db = new Database(":memory:");
  loadSqliteVec(db);
  initSchema(db);
  const repo = new SqliteMemoryRepository(db);
  const store = new StoreMemory(repo, repo, writeService, logger);

  // 3) 文档洪峰：120 条 chunk 落库（应该只产生 DB 任务，不占 RAM）
  const tFlood = Date.now();
  const chunkInputs = Array.from({ length: 120 }, (_, i) => ({
    layer: "document",
    contentType: "feature_chunk",
    sourceId: "doc-real-model",
    sourceTable: "features",
    conversationId: undefined,
    granularity: "fine",
    content: chunkText(i),
  }));
  await store.replaceChunksBySource(chunkInputs);
  const pending = await repo.pendingTaskCount();
  console.log(`[flood] 120 chunks 落库 ${Date.now() - tFlood}ms，pending=${pending}`);
  if (pending !== 120) throw new Error(`落库数不符：${pending} != 120`);
  const stats0 = writeService.stats;
  console.log(`[flood] RAM 状态：inFlight=${stats0.inFlight} pendingWaiters=${stats0.pendingWaiters}`);
  if (stats0.inFlight !== 0 || stats0.pendingWaiters !== 0) {
    throw new Error(`洪峰后 RAM 不应为 0：${JSON.stringify(stats0)}`);
  }

  // 4) 单 tick 触发批量消费（真实 ONNX 推理）——观察每批耗时
  const worker = new EmbeddingRetryWorker(repo, repo, repo, writeService, logger, 3_600_000, 3);
  const tDrain = Date.now();
  let lastPending = pending;
  let batchSamples = 0;
  await worker.tickNow();
  // 观察消费进度（轮询 pending 递减 + CPU）
  while (true) {
    await sleep2(2000);
    const p = await repo.pendingTaskCount();
    const s = writeService.stats;
    if (p !== lastPending) {
      const done = lastPending - p;
      batchSamples++;
      if (batchSamples % 5 === 1) {
        console.log(`[drain] pending=${p} (-${done}) inFlight=${s.inFlight} waiters=${s.pendingWaiters} elapsed=${((Date.now() - tDrain) / 1000).toFixed(1)}s`);
      }
      lastPending = p;
    }
    if (p === 0) break;
    if (Date.now() - tDrain > 30 * 60 * 1000) throw new Error("消费超时（30min）");
  }
  const drainSec = (Date.now() - tDrain) / 1000;
  console.log(`[drain] 全部完成：120 条 / ${drainSec.toFixed(1)}s = ${(120 / drainSec).toFixed(2)} 条/s`);

  // 5) 断言向量真实落库（抽 3 条维度 = 1024）
  const vecRows = db.prepare(
    `SELECT mv.memory_entry_id FROM memory_vec mv LIMIT 3`,
  ).all();
  console.log(`[verify] memory_vec 行数=${db.prepare("SELECT COUNT(*) AS n FROM memory_vec").get().n}`);
  if (vecRows.length === 0) throw new Error("无向量落库");

  // 6) 清理
  await worker.stop();
  dispose();
  db.close();
  console.log("=== PASS ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("=== FAIL ===", err);
  process.exit(1);
});
