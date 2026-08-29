import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WeixinPollingChannel, type WeixinInboundMessage } from "@frameworks/weixin/polling-channel";
import type { WeixinApiClient } from "@frameworks/weixin/api-client";
import type { WeixinAccountStore } from "@frameworks/weixin/account-store";
import type { Logger } from "@usecases/ports/logger";
import type { WeixinMessage } from "@frameworks/weixin/types";

/**
 * 轮询通道测试：断言副作用（收到消息记录/游标落盘记录/context_token 落盘记录），
 * 不断言 mock 调用参数本身（项目 lint 约定：副作用断言优先）。
 */
function makeMsg(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: "user-1",
    message_type: 0,
    item_list: [{ type: 1, text_item: { text: "你好" }, msg_id: "m-1" }],
    context_token: "ctx-1",
    ...overrides,
  };
}

function makeDeps() {
  const effects = {
    received: [] as WeixinInboundMessage[],
    savedSyncBufs: [] as string[],
    savedContextTokens: [] as Array<{ accountId: string; userId: string; token: string }>,
  };
  const accountStore = {
    loadSyncBuf: vi.fn().mockReturnValue(""),
    saveSyncBuf: vi.fn((id: string, buf: string) => { effects.savedSyncBufs.push(buf); }),
    saveContextToken: vi.fn((id: string, u: string, t: string) => { effects.savedContextTokens.push({ accountId: id, userId: u, token: t }); }),
    loadContextTokens: vi.fn().mockReturnValue({}),
  } as unknown as WeixinAccountStore;
  const onMessage = vi.fn(async (msg: WeixinInboundMessage) => { effects.received.push(msg); });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  return { accountStore, onMessage, logger, effects };
}

describe("WeixinPollingChannel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("收到消息：归一化分发 + 游标落盘 + context_token 落盘", async () => {
    const { accountStore, onMessage, logger, effects } = makeDeps();
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ret: 0, msgs: [makeMsg()], get_updates_buf: "buf-1" };
        return new Promise(() => {}); // 第二轮长轮询挂起（真实语义）
      }),
    } as unknown as WeixinApiClient;

    const ch = new WeixinPollingChannel({ api, accountStore, accountId: "acc-1", onMessage, logger });
    ch.start();
    await vi.waitFor(() => expect(effects.received).toHaveLength(1));
    ch.stop();

    expect(effects.received[0]).toMatchObject({ fromUserId: "user-1", body: "你好", contextToken: "ctx-1" });
    expect(effects.savedSyncBufs).toContain("buf-1");
    expect(effects.savedContextTokens).toContainEqual({ accountId: "acc-1", userId: "user-1", token: "ctx-1" });
  });

  it("过滤 bot 自身消息（message_type=2，防回环）", async () => {
    const { accountStore, onMessage, logger, effects } = makeDeps();
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ret: 0, msgs: [makeMsg({ message_type: 2 })], get_updates_buf: "b" };
        return new Promise(() => {});
      }),
    } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, accountStore, accountId: "acc-1", onMessage, logger });
    ch.start();
    await vi.advanceTimersByTimeAsync(50);
    ch.stop();
    expect(effects.received).toHaveLength(0);
  });

  it("errcode=-14（stale token）暂停不炸循环", async () => {
    const { accountStore, onMessage, logger, effects } = makeDeps();
    const api = { getUpdates: vi.fn(async () => ({ ret: 0, errcode: -14, errmsg: "stale" })) } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, accountStore, accountId: "acc-1", onMessage, logger });
    ch.start();
    await vi.advanceTimersByTimeAsync(100);
    ch.stop();
    // 暂停 1h 期间无消息分发、无游标落盘
    expect(effects.received).toHaveLength(0);
    expect(effects.savedSyncBufs).toHaveLength(0);
  });

  it("onMessage 抛错不中断轮询（后续消息照常收到）", async () => {
    const { accountStore, logger, effects } = makeDeps();
    const onMessage = vi.fn<(m: WeixinInboundMessage) => Promise<void>>()
      .mockRejectedValueOnce(new Error("handler boom"))
      .mockImplementation(async (m) => { effects.received.push(m); });
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ret: 0, msgs: [makeMsg()], get_updates_buf: "b1" };
        if (calls === 2) return { ret: 0, msgs: [makeMsg({ item_list: [{ type: 1, text_item: { text: "第二封" }, msg_id: "m-2" }] })], get_updates_buf: "b2" };
        return new Promise(() => {});
      }),
    } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, accountStore, accountId: "acc-1", onMessage, logger });
    ch.start();
    await vi.waitFor(() => expect(effects.received).toHaveLength(1));
    ch.stop();
    expect(effects.received[0].body).toBe("第二封");
  });

  it("语音转写 text 作为 body（协议 ASR 产物）", async () => {
    const { accountStore, onMessage, logger, effects } = makeDeps();
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ret: 0, msgs: [makeMsg({ item_list: [{ type: 3, voice_item: { text: "语音转写内容" } }] })], get_updates_buf: "b" };
        return new Promise(() => {});
      }),
    } as unknown as WeixinApiClient;
    const ch = new WeixinPollingChannel({ api, accountStore, accountId: "acc-1", onMessage, logger });
    ch.start();
    await vi.waitFor(() => expect(effects.received).toHaveLength(1));
    ch.stop();
    expect(effects.received[0].body).toBe("语音转写内容");
  });
});
