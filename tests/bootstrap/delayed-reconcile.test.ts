/**
 * F20260930roiv 启动窗口期孤儿 invoke 延迟 reconcile 测试。
 *
 * #1241（F20261006opid）判据升级后同步改造：孤儿判据从 bootTs 时间戳守卫
 * 换为 pid 归属（+pid 复用时间戳兑底）。原「防误杀」用例插的行无 pid（NULL），
 * 新判据下 NULL 属旧世界会被清理——用例改为按新语义表达「本 pid 且晚于 boot 不误杀」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initRepositories } from "../../src/bootstrap/repositories";
import type { Repositories } from "../../src/bootstrap/types";
import { reconcileRunningInvokes } from "../../src/bootstrap/database";
import { setupDelayedReconcile } from "../../src/bootstrap/invoke-reconcile";
import { buildApp } from "../../src/app";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";

const T0 = "2026-01-01T00:00:00Z";
const BOOT_TS = "2026-01-01T00:00:01Z"; // 进程启动时间

describe("F20260930roiv 启动窗口期孤儿 invoke 延迟 reconcile", () => {
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

  it("延迟 reconcile 清理窗口期写入的 running invoke（pid 判据）", async () => {
    // 旧进程写入的 running invoke（无 pid = 列引入前存量形态；亦可视为旧进程遗孓）
    db.prepare("INSERT INTO invokes (id, conversation_id, otter_id, status, started_at) VALUES ('orphan-1', 'conv-1', 'otter-1', 'running', ?)").run(T0);
    expect(db.prepare("SELECT COUNT(*) FROM invokes WHERE status='running'").pluck().get()).toBe(1);

    // 带判据的 reconcile（排除本进程 pid + boot 上限）
    await reconcileRunningInvokes(db, repos, createTestLogger(), { excludePid: process.pid, beforeTs: BOOT_TS });

    expect(db.prepare("SELECT COUNT(*) FROM invokes WHERE status='running'").pluck().get()).toBe(0);
    const row = db.prepare("SELECT status FROM invokes WHERE id='orphan-1'").get() as { status: string };
    expect(row.status).toBe("failed");
  });

  it("防误杀本进程活跃 invoke（本 pid 且晚于 boot）", async () => {
    // 本进程启动后创建的 invoke（pid=本进程、started_at > bootTs）
    db.prepare("INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, pid) VALUES ('active-1', 'conv-1', 'otter-1', 'running', ?, ?)").run("2026-01-01T00:00:02Z", process.pid);
    expect(db.prepare("SELECT COUNT(*) FROM invokes WHERE status='running'").pluck().get()).toBe(1);

    // 带判据的 reconcile 不应清理它
    await reconcileRunningInvokes(db, repos, createTestLogger(), { excludePid: process.pid, beforeTs: BOOT_TS });

    expect(db.prepare("SELECT COUNT(*) FROM invokes WHERE status='running'").pluck().get()).toBe(1);
    const row = db.prepare("SELECT status FROM invokes WHERE id='active-1'").get() as { status: string };
    expect(row.status).toBe("running");
  });

  it("setupDelayedReconcile 返回定时器且可 clearTimeout", () => {
    const timer = setupDelayedReconcile({ enableDelayedReconcile: true }, db, repos, createTestLogger());
    expect(timer).toBeDefined();
    expect(() => clearTimeout(timer!)).not.toThrow();
  });

  it("enableDelayedReconcile=false 时不启动定时器", () => {
    const timer = setupDelayedReconcile({ enableDelayedReconcile: false }, db, repos, createTestLogger());
    expect(timer).toBeUndefined();
  });

  it("enableDelayedReconcile 是 BuildAppOptions 的合法字段", () => {
    const options: Parameters<typeof buildApp>[0] = {
      enableDelayedReconcile: false,
      syncAuth: false,
      staticRoot: false,
    };
    expect(options.enableDelayedReconcile).toBe(false);
  });
});
