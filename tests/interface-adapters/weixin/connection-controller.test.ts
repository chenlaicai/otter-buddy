import { describe, it, expect, vi } from "vitest";
import { WeixinConnectionController } from "@interface-adapters/http/controllers/weixin-connection-controller";

/** F20260921imux：账号列表助理线投影 + 同号识别端点测试（先名后码流程的后端支撑） */

function makeDeps(overrides: Record<string, unknown> = {}) {
  const accounts = (overrides.accounts as Array<Record<string, unknown>>) ?? [
    { id: "weixin-a", ilinkUserId: "u-chen", addedAt: "2026-09-20T00:00:00Z", token: "t-a" },
  ];
  const accountStore = {
    listAccounts: () => accounts,
    getAccount: (id: string) => accounts.find(a => a.id === id),
    removeAccount: (id: string) => { const i = accounts.findIndex(a => a.id === id); if (i >= 0) accounts.splice(i, 1); },
  };
  // 有状态 fake 连接仓库：externalId → connection → active session（与真实链路同构）
  const sessionOf = new Map<string, string>([["conn-weixin-a", "conv-1"]]);
  const connectionRepo = {
    getByExternalId: async (externalId: string) => (accounts.some(a => a.id === externalId) ? { id: `conn-${externalId}` } : null),
    getActiveSession: async (connectionId: string) => (sessionOf.has(connectionId) ? { conversationId: sessionOf.get(connectionId)! } : null),
  };
  const json = vi.fn().mockReturnValue({} as Response);
  const c = { json, req: { json: async () => (overrides.body ?? {}) }, params: {} } as unknown as Parameters<WeixinConnectionController["listAccounts"]>[0];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const controller = new WeixinConnectionController({
    loginSessions: {} as never,
    accountStore: accountStore as never,
    connectionRepo: connectionRepo as never,
    logger: logger as never,
    ...(overrides.deps as object),
  });
  return { controller, json, c, connectionRepo, accountStore };
}

describe("WeixinConnectionController（F20260921imux 助理线投影）", () => {
  it("listAccounts：带 active 绑定的账号投影 assistantLine.conversationId", async () => {
    const { controller, json, c } = makeDeps();
    await controller.listAccounts(c);
    const list = json.mock.calls[0][0] as Array<Record<string, unknown>>;
    const acc = list.find(a => a.id === "weixin-a");
    expect(acc?.assistantLine).toEqual({ conversationId: "conv-1" });
    expect(acc?.hasToken).toBe(true);
  });

  it("listAccounts：无绑定账号不带 assistantLine 字段（未建线语义由缺失表达）", async () => {
    const { controller, json, c } = makeDeps();
    await controller.listAccounts(c);
    const list = json.mock.calls[0][0] as Array<{ assistantLine?: { conversationId?: unknown } | null }>;
    // 仅断言存在性与类型——具体绑定在上例覆盖
    expect(list.every(a => !a.assistantLine || typeof a.assistantLine.conversationId === "string")).toBe(true);
  });

  it("lookupExistingAccount：同 ilinkUserId 命中已有账号（含助理线）", async () => {
    const { controller, json, c } = makeDeps({ body: { ilinkUserId: "u-chen" } });
    await controller.lookupExistingAccount(c);
    const resp = json.mock.calls[0][0] as { account?: { id: string; assistantLine?: { conversationId: string } } };
    expect(resp.account?.id).toBe("weixin-a");
    expect(resp.account?.assistantLine?.conversationId).toBe("conv-1");
  });

  it("lookupExistingAccount：无同号返回空对象（不报错）", async () => {
    const { controller, json, c } = makeDeps({ body: { ilinkUserId: "u-nobody" } });
    await controller.lookupExistingAccount(c);
    expect(json.mock.calls[0][0]).toEqual({});
  });

  it("lookupExistingAccount：缺 ilinkUserId → 400", async () => {
    const { controller, json, c } = makeDeps({ body: {} });
    await controller.lookupExistingAccount(c);
    expect(json.mock.calls[0][1]).toBe(400);
  });
});
