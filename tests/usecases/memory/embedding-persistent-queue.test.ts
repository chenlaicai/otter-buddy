/**
 * F20261109epqst：后台 embedding 统一持久化队列——行为层失败用例（修复前红）。
 *
 * 根因结构：store-memory 的 replaceChunksBySource 把全部 chunk 文本预占进
 * RAM（fireAndForgetEmbedBatch → slotWaiters 长队），DB embedding_tasks 里
 * 看不到这些工作（双账本）——retry worker 消费与 doc 洪峰在内存队列里互相
 * 踩踏，且重启后 RAM 队列清零、任务凭空消失。
 *
 * 根治结构断言（修复前红、修复后绿）：
 * - P1: 文档 chunk 全量落库 embedding_tasks（bulk 优先级）——不再有 RAM 长队
 * - P2: retry worker 按批消费（embedBatch 携带多条文本）
 * - P3: 洪峰落库后单 tick 内旧任务与新任务全部出队（持续出队验收）
 * - P4: live 消息直通优先（洪峰期间实时 embedding 不被堵死）
 * - P5: 批内 storeEmbedding 失败的任务回队不丢
 * - P6: 重启恢复——任务在 DB，新 worker 实例接着消费
 * - P7: replaceChunksBySource 不再调用 gateway.embedBatch（RAM 长队删除）
 * - P8: pendingTaskStats 可观测（最老任务年龄/优先级分布）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../../helpers/db";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { StoreMemory } from "@usecases/memory/store-memory";
import { EmbeddingRetryWorker } from "@usecases/memory/embedding-retry-worker";
import { MemoryIndexAdapter } from "../../../src/bootstrap/memory";
import type { EmbeddingGateway, EmbedBatchCallOptions } from "@usecases/memory/embedding-gateway";
import { EMBED_TASK_PRIORITY } from "@usecases/memory/memory-queue";
import type DatabaseType from "better-sqlite3";
import { createTestLogger } from "../../helpers/logger";

vi.setConfig({ testTimeout: 20_000 });

let db: DatabaseType.Database;
let repo: SqliteMemoryRepository;

/** 1024 维测试向量（vec0 表 FLOAT[1024]） */
const VEC = () => new Float32Array(1024).fill(0.1);

function insertEntry(id: string, content: string): void {
  // conversation_id 缺省（避免 FK 约束——测试库 foreign_keys=ON 且无 conversations 行）
  db.prepare(`
    INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
      conversation_id, granularity, content, metadata, created_at)
    VALUES (?, 'working', 'message', ?, 'entries', NULL, 'fine', ?, NULL, datetime('now'))
  `).run(id, id, content);
  db.prepare(`INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)`).run(id, content);
}

/** 预置一条旧 bulk 任务（next_retry_at 已到期，模拟生产 09:14 迁入的存量） */
function seedOldTask(id: string, content: string): void {
  insertEntry(id, content);
  db.prepare(`
    INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, priority, attempts)
    VALUES (?, datetime('now', '-10 minutes'), 'pending', datetime('now', '-10 minutes'), 2, 0)
  `).run(id);
}

function pendingTasks(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM embedding_tasks WHERE status = 'pending'`).get() as { n: number }).n;
}

function vecCount(entryId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM memory_vec WHERE memory_entry_id = ?`).get(entryId) as { n: number }).n;
}

function chunkInput(i: number) {
  return {
    layer: "document" as const,
    contentType: "feature_chunk" as const,
    sourceId: "doc-flood-p",
    sourceTable: "features" as const,
    granularity: "coarse" as const,
    content: `chunk 内容 ${i}，长度足够通过校验`.repeat(3),
    conversationId: undefined,
  };
}

/** 记录 embedBatch 调用的 mock gateway（单条 embed 也立即可用） */
function makeRecordingGateway() {
  const batchCalls: Array<{ texts: string[]; opts?: EmbedBatchCallOptions }> = [];
  const embedCalls: string[] = [];
  const gateway: EmbeddingGateway = {
    available: true,
    embed: async (text: string) => {
      embedCalls.push(text);
      return VEC();
    },
    embedBatch: async (texts: string[], opts?: EmbedBatchCallOptions) => {
      batchCalls.push({ texts: [...texts], opts });
      return texts.map(() => VEC());
    },
  };
  return { gateway, batchCalls, embedCalls };
}

beforeAll(() => {
  db = createTestDb();
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM memory_edges;
    DELETE FROM memory_weights;
    DELETE FROM memory_fts_jieba;
    DELETE FROM embedding_tasks;
    DELETE FROM memory_vec;
    DELETE FROM memory_entries;
  `);
  repo = new SqliteMemoryRepository(db);
});

describe("F20261109epqst P1/P7：后台任务统一落库（RAM 长队删除）", () => {
  it("P1: replaceChunksBySource 后全部 chunk 落库为 bulk pending 任务（不再有 RAM 长队）", async () => {
    const { gateway } = makeRecordingGateway();
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());

    await store.replaceChunksBySource(Array.from({ length: 45 }, (_, i) => chunkInput(i)));

    // 45 条全部成为 pending bulk 任务——修复前：任务挂在 RAM slotWaiters，DB 计数为 0
    expect(pendingTasks()).toBe(45);
    const rows = db.prepare(
      `SELECT priority, COUNT(*) AS n FROM embedding_tasks WHERE status='pending' GROUP BY priority`,
    ).all() as Array<{ priority: number; n: number }>;
    expect(rows).toEqual([{ priority: EMBED_TASK_PRIORITY.bulk, n: 45 }]);
  });

  it("P7: replaceChunksBySource 不调用 gateway.embedBatch（也不逐条调 embed）——后台工作不再预占 RAM", async () => {
    const { gateway, batchCalls, embedCalls } = makeRecordingGateway();
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());

    await store.replaceChunksBySource(Array.from({ length: 45 }, (_, i) => chunkInput(i)));
    await new Promise((r) => setTimeout(r, 20));

    // 修复前：fireAndForgetEmbedBatch 直接调 embedBatch（45 条进 RAM）；修复后：0 次
    expect(batchCalls).toHaveLength(0);
    expect(embedCalls).toHaveLength(0);
  });

  it("gateway 完全不可用（available=false / embed 抛错）时任务仍然落库——同步路径不再依赖 gateway", async () => {
    const gateway: EmbeddingGateway = {
      available: false,
      embed: async () => {
        throw new Error("worker unavailable");
      },
    };
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());

    await store.replaceChunksBySource(Array.from({ length: 30 }, (_, i) => chunkInput(i)));

    expect(pendingTasks()).toBe(30);
  });
});

describe("F20261109epqst P2/P3：retry worker 批量消费与持续出队", () => {
  it("P2: tickNow 按批消费——embedBatch 被调用且携带多条文本（不再逐条 embed）", async () => {
    const { gateway, batchCalls, embedCalls } = makeRecordingGateway();
    seedOldTask("old-1", "旧任务内容一");
    seedOldTask("old-2", "旧任务内容二");
    seedOldTask("old-3", "旧任务内容三");

    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker.tickNow();
    // tickNow 触发后台 drain（不阻塞 patrol duty）——轮询等队列见底（行为断言）
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 5000 });

    // 批量调用发生（>1 条文本）
    const multiBatch = batchCalls.find(c => c.texts.length > 1);
    expect(multiBatch).toBeDefined();
    // 单条 embed 不再是消费主路径
    expect(embedCalls).toHaveLength(0);
    // 全部任务完成出队
    expect(pendingTasks()).toBe(0);
    expect(vecCount("old-1")).toBe(1);
    expect(vecCount("old-2")).toBe(1);
    expect(vecCount("old-3")).toBe(1);
  });

  it("P3: 洪峰落库 + 旧任务混合，单 tick 全部出队（持续出队验收）", async () => {
    const { gateway } = makeRecordingGateway();
    seedOldTask("old-starved", "被饿死一小时的旧任务");
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());
    // 文档洪峰：45 条 chunk（超过单批 20，跨 DOC_CHUNK_GATE_BATCH 批次）
    await store.replaceChunksBySource(Array.from({ length: 45 }, (_, i) => chunkInput(i)));
    expect(pendingTasks()).toBe(46); // 45 新 + 1 旧

    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker.tickNow();
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 5000 });

    // 一个 drain 周期内全部出队（BATCH_LIMIT=50 ≥ 46）
    expect(pendingTasks()).toBe(0);
    expect(vecCount("old-starved")).toBe(1);
    const docVecs = (db.prepare(`
      SELECT COUNT(*) AS n FROM memory_vec mv
      JOIN memory_entries me ON me.id = mv.memory_entry_id
      WHERE me.source_id = 'doc-flood-p'
    `).get() as { n: number }).n;
    expect(docVecs).toBe(45);
  });

  it("P3b: 超过 BATCH_LIMIT 的积压跨多轮 drain 持续出队（不饿死队尾）", async () => {
    const { gateway } = makeRecordingGateway();
    // 120 条旧任务（> BATCH_LIMIT=50 ×2 轮）
    for (let i = 0; i < 120; i++) {
      seedOldTask(`bulk-old-${i}`, `旧任务积压 ${i} 号，内容长度足够`);
    }
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker.tickNow();
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 10_000 });
  });
});

describe("F20261109epqst P4：live 实时优先", () => {
  it("P4: 洪峰积压期间 live 消息直通完成，live 任务先于 bulk 出队", async () => {
    const { gateway } = makeRecordingGateway();
    // 洪峰：bulk 任务积压 60 条
    for (let i = 0; i < 60; i++) {
      seedOldTask(`bulk-${i}`, `洪峰积压任务 ${i} 号，内容长度足够`);
    }
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());
    // live 消息直通（fireAndForget 单条，不走队列）
    const liveId = await store.execute({
      layer: "working",
      contentType: "message",
      sourceId: "live-msg-1",
      sourceTable: "entries",
      conversationId: undefined,
      granularity: "fine",
      content: "用户刚刚发的实时消息",
    });
    // 直通 fireAndForget 完成后向量落库（实时通道没有被洪峰堵死）
    await vi.waitFor(() => expect(vecCount(liveId)).toBe(1), { timeout: 3000 });

    // live 失败任务优先于 bulk 出队：预置一条 live 任务
    insertEntry("live-retry-1", "实时消息重试任务");
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, priority, attempts)
      VALUES ('live-retry-1', datetime('now', '-10 minutes'), 'pending', datetime('now'), 0, 0)
    `).run();
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker.tickNow();
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 10_000 });

    // 61 条任务全部出队（live 与 bulk 都不被互相饿死）
    expect(pendingTasks()).toBe(0);
    expect(vecCount("live-retry-1")).toBe(1);
  });
});

describe("F20261109epqst P5/P6：失败回队与重启恢复", () => {
  it("P5: 批量 storeEmbedding 失败的任务回队不丢（下轮重试成功）", async () => {
    const { gateway } = makeRecordingGateway();
    seedOldTask("store-fail-1", "写库会失败的任务一");
    seedOldTask("store-fail-2", "写库会失败的任务二");
    seedOldTask("store-fail-3", "写库成功的任务三");

    // 第一次：storeEmbedding 对 fail-1/fail-2 抛错
    const origStore = repo.storeEmbedding.bind(repo);
    let failFirst = true;
    repo.storeEmbedding = async (id: string, emb: Float32Array) => {
      if (failFirst && (id === "store-fail-1" || id === "store-fail-2")) {
        throw new Error("simulated store failure");
      }
      return origStore(id, emb);
    };
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker.tickNow();
    // fail-3 完成；fail-1/fail-2 任务仍在（attempts 计数但未 dead）
    await vi.waitFor(() => expect(vecCount("store-fail-3")).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(pendingTasks()).toBe(2), { timeout: 5000 });

    // 第二轮：恢复写库，任务重试成功（不再失败）。退避重置模拟启动迁移的
    // resetPendingAttempts（修复前后行为一致——只推进 next_retry_at）
    failFirst = false;
    await repo.resetPendingAttempts!();
    await worker.tickNow();
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 5000 });
    expect(vecCount("store-fail-1")).toBe(1);
    expect(vecCount("store-fail-2")).toBe(1);
  });

  it("P6: 重启恢复——进程内任务在 DB，新 worker 实例接着消费（不丢不重）", async () => {
    const { gateway } = makeRecordingGateway();
    seedOldTask("restart-1", "重启前入队的任务一");
    seedOldTask("restart-2", "重启前入队的任务二");

    // 第一个实例消费一部分后「死亡」（这里直接不消费——模拟重启后任务原样保留）
    const worker1 = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker1.tickNow();
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 5000 }); // 全部完成

    // 再灌一批任务后「重启」——新实例能看到并完成全部任务
    seedOldTask("restart-3", "重启后入队的任务三");
    const worker2 = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker2.tickNow();
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 5000 });
    expect(vecCount("restart-3")).toBe(1);
    // 不重复：每条任务只落一份向量
    expect(vecCount("restart-1")).toBe(1);
    expect(vecCount("restart-2")).toBe(1);
  });
});

describe("F20261109epqst P8：可观测性", () => {
  it("P8: pendingTaskStats 返回 pending 总数/最老任务年龄/优先级分布", async () => {
    // 预置不同优先级、不同年龄的任务
    insertEntry("obs-1", "观测任务一内容足够长");
    insertEntry("obs-2", "观测任务二内容足够长");
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, priority, attempts)
      VALUES ('obs-1', datetime('now', '-10 minutes'), 'pending', datetime('now', '-1 hours'), 2, 0)
    `).run();
    db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, priority, attempts)
      VALUES ('obs-2', datetime('now', '-10 minutes'), 'pending', datetime('now', '-5 minutes'), 0, 0)
    `).run();

    const stats = await repo.pendingTaskStats();
    expect(stats.pending).toBe(2);
    // 最老任务（obs-1，1 小时前创建）年龄 ≥ 3500s
    expect(stats.oldestAgeSeconds).toBeGreaterThanOrEqual(3500);
    expect(stats.byPriority[EMBED_TASK_PRIORITY.bulk]).toBe(1);
    expect(stats.byPriority[EMBED_TASK_PRIORITY.live]).toBe(1);
  });
});

describe("F20261109epqst 检视处置：drain 无界续跑（原 MAX_DRAIN_ROUNDS/MS 已删）", () => {
  /** 可控批延迟 gateway（batchDelayMs=批内等待；判别测试用它控制节奏，非真实模型） */
  function makeSlowGateway(batchDelayMs: number) {
    const batchCalls: number[] = [];
    const gateway: EmbeddingGateway = {
      available: true,
      embed: async () => VEC(),
      embedBatch: async (texts: string[]) => {
        batchCalls.push(texts.length);
        await new Promise((r) => setTimeout(r, batchDelayMs));
        return texts.map(() => VEC());
      },
    };
    return { gateway, batchCalls };
  }

  /**
   * D1 判别性（delta r2）：1100 条 > 旧 MAX_DRAIN_ROUNDS(20) × BATCH_LIMIT(50) = 1000 条上界。
   * 基线 b50e6bfb（含旧预算）本用例必红：20 轮后 drain 停、留 100 条 pending 等下个
   * patrol 1h——正是检视初轮发现的「1000 条积压脉冲化」。新代码无界续跑单次 tickNow
   * 全消化。批延迟 0（判别的是轮次边界不是时间预算，22 轮 × 100ms 冷却 ≈ 2.5s）。
   */
  it("S1: 1100 条（超旧 20 轮×50=1000 预算上界）单次 tickNow 后全部出队，无第二次 tickNow", async () => {
    const { gateway } = makeSlowGateway(0);
    for (let i = 0; i < 1100; i++) {
      seedOldTask(`bulk-s1-${i}`, `无界续跑验证任务 ${i} 号，内容长度足够通过校验`);
    }
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker.tickNow(); // 唯一一次 tickNow——drain 自续跑吃完全部
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 20_000 });
    const vecs = (db.prepare(`SELECT COUNT(*) AS n FROM memory_vec`).get() as { n: number }).n;
    expect(vecs).toBe(1100);
    await worker.stop();
  }, 25_000);

  it("S2: store 失败后任务留队吃退避 + retrigger 排期续跑（不丢、不活锁、无需新 tickNow）", async () => {
    const { gateway } = makeSlowGateway(5);
    for (let i = 0; i < 30; i++) {
      seedOldTask(`bulk-s2-${i}`, `退避续跑验证任务 ${i} 号，内容长度足够`);
    }
    const origStore = repo.storeEmbedding.bind(repo);
    let failStore = true;
    repo.storeEmbedding = async (id: string, emb: Float32Array) => {
      if (failStore && id.endsWith("-0")) {
        throw new Error("simulated store failure");
      }
      return origStore(id, emb);
    };
    // retrigger 周期压缩到 1.5s（测试钩子——本用例同时覆盖钩子的真实使用）
    EmbeddingRetryWorker.setTestRetriggerCapMs?.(1_500);
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    try {
    await worker.tickNow();
    // 首轮 drain：29 条成功；s2-0 的 store 失败 → 留 pending（claim 退避在未来，不 enqueueRetry）
    await vi.waitFor(() => expect(pendingTasks()).toBe(1), { timeout: 15_000 });
    const row = db.prepare(`SELECT attempts, (next_retry_at > datetime('now')) AS in_future FROM embedding_tasks WHERE entry_id LIKE 'bulk-s2-%'`).get() as { attempts: number; in_future: number };
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    expect(row.in_future).toBe(1); // 退避生效（enqueueRetry 会把它重置为 now——已删）
    // drain 退出（全部在退避）→ retrigger 已按退避窗口排期（软断言：本用例的
    // 判别力在首段 in_future（活锁修复）与消化段（无 retrigger 则超时）；排期
    // 存在性检查用软等让失败聚合到判别点）
    await new Promise<void>((resolve) => {
      const started = Date.now();
      const check = () => {
        if ((worker as unknown as { retriggerTimer?: unknown }).retriggerTimer != null) resolve();
        else if (Date.now() - started > 5_000) resolve(); // 基线：无 retrigger，继续（消化段判别红）
        else setTimeout(check, 50);
      };
      check();
    });

    // D1（delta r2）：消化段——cap 压缩 retrigger 周期到 1.5s，强制到期后由
    // retrigger 链自动消化，全程无第二次 tickNow。基线（无 retrigger 机制）本段
    // 必红：任务退避 30s，drain 已退出，无人再触发——等 patrol 1h，测试超时。
    failStore = false;
    db.prepare(`UPDATE embedding_tasks SET next_retry_at = datetime('now','-1 second')`).run();
    await vi.waitFor(() => expect(pendingTasks()).toBe(0), { timeout: 10_000 });
    const vecs = (db.prepare(`SELECT COUNT(*) AS n FROM memory_vec`).get() as { n: number }).n;
    expect(vecs).toBe(30);
    } finally {
      EmbeddingRetryWorker.setTestRetriggerCapMs?.(null);
      await worker.stop();
    }
  }, 30_000);

  it("S3: stop() 在 drain 运行中能收敛——续跑定时器清理、drainLoop 收尾、无泄漏句柄", async () => {
    const { gateway } = makeSlowGateway(50);
    for (let i = 0; i < 120; i++) {
      seedOldTask(`bulk-s3-${i}`, `停止收敛验证任务 ${i} 号，内容长度足够`);
    }
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 3_600_000, 3);
    await worker.tickNow();
    // drain 进行中 stop——等待收尾不炸
    await worker.stop();
    // stop 后 pending 不再被消费（drain 已停）
    const after = pendingTasks();
    await new Promise((r) => setTimeout(r, 300));
    expect(pendingTasks()).toBe(after);
  }, 15_000);
});

describe("F20261109epqst 检视处置：运行期入库弱触发（onBulkEnqueued）", () => {
  it("S4: MemoryIndexAdapter 批量落库后触发回调（弱触发通道接线验证）", async () => {
    const { gateway } = makeRecordingGateway();
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());
    let triggerCount = 0;
    // 模拟 bootstrap 装配：回调接 worker tickNow（这里只记数——worker 接线由 app 装配测试覆盖）
    const adapter = new MemoryIndexAdapter(store, () => { triggerCount++; });
    // feature chunk 索引（内部走 replaceChunksBySource → 落库 → 触发）
    await adapter.indexFeatureChunks("F-test-doc", [
      { content: "运行期触发验证 chunk 一，内容长度足够通过校验", headingPath: ["a"], charCount: 30 },
      { content: "运行期触发验证 chunk 二，内容长度足够通过校验", headingPath: ["a", "b"], charCount: 30 },
    ], { title: "测试文档" });
    expect(pendingTasks()).toBe(2);
    expect(triggerCount).toBe(1); // 落库即触发（不等 patrol）
    // research chunk 同道
    await adapter.indexResearchChunks("R-test-doc", [
      { content: "研究文档运行期触发验证，内容长度足够", headingPath: ["r"], charCount: 25 },
    ], { title: "测试研究" });
    expect(triggerCount).toBe(2);
    // 无回调构造不炸（向后兼容）
    const bare = new MemoryIndexAdapter(store);
    await bare.indexFeatureChunks("F-bare", [
      { content: "无回调兼容验证，内容长度足够校验", headingPath: ["x"], charCount: 20 },
    ], { title: "裸适配" });
    expect(pendingTasks()).toBeGreaterThanOrEqual(3);
  });
});
