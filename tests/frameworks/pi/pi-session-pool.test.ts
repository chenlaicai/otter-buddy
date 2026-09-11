/**
 * PiSessionPool 单元测试（F20260911pspl）
 *
 * 覆盖：acquire 命中/重建、LRU touch 刷新、TTL 驱逐、running 豁免（isBusy 注入与
 * isStreaming 回退两条路径）、容量驱逐、inflight 并发去重、factory 失败不入池、
 * disposeAll/dispose 容错。
 * 断言风格：以状态/副作用断言为主（pool.has/size、disposed 标志）；仅「防重复拉起」
 * 场景保留 factory 调用次数断言——被验证的恰是「factory 只执行一次」这一外部行为本身，
 * lint 禁止的是 mock API 断言（toHaveBeenCalledWith 等绑定实现细节的写法）。
 */
import { describe, it, expect } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiSessionPool } from "@frameworks/pi/pi-session-pool";

/** 最小 AgentSession mock：池只触碰 isStreaming 与 dispose。
 *  disposed 标志暴露副作用断言点（lint 禁止断言调用次数）。 */
function fakeSession(streaming = false): AgentSession & { disposed: boolean } {
  const s = {
    isStreaming: streaming,
    disposed: false,
    dispose() { s.disposed = true; },
  };
  return s as unknown as AgentSession & { disposed: boolean };
}

function makePool(opts: {
  factory?: (key: string) => Promise<AgentSession>;
  ttlMs?: number;
  maxSize?: number;
  isBusy?: (s: AgentSession) => boolean;
  now?: () => number;
} = {}) {
  const factory = opts.factory ?? (async () => fakeSession());
  return new PiSessionPool(factory, {
    ttlMs: opts.ttlMs,
    maxSize: opts.maxSize,
    isBusy: opts.isBusy,
    now: opts.now,
  });
}

/** 触发一次驱逐扫描（测试路径直达，绕过定时器） */
function sweep(pool: PiSessionPool): void {
  (pool as unknown as { sweep(): void }).sweep();
}

describe("PiSessionPool.acquire", () => {
  it("首次 acquire 经 factory 拉起入池；二次 acquire 命中同一对象（不重复拉起）", async () => {
    const session = fakeSession();
    let factoryCalls = 0;
    const pool = makePool({ factory: async () => { factoryCalls++; return session; } });

    const a = await pool.acquire("k1");
    const b = await pool.acquire("k1");

    expect(a).toBe(session);
    expect(b).toBe(session);
    expect(factoryCalls).toBe(1); // 防重复拉起是外部可观察行为，断言计数即断言行为本身
    expect(pool.has("k1")).toBe(true);
    expect(pool.size).toBe(1);
  });

  it("同 key 并发 acquire 共享同一 inflight 拉起（factory 只执行一次）", async () => {
    let calls = 0;
    const pool = makePool({
      factory: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return fakeSession();
      },
    });

    const [a, b] = await Promise.all([pool.acquire("k1"), pool.acquire("k1")]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("factory 失败：不入池、异常透传、下次 acquire 可重试成功", async () => {
    let calls = 0;
    const pool = makePool({
      factory: async () => {
        calls++;
        if (calls === 1) throw new Error("restore failed");
        return fakeSession();
      },
    });

    await expect(pool.acquire("k1")).rejects.toThrow("restore failed");
    expect(pool.has("k1")).toBe(false); // 失败不入池

    await pool.acquire("k1");
    expect(pool.has("k1")).toBe(true); // 重试成功
  });

  it("acquire 命中会刷新 lastTouched（TTL 从最后一次触发算起）", async () => {
    let t = 0;
    const pool = makePool({ ttlMs: 100, now: () => t });
    const evicted: string[] = [];
    pool.onEvict = (key) => { evicted.push(key); };

    await pool.acquire("k1"); // touched@0
    t = 90;
    await pool.acquire("k1"); // 刷新 touched@90
    t = 150;
    sweep(pool); // 150-90=60 < 100，不驱逐
    expect(pool.has("k1")).toBe(true);

    t = 250;
    sweep(pool); // 250-90=160 > 100，驱逐
    expect(pool.has("k1")).toBe(false);
    expect(evicted).toEqual(["k1"]); // 副作用断言：驱逐事件发出
  });
});

describe("PiSessionPool 驱逐", () => {
  it("TTL 驱逐：idle 超期 dispose 出池", async () => {
    let t = 0;
    const session = fakeSession();
    const pool = makePool({ factory: async () => session, ttlMs: 100, now: () => t });

    await pool.acquire("k1");
    t = 200;
    sweep(pool);

    expect(pool.has("k1")).toBe(false);
    expect(session.disposed).toBe(true); // 副作用断言
  });

  it("running 豁免：isBusy 注入返回 true 时不驱逐", async () => {
    let t = 0;
    const pool = makePool({ ttlMs: 100, now: () => t, isBusy: () => true });

    await pool.acquire("k1");
    t = 99999;
    sweep(pool);

    expect(pool.has("k1")).toBe(true);
  });

  it("running 豁免回退路径：未注入 isBusy 时用 session.isStreaming", async () => {
    let t = 0;
    const streaming = fakeSession(true);
    const idle = fakeSession(false);
    const pool = makePool({
      ttlMs: 100,
      now: () => t,
      factory: async (key) => (key === "busy" ? streaming : idle),
    });

    await pool.acquire("busy");
    await pool.acquire("idle");
    t = 200;
    sweep(pool);

    expect(pool.has("busy")).toBe(true);   // isStreaming=true → 豁免
    expect(pool.has("idle")).toBe(false);  // 驱逐
    expect(streaming.disposed).toBe(false);
    expect(idle.disposed).toBe(true);
  });

  it("TTL 驱逐 dispose 抛错不阻塞出池（尽力而为）", async () => {
    let t = 0;
    const bad = fakeSession();
    bad.dispose = () => { throw new Error("boom"); };
    const pool = makePool({ factory: async () => bad, ttlMs: 100, now: () => t });

    await pool.acquire("k1");
    t = 200;
    expect(() => sweep(pool)).not.toThrow();
    expect(pool.has("k1")).toBe(false);
  });

  it("异常防护：isBusy 谓词抛错保守视为 running（不驱逐、不 crash）", async () => {
    let t = 0;
    const pool = makePool({
      ttlMs: 100,
      now: () => t,
      isBusy: () => { throw new Error("host predicate broken"); },
    });

    await pool.acquire("k1");
    t = 200;
    expect(() => sweep(pool)).not.toThrow();
    expect(pool.has("k1")).toBe(true); // 抛错 = 保守不杀
  });

  it("异常防护：损坏 session 的 isStreaming getter 抛错同样视为 running", async () => {
    let t = 0;
    const brokenObj = {
      get isStreaming(): boolean { throw new TypeError("session corrupted"); },
      disposed: false,
      dispose() { brokenObj.disposed = true; },
    };
    const broken = brokenObj as unknown as AgentSession;
    const pool = makePool({ factory: async () => broken, ttlMs: 100, now: () => t });

    await pool.acquire("k1");
    t = 200;
    expect(() => sweep(pool)).not.toThrow();
    expect(pool.has("k1")).toBe(true);
    expect(brokenObj.disposed).toBe(false);
  });

  it("异常防护：onEvict 回调抛错不阻塞驱逐流程", async () => {
    let t = 0;
    const session = fakeSession();
    const pool = makePool({ factory: async () => session, ttlMs: 100, now: () => t });
    pool.onEvict = () => { throw new Error("observer broken"); };

    await pool.acquire("k1");
    t = 200;
    expect(() => sweep(pool)).not.toThrow();
    expect(pool.has("k1")).toBe(false); // 驱逐仍然完成
    expect(session.disposed).toBe(true);
  });
});

describe("PiSessionPool 容量驱逐（maxSize）", () => {
  it("超出容量时驱逐最久未触的 idle 项", async () => {
    let t = 0;
    const sessions = new Map<string, AgentSession & { disposed: boolean }>();
    const pool = makePool({
      maxSize: 2,
      now: () => t,
      factory: async (key) => { const s = fakeSession(); sessions.set(key, s); return s; },
    });
    const evicted: Array<[string, string]> = [];
    pool.onEvict = (key, reason) => { evicted.push([key, reason]); };

    await pool.acquire("a"); t = 1;
    await pool.acquire("b"); t = 2;
    await pool.acquire("a"); // a 刷新为最新
    t = 3;
    await pool.acquire("c"); // 触发容量驱逐：b 最久未触

    expect(pool.size).toBe(2);
    expect(pool.has("a")).toBe(true);
    expect(pool.has("b")).toBe(false);
    expect(pool.has("c")).toBe(true);
    expect(evicted).toEqual([["b", "lru"]]);
    expect(sessions.get("b")!.disposed).toBe(true);
  });

  it("容量驱逐 running 豁免：全员 running 时放弃驱逐（宁超容不杀活会话）", async () => {
    const pool = makePool({ maxSize: 1, isBusy: () => true });
    await pool.acquire("a");
    await pool.acquire("b");
    expect(pool.size).toBe(2); // 超容但无 victim
  });
});

describe("PiSessionPool 手动驱逐与全量释放", () => {
  it("evict(key)：存在则 dispose 出池返回 true；不存在返回 false", async () => {
    const session = fakeSession();
    const pool = makePool({ factory: async () => session });

    await pool.acquire("k1");
    expect(pool.evict("k1")).toBe(true);
    expect(session.disposed).toBe(true);
    expect(pool.has("k1")).toBe(false);
    expect(pool.evict("k1")).toBe(false);
  });

  it("disposeAll：停止扫描并 dispose 全部 session", async () => {
    const s1 = fakeSession();
    const s2 = fakeSession();
    const pool = makePool({ factory: async (k) => (k === "a" ? s1 : s2) });

    await pool.acquire("a");
    await pool.acquire("b");
    pool.start();
    pool.disposeAll();

    expect(pool.size).toBe(0);
    expect(s1.disposed).toBe(true);
    expect(s2.disposed).toBe(true);
  });

  it("start 幂等；stop 可重复", () => {
    const pool = makePool();
    pool.start();
    pool.start();
    pool.stop();
    pool.stop();
    expect(pool.size).toBe(0);
  });
});
