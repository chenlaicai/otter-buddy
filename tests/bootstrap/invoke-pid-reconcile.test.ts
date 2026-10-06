/**
 * #1241（F20261006opid）pid 归属判据 reconcile 测试。
 *
 * 失败固化用例：9/29 事故形态——旧进程在新进程启动后晚写入的 running invoke
 * （started_at 晚于 duty 构造时刻 bootTs）。#1244 的 bootTs 时间戳守卫对该形态
 * 永远跳过（10s 补跑与 1h 兜底同一 bootTs，空转），pid 归属判据可清理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initRepositories } from "../../src/bootstrap/repositories";
import type { Repositories } from "../../src/bootstrap/types";
import { reconcileRunningInvokes } from "../../src/bootstrap/database";
import { createInvokeOrphanReconcileDuty } from "../../src/bootstrap/invoke-reconcile";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";

const T0 = "2026-01-01T00:00:00Z";

describe("#1241 pid 归属判据孤儿 invoke reconcile", () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createTestDb();
    repos = initRepositories(db, createTestLogger());
    db.prepare("INSERT INTO otters (id, name, type, created_at) VALUES ('otter-1', '獭一', 'big', ?)").run(T0);
    db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', '测试', 'active', ?, ?)").run(T0, T0);
  });

  afterEach(() => {
    db.close();
  });

  const statusOf = (id: string): string =>
    (db.prepare("SELECT status FROM invokes WHERE id = ?").get(id) as { status: string }).status;

  it("【失败固化】旧进程晚写入的 running（started_at 晚于 duty 构造时刻）被 duty.run() 清理", async () => {
    const duty = createInvokeOrphanReconcileDuty(db, repos, createTestLogger());
    // 确保「晚写入」在词法上严格晚于 duty 捕获的 bootTs（事故中约 78s，这里 5ms 即可表达时序）
    await new Promise((r) => setTimeout(r, 5));
    db.prepare(
      "INSERT INTO invokes (id, conversation_id, otter_id, status, started_at) VALUES ('orphan-late', 'conv-1', 'otter-1', 'running', ?)",
    ).run(new Date().toISOString());

    await duty.run();

    expect(statusOf("orphan-late")).toBe("failed");
  });

  it("旧 pid 的 running 被 guard 清理（无论写入早晚）", async () => {
    db.prepare(
      "INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, pid) VALUES ('orphan-oldpid', 'conv-1', 'otter-1', 'running', ?, 99999)",
    ).run(new Date().toISOString());

    await reconcileRunningInvokes(db, repos, createTestLogger(), { excludePid: process.pid, beforeTs: T0 });

    expect(statusOf("orphan-oldpid")).toBe("failed");
  });

  it("pid 为 NULL 的 running（存量/直插数据）被清理", async () => {
    db.prepare(
      "INSERT INTO invokes (id, conversation_id, otter_id, status, started_at) VALUES ('orphan-nullpid', 'conv-1', 'otter-1', 'running', ?)",
    ).run(new Date().toISOString());

    await reconcileRunningInvokes(db, repos, createTestLogger(), { excludePid: process.pid, beforeTs: T0 });

    expect(statusOf("orphan-nullpid")).toBe("failed");
  });

  it("本 pid 且晚于 boot 的 running 不被误杀（本进程活跃 invoke）", async () => {
    db.prepare(
      "INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, pid) VALUES ('active-own', 'conv-1', 'otter-1', 'running', ?, ?)",
    ).run(new Date().toISOString(), process.pid);

    await reconcileRunningInvokes(db, repos, createTestLogger(), { excludePid: process.pid, beforeTs: T0 });

    expect(statusOf("active-own")).toBe("running");
  });

  it("pid 复用兜底：pid 同为本进程但 started_at 早于 boot 的 running 仍被清理", async () => {
    // 场景：上个进程恰好复用了与本进程相同的 pid，其遗留 running 无法靠 pid 区分——
    // 但其写入必然早于本进程 boot 时刻，时间戳条件兜底命中
    db.prepare(
      "INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, pid) VALUES ('orphan-pidreuse', 'conv-1', 'otter-1', 'running', ?, ?)",
    ).run(T0, process.pid);

    await reconcileRunningInvokes(db, repos, createTestLogger(), { excludePid: process.pid, beforeTs: "2026-01-01T00:00:01Z" });

    expect(statusOf("orphan-pidreuse")).toBe("failed");
  });

  it("启动无条件 reconcile 清理全部 running（含本 pid 行）", async () => {
    db.prepare(
      "INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, pid) VALUES ('orphan-any', 'conv-1', 'otter-1', 'running', ?, ?)",
    ).run(T0, process.pid);

    await reconcileRunningInvokes(db, repos, createTestLogger());

    expect(statusOf("orphan-any")).toBe("failed");
  });
});
