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

  it("readCurrentSessionEntries：真实 jsonl 文件 → 池外 open 只读路径返回 entries（建议2 正向冒烟）", async () => {
    // 建议2：真实 jsonl 正向冒烟——验证池外路径的只读接线（sessionStore.getWithFile →
    //  SessionManagerClass.open → readSessionEntries），顺带锁死修复4 的「只读不 create」语义
    // （若实现回退到 restoreOrCreate，无 otter_config 时会抛错——本用例无 config，恢复形态必红）。
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-smoke-"));
    const sessionFile = path.join(sessionDir, "test-session.jsonl");
    const entries = [
      { type: "message", id: "e1", parentId: null, timestamp: "2026-09-22T00:00:00Z", message: { role: "user", content: "你好" } },
      { type: "message", id: "e2", parentId: "e1", timestamp: "2026-09-22T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "在的" }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } },
    ];
    fs.writeFileSync(sessionFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

    // 真实 SDK 的 SessionManager.open 只读解析 jsonl——mock 按行 JSON.parse 模拟其行为
    const mockPiCodingAgent = {
      SessionManager: {
        create: () => { throw new Error("create 不应被 readCurrentSessionEntries 调用（只读语义）"); },
        open: (file: string) => ({
          getSessionId: () => "sid-smoke",
          getSessionFile: () => file,
          getEntries: () => fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l)),
        }),
      },
    };

    const factory = new PiSessionFactory({
      db,
      sessionDir,
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
      // mock ModelRuntimeRegistry.getPiCodingAgent 返回 mock——经 cfg.resourceLoader 路径不行，
      // 直接替换实例私有字段（cast 触达，同 identity-prefix 的已知妥协模式）。
    } as never, createTestLogger());

    // 注入 mock piCodingAgent（替换 modelRuntimeRegistry 私有字段）
    const registry = (factory as unknown as { modelRuntimeRegistry: { getPiCodingAgent: () => unknown } }).modelRuntimeRegistry;
    (registry as { getPiCodingAgent: () => unknown }).getPiCodingAgent = () => mockPiCodingAgent;

    // 账本写入 sessionFile（模拟生产装配的持久化行）——agent_sessions.otter_id 外键指向
    //  otters，须先建 otter 行。
    const repo = new SqliteOtterRepository(db);
    await repo.createOtter({ id: "otter-jsonl", name: "冒烟獭", type: "small", status: "active", createdAt: "2026-09-22T00:00:00Z" } as never);
    const store = (factory as unknown as { sessionStore: { setWithFile: (o: string, sid: string, f: string) => void } }).sessionStore;
    store.setWithFile("otter-jsonl", "sid-smoke", sessionFile);

    const result = await factory.readCurrentSessionEntries("otter-jsonl");
    expect(result).toBeDefined();
    expect(result!.length).toBe(2);
    expect((result![0] as { id: string }).id).toBe("e1");

    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("readCurrentSessionEntries：账本 sessionFile 磁盘缺失 → open 抛错 → 返回 undefined（降级，不 create）", async () => {
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());

    const mockPiCodingAgent = {
      SessionManager: {
        create: () => { throw new Error("create 不应被调用"); },
        open: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      },
    };
    const registry = (factory as unknown as { modelRuntimeRegistry: { getPiCodingAgent: () => unknown } }).modelRuntimeRegistry;
    (registry as { getPiCodingAgent: () => unknown }).getPiCodingAgent = () => mockPiCodingAgent;
    const repo = new SqliteOtterRepository(db);
    await repo.createOtter({ id: "otter-missing", name: "缺失獭", type: "small", status: "active", createdAt: "2026-09-22T00:00:00Z" } as never);
    const store = (factory as unknown as { sessionStore: { setWithFile: (o: string, sid: string, f: string) => void } }).sessionStore;
    store.setWithFile("otter-missing", "sid-x", "/nonexistent/path.jsonl");

    await expect(factory.readCurrentSessionEntries("otter-missing")).resolves.toBeUndefined();
  });

  it("acquireSessionLock：交接模式覆盖整个持锁期（release 闭包内复位，非 finally）", async () => {
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());

    // handoffModeKeys 是 SimpleLockManager 私有——cast 触达（同 identity-prefix 测试的已知妥协模式）。
    // 本用例锁死 F20260922handoff 审视打回的语义反转 bug：若复位在外层 finally，
    // 持锁期间 handoffModeKeys 已被清空（交接窗口内 waiter 回退 30s 默认超时）。
    const lockManager = (factory as unknown as { lockManager: { handoffModeKeys: Set<string> } }).lockManager;
    const key = "session:otter-handoff";

    const release = await factory.acquireSessionLock("otter-handoff");
    expect(lockManager.handoffModeKeys.has(key)).toBe(true); // 持锁期：交接模式在位

    release();
    expect(lockManager.handoffModeKeys.has(key)).toBe(false); // release 后：复位
  });

  it("acquireSessionLock：acquire 抛错路径复位 handoffMode（防泄漏）", async () => {
    const factory = new PiSessionFactory({
      db,
      sessionDir: ":memory:",
      otterToolClient: {} as never,
      model: null as never,
      createTools: () => [],
      otterConfigProvider: new SqliteOtterConfigProvider(db),
      otterRepo: new SqliteOtterRepository(db),
    }, createTestLogger());

    const lockManager = (factory as unknown as { lockManager: { handoffModeKeys: Set<string>; acquire: (k: string) => Promise<() => void> } }).lockManager;
    const key = "session:otter-err";
    // 先占锁，让后续 acquireSessionLock 的 acquire 排队——steal 阈值 5min 内不会接管，
    // 用 defaultTimeout 30s 太久，直接 mock acquire 抛错更快（异常路径复位语义不变）。
    const origAcquire = lockManager.acquire.bind(lockManager);
    lockManager.acquire = () => Promise.reject(new Error("simulated acquire failure"));

    await expect(factory.acquireSessionLock("otter-err")).rejects.toThrow("simulated acquire failure");
    expect(lockManager.handoffModeKeys.has(key)).toBe(false); // 异常路径：复位

    lockManager.acquire = origAcquire;
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
