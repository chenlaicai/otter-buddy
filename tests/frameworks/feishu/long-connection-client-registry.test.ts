import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelStatusRegistry } from "@usecases/channel/channel-status";

// F20260901chun：飞书 WS 回调→registry 状态映射测试
// 检视獭 D2 要求：飞书4回调映射至少一组测试覆盖

/** Mock WSClient 回调捕获器 */
let capturedCallbacks: {
  onReady?: () => void;
  onError?: (err: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
} = {};

vi.mock("@larksuiteoapi/node-sdk", () => {
  return {
    WSClient: class {
      constructor(opts: Record<string, unknown>) {
        capturedCallbacks.onReady = opts.onReady as () => void;
        capturedCallbacks.onError = opts.onError as (err: Error) => void;
        capturedCallbacks.onReconnecting = opts.onReconnecting as () => void;
        capturedCallbacks.onReconnected = opts.onReconnected as () => void;
      }
      getConnectionStatus() { return { state: "connected", lastConnectTime: "t", reconnectAttempts: 0 }; }
      async start() { /* noop */ }
      close() { /* noop */ }
    },
    EventDispatcher: class {
      register() { /* noop */ }
    },
  };
});

function makeRegistry(): ChannelStatusRegistry & { calls: Array<{ channelId: string; entry: unknown }> } {
  const calls: Array<{ channelId: string; entry: unknown }> = [];
  return {
    update: vi.fn((channelId: string, entry: unknown) => { calls.push({ channelId, entry }); }),
    remove: vi.fn(),
    snapshot: vi.fn(() => []),
    clear: vi.fn(),
    calls,
  };
}

describe("FeishuLongConnectionClient WS回调→registry 状态映射", () => {
  beforeEach(() => {
    capturedCallbacks = {};
  });

  it("onReady → registry 收到 running 状态", async () => {
    const { FeishuLongConnectionClient } = await import("@frameworks/feishu/long-connection-client");
    const registry = makeRegistry();
    const config = { appId: "a", appSecret: "s" } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const tokenManager = {} as never;

    new FeishuLongConnectionClient(config, logger as never, tokenManager, registry);
    capturedCallbacks.onReady!();

    expect(registry.update).toHaveBeenCalledOnce();
    expect(registry.calls[0]).toMatchObject({
      channelId: "feishu",
      entry: { kind: "feishu", state: expect.objectContaining({ kind: "running" }) },
    });
  });

  it("onError → registry 收到 error_backoff 状态（含 errorMsg）", async () => {
    const { FeishuLongConnectionClient } = await import("@frameworks/feishu/long-connection-client");
    const registry = makeRegistry();
    const config = { appId: "a", appSecret: "s" } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const tokenManager = {} as never;

    new FeishuLongConnectionClient(config, logger as never, tokenManager, registry);
    capturedCallbacks.onError!(new Error("test error"));

    expect(registry.update).toHaveBeenCalledOnce();
    expect(registry.calls[0]).toMatchObject({
      channelId: "feishu",
      entry: { kind: "feishu", state: expect.objectContaining({ kind: "error_backoff", errorMsg: "test error" }) },
    });
  });

  it("onReconnecting → registry 收到 error_backoff 状态（errorMsg='WS 重连中'）", async () => {
    const { FeishuLongConnectionClient } = await import("@frameworks/feishu/long-connection-client");
    const registry = makeRegistry();
    const config = { appId: "a", appSecret: "s" } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const tokenManager = {} as never;

    new FeishuLongConnectionClient(config, logger as never, tokenManager, registry);
    capturedCallbacks.onReconnecting!();

    expect(registry.update).toHaveBeenCalledOnce();
    expect(registry.calls[0]).toMatchObject({
      channelId: "feishu",
      entry: { kind: "feishu", state: expect.objectContaining({ kind: "error_backoff", errorMsg: "WS 重连中" }) },
    });
  });

  it("onReconnected → registry 收到 running 状态（重连成功）", async () => {
    const { FeishuLongConnectionClient } = await import("@frameworks/feishu/long-connection-client");
    const registry = makeRegistry();
    const config = { appId: "a", appSecret: "s" } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const tokenManager = {} as never;

    new FeishuLongConnectionClient(config, logger as never, tokenManager, registry);
    capturedCallbacks.onReconnected!();

    expect(registry.update).toHaveBeenCalledOnce();
    expect(registry.calls[0]).toMatchObject({
      channelId: "feishu",
      entry: { kind: "feishu", state: expect.objectContaining({ kind: "running" }) },
    });
  });

  it("无 registry 注入时不崩溃", async () => {
    const { FeishuLongConnectionClient } = await import("@frameworks/feishu/long-connection-client");
    const config = { appId: "a", appSecret: "s" } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const tokenManager = {} as never;

    new FeishuLongConnectionClient(config, logger as never, tokenManager);
    // 所有回调触发不抛异常
    capturedCallbacks.onReady!();
    capturedCallbacks.onError!(new Error("x"));
    capturedCallbacks.onReconnecting!();
    capturedCallbacks.onReconnected!();
  });
});
