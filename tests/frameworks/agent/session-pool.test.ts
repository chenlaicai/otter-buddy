import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionPool, type PooledSession, type SessionPoolEntry } from "@frameworks/agent/session-pool";
import { createTestLogger } from "../../helpers/logger";

function makeMockSession(overrides?: Partial<PooledSession>): PooledSession {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
    state: {},
    getSessionStats: vi.fn().mockReturnValue({ tokens: { input: 0, output: 0 } }),
    sessionManager: { getBranch: vi.fn().mockReturnValue([]) },
    ...overrides,
  };
}

function makeToolContext(overrides?: Record<string, unknown>) {
  return {
    client: undefined as never,
    otterId: "",
    conversationId: "",
    currentMessageId: "",
    pendingDispatches: new Map(),
    dispatchWarningShown: false,
    orchestrationWarningShown: false,
    ...overrides,
  } as any;
}

function makeEntry(otterId: string, overrides?: Partial<SessionPoolEntry>): SessionPoolEntry {
  return {
    session: makeMockSession(),
    otterId,
    conversationId: "conv-1",
    toolContext: makeToolContext({ otterId }),
    turnText: { text: "" },
    lastActiveAt: Date.now(),
    isStreaming: false,
    ...overrides,
  };
}

describe("SessionPool", () => {
  let pool: SessionPool;
  const logger = createTestLogger();

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new SessionPool({ maxSize: 3, idleTtlMs: 60_000 }, logger);
  });

  afterEach(() => {
    pool.dispose();
    vi.useRealTimers();
  });

  // AT-9: 热池基本功能
  describe("AT-9: 容量管理", () => {
    it("put + acquire 基本流程", () => {
      const entry = makeEntry("otter-1");
      pool.put(entry);
      expect(pool.size).toBe(1);

      const acquired = pool.acquire("otter-1");
      expect(acquired).not.toBeNull();
      expect(acquired!.otterId).toBe("otter-1");
    });

    it("池满时驱逐最旧空闲条目", () => {
      pool.put(makeEntry("otter-1"));
      pool.put(makeEntry("otter-2"));
      pool.put(makeEntry("otter-3"));
      expect(pool.size).toBe(3);

      // 放入第 4 个，应驱逐最旧的 otter-1
      pool.put(makeEntry("otter-4"));
      expect(pool.size).toBe(3);
      expect(pool.acquire("otter-1")).toBeNull(); // 已被驱逐
      expect(pool.acquire("otter-4")).not.toBeNull();
    });

    it("运行中条目不可驱逐", () => {
      pool.put(makeEntry("otter-1", { isStreaming: true }));
      pool.put(makeEntry("otter-2"));
      pool.put(makeEntry("otter-3"));

      // 放入第 4 个，otter-1 运行中不可驱逐，应驱逐 otter-2
      pool.put(makeEntry("otter-4"));
      expect(pool.acquire("otter-1")).not.toBeNull(); // 运行中，未被驱逐
      expect(pool.acquire("otter-2")).toBeNull(); // 已被驱逐
    });

    it("所有条目都在运行中时无法驱逐", () => {
      pool.put(makeEntry("otter-1", { isStreaming: true }));
      pool.put(makeEntry("otter-2", { isStreaming: true }));
      pool.put(makeEntry("otter-3", { isStreaming: true }));

      // 放入第 4 个，无法驱逐任何条目
      pool.put(makeEntry("otter-4"));
      expect(pool.size).toBe(3); // 无法驱逐，新条目未入池
    });

    it("同 otterId 替换旧条目时 dispose 旧 session", () => {
      const oldSession = makeMockSession();
      const newSession = makeMockSession();
      pool.put(makeEntry("otter-1", { session: oldSession }));
      pool.put(makeEntry("otter-1", { session: newSession }));

      expect(oldSession.dispose).toHaveBeenCalled();
      expect(pool.size).toBe(1);
    });
  });

  // AT-9: TTL 驱逐
  describe("AT-9: TTL 驱逐", () => {
    it("超过 idleTtlMs 的空闲条目被 TTL 扫描驱逐", () => {
      pool.put(makeEntry("otter-1"));
      expect(pool.size).toBe(1);

      // TTL 扫描间隔 60s，idleTtl 60s，总计需要等待 120s（扫描触发 + TTL 判定）
      vi.advanceTimersByTime(120_000);

      expect(pool.size).toBe(0);
    });

    it("运行中条目即使 TTL 过期也不驱逐", () => {
      pool.put(makeEntry("otter-1", { isStreaming: true }));
      vi.advanceTimersByTime(120_000);
      expect(pool.size).toBe(1); // 运行中，不驱逐
    });
  });

  // AT-9: isRunning / followUp / steer 接口
  describe("AT-9: 外部接口", () => {
    it("isRunning: 在池且 isStreaming 才返回 true", () => {
      expect(pool.isRunning("otter-1")).toBe(false);

      pool.put(makeEntry("otter-1", { isStreaming: true }));
      expect(pool.isRunning("otter-1")).toBe(true);

      pool.markStreaming("otter-1", false);
      expect(pool.isRunning("otter-1")).toBe(false);
    });

    it("followUp: 运行中时调用 session.followUp", () => {
      const session = makeMockSession();
      pool.put(makeEntry("otter-1", { session, isStreaming: true }));

      const result = pool.followUp("otter-1", "hello");
      expect(result).toBe(true);
      // 验证 followUp 被调用（通过返回值和 mock 状态）
      expect((session.followUp as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });

    it("followUp: 不在池或未运行时返回 false", () => {
      expect(pool.followUp("otter-1", "hello")).toBe(false);

      pool.put(makeEntry("otter-1", { isStreaming: false }));
      expect(pool.followUp("otter-1", "hello")).toBe(false);
    });

    it("steer: 运行中时调用 session.steer", () => {
      const session = makeMockSession();
      pool.put(makeEntry("otter-1", { session, isStreaming: true }));

      const result = pool.steer("otter-1", "urgent");
      expect(result).toBe(true);
      // 验证 steer 被调用（通过返回值和 mock 状态）
      expect((session.steer as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });

    it("steer: 不在池或未运行时返回 false", () => {
      expect(pool.steer("otter-1", "urgent")).toBe(false);
    });
  });

  // 工具闭包刷新
  describe("工具闭包刷新", () => {
    it("acquire 更新 lastActiveAt", () => {
      const entry = makeEntry("otter-1");
      entry.lastActiveAt = 1000;
      pool.put(entry);

      const acquired = pool.acquire("otter-1");
      expect(acquired!.lastActiveAt).toBeGreaterThan(1000);
    });

    it("markStreaming 结束时刷新 lastActiveAt", () => {
      const entry = makeEntry("otter-1", { isStreaming: true, lastActiveAt: 1000 });
      pool.put(entry);

      pool.markStreaming("otter-1", false);
      const acquired = pool.acquire("otter-1");
      expect(acquired!.lastActiveAt).toBeGreaterThan(1000);
    });
  });

  // remove 和 dispose
  describe("生命周期", () => {
    it("remove dispose session 并从池中移除", () => {
      const session = makeMockSession();
      pool.put(makeEntry("otter-1", { session }));
      pool.remove("otter-1");

      expect(session.dispose).toHaveBeenCalled();
      expect(pool.size).toBe(0);
      expect(pool.acquire("otter-1")).toBeNull();
    });

    it("dispose 清理所有 session", () => {
      const s1 = makeMockSession();
      const s2 = makeMockSession();
      pool.put(makeEntry("otter-1", { session: s1 }));
      pool.put(makeEntry("otter-2", { session: s2 }));

      pool.dispose();
      expect(s1.dispose).toHaveBeenCalled();
      expect(s2.dispose).toHaveBeenCalled();
      expect(pool.size).toBe(0);
    });
  });
});
