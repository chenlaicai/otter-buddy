/**
 * F20260929roiv 启动窗口期孤儿 invoke 延迟 reconcile 测试。
 *
 * 验证：窗口期写入的 running invoke 会被延迟 reconcile 清理；
 * enableDelayedReconcile 是 BuildAppOptions 的合法字段（编译期检查）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initRepositories } from "../../src/bootstrap/repositories";
import type { Repositories } from "../../src/bootstrap/types";
import { reconcileRunningInvokes } from "../../src/bootstrap/database";
import { buildApp } from "../../src/app";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";

const T0 = "2026-01-01T00:00:00Z";

describe("F20260929roiv 启动窗口期孤儿 invoke 延迟 reconcile", () => {
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

  it("延迟 reconcile 清理窗口期写入的 running invoke", async () => {
    // 先跑一遍 reconcile（模拟启动时的 postInitDatabase）
    await repos.invoke.failRunningInvokes(new Date().toISOString());
    expect(db.prepare("SELECT COUNT(*) FROM invokes WHERE status='running'").pluck().get()).toBe(0);

    // 模拟窗口期：reconcile 后、新进程接管前，旧进程写入一条 running invoke
    db.prepare("INSERT INTO invokes (id, conversation_id, otter_id, status, started_at) VALUES ('orphan-1', 'conv-1', 'otter-1', 'running', ?)").run(T0);
    expect(db.prepare("SELECT COUNT(*) FROM invokes WHERE status='running'").pluck().get()).toBe(1);

    // 手动触发延迟 reconcile（模拟 5s 后定时器触发）
    await reconcileRunningInvokes(db, repos, createTestLogger());

    expect(db.prepare("SELECT COUNT(*) FROM invokes WHERE status='running'").pluck().get()).toBe(0);
    const row = db.prepare("SELECT status FROM invokes WHERE id='orphan-1'").get() as { status: string };
    expect(row.status).toBe("failed");
  });

  it("enableDelayedReconcile 是 BuildAppOptions 的合法字段", () => {
    // 编译期检查：如果字段不存在，tsc 会报错
    const options: Parameters<typeof buildApp>[0] = {
      enableDelayedReconcile: false,
      syncAuth: false,
      staticRoot: false,
    };
    expect(options.enableDelayedReconcile).toBe(false);
  });
});
