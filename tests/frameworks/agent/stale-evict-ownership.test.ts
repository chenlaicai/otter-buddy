/**
 * #904：stale 双活下 pendingRestart 消费的归属校验。
 *
 * 守护的行为（_evictPooledIfOwned）：旧 invoke 卡死超 300s 被 stale steal（#599）放行
 * 新 invoke → 新 invoke 冷启动新 session 入池 → 旧 invoke 苏醒收尾时 pendingRestart
 * 已置位 → finally 消费点 evict 前比对池内条目归属（poolMeta.toolContext === 本 invoke
 * 的 toolContext），不匹配则跳过——只逐自己的 session，不误杀新 invoke 的新 session。
 *
 * 策略：与 pool-hit-path.test.ts 同款——mock 掉 SDK 两侧，直接构造 poolMeta 双活
 * 状态，打真实私有方法 _evictPooledIfOwned（经 internals 逸出访问），锁定三个分支：
 * 归属自己 → evict；归属他人（stale 双活）→ 保留；池内无条目 → 安全跳过。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { createInvokeRegister } from "@frameworks/agent/tool-builder";
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

type EvictTarget = { toolContext: object };

/** 构造可测工厂：pool.evict 用可观测副作用实现（真实行为同构：池内有则删） */
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

  /** evict 副作用记录（状态断言用，遵守 no-restricted-syntax：不断言 mock 调用细节） */
  const evicted: string[] = [];
  const internals = factory as unknown as {
    pool: { evict: (key: string) => boolean };
    poolMeta: Map<string, EvictTarget & { session: FakeSession; register: ReturnType<typeof createInvokeRegister> }>;
    _evictPooledIfOwned: (otterId: string, toolContext: object) => void;
  };
  // 与 PiSessionPool.evict 真实行为同构：返回是否眞逐出（池内有才删）
  internals.pool = { evict: (key: string) => evicted.push(key) > 0 };

  return { internals, evicted, db };
}

describe("#904 stale 双活 pendingRestart 归属校验（_evictPooledIfOwned）", () => {
  it("归属自己（正常自重启）：池内条目 toolContext 相同 → evict + poolMeta 清除", () => {
    const { internals, evicted, db } = makeFactory();
    const myToolContext = {};
    internals.poolMeta.set("o1", {
      session: fakeSession(),
      toolContext: myToolContext,
      register: createInvokeRegister(),
    });

    internals._evictPooledIfOwned("o1", myToolContext);

    expect(evicted).toEqual(["o1"]); // 副作用：逐出的是 o1
    expect(internals.poolMeta.has("o1")).toBe(false);
    db.close();
  });

  it("stale 双活：池内条目已被新 invoke 顶替（toolContext 不同）→ 不 evict，新 session 存活", () => {
    const { internals, evicted, db } = makeFactory();
    const oldToolContext = {}; // 旧 invoke 的（其 session 已被 stale steal 出池成孤儿）
    const newToolContext = {}; // 新 invoke 冷启动入池的
    internals.poolMeta.set("o1", {
      session: fakeSession(),
      toolContext: newToolContext,
      register: createInvokeRegister(),
    });

    // 旧 invoke finally 消费 pendingRestart：归属校验应拦截
    internals._evictPooledIfOwned("o1", oldToolContext);

    expect(evicted).toEqual([]); // 无逐出副作用
    expect(internals.poolMeta.has("o1")).toBe(true); // 新 session 存活
    db.close();
  });

  it("池内无条目（已被 LRU 驱逐/池 miss）→ 安全跳过，不抛不误逐", () => {
    const { internals, evicted, db } = makeFactory();
    // 不 set poolMeta——池内无该 otter 条目

    expect(() => internals._evictPooledIfOwned("o1", {})).not.toThrow();
    expect(evicted).toEqual([]);
    db.close();
  });
});
