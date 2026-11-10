/**
 * #1788：activeSessions 前缀匹配命中后，必须 await entry.steer 的真实 admission。
 * 只有 admitted 才返回 true；未命中、idle 或 admission 失败均返回 false，
 * 由 SignalRouter 回退新 invoke，且不得把信号销账为 steered。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { ConversationIdle } from "@earendil-works/pi-durable";
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

describe("steerSession（#1788 真实 admission 后才算成功）", () => {
  it("activeSessions 前缀匹配命中 → entry.steer 注入并返回 true", async () => {
    const { factory, internals, db } = makeFactory();
    const steered: string[] = [];
    internals.activeSessions.set("o1:inv-9", {
      abort: async () => {},
      steer: async (text: string) => { steered.push(text); },
      toolCallCount: 0,
    });

    await expect(factory.steerSession("o1", "URGENT 急讯")).resolves.toBe(true);
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

    await expect(factory.steerSession("o1", "x")).resolves.toBe(true);
    expect(steered).toEqual(["x"]);
    db.close();
  });

  it("session 不活跃（activeSessions 空）→ false", async () => {
    const { factory, db } = makeFactory();
    await expect(factory.steerSession("o-none", "x")).resolves.toBe(false);
    db.close();
  });

  it("entry 无 steer 能力 → false（前缀匹配但 steer 缺失）", async () => {
    const { factory, internals, db } = makeFactory();
    internals.activeSessions.set("o1:inv-1", {
      abort: async () => {},
      toolCallCount: 0,
    });
    await expect(factory.steerSession("o1", "x")).resolves.toBe(false);
    db.close();
  });

  it("不同 otterId 前缀不误匹配（o1 不命中 o10）", async () => {
    const { factory, internals, db } = makeFactory();
    internals.activeSessions.set("o10:inv-1", {
      abort: async () => {},
      steer: async () => {},
      toolCallCount: 0,
    });
    await expect(factory.steerSession("o1", "x")).resolves.toBe(false);
    db.close();
  });

  it("durable 已 idle 但 active entry 未删 → false，不启动无人托管的新 run", async () => {
    const { factory, internals, db } = makeFactory();
    internals.activeSessions.set("o1:inv-1", {
      abort: async () => {},
      steer: async () => { throw new ConversationIdle(1 as never); },
      toolCallCount: 0,
    });
    await expect(factory.steerSession("o1", "x")).resolves.toBe(false);
    db.close();
  });

  it("其他 steer admission 错误不冒充成功，返回 false", async () => {
    const { factory, internals, db } = makeFactory();
    internals.activeSessions.set("o1:inv-1", {
      abort: async () => {},
      steer: async () => { throw new Error("session dispose 中"); },
      toolCallCount: 0,
    });
    await expect(factory.steerSession("o1", "x")).resolves.toBe(false);
    db.close();
  });
});
