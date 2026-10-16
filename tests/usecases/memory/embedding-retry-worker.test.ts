/**
 * F20260812mrcq Part 1：embedding 重试 worker 测试
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { initSchema } from "@frameworks/db/schema";
import { EmbeddingRetryWorker } from "@usecases/memory/embedding-retry-worker";
import { createAndStartRetryWorker } from "../../../src/bootstrap/memory";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { EmbedTimeoutError, EmbedBackpressureError, EmbedTransientError } from "@usecases/memory/embedding-gateway";
import type { Repositories } from "../../../src/bootstrap/types";
import type DatabaseType from "better-sqlite3";
import { createTestLogger } from "../../helpers/logger";

let db: DatabaseType.Database;
let repo: SqliteMemoryRepository;

function makeEmbeddingGateway(impl: (text: string) => Promise<Float32Array> | never): EmbeddingGateway {
  return {
    available: true,
    embed: impl,
  };
}

const SAMPLE_VEC = new Float32Array(1024).fill(0.1);

beforeAll(() => {
  db = new Database(":memory:");
  try { loadSqliteVec(db); } catch { /* vec 不可用则跳过 */ }
  initSchema(db);
  repo = new SqliteMemoryRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  // 清空所有表（注意 FK 顺序：先 subordinate 再 memory_entries）
  db.exec(`
    DELETE FROM memory_weights;
    DELETE FROM memory_fts_jieba;
    DELETE FROM embedding_tasks;
    DELETE FROM memory_vec;
    DELETE FROM memory_entries;
  `);
  // 重建 repo 实例——防止前一个测试的 disableVec() 污染 hasVec 状态
  repo = new SqliteMemoryRepository(db);
});

function insertEntry(id: string, content: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
      conversation_id, granularity, content, metadata, created_at)
    VALUES (?, 'working', 'message', ?, 'messages', NULL, 'fine', ?, NULL, ?)
  `).run(id, id, content, now);
  db.prepare(`INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)`).run(id, content);
  db.prepare(`
    INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged)
    VALUES (?, 0, NULL, 0)
  `).run(id);
}

function getTaskStatus(entryId: string): { status: string; attempts: number } | null {
  const row = db.prepare(
    `SELECT status, attempts FROM embedding_tasks WHERE entry_id = ?`,
  ).get(entryId) as { status: string; attempts: number } | undefined;
  return row ?? null;
}

function getVecCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM memory_vec`).get() as { c: number }).c;
}

describe("EmbeddingRetryWorker - F20260812mrcq Part 1", () => {
  it("P1-AT-1: enqueueRetry 入队，attempts=0", async () => {
    insertEntry("e1", "test content");
    await repo.enqueueRetry("e1", new Error("mock failure"));
    const task = getTaskStatus("e1");
    expect(task).not.toBeNull();
    expect(task!.status).toBe("pending");
    expect(task!.attempts).toBe(0);
  });

  it("P1-AT-6: 反复 enqueueRetry 不重置 attempts（ON CONFLICT 保留）", async () => {
    insertEntry("e2", "content");
    await repo.enqueueRetry("e2", new Error("first"));
    // 模拟已 claim 一次
    await repo.claimPendingTasks(10);
    expect(getTaskStatus("e2")!.attempts).toBe(1);
    // 再次失败入队
    await repo.enqueueRetry("e2", new Error("second"));
    // attempts 应保持 1，不重置
    expect(getTaskStatus("e2")!.attempts).toBe(1);
    expect(getTaskStatus("e2")!.status).toBe("pending");
  });

  it("P1-AT-2: tick 消费成功 → task 删除 + vec 写入", async () => {
    insertEntry("e3", "hello");
    await repo.enqueueRetry("e3", new Error("first failure"));

    const gw = makeEmbeddingGateway(async () => SAMPLE_VEC);
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gw, createTestLogger(), 30_000, 3);
    await worker.tickNow();

    expect(getTaskStatus("e3")).toBeNull();  // task 删除
    expect(getVecCount()).toBe(1);
  });

  it("P1-AT-3: 指数退避——claim 后 next_retry_at 在未来，未到时间不重复 claim", async () => {
    insertEntry("e4", "x");
    await repo.enqueueRetry("e4", new Error("fail"));
    const gw = makeEmbeddingGateway(async () => { throw new Error("always fails"); });
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gw, createTestLogger(), 30_000, 3);

    // 第 1 次 tick：claim（attempts 0→1），embed 抛错，markFailed 不转 dead（1<3）
    await worker.tickNow();
    const task = getTaskStatus("e4");
    expect(task!.attempts).toBe(1);
    expect(task!.status).toBe("pending");
    // next_retry_at 应在未来，立即再 tick 取不到
    const row = db.prepare(
      `SELECT (next_retry_at > datetime('now')) AS in_future FROM embedding_tasks WHERE entry_id='e4'`,
    ).get() as { in_future: number };
    expect(row.in_future).toBe(1);
    await worker.tickNow();
    expect(getTaskStatus("e4")!.attempts).toBe(1);  // 没变

    // 强制到期，第 2 次 tick：attempts=2
    db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second') WHERE entry_id='e4'`).run();
    await worker.tickNow();
    expect(getTaskStatus("e4")!.attempts).toBe(2);
    expect(getTaskStatus("e4")!.status).toBe("pending");

    // 第 3 次 tick：attempts=3 → 转 dead
    db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second') WHERE entry_id='e4'`).run();
    await worker.tickNow();
    const final = getTaskStatus("e4");
    expect(final!.attempts).toBe(3);
    expect(final!.status).toBe("dead");
  });

  it("P1-AT-5: dead-letter 不出现在默认 scanDarkEntries，includeDead=true 才返回", async () => {
    insertEntry("e5", "no-vec");
    // e5 没 vec 索引，直接进入暗化报告
    const defaultReport = await repo.scanDarkEntries();
    expect(defaultReport.total).toBe(1);

    // 让 e5 走到 dead
    await repo.enqueueRetry("e5", new Error("fail"));
    const gw = makeEmbeddingGateway(async () => { throw new Error("always"); });
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gw, createTestLogger(), 30_000, 3);
    for (let i = 0; i < 3; i++) {
      db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second') WHERE entry_id='e5'`).run();
      await worker.tickNow();
    }
    expect(getTaskStatus("e5")!.status).toBe("dead");

    // 默认报告：排除 dead-letter
    const filtered = await repo.scanDarkEntries();
    expect(filtered.total).toBe(0);
    // includeDead=true：含 dead-letter
    const all = await repo.scanDarkEntries(true);
    expect(all.total).toBe(1);
  });

  it("P1-AT-8: vec 禁用时 tick 不消费", async () => {
    insertEntry("e6", "test");
    await repo.enqueueRetry("e6", new Error("fail"));
    repo.disableVec();  // 清表 + 设 hasVec=false

    const gw = makeEmbeddingGateway(async () => SAMPLE_VEC);
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gw, createTestLogger(), 30_000, 3);
    await worker.tickNow();

    // task 应仍在（未被消费）
    expect(getTaskStatus("e6")).not.toBeNull();
    expect(getVecCount()).toBe(0);
  });

  it("P1-AT-11: entry 被删除时 embedding_tasks 联动清理", async () => {
    insertEntry("e7", "to-delete");
    await repo.enqueueRetry("e7", new Error("fail"));
    expect(getTaskStatus("e7")).not.toBeNull();

    await repo.deleteBySource("messages", "e7");
    expect(getTaskStatus("e7")).toBeNull();
  });

  it("P1-AT-12: embedding_tasks 表无 content 列（不冗余存储）", () => {
    const cols = db.prepare(`PRAGMA table_info(embedding_tasks)`).all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain("content");
    expect(colNames).toContain("entry_id");
    expect(colNames).toContain("attempts");
    expect(colNames).toContain("status");
  });

  it("claimPendingTasks 跳过未到 next_retry_at 的任务", async () => {
    insertEntry("e8", "future");
    await repo.enqueueRetry("e8", new Error("fail"));
    // 立即 claim 应能取到（next_retry_at = now）
    const c1 = await repo.claimPendingTasks(10);
    expect(c1).toHaveLength(1);
    // claim 后 next_retry_at 已 +30s，再 claim 应为空
    const c2 = await repo.claimPendingTasks(10);
    expect(c2).toHaveLength(0);
  });

  it("claimPendingTasks 返回空 content 时 tick 转 dead", async () => {
    // entry 不存在但 task 存在（理论场景：手动 SQL 插入 orphan task）
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at)
      VALUES ('orphan', datetime('now'), 'pending', datetime('now'))
    `).run();

    const gw = makeEmbeddingGateway(async () => SAMPLE_VEC);
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gw, createTestLogger(), 30_000, 3);
    // 多次 claim+tick 让 attempts 累加到 maxAttempts 转 dead
    for (let i = 0; i < 3; i++) {
      db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second') WHERE entry_id='orphan'`).run();
      await worker.tickNow();
    }
    const finalStatus = getTaskStatus("orphan");
    expect(finalStatus!.status).toBe("dead");
    expect(finalStatus!.attempts).toBe(3);
  });

  describe("F20261016ebrt 超时不算 dead-letter", () => {
    it("EmbedTimeoutError 不计入 maxAttempts，条目保持 pending", async () => {
      insertEntry("timeout-entry", "timeout content that is long enough");
      await repo.enqueueRetry("timeout-entry", new Error("init"));

      const timeoutGw = makeEmbeddingGateway(async () => {
        throw new EmbedTimeoutError("Embed timeout after 200ms, falling back to FTS5-only");
      });
      const worker = new EmbeddingRetryWorker(repo, repo, repo, timeoutGw, createTestLogger(), 30_000, 3);

      // 连续 5 次超时（远超 maxAttempts=3）——若超时计入 dead-letter，3 次就该 dead
      for (let round = 0; round < 5; round++) {
        db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
        await worker.tickNow();
      }

      const row = db.prepare(
        `SELECT status, attempts FROM embedding_tasks WHERE entry_id = 'timeout-entry'`
      ).get() as { status: string; attempts: number } | undefined;

      // 关键断言：仍是 pending（没被 dead-letter 埋掉）
      expect(row).toBeDefined();
      expect(row!.status).toBe("pending");
    });

    it("普通错误仍计入 maxAttempts，3 次转 dead", async () => {
      insertEntry("err-entry", "error content that is long enough");
      await repo.enqueueRetry("err-entry", new Error("init"));

      const failGw = makeEmbeddingGateway(async () => { throw new Error("real failure"); });
      const worker = new EmbeddingRetryWorker(repo, repo, repo, failGw, createTestLogger(), 30_000, 3);

      for (let round = 0; round < 4; round++) {
        db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
        await worker.tickNow();
      }

      const row = db.prepare(
        `SELECT status FROM embedding_tasks WHERE entry_id = 'err-entry'`
      ).get() as { status: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.status).toBe("dead");
    });
  });

  describe("F20261013ebps 熔断", () => {
    it("连续 3 次全失败 tick 后熔断暂停消费", async () => {
      // 插入 10 条任务（BATCH_LIMIT=10，一次 tick claim 全部）
      for (let i = 0; i < 10; i++) {
        insertEntry(`cb-${i}`, `content-${i}`);
        await repo.enqueueRetry(`cb-${i}`, new Error("init"));
      }

      const failGw = makeEmbeddingGateway(async () => { throw new Error("always fails"); });
      const worker = new EmbeddingRetryWorker(repo, repo, repo, failGw, createTestLogger(), 30_000, 3);

      // 3 次全失败 tick
      for (let round = 0; round < 3; round++) {
        db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
        await worker.tickNow();
      }

      // 验证熔断：第 4 次 tick 不消费（attempts 不再增长）
      const beforeAttempts = db.prepare(
        `SELECT SUM(attempts) as total FROM embedding_tasks WHERE status='pending'`
      ).get() as { total: number };

      db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
      await worker.tickNow();

      const afterAttempts = db.prepare(
        `SELECT SUM(attempts) as total FROM embedding_tasks WHERE status='pending'`
      ).get() as { total: number };

      // 熔断中——attempts 不变（未消费）
      expect(afterAttempts.total).toBe(beforeAttempts.total);
    });

    it("有成功即重置熔断计数", async () => {
      for (let i = 0; i < 10; i++) {
        insertEntry(`reset-${i}`, `content-${i}`);
        await repo.enqueueRetry(`reset-${i}`, new Error("init"));
      }

      // 先 2 次全失败
      const failGw = makeEmbeddingGateway(async () => { throw new Error("fail"); });
      const failWorker = new EmbeddingRetryWorker(repo, repo, repo, failGw, createTestLogger(), 30_000, 3);
      for (let round = 0; round < 2; round++) {
        db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
        await failWorker.tickNow();
      }

      // 换成成功 gateway——1 次成功 tick 重置计数
      const okGw = makeEmbeddingGateway(async () => SAMPLE_VEC);
      const okWorker = new EmbeddingRetryWorker(repo, repo, repo, okGw, createTestLogger(), 30_000, 3);
      db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
      await okWorker.tickNow();

      // 全部成功——task 清空，vec 写入
      expect(getVecCount()).toBe(10);
    });
  });

});

describe("F20260812mrcq Part 1 审视 M3 - createAndStartRetryWorker 存量迁移", () => {
  it("P1-AT-9: 启动时把存量暗化条目批量入队", async () => {
    // 用独立 db 装配完整 repo
    const migDb = new Database(":memory:");
    try { loadSqliteVec(migDb); } catch { /* skip */ }
    initSchema(migDb);
    const migRepo = new SqliteMemoryRepository(migDb);

    // 制造 3 条存量暗化条目（有 entries 无 vec 索引）
    for (let i = 0; i < 3; i++) {
      migDb.prepare(`
        INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
          conversation_id, granularity, content, metadata, created_at)
        VALUES (?, 'working', 'message', ?, 'messages', NULL, 'fine', ?, NULL, ?)
      `).run(`mig-${i}`, `mig-${i}`, `content-${i}`, `2026-08-12T00:00:0${i}Z`);
    }
    // 验证存量暗化存在
    const before = await migRepo.scanDarkEntries();
    expect(before.total).toBe(3);

    // mock Repositories 最小结构
    const mockRepos = { memory: migRepo, memoryReader: migRepo, memoryWriter: migRepo, memoryQueue: migRepo } as unknown as Repositories;
    const mockEmbedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array(1024).fill(0.1),
    };
    const logger = createTestLogger();

    const worker = await createAndStartRetryWorker(mockRepos, mockEmbedding, logger);
    expect(worker).not.toBeNull();

    // 验证 3 条都入队了
    const tasks = migDb.prepare(`SELECT entry_id FROM embedding_tasks`).all() as Array<{ entry_id: string }>;
    expect(tasks.length).toBe(3);
    expect(tasks.map(t => t.entry_id)).toContain("mig-0");
    expect(tasks.map(t => t.entry_id)).toContain("mig-1");
    expect(tasks.map(t => t.entry_id)).toContain("mig-2");

    await worker!.stop();
    migDb.close();
  });

  it("P1-AT-9 变体: vec 禁用时不启动 worker（返回 null）", async () => {
    const migDb = new Database(":memory:");
    try { loadSqliteVec(migDb); } catch { /* skip */ }
    initSchema(migDb);
    const migRepo = new SqliteMemoryRepository(migDb);
    migRepo.disableVec();  // vec 禁用

    const mockRepos = { memory: migRepo, memoryReader: migRepo, memoryWriter: migRepo, memoryQueue: migRepo } as unknown as Repositories;
    const mockEmbedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array(1024).fill(0.1),
    };

    const worker = await createAndStartRetryWorker(mockRepos, mockEmbedding, createTestLogger());
    expect(worker).toBeNull();  // vec 禁用时不启动
    migDb.close();
  });
});

describe("F20261016slvg 背压不计 attempts + salvage 落库去重", () => {
  it("EmbedBackpressureError 不计入 maxAttempts 且终止本轮（条目保持 pending）", async () => {
    insertEntry("bp-entry", "backpressure content that is long enough");
    await repo.enqueueRetry("bp-entry", new Error("init"));

    const bpGw = makeEmbeddingGateway((): Promise<Float32Array> => {
      throw new EmbedBackpressureError("Embedding backpressure: 1 in-flight requests exceed limit 1");
    });
    const worker = new EmbeddingRetryWorker(repo, repo, repo, bpGw, createTestLogger(), 30_000, 3);

    for (let round = 0; round < 4; round++) {
      db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
      await worker.tickNow();
    }

    const row = getTaskStatus("bp-entry");
    // 关键断言：仍是 pending 且 attempts 未被背压消耗（claim 的 attempts+1 来自 claimPendingTasks 自身）
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(getVecCount()).toBe(0);
  });

  it("超时后 salvage 晚到向量落库 + markTaskDone 去重（双轨）", async () => {
    insertEntry("salvage-entry", "salvage content that is long enough");
    await repo.enqueueRetry("salvage-entry", new Error("init"));

    // mock：调用方 promise 超时 reject，但通过 opts.salvage 晚到结果
    const timeoutThenSalvageGw: EmbeddingGateway = {
      available: true,
      embed: (_text: string, opts?: { salvage?: (v: Float32Array) => void }) => {
        // 调用方 30s 超时语义：直接 reject EmbedTimeoutError（模拟超时已发生）
        // 稍后 salvage 晚到向量（模拟 worker 响应到达）
        setTimeout(() => opts?.salvage?.(SAMPLE_VEC), 10);
        return Promise.reject(new EmbedTimeoutError("Embed timeout after 30ms"));
      },
    };
    const worker = new EmbeddingRetryWorker(repo, repo, repo, timeoutThenSalvageGw, createTestLogger(), 30_000, 3);

    await worker.tickNow();
    // salvage 是异步 fire-and-forget——等它落库
    for (let i = 0; i < 100 && getVecCount() === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // 晚到向量经 salvage 落库，任务行被 markTaskDone 删除
    expect(getVecCount()).toBe(1);
    expect(getTaskStatus("salvage-entry")).toBeNull();
  });

  it("tickNow 重入守卫：in-flight tick 期间不并发进入", async () => {
    insertEntry("reentry-entry", "reentry content that is long enough");
    await repo.enqueueRetry("reentry-entry", new Error("init"));

    let release: (() => void) | null = null;
    const slowGw = makeEmbeddingGateway(
      () => new Promise<Float32Array>((resolve) => { release = () => resolve(SAMPLE_VEC); }),
    );
    const worker = new EmbeddingRetryWorker(repo, repo, repo, slowGw, createTestLogger(), 30_000, 3);

    const first = worker.tickNow();
    const second = worker.tickNow(); // in-flight——应立即返回（不消费）
    await second;
    // TS 收窄 workaround：release 在闭包内赋值，外层读需断言回联合类型
    (release as (() => void) | null)?.();
    await first;

    expect(getVecCount()).toBe(1);
  });
});

describe("F20261016slvg 对抗审视修复", () => {
  it("EmbedTransientError 不计入 maxAttempts——反复瞬态失败后条目仍 pending", async () => {
    insertEntry("transient-entry", "transient content that is long enough");
    await repo.enqueueRetry("transient-entry", new Error("init"));
    // 预置 attempts 撑大（模拟活锁期被反复 claim）
    db.prepare(`UPDATE embedding_tasks SET attempts = 5 WHERE entry_id = 'transient-entry'`).run();

    const transientGw = makeEmbeddingGateway((): Promise<Float32Array> => {
      throw new EmbedTransientError("Embedding worker restarting (watchdog)");
    });
    const worker = new EmbeddingRetryWorker(repo, repo, repo, transientGw, createTestLogger(), 30_000, 3);

    for (let round = 0; round < 4; round++) {
      db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
      await worker.tickNow();
    }

    // 瞬态错误不埋单：仍 pending（若走 markTaskAttemptFailed，attempts=6 ≥ 3 必 dead）
    const row = getTaskStatus("transient-entry");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
  });

  it("纯超时轮不计入熔断（吸收态修正）——连续 4 轮全超时后仍继续消费", async () => {
    for (let i = 0; i < 3; i++) {
      insertEntry(`absorb-${i}`, `absorb content ${i}`);
      await repo.enqueueRetry(`absorb-${i}`, new Error("init"));
    }
    // 全部超时
    const timeoutGw = makeEmbeddingGateway(async () => {
      throw new EmbedTimeoutError("Embed timeout after 30ms");
    });
    const worker = new EmbeddingRetryWorker(repo, repo, repo, timeoutGw, createTestLogger(), 30_000, 3);
    for (let round = 0; round < 4; round++) {
      db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
      await worker.tickNow();
    }

    // 换成功 gateway——熔断未开（纯超时轮不算全失败），立即能继续消费
    const okGw = makeEmbeddingGateway(async () => SAMPLE_VEC);
    const okWorker = new EmbeddingRetryWorker(repo, repo, repo, okGw, createTestLogger(), 30_000, 3);
    db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
    await okWorker.tickNow();
    expect(getVecCount()).toBe(3);
    expect(getTaskStatus("absorb-0")).toBeNull();
  });

  it("resetPendingAttempts：pending 任务 attempts 归零并立即可重试", async () => {
    insertEntry("amnesty-entry", "amnesty content that is long enough");
    await repo.enqueueRetry("amnesty-entry", new Error("init"));
    db.prepare(`UPDATE embedding_tasks SET attempts = 7 WHERE entry_id = 'amnesty-entry'`).run();

    const reset = await repo.resetPendingAttempts!();
    expect(reset).toBeGreaterThanOrEqual(1);
    const row = getTaskStatus("amnesty-entry");
    expect(row!.attempts).toBe(0);
  });
});
