/**
 * F20260922handoff 死链修复：装配冒烟测试（防「mock 掩盖生产接线」复发）。
 *
 * 背景（排查报告 9/21）：readCurrentSessionEntries / acquireSessionLock 在 SdkInvokePort
 * 声明为可选，agent-invoker 用 `?.` 消费——单测注入的 mock port 自带这些方法，
 * TS 结构类型对「实现体缺可选方法」沉默，3663 单测全绿但生产链路死。
 *
 * 本测试用真实 PiSessionFactory 实例（真 schema DB，不 mock port），断言关键端口方法
 * 存在于实现体上——生产装配若再漏接线，此处直接红。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

describe("PiSessionFactory 端口方法装配冒烟（F20260922handoff 死链防复发）", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("readCurrentSessionEntries 在真实工厂实例上存在且为函数", () => {
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());

    expect(typeof (factory as unknown as Record<string, unknown>).readCurrentSessionEntries).toBe("function");
  });

  it("acquireSessionLock 在真实工厂实例上存在且为函数", () => {
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());

    expect(typeof (factory as unknown as Record<string, unknown>).acquireSessionLock).toBe("function");
  });

  it("readCurrentSessionEntries：无 session 的獭返回 undefined（不抛错）", async () => {
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());

    await expect(
      factory.readCurrentSessionEntries("no-such-otter"),
    ).resolves.toBeUndefined();
  });

  it("acquireSessionLock：取锁/释放闭环（释放函数可调用，不抛错）", async () => {
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());

    const release = await factory.acquireSessionLock("otter-1");
    expect(typeof release).toBe("function");
    release();
  });
});
