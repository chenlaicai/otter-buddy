/**
 * WeixinPollingChannel context_token 过期预警测试（F20260901wxnt）
 *
 * fake clock + mock api：断言副作用（发送尝试 / warnedAt 记录 / 日志），
 * 不断言 mock 调用参数本身（项目 lint 约定）。
 *
 * 覆盖：满阈值触发 / cooldown 抑制 / 入站重置 / 失败记 warnedAt 不重试（tick 两次 api 只调一次）/
 * 多用户一个失败不阻断 / 未配置不启用
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WeixinPollingChannel } from "@frameworks/weixin/polling-channel";
import type { WeixinApiClient } from "@frameworks/weixin/api-client";
import type { WeixinAccountStore, ContextTokenEntry } from "@frameworks/weixin/account-store";
import type { Logger } from "@usecases/ports/logger";

function makeFakeAccountStore(initial: Record<string, Record<string, ContextTokenEntry>> = {}) {
  const store: Record<string, Record<string, ContextTokenEntry>> = JSON.parse(JSON.stringify(initial));
  const warnedCalls: Array<{ accountId: string; userId: string }> = [];
  const savedTokens: Array<{ accountId: string; userId: string; token: string }> = [];
  return {
    store,
    warnedCalls,
    savedTokens,
    accountStore: {
      loadSyncBuf: vi.fn().mockReturnValue(""),
      saveSyncBuf: vi.fn(),
      loadContextTokens: vi.fn((accountId: string) => {
        const entries = store[accountId] ?? {};
        const result: Record<string, string> = {};
        for (const [uid, entry] of Object.entries(entries)) result[uid] = entry.token;
        return result;
      }),
      loadRawContextTokens: vi.fn((accountId: string) => store[accountId] ?? {}),
      saveContextToken: vi.fn((accountId: string, userId: string, token: string) => {
        if (!store[accountId]) store[accountId] = {};
        store[accountId][userId] = { token, receivedAt: Date.now() };
        savedTokens.push({ accountId, userId, token });
      }),
      recordContextTokenWarned: vi.fn((accountId: string, userId: string) => {
        if (store[accountId]?.[userId]) {
          store[accountId][userId].warnedAt = Date.now();
        }
        warnedCalls.push({ accountId, userId });
      }),
    } as unknown as WeixinAccountStore,
  };
}

function makeLogger() {
  const logs: { level: string; msg: string; meta?: unknown }[] = [];
  return {
    logger: {
      info: vi.fn((msg: string, meta?: unknown) => logs.push({ level: "info", msg, meta })),
      warn: vi.fn((msg: string, meta?: unknown) => logs.push({ level: "warn", msg, meta })),
      error: vi.fn((msg: string, _err?: Error, meta?: unknown) => logs.push({ level: "error", msg, meta })),
      debug: vi.fn(),
    } as unknown as Logger,
    logs,
  };
}

describe("WeixinPollingChannel - context_token 过期预警 (F20260901wxnt)", () => {
  let fakeNow: number;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 1725188000000; // 固定起点
    vi.setSystemTime(fakeNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("静默满阈值触发预警发送", async () => {
    const receivedAt = fakeNow - 61 * 60_000; // 61 分钟前收到
    const { accountStore } = makeFakeAccountStore({
      "acc-1": { user1: { token: "tok-old", receivedAt } },
    });
    const { logger } = makeLogger();
    const sendCalls: Array<{ toUserId: string; contextToken?: string; text: string }> = [];
    const api = {
      getUpdates: vi.fn(() => new Promise<never>(() => {})), // 长轮询挂起
      sendTextMessage: vi.fn(async (p: { toUserId: string; contextToken?: string; text: string }) => {
        sendCalls.push(p);
      }),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000, cooldownMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    // 等待 checkContextTokenExpiry 执行（在 loop 第一个 tick）
    await vi.advanceTimersByTimeAsync(100);

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].toUserId).toBe("user1");
    expect(sendCalls[0].contextToken).toBe("tok-old");
    expect(sendCalls[0].text).toContain("随便回我一条");

    poller.stop();
  });

  it("cooldown 期内抑制重复预警", async () => {
    const receivedAt = fakeNow - 61 * 60_000;
    const warnedAt = fakeNow - 30 * 60_000; // 30 分钟前预警过
    const { accountStore, warnedCalls } = makeFakeAccountStore({
      "acc-1": { user1: { token: "tok", receivedAt, warnedAt } },
    });
    const { logger } = makeLogger();
    const sendCalls: unknown[] = [];
    const api = {
      getUpdates: vi.fn(() => new Promise<never>(() => {})),
      sendTextMessage: vi.fn(async () => { sendCalls.push(1); }),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000, cooldownMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);

    // cooldown 内不发，sendTextMessage 不应被调用
    expect(sendCalls).toHaveLength(0);
    // recordContextTokenWarned 也不应被调用（没到发的条件）
    expect(warnedCalls).toHaveLength(0);

    poller.stop();
  });

  it("入站消息重置 receivedAt（用户说话了 → 不再预警）", async () => {
    // 初始：token 即将过期
    const { accountStore } = makeFakeAccountStore({
      "acc-1": { user1: { token: "tok-old", receivedAt: fakeNow - 59 * 60_000 } },
    });
    const { logger } = makeLogger();
    const api = {
      getUpdates: vi.fn(() => new Promise<never>(() => {})),
      sendTextMessage: vi.fn(async () => {}),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000, cooldownMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    // 模拟入站消息更新了 token（dispatchInbound 调 saveContextToken）
    accountStore.saveContextToken("acc-1", "user1", "tok-new");

    // 现在 receivedAt = fakeNow（刚收到），年龄 = 0，不会触发预警
    poller.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(api.sendTextMessage).not.toHaveBeenCalled();

    poller.stop();
  });

  it("发送失败记 warnedAt 不重试（tick 两次 api 只调一次 sendTextMessage）", async () => {
    const receivedAt = fakeNow - 61 * 60_000;
    const { accountStore, warnedCalls } = makeFakeAccountStore({
      "acc-1": { user1: { token: "tok-dead", receivedAt } },
    });
    const { logger, logs } = makeLogger();
    // Why: 第一次 getUpdates 立即返回让 loop 推进到 tick 2；第二次挂起阻止 spin——
    // 原 mock 永挂起 = 循环卡死在 tick 1，断言永远成立（vacuous）
    let getUpdatesCalls = 0;
    const api = {
      getUpdates: vi.fn().mockImplementation(() => {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) return Promise.resolve({ ret: 0, msgs: [] } as never);
        return new Promise<never>(() => {}); // 第二次挂起，loop 停在 tick 2 的 getUpdates
      }),
      sendTextMessage: vi.fn(async () => { throw new Error("weixin sendmessage ret=-2 errmsg=prepare failed"); }),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000, cooldownMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    // 推进 100ms：tick 1（send 失败 + warnedAt）→ getUpdates resolve → tick 2（cooldown skip）→ getUpdates 挂起
    await vi.advanceTimersByTimeAsync(100);

    // tick 1：触发预警 → 失败 → 记 warnedAt
    expect(warnedCalls).toHaveLength(1);
    expect(warnedCalls[0]).toEqual({ accountId: "acc-1", userId: "user1" });
    const errorLog = logs.find(l => l.level === "error" && l.msg.includes("context_token 预警发送失败"));
    expect(errorLog).toBeDefined();

    // tick 2 已执行 checkContextTokenExpiry（getUpdates call 2 发生 = tick 2 的 check 已跑完）
    // 但 warnedCalls 仍只有1条——cooldown 生效，未再尝试预警
    expect(getUpdatesCalls).toBe(2); // 确认 loop 确实推进到了 tick 2

    poller.stop();
  });

  it("多用户一个失败不阻断其他用户", async () => {
    const receivedAt = fakeNow - 61 * 60_000;
    const { accountStore, warnedCalls } = makeFakeAccountStore({
      "acc-1": {
        user1: { token: "tok-dead", receivedAt },
        user2: { token: "tok-ok", receivedAt },
      },
    });
    const { logger } = makeLogger();
    const sentTo: string[] = [];
    const api = {
      getUpdates: vi.fn(() => new Promise<never>(() => {})),
      sendTextMessage: vi.fn(async (p: { toUserId: string }) => {
        if (p.toUserId === "user1") throw new Error("ret=-2");
        sentTo.push(p.toUserId);
      }),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000, cooldownMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);

    // user1 失败但 user2 成功
    expect(sentTo).toContain("user2");
    // 两个用户都被记了 warnedAt
    expect(warnedCalls).toHaveLength(2);

    poller.stop();
  });

  it("未配置 contextTokenWarn 不启用检查（sendTextMessage 不被调用）", async () => {
    const receivedAt = fakeNow - 120 * 60_000; // 2 小时前，已过期
    const { accountStore } = makeFakeAccountStore({
      "acc-1": { user1: { token: "tok-old", receivedAt } },
    });
    const { logger } = makeLogger();
    const api = {
      getUpdates: vi.fn(() => new Promise<never>(() => {})),
      sendTextMessage: vi.fn(async () => {}),
    } as unknown as WeixinApiClient;

    // 不传 contextTokenWarn
    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      now: () => fakeNow,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(api.sendTextMessage).not.toHaveBeenCalled();

    poller.stop();
  });

  it("无 token 条目不触发（空 store）", async () => {
    const { accountStore } = makeFakeAccountStore({});
    const { logger } = makeLogger();
    const api = {
      getUpdates: vi.fn(() => new Promise<never>(() => {})),
      sendTextMessage: vi.fn(async () => {}),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-empty",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000, cooldownMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(api.sendTextMessage).not.toHaveBeenCalled();

    poller.stop();
  });
});

describe("WeixinPollingChannel - 预警内存补偿止损 (F20260901wxnt 发现3)", () => {
  let fakeNow: number;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 1725188000000;
    vi.setSystemTime(fakeNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recordContextTokenWarned 落盘失败时内存补偿止损（F20260901wxnt 发现3）", async () => {
    const receivedAt = fakeNow - 61 * 60_000;
    const fakeStore = makeFakeAccountStore({
      "acc-1": {
        user1: { token: "tok-dead", receivedAt },
        user2: { token: "tok-ok", receivedAt },
      },
    });
    // user1 落盘失败（模拟磁盘故障），user2 正常
    let diskFailForUser1 = true;
    const origWarned = fakeStore.accountStore.recordContextTokenWarned as ReturnType<typeof vi.fn>;
    origWarned.mockImplementation((accountId: string, userId: string) => {
      if (accountId === "acc-1" && userId === "user1" && diskFailForUser1) {
        throw new Error("ENOSPC: disk full");
      }
      fakeStore.warnedCalls.push({ accountId, userId });
      if (fakeStore.store[accountId]?.[userId]) {
        fakeStore.store[accountId][userId].warnedAt = Date.now();
      }
    });
    const { logger } = makeLogger();
    const sendCalls: Array<{ toUserId: string }> = [];
    let getUpdatesCalls = 0;
    const DELAY_MS = 50;
    const api = {
      getUpdates: vi.fn().mockImplementation(() => {
        getUpdatesCalls++;
        return new Promise(resolve => setTimeout(() => resolve({ ret: 0, msgs: [] } as never), DELAY_MS));
      }),
      sendTextMessage: vi.fn(async (p: { toUserId: string }) => { sendCalls.push(p); }),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore: fakeStore.accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000, cooldownMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    // 推进 100ms：tick 1（user1 落盘失败但内存缓存已生效 + user2 成功）→ getUpdates sleep DELAY_MS
    await vi.advanceTimersByTimeAsync(100);

    // tick 1：两用户都触发预警，user1 落盘失败 + user2 正常
    expect(sendCalls).toHaveLength(2);
    expect(fakeStore.warnedCalls).toHaveLength(1); // 只有 user2 成功落盘
    expect(fakeStore.warnedCalls[0].userId).toBe("user2");

    const sendsAfterTick1 = sendCalls.length;

    // tick 2：即使 user1 落盘失败，内存缓存的 warnedAt 生效→冷却期内不重发
    await vi.advanceTimersByTimeAsync(DELAY_MS + 100); // 推进到 tick 2
    expect(sendCalls).toHaveLength(sendsAfterTick1); // 冷却期内无新发送

    // tick 3：推进 fakeNow 到冷却期过后，重发成功
    fakeNow += 61 * 60_000; // 61 分钟后，冷却期已过
    diskFailForUser1 = false; // 恢复磁盘
    await vi.advanceTimersByTimeAsync(DELAY_MS + 100); // 推进到 tick 3
    expect(sendCalls.length).toBeGreaterThan(sendsAfterTick1); // 冷却期过后有新发送
    expect(getUpdatesCalls).toBeGreaterThan(0); // loop 确实在运行

    poller.stop();
  });
});
