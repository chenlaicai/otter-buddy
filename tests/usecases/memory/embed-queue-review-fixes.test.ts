/**
 * F20261105embqg 对抗审视三发现的修复验证（检视獭点名的三类决定性用例）：
 *
 * 发现 1：首次洪峰受限——空队列（pending=0）灌 2001 条 bulk chunk，
 *         任一时刻「已提交未完成」的 bulk 不得超出水位上界（独立复现的反例）。
 * 发现 2：retry 优先级跨层闭合——claim 的 priority 透传到 embed 调用
 *         （live retry 任务先于已在等的 bulk waiter 被 worker 消费）。
 * 发现 3：S3 跳过的暗条目有运行时恢复路径——retry tick 空闲时（队列空）
 *         有界回填暗条目为 bulk 任务。
 *
 * lint-tests:allow-ddl——豁免理由：发现 2/3 用例需真实 SqliteMemoryRepository
 * （embedding_tasks 表语义 + scanDarkEntries），与 embedding-task-gate.test.ts 同模式。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { initSchema } from "@frameworks/db/schema";
import { StoreMemory } from "@usecases/memory/store-memory";
import { EmbeddingRetryWorker } from "@usecases/memory/embedding-retry-worker";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { EMBED_TASK_PRIORITY, EMBED_QUEUE_HIGH_WATER } from "@usecases/memory/memory-queue";
import type DatabaseType from "better-sqlite3";
import { createTestLogger } from "../../helpers/logger";

let db: DatabaseType.Database;
let repo: SqliteMemoryRepository;

beforeAll(async () => {
  db = new Database(":memory:");
  try { await loadSqliteVec(db); } catch { /* vec 不可用则跳过 */ }
  initSchema(db);
  repo = new SqliteMemoryRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM memory_weights;
    DELETE FROM memory_fts_jieba;
    DELETE FROM embedding_tasks;
    DELETE FROM memory_vec;
    DELETE FROM memory_entries;
  `);
  repo = new SqliteMemoryRepository(db);
});

function chunkInput(i: number) {
  return {
    layer: "document" as const,
    contentType: "feature_chunk" as const,
    sourceId: "doc-flood",
    sourceTable: "documents" as const,
    granularity: "coarse" as const,
    content: `chunk ${i} `.repeat(12), // ≥10 有效字符
    conversationId: undefined,
  };
}

describe("发现 1：首次洪峰受限（空队列也闸得住）", () => {
  it("pending=0 时灌 2001 条，任一时刻在飞 bulk ≤ 水位上界；未提交部分被跳过", async () => {
    let submitted = 0;
    let maxObservedInFlight = 0;
    const neverResolve = new Promise<Float32Array[]>(() => {});
    // 永不完成的 embedBatch——模拟 worker 满转，暴露「提交不受限」
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array(1024).fill(0.1),
      embedBatch: (texts: string[], opts?: { waitSlot?: boolean; priority?: number }) => {
        submitted += texts.length;
        // 每次提交后观测在飞峰值（bulkInFlight 含 waiter——由闸门分批保证）
        maxObservedInFlight = Math.max(maxObservedInFlight, submitted);
        void opts; // waitSlot 语义在 mock 里不生效（service 层已有专测），此处测闸门分批
        return neverResolve;
      },
    };
    const store = new StoreMemory(repo, repo, embedding, createTestLogger());

    const ids = await store.replaceChunksBySource(
      Array.from({ length: EMBED_QUEUE_HIGH_WATER + 1 }, (_, i) => chunkInput(i)),
    );

    // 全部条目入库（FTS/entries 不受闸门影响）
    expect(ids).toHaveLength(EMBED_QUEUE_HIGH_WATER + 1);
    // 已提交的 bulk 受水位约束：pending(0) + 提交量不得超 HIGH_WATER + 单批余量
    // （分批复查间隔 = DOC_CHUNK_GATE_BATCH=20，故上界 = HIGH_WATER + 20 - 1）
    expect(submitted).toBeLessThanOrEqual(EMBED_QUEUE_HIGH_WATER + 19);
    // 2001 条不是全提交（独立复现的 submitted===2001 反例被消灭）
    expect(submitted).toBeLessThan(EMBED_QUEUE_HIGH_WATER + 1);
  });
});

describe("发现 2：retry 优先级跨层闭合（claim → embed 透传）", () => {
  it("live retry 任务 embed 时带 priority=0，先于已排队的 bulk waiter", async () => {
    // 1) 预置一个 live 任务（priority=0）进 embedding_tasks
    db.prepare(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
        conversation_id, granularity, content, metadata, created_at)
      VALUES ('live-retry-1', 'working', 'message', 'live-retry-1', 'messages',
        NULL, 'fine', 'live message content', NULL, datetime('now'))
    `).run();
    db.prepare(`INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES ('live-retry-1', 'live message content')`).run();
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, priority)
      VALUES ('live-retry-1', datetime('now', '-10 minutes'), 'pending', datetime('now'), 0)
    `).run();

    // 2) 记录 embed 调用的 priority
    const embedCalls: Array<{ text: string; priority?: number }> = [];
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async (text: string, opts?: { priority?: number }) => {
        embedCalls.push({ text, priority: opts?.priority });
        return new Float32Array(1024).fill(0.1);
      },
    };

    // 3) 跑一个 tick——claim live 任务并 embed
    const worker = new EmbeddingRetryWorker(repo, repo, repo, embedding, createTestLogger(), 3_600_000, 3);
    await worker.tickNow();

    // live 任务的 embed 调用携带 priority=0（而非默认 1/丢失）
    const liveCall = embedCalls.find(c => c.text.includes("live message"));
    expect(liveCall).toBeDefined();
    expect(liveCall!.priority).toBe(EMBED_TASK_PRIORITY.live);
  });
});

describe("发现 3：S3 跳过的暗条目有运行时恢复路径", () => {
  it("空队列 tick 回填暗条目为 bulk 任务；下个 tick 消费后向量落库、队列归零、不再回填", async () => {
    // 1) 造一个暗条目（无 vec、无 task）
    db.prepare(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
        conversation_id, granularity, content, metadata, created_at)
      VALUES ('dark-1', 'document', 'feature_chunk', 'doc-x', 'documents',
        NULL, 'coarse', 'dark chunk content here', NULL, datetime('now'))
    `).run();
    db.prepare(`INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES ('dark-1', 'dark chunk content here')`).run();

    // mock 必须返回 1024 维（vec0 表 FLOAT[1024]）——维度不符则 storeEmbedding 失败，
    // 任务退回队列，测试会假绿（对抗审视 delta 发现：首轮 1 维 mock 实际
    // Dimension mismatch，pending=1 却被断言成恢复成功）
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array(1024).fill(0.1),
    };

    // 2) 队列空 → 第一 tick：drain 无任务可消费（claimed=0）→ 回填 dark-1 为 bulk 任务。
    // 回填发生在 drain 之后、同 tick 不再消费——任务留存到下个 tick
    const worker = new EmbeddingRetryWorker(repo, repo, repo, embedding, createTestLogger(), 3_600_000, 3);
    await worker.tickNow();
    const refilled = db.prepare("SELECT priority, attempts FROM embedding_tasks WHERE entry_id = 'dark-1'").get() as { priority: number; attempts: number } | undefined;
    expect(refilled?.priority).toBe(EMBED_TASK_PRIORITY.bulk);
    expect(refilled?.attempts).toBe(0); // 只入队未 claim

    // 3) 第二 tick：claim → embed（1024 维）→ storeEmbedding 落库 → markTaskDone。
    // 关键闭合验证：向量真的落库（而非 Dimension mismatch 后退队假绿）
    await worker.tickNow();
    const vecRow = db.prepare("SELECT COUNT(*) AS n FROM memory_vec WHERE memory_entry_id = 'dark-1'").get() as { n: number };
    expect(vecRow.n).toBe(1); // 向量落库实锤
    const pendingAfter = await repo.pendingTaskCount();
    expect(pendingAfter).toBe(0); // 队列归零（消费成功，非失败退队）

    // 4) 第三 tick：暗条目已有向量，不再被 scanDarkEntries 识别 → 无回填循环
    await worker.tickNow();
    expect(await repo.pendingTaskCount()).toBe(0);
  });
});
