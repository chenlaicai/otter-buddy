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
    const api = {
      getUpdates: vi.fn(() => new Promise<never>(() => {})),
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
    // 第一个 tick：触发预警 → 失败 → 记 warnedAt
    await vi.advanceTimersByTimeAsync(100);
    expect(warnedCalls).toHaveLength(1);
    expect(warnedCalls[0]).toEqual({ accountId: "acc-1", userId: "user1" });
    // error 日志记录了失败
    const errorLog = logs.find(l => l.level === "error" && l.msg.includes("context_token 预警发送失败"));
    expect(errorLog).toBeDefined();

    // 第二个 tick（冷却期内，warnedAt 刚记过）：不应再调 sendTextMessage
    // 快进到第二个 tick（轮询循环每 tick 会再检查一次）
    const warnedCallsAfterFirst = warnedCalls.length;
    await vi.advanceTimersByTimeAsync(100);
    // warnedCalls 数量不变——冷却期内不再尝试预警
    expect(warnedCalls).toHaveLength(warnedCallsAfterFirst);

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
