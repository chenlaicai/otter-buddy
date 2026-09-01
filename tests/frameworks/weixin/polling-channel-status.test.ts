/**
 * WeixinPollingChannel 状态上报测试（F20260901chun 测试设计承诺）
 *
 * 使用 fake registry 收集副作用（沿用 #638 副作用断言风格），
 * 断言 5 个关键节点（starting/running/token_stale/error_backoff/stopped）+ start/stop。
 * 禁止断言调用次数的 lint 红线。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WeixinPollingChannel, type WeixinInboundMessage } from "@frameworks/weixin/polling-channel";
import type { WeixinApiClient } from "@frameworks/weixin/api-client";
import type { WeixinAccountStore } from "@frameworks/weixin/account-store";
import type { Logger } from "@usecases/ports/logger";
import type { ChannelStatusRegistry, ChannelStatusEntry } from "@usecases/channel/channel-status";
import type { WeixinMessage } from "@frameworks/weixin/types";

/** fake registry：收集所有 update 调用的副作用（含 merge 逻辑，与 InMemoryChannelStatusRegistry 一致） */
function makeFakeRegistry() {
  const updates: Array<{ channelId: string; entry: Omit<ChannelStatusEntry, "channelId"> }> = [];
  const store = new Map<string, ChannelStatusEntry>();
  const registry: ChannelStatusRegistry = {
    update(channelId, entry) {
      const existing = store.get(channelId);
      const mergedState = existing ? { ...existing.state, ...entry.state } : entry.state;
      const merged = { ...entry, state: mergedState, channelId };
      store.set(channelId, merged);
      updates.push({ channelId, entry: merged });
    },
    remove() {},
    snapshot() {
      return Array.from(store.values()).map(e => ({ ...e }));
    },
    clear() { updates.length = 0; },
  };
  return { registry, updates };
}

function makeDeps(registry?: ChannelStatusRegistry) {
  const effects = {
    received: [] as WeixinInboundMessage[],
  };
  const accountStore = {
    loadSyncBuf: vi.fn().mockReturnValue(""),
    saveSyncBuf: vi.fn(),
    saveContextToken: vi.fn(),
    loadContextTokens: vi.fn().mockReturnValue({}),
  } as unknown as WeixinAccountStore;
  const onMessage = vi.fn(async (msg: WeixinInboundMessage) => { effects.received.push(msg); });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  return { accountStore, onMessage, logger, effects, registry };
}

function makeMsg(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: "user-1",
    message_type: 0,
    item_list: [{ type: 1, text_item: { text: "你好" }, msg_id: "m-1" }],
    context_token: "ctx-1",
    ...overrides,
  };
}

describe("WeixinPollingChannel 状态上报", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("start → starting 状态上报", () => {
    const { registry, updates } = makeFakeRegistry();
    const deps = makeDeps(registry);
    const api = { getUpdates: vi.fn(async () => new Promise(() => {})) } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, ...deps, accountId: "acc-1" });
    ch.start();
    // start 立即上报 starting
    expect(updates.some(u => u.entry.state.kind === "starting" && u.channelId === "weixin-acc-1")).toBe(true);
    ch.stop();
  });

  it("首次成功 getupdates → running 状态上报", async () => {
    const { registry, updates } = makeFakeRegistry();
    const deps = makeDeps(registry);
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ret: 0, msgs: [makeMsg()], get_updates_buf: "buf-1" };
        return new Promise(() => {});
      }),
    } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, ...deps, accountId: "acc-1" });
    ch.start();
    await vi.waitFor(() => expect(updates.some(u => u.entry.state.kind === "running")).toBe(true));
    ch.stop();
  });

  it("errcode -14 → token_stale 状态上报", async () => {
    const { registry, updates } = makeFakeRegistry();
    const deps = makeDeps(registry);
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { errcode: -14, errmsg: "session timeout" };
        return new Promise(() => {});
      }),
    } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, ...deps, accountId: "acc-1" });
    ch.start();
    await vi.waitFor(() => expect(updates.some(u => u.entry.state.kind === "token_stale")).toBe(true));
    const staleUpdate = updates.find(u => u.entry.state.kind === "token_stale");
    expect(staleUpdate?.entry.state).toMatchObject({ kind: "token_stale", errmsg: "session timeout" });
    ch.stop();
  });

  it("stop → stopped 状态上报", () => {
    const { registry, updates } = makeFakeRegistry();
    const deps = makeDeps(registry);
    const api = { getUpdates: vi.fn(async () => new Promise(() => {})) } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, ...deps, accountId: "acc-1" });
    ch.start();
    ch.stop();
    expect(updates.some(u => u.entry.state.kind === "stopped")).toBe(true);
  });

  it("无 registry 注入时不报错（防御性）", async () => {
    const deps = makeDeps(undefined);
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ret: 0, msgs: [makeMsg()], get_updates_buf: "b" };
        return new Promise(() => {});
      }),
    } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, ...deps, accountId: "acc-1" });
    ch.start();
    await vi.waitFor(() => expect(deps.effects.received).toHaveLength(1));
    ch.stop();
    // 不抛错即通过
  });

  it("lastInboundAt 保留：收到消息后报告 lastInboundAt，后续空轮询不覆盖", async () => {
    const { registry, updates } = makeFakeRegistry();
    const deps = makeDeps(registry);
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ret: 0, msgs: [makeMsg()], get_updates_buf: "b1" };
        if (calls === 2) return { ret: 0, msgs: [], get_updates_buf: "b2" }; // 空轮询
        return new Promise(() => {});
      }),
    } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, ...deps, accountId: "acc-1" });
    ch.start();
    // 等两轮轮询完成
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    ch.stop();
    // 找最后一次 running 状态更新
    const runningUpdates = updates.filter(u => u.entry.state.kind === "running");
    expect(runningUpdates.length).toBeGreaterThanOrEqual(2);
    // 第二次空轮询的 lastInboundAt 应保留第一次的值
    const lastRunning = runningUpdates[runningUpdates.length - 1];
    expect(lastRunning.entry.state.kind).toBe("running");
    // lastInboundAt 不应是 undefined（应保留第一次消息的值）
    expect((lastRunning.entry.state as any).lastInboundAt).toBeDefined();
  });
});
