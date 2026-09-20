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
      contextTokenWarn: { afterMs: 60 * 60_000 },
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


  it("已提醒过即抑制，无论过去多久（原 cooldown 语义子集，F20260920wxho）", async () => {
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
      contextTokenWarn: { afterMs: 60 * 60_000 },
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
      contextTokenWarn: { afterMs: 60 * 60_000 },
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
      contextTokenWarn: { afterMs: 60 * 60_000 },
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
      contextTokenWarn: { afterMs: 60 * 60_000 },
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
      contextTokenWarn: { afterMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(api.sendTextMessage).not.toHaveBeenCalled();

    poller.stop();
  });
});

describe("WeixinPollingChannel - 入站清除内存缓存 warnedAt (F20260901wxnt 发现F)", () => {
  let fakeNow: number;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 1725188000000;
    vi.setSystemTime(fakeNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("入站消息清除内存缓存 warnedAt（资格重置的内存侧，F20260920wxho 语义）", async () => {
    // 场景（F20260920wxho 后：每静默期只提醒一次）
    // Phase 1: disk warnedAt=10min ago → 已提醒过 → 抑制
    // Phase 2: 快进121min → 仍抑制（cooldown 已退役，warnedAt 存在即跳过）
    //   ——但为验证内存清除链路，本测试 Phase 2 先入站换新重置资格：
    //   快进前先注入入站消息 → saveContextToken 清 disk warnedAt → 内存缓存 delete → 资格恢复
    // Phase 3: 快进 61min → age > afterMs → 预警触发 → 内存缓存 set warnedAt
    // Phase 4: 用户回复 → dispatchInbound → saveContextToken (disk 清零) + warnedAtMemoryCache.delete (内存清零)
    // Phase 5: 快进90min → age > afterMs, 内存缓存已清 → 预警触发
    // 若内存缓存未清（bug）：warnedAt 存在 → 错误抑制 → 漏发（用户回了消息却再收不到预警）
    const warnedAt = fakeNow - 10 * 60_000; // disk: 10 分钟前被预警过
    const { accountStore, savedTokens } = makeFakeAccountStore({
      "acc-1": { user1: { token: "tok", receivedAt: fakeNow - 61 * 60_000, warnedAt } },
    });
    const { logger } = makeLogger();
    const sendCalls: Array<{ toUserId: string; contextToken?: string }> = [];
    // Why: 使用 controllable resolver 控制 getUpdates 响应时机——
    // 每次 resolve 后 loop 自动推进到下一个 hanging getUpdates，可在两次 resolve 之间精确控制 fakeNow
    const getUpdatesResolvers: Array<(v: { ret: number; msgs: unknown[] }) => void> = [];
    let getUpdatesCallCount = 0;
    const api = {
      getUpdates: vi.fn().mockImplementation(() => {
        getUpdatesCallCount++;
        return new Promise(resolve => { getUpdatesResolvers.push(resolve); });
      }),
      sendTextMessage: vi.fn(async (p: { toUserId: string; contextToken?: string }) => { sendCalls.push(p); }),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();

    // Phase 1: check 运行（fakeNow 原始值），已提醒过 → 抑制 → getUpdates 1 挂起
    await vi.advanceTimersByTimeAsync(100); // drain check 微任务
    expect(getUpdatesCallCount).toBe(1); // loop 卡在 getUpdates 1
    expect(sendCalls).toHaveLength(0); // 已提醒过抑制

    // Phase 2: 入站消息 → saveContextToken（disk 清零）+ 内存缓存 delete → 资格重置
    getUpdatesResolvers[0]({
      ret: 0,
      msgs: [{
        message_type: 1,
        from_user_id: "user1",
        context_token: "tok-mid",
        item_list: [{ type: 1, text_item: { text: "还在吗" } }],
      }],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(savedTokens).toHaveLength(1);
    expect(getUpdatesCallCount).toBe(2); // loop 卡在 getUpdates 2

    // Phase 3: 快进 61 分钟 → resolve getUpdates 2 → check 运行 → 预警触发（第二次静默期满阈值）
    fakeNow += 61 * 60_000;
    getUpdatesResolvers[1]({ ret: 0, msgs: [] });
    await vi.advanceTimersByTimeAsync(100); // drain check + send + getUpdates 3 hang
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].toUserId).toBe("user1");
    expect(getUpdatesCallCount).toBe(3); // loop 卡在 getUpdates 3

    // Phase 4: resolve getUpdates 3 → 入站消息 → dispatchInbound
    // → saveContextToken（disk: receivedAt=now, warnedAt=undefined）+ warnedAtMemoryCache.delete
    // → check 运行（fakeNow 不变，age=0 → 不触发）→ getUpdates 4 挂起
    getUpdatesResolvers[2]({
      ret: 0,
      msgs: [{
        message_type: 1,
        from_user_id: "user1",
        context_token: "tok-renewed",
        item_list: [{ type: 1, text_item: { text: "hi" } }],
      }],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(savedTokens).toHaveLength(2); // saveContextToken 再次被调用
    expect(savedTokens[1].token).toBe("tok-renewed"); // token 换新
    expect(getUpdatesCallCount).toBe(4); // loop 卡在 getUpdates 4

    // Phase 5: 快进 90 分钟 → resolve getUpdates 4 → check 运行
    // age = 90min > afterMs = 60min
    // disk warnedAt = undefined（saveContextToken 清零）
    // 内存缓存 = 已清除（dispatchInbound 调了 delete）
    // → 应触发第二次预警（资格重置后的新静默期）
    // 若内存缓存未清（bug）：warnedAt 存在 → 错误抑制 → 漏发
    fakeNow += 90 * 60_000;
    getUpdatesResolvers[3]({ ret: 0, msgs: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1].toUserId).toBe("user1");
    expect(sendCalls[1].contextToken).toBe("tok-renewed"); // 入站换的新 token
    expect(getUpdatesCallCount).toBe(5); // loop 卡在 getUpdates 5

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
    // user1 落盘失败（模拟磁盘故障），user2 正常（F20260920wxho：不再恢复磁盘——每静默期一次无重发路径）
    const diskFailForUser1 = true;
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
      contextTokenWarn: { afterMs: 60 * 60_000 },
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

    // tick 2：即使 user1 落盘失败，内存缓存的 warnedAt 生效 → 本静默期内不重发（F20260920wxho：无论过多久）
    await vi.advanceTimersByTimeAsync(DELAY_MS + 100); // 推进到 tick 2
    fakeNow += 121 * 60_000; // 快进超过原 cooldown，仍不应重发
    await vi.advanceTimersByTimeAsync(DELAY_MS + 100); // tick 3
    expect(sendCalls).toHaveLength(sendsAfterTick1); // 每静默期一次：无新发送
    expect(getUpdatesCalls).toBeGreaterThan(0); // loop 确实在运行

    poller.stop();
  });
});

describe("WeixinPollingChannel - 预警资格重置（F20260920wxho：每静默期只提醒一次）", () => {
  let fakeNow: number;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 1725188000000;
    vi.setSystemTime(fakeNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("跨冷却期不重发：同一静默期只提醒一次（F20260920wxho 修复核心断言）", async () => {
    // 背景：修复前 cooldown 过期即重发，用户不回复 → 每小时一条无限轰炸（生产实证 6h/6 条）
    // 修复后：warnedAt 存在（本静默期内已提醒过）→ 无条件跳过，只有入站换新 token 才重置资格
    const receivedAt = fakeNow - 61 * 60_000;
    const warnedAt = fakeNow - 121 * 60_000; // 121 分钟前预警过（cooldown 60min 早已过期）
    const { accountStore } = makeFakeAccountStore({
      "acc-1": { user1: { token: "tok", receivedAt, warnedAt } },
    });
    const { logger } = makeLogger();
    const sendCalls: unknown[] = [];
    let getUpdatesCalls = 0;
    const DELAY_MS = 50;
    const api = {
      getUpdates: vi.fn().mockImplementation(() => {
        getUpdatesCalls++;
        return new Promise(resolve => setTimeout(() => resolve({ ret: 0, msgs: [] } as never), DELAY_MS));
      }),
      sendTextMessage: vi.fn(async () => { sendCalls.push(1); }),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2 + 100);
    expect(getUpdatesCalls).toBeGreaterThanOrEqual(2); // loop 确实跑了多个 tick
    expect(sendCalls).toHaveLength(0); // cooldown 早已过期，但本静默期已提醒过 → 不再发

    poller.stop();
  });

  it("入站换新 token 后重新获得预警资格（第二次静默期仍会提醒一次）", async () => {
    // 回复后资格重置的完整链路：dispatchInbound → saveContextToken 清 warnedAt + 内存缓存清除
    const receivedAt = fakeNow - 61 * 60_000;
    const warnedAt = fakeNow - 121 * 60_000;
    const { accountStore } = makeFakeAccountStore({
      "acc-1": { user1: { token: "tok-old", receivedAt, warnedAt } },
    });
    const { logger } = makeLogger();
    const sendCalls: Array<{ toUserId: string; contextToken?: string }> = [];
    const getUpdatesResolvers: Array<(v: { ret: number; msgs: unknown[] }) => void> = [];
    let getUpdatesCallCount = 0;
    const api = {
      getUpdates: vi.fn().mockImplementation(() => {
        getUpdatesCallCount++;
        return new Promise(resolve => { getUpdatesResolvers.push(resolve); });
      }),
      sendTextMessage: vi.fn(async (p: { toUserId: string; contextToken?: string }) => { sendCalls.push(p); }),
    } as unknown as WeixinApiClient;

    const poller = new WeixinPollingChannel({
      api,
      accountStore,
      accountId: "acc-1",
      onMessage: async () => {},
      logger,
      contextTokenWarn: { afterMs: 60 * 60_000 },
      now: () => fakeNow,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(100); // tick 1：已提醒过 → 不发
    expect(sendCalls).toHaveLength(0);

    // 入站消息换新 token（资格重置）
    getUpdatesResolvers[0]({
      ret: 0,
      msgs: [{
        message_type: 1,
        from_user_id: "user1",
        context_token: "tok-new",
        item_list: [{ type: 1, text_item: { text: "hi" } }],
      }],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(getUpdatesCallCount).toBe(2);

    // 快进 61 分钟 → 第二次静默期满阈值 → 应再次提醒（且用新 token）
    fakeNow += 61 * 60_000;
    getUpdatesResolvers[1]({ ret: 0, msgs: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].contextToken).toBe("tok-new");

    poller.stop();
  });
});
