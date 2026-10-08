/**
 * ChannelController 聚合端点测试（F20260901chun 测试设计承诺）
 *
 * 断言 leftJoin 合并逻辑：有 registry 条目用运行态、无条目显示 not_started、
 * 飞书通道仅在有 registry 条目时出现。
 */
import { describe, it, expect } from "vitest";
import { ChannelController } from "@interface-adapters/http/controllers/channel-controller";
import type { ChannelStatusRegistry, ChannelStatusEntry } from "@usecases/channel/channel-status";
import type { WeixinAccountStorePort } from "@interface-adapters/http/controllers/weixin-connection-controller";

/** fake registry */
function makeRegistry(entries: ChannelStatusEntry[]): ChannelStatusRegistry {
  return {
    update() {},
    remove() {},
    snapshot() { return entries.map(e => ({ ...e })); },
    clear() {},
  };
}

/** fake account store */
function makeAccountStore(accounts: Array<{ id: string; nickname?: string }>): WeixinAccountStorePort {
  return {
    listAccounts: () => accounts,
  } as WeixinAccountStorePort;
}

/** minimal Hono Context mock */
function makeContext() {
  let responseBody: any;
  return {
    ctx: { json: (body: any) => { responseBody = body; return new Response(JSON.stringify(body)); } } as any,
    getBody: () => responseBody,
  };
}

describe("ChannelController.getStatus", () => {
  it("微信账号有 registry 条目时返回运行态", async () => {
    const registry = makeRegistry([
      { channelId: "weixin-acc1", kind: "weixin", state: { kind: "running", since: 1000 } },
    ]);
    const accountStore = makeAccountStore([{ id: "acc1" }]);
    const controller = new ChannelController(registry, accountStore);
    const { ctx, getBody } = makeContext();
    await controller.getStatus(ctx);
    const body = getBody();
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({
      channelId: "weixin-acc1",
      kind: "weixin",
      state: { kind: "running", since: 1000 },
      account: { id: "acc1" },
    });
  });

  it("微信账号无 registry 条目时返回 not_started", async () => {
    const registry = makeRegistry([]);
    const accountStore = makeAccountStore([{ id: "acc1" }]);
    const controller = new ChannelController(registry, accountStore);
    const { ctx, getBody } = makeContext();
    await controller.getStatus(ctx);
    const body = getBody();
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({
      channelId: "weixin-acc1",
      kind: "weixin",
      state: { kind: "stopped", reason: "not_started" },
    });
  });

  it("飞书通道有 registry 条目时出现（F20260929fsqr：静态键退役，扫码线 feishu-bot: 前缀投影）", async () => {
    const registry = makeRegistry([
      { channelId: "feishu-bot:cli_a****z9k2", kind: "feishu-bot:cli_a****z9k2", state: { kind: "running", since: 2000 } },
    ]);
    const accountStore = makeAccountStore([]);
    const controller = new ChannelController(registry, accountStore);
    const { ctx, getBody } = makeContext();
    await controller.getStatus(ctx);
    const body = getBody();
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({ channelId: "feishu-bot:cli_a****z9k2", kind: "feishu-bot:cli_a****z9k2" });
  });

  it("飞书通道无 registry 条目时不出现", async () => {
    const registry = makeRegistry([]);
    const accountStore = makeAccountStore([]);
    const controller = new ChannelController(registry, accountStore);
    const { ctx, getBody } = makeContext();
    await controller.getStatus(ctx);
    const body = getBody();
    expect(body.channels).toHaveLength(0);
  });

  it("混合场景：微信 + 飞书扫码线同时存在（静态键退役后仅 feishu-bot: 前缀）", async () => {
    const registry = makeRegistry([
      { channelId: "weixin-acc1", kind: "weixin", state: { kind: "token_stale", since: 3000, errmsg: "session timeout" } },
      { channelId: "feishu-bot:cli_a****z9k2", kind: "feishu-bot:cli_a****z9k2", state: { kind: "error_backoff", since: 4000, errorMsg: "WS 断线" } },
    ]);
    const accountStore = makeAccountStore([{ id: "acc1" }]);
    const controller = new ChannelController(registry, accountStore);
    const { ctx, getBody } = makeContext();
    await controller.getStatus(ctx);
    const body = getBody();
    expect(body.channels).toHaveLength(2);
    expect(body.channels[0].state.kind).toBe("token_stale");
    expect(body.channels[1].state.kind).toBe("error_backoff");
  });

  // #1211：deprecatedFeishuConfig 透传——存量 feishu 静态段检测，仅 true 时携带
  it("#1211 deprecatedFeishuConfig=true：响应顶层携带迁移标记", async () => {
    const registry = makeRegistry([]);
    const controller = new ChannelController(registry, undefined, true);
    const { ctx, getBody } = makeContext();
    await controller.getStatus(ctx);
    const body = getBody();
    expect(body.deprecatedFeishuConfig).toBe(true);
    expect(body.channels).toHaveLength(0);
  });

  it("#1211 deprecatedFeishuConfig 缺省（无旧段）：响应不携带字段（非 false 污染）", async () => {
    const registry = makeRegistry([]);
    const accountStore = makeAccountStore([{ id: "acc1" }]);
    const controller = new ChannelController(registry, accountStore);
    const { ctx, getBody } = makeContext();
    await controller.getStatus(ctx);
    const body = getBody();
    expect(body.deprecatedFeishuConfig).toBeUndefined();
    expect(body.channels).toHaveLength(1);
  });
});
