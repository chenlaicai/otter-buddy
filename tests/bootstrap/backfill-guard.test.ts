/**
 * F20260902sgp2 S2 前置：backfill 墓碑一次性守卫测试（真实仓储 + postInitDatabase 全链路）。
 *
 * R1 场景保护验证：崩溃窗口的真 pending 不被「重启即重跑的墓碑」误吞。
 * 墓碑的一次性语义由两道防线构成：
 * ① settings CAS（tryInsertIfAbsent）——同库多进程先到先得
 * ② 存量墓碑行检查（source='backfill' 行存在 = 已执行过）——老库无守卫期兼容
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SqliteDispatchAttemptRepo } from "@frameworks/db/conversation/sqlite-dispatch-attempt-repo";
import { SqliteSettingsRepository } from "@frameworks/db/settings/sqlite-settings-repository";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";
import type { Logger } from "@usecases/ports/logger";
import type { Repositories } from "../../src/bootstrap/types";

/** 最小 Repositories 桩：postInitDatabase 墓碑路径只触 dispatchAttempt + settings，
 *  其余依赖（seedTerminology/reconcileOrphans/backfillSessionLedger）通过注入
 *  空实现规避——守卫逻辑本身不依赖它们。 */
function makeRepos(db: Database.Database): Repositories {
  return {
    dispatchAttempt: new SqliteDispatchAttemptRepo(db),
    settings: new SqliteSettingsRepository(db),
  } as unknown as Repositories;
}

async function runGuard(db: Database.Database, repos: Repositories, logger: Logger): Promise<void> {
  const { postInitDatabase } = await import("../../src/bootstrap/database");
  // seedTerminology/reconcileOrphans/backfillSessionLedger 在空库上是 no-op（真实函数容忍空库）
  await postInitDatabase(db, repos, logger);
}

function seedDelivered(db: Database.Database, id: string, otterId: string): void {
  db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run();
  db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES ('turn-1', 'conv-1', 1, '2026-09-02T00:00:00Z')`).run();
  db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, created_at) VALUES (?, ?, 'big', '2026-09-02T00:00:00Z')`).run(otterId, `otter-${otterId}`);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at)
    VALUES (?, 'conv-1', 'user', 'user', 'completed', 1, 'turn-1', ?, '2026-09-02T09:00:00Z')
  `).run(id, JSON.stringify([otterId]));
}

describe("backfill 墓碑一次性守卫（F20260902sgp2 S2 前置）", () => {
  let db: Database.Database;
  let logger: Logger;

  beforeEach(() => {
    db = createTestDb();
    logger = createTestLogger();
  });

  afterEach(() => {
    db.close();
  });

  it("R1 保护：崩溃窗口真 pending 不被二次重启的墓碑吞掉——首次守卫后新增 pending 存活", async () => {
    const repos = makeRepos(db);
    seedDelivered(db, "msg-pre-existing", "otter-guard"); // 重启前已存在的投递
    await runGuard(db, repos, logger); // 第一次启动：墓碑跑，msg-pre-existing 被翻篇
    expect(repos.dispatchAttempt.countPendingSignals("conv-1")).toBe(0);

    // 崩溃窗口：真 pending 产生（用户消息落库后进程死，无人应答）
    seedDelivered(db, "msg-crash-window", "otter-guard");
    expect(repos.dispatchAttempt.countPendingSignals("conv-1")).toBe(1);

    await runGuard(db, repos, logger); // 第二次启动（修复前：墓碑重跑会吞掉它）
    // 修复后：墓碑被守卫拦住，真 pending 存活（等补扫点燃）
    expect(repos.dispatchAttempt.countPendingSignals("conv-1")).toBe(1);
    const row = db.prepare(`SELECT source FROM dispatch_attempts WHERE message_id = 'msg-crash-window'`).get();
    expect(row).toBeUndefined(); // 没有被墓碑标记
  });

  it("老库兼容：无守卫期已跑过墓碑（存在 source='backfill' 行）→ 守卫直接跳过", async () => {
    const repos = makeRepos(db);
    seedDelivered(db, "msg-old-lib", "otter-guard");
    // 模拟老库无守卫期已跑过墓碑：手插一条 backfill 行（生产库 3607 条的缩影）
    db.prepare(`
      INSERT INTO dispatch_attempts (id, conversation_id, message_id, target_otter_id, status, source, note)
      VALUES ('legacy-tomb', 'conv-1', 'msg-old-lib', 'otter-guard', 'completed', 'backfill', 'legacy-attempted')
    `).run();
    // settings 无锁 key（老库没写过）
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'sgp2:backfill-legacy-attempted'`).get()).toBeUndefined();

    await runGuard(db, repos, logger);
    // 无新增墓碑（msg-old-lib 的槽位被占，其余可验：锁 key 仍未写入——历史行检查先行短路）
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'sgp2:backfill-legacy-attempted'`).get()).toBeUndefined();
  });

  it("多进程并发：CAS 先到先得，后到者跳过不重跑", async () => {
    const repos = makeRepos(db);
    seedDelivered(db, "msg-race", "otter-guard");
    // 模拟另一进程已抢锁
    await repos.settings.tryInsertIfAbsent("sgp2:backfill-legacy-attempted", "2026-09-02T15:00:00Z");

    await runGuard(db, repos, logger);
    const count = db.prepare(`SELECT count(*) AS n FROM dispatch_attempts WHERE source = 'backfill'`).get() as { n: number };
    expect(count.n).toBe(0); // 锁被占，墓碑没跑
  });

  it("死亡证明每次重启照常跑（非迁移，记账面收尾）", async () => {
    const repos = makeRepos(db);
    seedDelivered(db, "msg-stale", "otter-guard");
    repos.dispatchAttempt.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-stale", targetOtterId: "otter-guard", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:01Z", note: null });

    await runGuard(db, repos, logger);
    const row = db.prepare(`SELECT status FROM dispatch_attempts WHERE id = 'a1'`).get() as { status: string };
    expect(row.status).toBe("failed"); // 死亡证明不受守卫影响
    // 连续二次启动，死亡证明依然工作
    repos.dispatchAttempt.recordStart({ id: "a2", conversationId: "conv-1", messageId: "msg-stale", targetOtterId: "otter-guard", status: "in_progress", source: "retry", attemptStartedAt: "2026-09-02T10:00:00Z", note: null });
    await runGuard(db, repos, logger);
    const row2 = db.prepare(`SELECT status FROM dispatch_attempts WHERE id = 'a2'`).get() as { status: string };
    expect(row2.status).toBe("failed");
  });
});
