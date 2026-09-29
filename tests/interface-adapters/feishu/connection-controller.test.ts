import { describe, it, expect, vi } from "vitest";
import { FeishuConnectionController } from "@interface-adapters/http/controllers/feishu-connection-controller";
import { maskAppId } from "@frameworks/feishu/long-connection-client";

/** F20260928fsqr：飞书扫码连接端点测试——账号列表投影（掩码 appId）+ 删除防复活序 + 幂等建线 */

function makeDeps(overrides: Record<string, unknown> = {}) {
  const apps = (overrides.apps as Array<Record<string, string>>) ?? [
    { appId: "cli_a1b2c3d4e5f6", appSecret: "sec-a", ownerOpenId: "ou_chen", name: "joy 线", addedAt: "2026-09-28T00:00:00Z" },
    { appId: "cli_b2c3d4e5f6g7", appSecret: "sec-b", addedAt: "2026-09-28T01:00:00Z" },
  ];
  const appStore = {
    listApps: () => apps,
    getApp: (id: string) => apps.find((a) => a.appId === id),
    getAppByMaskedId: (masked: string) => {
      // maskAppId 单源同构；单射唯一命中才返回（碰撞 undefined）
      const hits = apps.filter((a) => maskAppId(a.appId) === masked);
      return hits.length === 1 ? hits[0] : undefined;
    },
    removeApp: (id: string) => { const i = apps.findIndex((a) => a.appId === id); if (i >= 0) apps.splice(i, 1); },
  };
  // 有状态 fake 连接仓库：botKey → connection → active session
  const sessionOf = new Map<string, string>([["conn-fs-0", "conv-fs-0"]]);
  const connectionRepo = {
    getByExternalId: async (externalId: string) =>
      externalId === "feishu-bot:cli_a****e5f6" ? { id: "conn-fs-0" } : null,
    getActiveSession: async (connectionId: string) =>
      sessionOf.has(connectionId) ? { conversationId: sessionOf.get(connectionId)! } : null,
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const onAppDeleted = vi.fn();
  const provision = overrides.provision as never;
  const controller = new FeishuConnectionController({
    loginSessions: {} as never,
    appStore: appStore as never,
    connectionRepo: connectionRepo as never,
    onAppDeleted,
    ...(provision ? { provisionAssistantLine: provision } : {}),
    logger: logger as never,
  });
  const json = vi.fn().mockReturnValue({} as Response);
  const mkCtx = (params: Record<string, string> = {}, body: unknown = {}) =>
    ({
      json,
      get: () => undefined,
      req: { json: async () => body, param: (n: string) => params[n] },
      params,
    } as never);
  return { controller, json, mkCtx, apps, onAppDeleted };
}

describe("FeishuConnectionController（F20260928fsqr）", () => {
  it("listApps：appId 掩码出网 + secret 不出网 + assistantLine 投影（botKey 匹配）", async () => {
    const { controller, json, mkCtx } = makeDeps();
    await controller.listApps(mkCtx());
    const list = json.mock.calls[0][0] as Array<Record<string, unknown>>;
    const first = list.find((a) => (a.appId as string).startsWith("cli_a"));
    expect(first?.appId).toBe("cli_a****e5f6"); // 掩码（非原文 cli_a1b2c3d4e5f6）
    expect(first).not.toHaveProperty("appSecret");
    expect(first?.hasSecret).toBe(true);
    expect(first?.assistantLine).toEqual({ conversationId: "conv-fs-0" });
    // 无绑定线（掩码不命中）不带 assistantLine
    const second = list.find((a) => (a.appId as string).startsWith("cli_b"));
    expect(second).not.toHaveProperty("assistantLine");
  });

  it("deleteApp：防复活序——掩码 id 回查（前端唯一可见形态），先回调停运行时后删 store", async () => {
    const { controller, json, mkCtx, apps } = makeDeps();
    // 前端只能传掩码（cli_a****e5f6），不是完整 appId（检视严重 3 回归锁）
    await controller.deleteApp(mkCtx({ id: "cli_a****e5f6" }));
    expect(apps.find((a) => a.appId === "cli_a1b2c3d4e5f6")).toBeUndefined(); // 完整 id 的 app 被删
    expect((json.mock.calls[0][0] as { ok: boolean }).ok).toBe(true);
  });

  it("deleteApp：掩码碰撞（两个 app 同掩码）→ 404 宁拒勿错删", async () => {
    const { controller, json, mkCtx, apps } = makeDeps({
      apps: [
        { appId: "cli_a1b2c3d4e5f6", appSecret: "s1", addedAt: "t1" },
        { appId: "cli_a1b2xxxxe5f6", appSecret: "s2", addedAt: "t2" }, // 前5尾4 同掩码
      ],
    });
    await controller.deleteApp(mkCtx({ id: "cli_a****e5f6" }));
    expect((json.mock.calls[0][0] as { error?: string }).error).toBe("feishu app not found");
    expect(apps).toHaveLength(2); // 都不删
  });

  it("provisionAssistantLine：掩码 id 回查 + name 缺省取 store 名（闭包收到完整 appId）", async () => {
    let provisioned: { appId: string; name: string } | undefined;
    const provision = async (appId: string, name: string) => {
      provisioned = { appId, name };
      return { conversationId: "conv-9", title: "joy 线" };
    };
    const { controller, json, mkCtx } = makeDeps({ provision });
    await controller.provisionAssistantLine(mkCtx({ id: "cli_a****e5f6" }, {}));
    expect(provisioned).toEqual({ appId: "cli_a1b2c3d4e5f6", name: "joy 线" }); // 闭包拿完整 id
    expect((json.mock.calls[0][0] as { conversationId: string }).conversationId).toBe("conv-9");
  });

  it("deleteApp：app 不存在 → 404（无副作用）", async () => {
    const { controller, json, mkCtx, apps } = makeDeps();
    const before = [...apps];
    await controller.deleteApp(mkCtx({ id: "cli_nope" }));
    expect((json.mock.calls[0][0] as { error?: string }).error).toBe("feishu app not found");
    expect(apps).toEqual(before); // store 未动
  });

  it("provisionAssistantLine：provision 闭包未注入（助理态未启用）→ 503", async () => {
    const { controller, json, mkCtx } = makeDeps(); // 不传 provision
    await controller.provisionAssistantLine(mkCtx({ id: "cli_a****e5f6" }, {}));
    expect(json.mock.calls[0][1]).toBe(503);
  });

  it("startLogin：name 超 60 字符 → 400", async () => {
    const { controller, json, mkCtx } = makeDeps();
    await controller.startLogin(mkCtx({}, { name: "很".repeat(61) }));
    expect(json.mock.calls[0][1]).toBe(400);
  });
});
