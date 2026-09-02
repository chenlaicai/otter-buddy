import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelStatusRegistry } from "@usecases/channel/channel-status";

// F20260901chun：飞书 WS 回调→registry 状态映射测试
// 检视獭 D2 要求：飞书4回调映射至少一组测试覆盖

/** Mock 连接状态（#663：onReconnecting 上报 reconnectAttempts 的数据源，用例内可改） */
let mockConnectionStatus: { state: string; lastConnectTime?: string; reconnectAttempts: number } = {
  state: "connected", lastConnectTime: "t", reconnectAttempts: 0,
};

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
      getConnectionStatus() { return mockConnectionStatus; }
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
    mockConnectionStatus = { state: "connected", lastConnectTime: "t", reconnectAttempts: 0 };
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

  // ── #663：重连次数入 registry + appId 掩码上报 ──

  it("onReconnecting：registry 状态携带 reconnectAttempts（#663 数据源只打日志→入 registry）", async () => {
    const { FeishuLongConnectionClient } = await import("@frameworks/feishu/long-connection-client");
    const registry = makeRegistry();
    const config = { appId: "cli_a1b2c3d4e5f6g7h8", appSecret: "s" } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const tokenManager = {} as never;

    new FeishuLongConnectionClient(config, logger as never, tokenManager, registry);
    mockConnectionStatus = { state: "reconnecting", reconnectAttempts: 3 };
    capturedCallbacks.onReconnecting!();

    expect(registry.calls[0]).toMatchObject({
      channelId: "feishu",
      entry: {
        kind: "feishu",
        state: expect.objectContaining({ kind: "error_backoff", errorMsg: "WS 重连中", reconnectAttempts: 3 }),
      },
    });
  });

  it("registry 条目携带掩码 appId（#663 完整凭证不出 frameworks 层）", async () => {
    const { FeishuLongConnectionClient } = await import("@frameworks/feishu/long-connection-client");
    const registry = makeRegistry();
    const config = { appId: "cli_a1b2c3d4e5f6g7h8", appSecret: "s" } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const tokenManager = {} as never;

    new FeishuLongConnectionClient(config, logger as never, tokenManager, registry);
    capturedCallbacks.onReady!();

    const entry = registry.calls[0].entry as { appIdMasked?: string };
    expect(entry.appIdMasked).toBe("cli_a****g7h8");
    expect(String(entry.appIdMasked)).not.toContain("b2c3d4e5f6"); // 中段不可见
  });
});

describe("maskAppId（#663）", () => {
  it("常规 appId：前 5 后 4 可见，中段掩码", async () => {
    const { maskAppId } = await import("@frameworks/feishu/long-connection-client");
    expect(maskAppId("cli_a1b2c3d4e5f6g7h8")).toBe("cli_a****g7h8");
  });

  it("超短 appId（≤9 位）：只留前 2 后 2", async () => {
    const { maskAppId } = await import("@frameworks/feishu/long-connection-client");
    expect(maskAppId("cli_ab")).toBe("cl****ab");
    expect(maskAppId("cli_abcde")).toBe("cl****de");
  });

  it("空串安全", async () => {
    const { maskAppId } = await import("@frameworks/feishu/long-connection-client");
    expect(maskAppId("")).toBe("");
  });
});
