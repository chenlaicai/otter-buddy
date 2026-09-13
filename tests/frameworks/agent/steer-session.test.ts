/**
 * F20260913ctlv 整合轮修复锁定测试：steerSession（合并时曾误删，检视发现 1）。
 *
 * 守护的行为：activeSessions 前缀匹配命中 → entry.steer 注入（fire-and-forget）→
 * 返回 true；未命中（不活跃/无 steer 能力）→ false + warn 日志。
 * URGENT 急讯路由（signal-router:218）依赖本方法——丢方法 = 运行时崩溃
 * （app.ts 现用显式 adapter，方法缺失编译期即报，本测试锁行为语义）。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";

function makeFactory() {
  const db = createTestDb();
  const factory = new PiSessionFactory({
    db,
    sessionDir: ":memory:",
    otterToolClient: {} as never,
    model: null as never,
    createTools: () => [],
    otterConfigProvider: {
      getConfig: () => ({ systemPrompt: undefined, otterType: "big", modelAlias: null }),
      setConfig: () => {},
      deleteConfig: () => {},
    } as never,
    otterRepo: new SqliteOtterRepository(db),
  }, createTestLogger());
  return { factory, internals: factory as unknown as {
    activeSessions: Map<string, { abort: () => Promise<void>; steer?: (text: string) => Promise<void>; toolCallCount: number }>;
  }, db };
}

describe("steerSession（F20260913ctlv 整合轮恢复——main 版语义锁定）", () => {
  it("activeSessions 前缀匹配命中 → entry.steer 注入并返回 true", async () => {
    const { factory, internals, db } = makeFactory();
    const steered: string[] = [];
    // 生产键格式 ${otterId}:${messageId}
    internals.activeSessions.set("o1:inv-9", {
      abort: async () => {},
      steer: async (text: string) => { steered.push(text); },
      toolCallCount: 0,
    });

    const result = factory.steerSession("o1", "URGENT 急讯");
    // fire-and-forget：先返回 true，注入异步完成
    expect(result).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(steered).toEqual(["URGENT 急讯"]);
    db.close();
  });

  it("bare key（无 messageId 键控）精确匹配也命中", async () => {
    const { factory, internals, db } = makeFactory();
    const steered: string[] = [];
    internals.activeSessions.set("o1", {
      abort: async () => {},
      steer: async (text: string) => { steered.push(text); },
      toolCallCount: 0,
    });

    expect(factory.steerSession("o1", "x")).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(steered).toEqual(["x"]);
    db.close();
  });

  it("session 不活跃（activeSessions 空）→ false", () => {
    const { factory, db } = makeFactory();
    expect(factory.steerSession("o-none", "x")).toBe(false);
    db.close();
  });

  it("entry 无 steer 能力 → false（前缀匹配但 steer 缺失）", () => {
    const { factory, internals, db } = makeFactory();
    internals.activeSessions.set("o1:inv-1", {
      abort: async () => {},
      // steer 缺失（无 steer 能力的 session）
      toolCallCount: 0,
    });
    expect(factory.steerSession("o1", "x")).toBe(false);
    db.close();
  });

  it("不同 otterId 前缀不误匹配（o1 不命中 o10）", () => {
    const { factory, internals, db } = makeFactory();
    internals.activeSessions.set("o10:inv-1", {
      abort: async () => {},
      steer: async () => {},
      toolCallCount: 0,
    });
    // "o1" 前缀匹配要求 key === "o1" 或以 "o1:" 开头——"o10:" 不满足（':' 边界）
    expect(factory.steerSession("o1", "x")).toBe(false);
    db.close();
  });

  it("steer 抛错不崩（fire-and-forget catch）且返回 true", async () => {
    const { factory, internals, db } = makeFactory();
    internals.activeSessions.set("o1:inv-1", {
      abort: async () => {},
      steer: async () => { throw new Error("session dispose 中"); },
      toolCallCount: 0,
    });
    expect(factory.steerSession("o1", "x")).toBe(true);
    await new Promise((r) => setTimeout(r, 10)); // 不抛未捕获异常
    db.close();
  });
});
