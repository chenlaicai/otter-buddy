/**
 * #896：嵌套 invoke 锁旁路 + streaming 保护。
 *
 * 守护的行为链（PR #897 检视后修正版）：
 * 1. 锁层：同 async context 嵌套 invoke（ALS store 同 otterId）旁路 per-otter 锁——
 *    压缩钩子在 prompt 中途触发，外层持锁，嵌套再取锁必死锁（原 #896）。
 * 2. 池层：嵌套 invoke 遇到 streaming session **抛错降级**（不得 stale 出池顶替外层活 session——
 *    出池会丢压缩摘要 entry + 外层后续消息，压缩永不生效，PR #897 检视严重 1）。
 * 3. 真并发（不同 async context / stale steal）遇 streaming 照常走 stale 出池冷启动（#599 语义不变）。
 *
 * 测试策略：锁层用 barrier 挂起外层模拟 prompt 中途；池层直接测 _acquirePooled 的
 * streaming 分支（与 pool-hit-path.test.ts 同构的 mock 边界）。
 */
import { describe, it, expect, vi } from "vitest";

// 与 identity-prefix.test.ts 同款：getConfig 需要初始化，mock 掉
vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { otterInvokeStorage } from "@frameworks/agent/model-runtime-registry";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";

type FakeSession = {
  isStreaming: boolean;
  disposed: boolean;
  dispose(): void;
  abort(): Promise<void>;
  steer(text: string): Promise<void>;
};

function fakeSession(): FakeSession {
  const s: FakeSession = {
    isStreaming: false,
    disposed: false,
    dispose() { s.disposed = true; },
    abort: async () => {},
    steer: async () => {},
  };
  return s;
}

/** 可控 barrier：外层 _invokeInternal 挂起直到 release，模拟压缩钩子触发时外层仍在 prompt */
function makeBarrier() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

function makeFactory(internalImpl: (id: string, msg: string) => Promise<{ text: string }>) {
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

  const internals = factory as unknown as {
    lockManager: { locks: Map<string, { held: boolean }> };
    _invokeInternal: (id: string, msg: string, opts: unknown) => Promise<{ text: string }>;
  };
  internals._invokeInternal = internalImpl;
  return { factory, internals, db };
}

/** 构造池化编排可测的工厂（mock SDK 接触的两侧，与 pool-hit-path.test.ts 同构） */
function makePoolFactory() {
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

  const sessions = new Map<string, FakeSession>();
  let createCount = 0;
  const internals = factory as unknown as {
    _restoreOrCreateSession: (id: string) => Promise<{ sessionManager: unknown; createdNew: boolean }>;
    _createSessionWithTools: (...args: unknown[]) => Promise<{ session: unknown; sessionKey: string; toolContext: unknown }>;
    _acquirePooled: (id: string, opts: unknown) => Promise<{
      session: FakeSession; sessionKey: string; toolContext: { register?: unknown };
      turnText: { text: string }; isPooled: boolean; createdNew: boolean;
    }>;
    poolMeta: Map<string, { session: FakeSession }>;
  };

  internals._restoreOrCreateSession = async () => ({ sessionManager: {}, createdNew: false });
  internals._createSessionWithTools = async (otterId: unknown) => {
    createCount++;
    const session = fakeSession();
    sessions.set(otterId as string, session);
    return { session, sessionKey: otterId as string, toolContext: {} };
  };
  return { factory, internals, sessions, db, getCreateCount: () => createCount };
}

describe("#896 嵌套 invoke 锁旁路", () => {
  it("外层持锁期间，同 otterId 的嵌套 invoke（压缩合成）旁路锁立即执行", async () => {
    const barrier = makeBarrier();
    const { factory, internals, db } = makeFactory(async (_id, msg) => {
      if (msg === "外层用户消息") await barrier.gate;
      return { text: `done:${msg}` };
    });

    const outerPromise = factory.invoke("o1", "外层用户消息", { conversationId: "c1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(internals.lockManager.locks.get("session:o1")?.held).toBe(true);

    const nestedResult = await otterInvokeStorage.run(
      { otterPromptConfig: undefined, identityPrefix: "", otterId: "o1" },
      () => factory.invoke("o1", "压缩合成 prompt", { conversationId: "", readOnly: true }),
    );
    expect(nestedResult.text).toBe("done:压缩合成 prompt");
    expect(internals.lockManager.locks.get("session:o1")?.held).toBe(true);

    barrier.release();
    const outerResult = await outerPromise;
    expect(outerResult.text).toBe("done:外层用户消息");
    expect(internals.lockManager.locks.get("session:o1")?.held ?? false).toBe(false);
    db.close();
  });

  it("不同 async context 的同 otterId invoke 照常取锁（真并发不旁路，排队等待）", async () => {
    const barrier = makeBarrier();
    const { factory, internals, db } = makeFactory(async (_id, msg) => {
      if (msg === "外层用户消息") await barrier.gate;
      return { text: `done:${msg}` };
    });

    const outerPromise = factory.invoke("o1", "外层用户消息", { conversationId: "c1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(internals.lockManager.locks.get("session:o1")?.held).toBe(true);

    let secondSettled = false;
    const secondPromise = factory.invoke("o1", "并发消息", { conversationId: "c2" })
      .then((r) => { secondSettled = true; return r; });
    await new Promise((r) => setTimeout(r, 50));
    expect(secondSettled).toBe(false);

    barrier.release();
    const secondResult = await secondPromise;
    expect(secondSettled).toBe(true);
    expect(secondResult.text).toBe("done:并发消息");
    await outerPromise;
    expect(internals.lockManager.locks.get("session:o1")?.held ?? false).toBe(false);
    db.close();
  });

  it("ALS store 中 otterId 不同（其他獭的嵌套上下文）不旁路，照常取锁排队", async () => {
    const barrier = makeBarrier();
    const { factory, internals, db } = makeFactory(async (_id, msg) => {
      if (msg === "外层用户消息") await barrier.gate;
      return { text: `done:${msg}` };
    });

    const outerPromise = factory.invoke("otter-A", "外层用户消息", { conversationId: "c1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(internals.lockManager.locks.get("session:otter-A")?.held).toBe(true);

    let settled = false;
    const promise = otterInvokeStorage.run(
      { otterPromptConfig: undefined, identityPrefix: "", otterId: "otter-B" },
      () => factory.invoke("otter-A", "其他獭上下文中的调用", { conversationId: "c2" })
        .then((r) => { settled = true; return r; }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    barrier.release();
    const result = await promise;
    expect(result.text).toBe("done:其他獭上下文中的调用");
    await outerPromise;
    db.close();
  });
});

describe("#896 池层 streaming 保护（PR #897 检视严重 1）", () => {
  it("嵌套 invoke（ALS 同 otterId）遇 streaming session 抛错降级——不出池、不顶替外层 session", async () => {
    const { internals, sessions, db, getCreateCount } = makePoolFactory();
    const first = await internals._acquirePooled("o1", { messageId: "m1" });
    expect(getCreateCount()).toBe(1);

    // 外层 invoke 进行中：session streaming
    sessions.get("o1")!.isStreaming = true;

    // 嵌套 invoke（ALS store 同 otterId）撞上 streaming → 必须抛错（由钩子 catch 降级），
    // 且不得出池/顶替（外层 session 仍是池条目）
    await expect(
      otterInvokeStorage.run(
        { otterPromptConfig: undefined, identityPrefix: "", otterId: "o1" },
        () => internals._acquirePooled("o1", { messageId: "nested" }),
      ),
    ).rejects.toThrow(/nested invoke while outer invoke is streaming/);

    // 外层 session 未被顶替：池条目仍是原 session，未重建，未 dispose
    expect(internals.poolMeta.get("o1")?.session).toBe(first.session);
    expect(sessions.get("o1")!.disposed).toBe(false);
    expect(getCreateCount()).toBe(1);
    db.close();
  });

  it("真并发（无 ALS store）遇 streaming session 照常 stale 出池冷启动（#599 语义不变）", async () => {
    const { internals, sessions, db, getCreateCount } = makePoolFactory();
    const first = await internals._acquirePooled("o1", { messageId: "m1" });
    sessions.get("o1")!.isStreaming = true;

    // 裸调用（无 store）→ stale steal 场景：出池 + 冷启动
    const second = await internals._acquirePooled("o1", { messageId: "m2" });
    expect(second.isPooled).toBe(false);
    expect(getCreateCount()).toBe(2);
    expect(sessions.get("o1")!.disposed).toBe(false); // 出池不 dispose（旧 invoke 生命周期托管）
    expect(second.session).not.toBe(first.session);
    db.close();
  });
});
