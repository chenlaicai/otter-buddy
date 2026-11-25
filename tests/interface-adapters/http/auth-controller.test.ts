/**
 * 统一接入登录三端点 + 中间件会话优先。
 * 裸 createRouter + auth plumbing（不经 tests/api/helpers 身份包装）——断言真实装配行为。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createSessionSigner } from "../../../src/interface-adapters/http/auth/session-cookie";
import { verifyOwnerPassword } from "../../../src/interface-adapters/http/auth/owner-password";
import { AuthController } from "../../../src/interface-adapters/http/controllers/auth-controller";
import { createRouter, type Controllers, type RouterPlumbingOptions } from "../../../src/interface-adapters/http/router";

const OWNER_PASSWORD = "test-owner-password";

interface ExecutionMachineFixture {
  id: string;
  name: string;
}

function rawApp(executionMachines?: {
  list: () => ExecutionMachineFixture[];
  currentId: () => string;
  deviceStatus?: () => Promise<Array<{ deviceId: string; name: string; online: boolean; lastSeenAt: string | null }>>;
  conversationExists?: (conversationId: string) => Promise<boolean>;
  setConversationMachine?: (conversationId: string, machineId: string | null) => Promise<{ ok: true } | { ok: false; status: 400 | 404; error: string }>;
  getConversationMachine?: (conversationId: string) => Promise<string | null>;
  listConversationRemoteActions?: (conversationId: string, limit?: number) => Promise<Array<{ actionId: string; deviceId: string; actionType: string; status: string; error: string | null; createdAt: string; settledAt: string | null }>>;
}): Hono {
  const signer = createSessionSigner(OWNER_PASSWORD);
  const auth = {
    verifySession: (value: string) => signer.verify(value, Date.now()),
    controller: new AuthController({
      verifyOwnerPassword: (t) => verifyOwnerPassword(OWNER_PASSWORD, t),
      signSession: (identity) => signer.sign(identity, Date.now()),
    }),
  };
  const controllers = {
    inbound: {
      optionsEvents: (c: { body: (b: null, s: number) => Response }) => c.body(null, 204),
      receiveEvents: async (c: { json: (b: unknown) => Response }) => c.json({ ok: true }),
      getStatus: async (c: { json: (b: unknown) => Response }) => c.json({ ok: true }),
    },
  } as unknown as Controllers;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  const plumbing: RouterPlumbingOptions = { auth };
  if (executionMachines) plumbing.executionMachines = executionMachines;
  return createRouter(controllers, logger as never, plumbing);
}

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const nameValue = setCookie!.split(";")[0];
  expect(nameValue).toMatch(/^otter_session=/);
  return nameValue.slice("otter_session=".length);
}

describe("统一接入登录（auth 三端点）", () => {
  const app = rawApp();

  it("login：错误/缺失口令 → 401 invalid_password", async () => {
    const bad = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) });
    expect(bad.status).toBe(401);
    expect((await bad.json() as { code: string }).code).toBe("invalid_password");
    const empty = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    expect(empty.status).toBe(401);
  });

  it("login：正确口令 → 200 + 派发会话 cookie；session 端点凭 cookie 读到 owner/admin", async () => {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);

    const session = await app.request("/api/auth/session", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(session.status).toBe(200);
    const body = await session.json() as { identity: { userId: string; role: string } };
    expect(body.identity).toEqual({ userId: "owner", role: "admin" });
  });

  it("cookie Secure 按请求形态翻转：反代 https → 带 Secure；明文 → 不带", async () => {
    const proxied = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    expect(proxied.headers.get("set-cookie")).toContain("Secure");

    const plain = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    expect(plain.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("cookie Secure：多值转发头取第一段，https 以外的值一律按明文", async () => {
    const multi = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https, http" },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    expect(multi.headers.get("set-cookie")).toContain("Secure");

    const downgraded = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "http" },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    expect(downgraded.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("session：无 cookie → 401（fail-closed，未登录 API 按策略拒绝）", async () => {
    const res = await app.request("/api/auth/session");
    expect(res.status).toBe(401);
  });

  it("会话优先：有效 cookie 即使并发伪造 admin 头，也采信会话（owner 不来自可伪造值源）", async () => {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    const cookie = cookieOf(login);
    const res = await app.request("/api/auth/session", {
      headers: { Cookie: `otter_session=${cookie}`, "X-Otter-User-Id": "evil", "X-Otter-User-Role": "guest" },
    });
    const body = await res.json() as { identity: { userId: string; role: string } };
    expect(body.identity.userId).toBe("owner");
  });

  it("logout：幂等清 cookie（无状态会话：登出不撤销已签发 cookie 值，撤销靠口令轮换）", async () => {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    const cookie = cookieOf(login); // 裸 app.request 不自动管理 cookie，此处显式取出以验证精确语义
    const logout = await app.request("/api/auth/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    // 无 cookie 登出也 200（幂等）
    const again = await app.request("/api/auth/logout", { method: "POST" });
    expect(again.status).toBe(200);
    // 已签发的 cookie 值在登出后仍可凭 HMAC 签名通过校验（无状态设计：登出仅清客户端 cookie）
    const after = await app.request("/api/auth/session", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(after.status).toBe(200);
  });

  it("AuthController.session 兜底：identity 缺失 → 401（fail-closed，不 fabricate admin）", async () => {
    const controller = new AuthController({
      verifyOwnerPassword: () => true,
      signSession: () => "unused-sig",
    });
    const bareContext = {
      get: () => undefined as unknown,
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    };
    const res = await controller.session(bareContext as never);
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe("unauthenticated");
  });

  it("登录拿到的 cookie 能通过受保护列表端点（authenticated 档）", async () => {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    const cookie = cookieOf(login);
    // /api/auth/session 是 authenticated 档的活端点，跨请求复用 cookie 即可
    expect((await app.request("/api/auth/session", { headers: { Cookie: `otter_session=${cookie}` } })).status).toBe(200);
  });
});

describe("执行机投影端点（/api/execution-machines）", () => {
  const app = rawApp({
    list: () => [{ id: "local", name: "本机" }],
    currentId: () => "local",
  });

  it("未登录 → 401（fail-closed，非 public 端点一律要求会话）", async () => {
    const res = await app.request("/api/execution-machines");
    expect(res.status).toBe(401);
  });

  it("登录后 → 200 返回 { machines, currentMachineId } 契约", async () => {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    const cookie = cookieOf(login);
    const res = await app.request("/api/execution-machines", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { machines: Array<{ id: string; name: string; online: boolean; lastSeenAt: string | null }>; currentMachineId: string };
    // F20261125expot PR-1：local 补齐 online/lastSeenAt（与设备条目同构；共享投影给 agent 感知工具）
    expect(body).toEqual({
      machines: [{ id: "local", name: "本机", online: true, lastSeenAt: null, local: true }],
      currentMachineId: "local",
    });
  });

  it("阶段 5 + M2（检视）：GET 全量设备列表——离线已配对设备可见 + 在线状态点", async () => {
    const appJoin = rawApp({
      list: () => [{ id: "local", name: "本机" }],
      currentId: () => "local",
      deviceStatus: async () => [
        { deviceId: "connector-b", name: "B 机", online: true, lastSeenAt: "2026-11-18T06:00:00Z" },
        { deviceId: "connector-c", name: "C 机（离线）", online: false, lastSeenAt: "2026-11-17T00:00:00Z" },
      ],
    });
    const login = await appJoin.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    const cookie = cookieOf(login);
    const res = await appJoin.request("/api/execution-machines", { headers: { Cookie: `otter_session=${cookie}` } });
    const body = await res.json() as { machines: Array<{ id: string; name: string; online?: boolean; lastSeenAt?: string }>; currentMachineId: string };
    // local 恒在首位（Registry）；已配对设备全量（含离线——人要看得见才能决定切回）
    expect(body.machines.map(m => m.id)).toEqual(["local", "connector-b", "connector-c"]);
    expect(body.machines.find(m => m.id === "connector-b")).toMatchObject({ online: true, lastSeenAt: "2026-11-18T06:00:00Z" });
    expect(body.machines.find(m => m.id === "connector-c")).toMatchObject({ online: false, lastSeenAt: "2026-11-17T00:00:00Z" });
    expect(body.machines.find(m => m.id === "local")).toMatchObject({ online: true, lastSeenAt: null, local: true }); // F20261125expot S1：local 恒在线 + local:true 显式信号（isDevice 判别不靠字段缺省）
  });

  it("阶段 5：deviceStatus 缺省 → 仅 local（旧装配兼容退化）", async () => {
    const appNoStatus = rawApp({ list: () => [{ id: "local", name: "本机" }], currentId: () => "local" });
    const login = await appNoStatus.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    const cookie = cookieOf(login);
    const res = await appNoStatus.request("/api/execution-machines", { headers: { Cookie: `otter_session=${cookie}` } });
    const body = await res.json() as { machines: Array<{ id: string; online: boolean; lastSeenAt: string | null }> };
    expect(body.machines).toEqual([{ id: "local", name: "本机", online: true, lastSeenAt: null, local: true }]);
  });
});

describe("对话级执行机切换端点（阶段 5 PR-A：PUT /api/conversations/:id/execution-machine）", () => {
  function appWith(setter: NonNullable<Parameters<typeof rawApp>[0]>["setConversationMachine"]): Hono {
    return rawApp({
      list: () => [{ id: "local", name: "本机" }, { id: "connector-b", name: "B 机" }],
      currentId: () => "local",
      setConversationMachine: setter,
    });
  }
  async function cookieOfApp(app: Hono): Promise<string> {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    return cookieOf(login);
  }

  it("未登录 → 401（fail-closed）", async () => {
    const res = await appWith(async () => ({ ok: true })).request("/api/conversations/c-1/execution-machine", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineId: "connector-b" }) });
    expect(res.status).toBe(401);
  });

  it("非法 body（machineId 非字符串/非 null）→ 400", async () => {
    const app = appWith(async () => ({ ok: true }));
    const cookie = await cookieOfApp(app);
    const res = await app.request("/api/conversations/c-1/execution-machine", { method: "PUT", headers: { "Content-Type": "application/json", Cookie: `otter_session=${cookie}` }, body: JSON.stringify({ machineId: 42 }) });
    expect(res.status).toBe(400);
  });

  it("目标未注册 → 400（setter 收到校验后的调用）；对话不存在 → 404；成功 → {ok:true}", async () => {
    const calls: Array<[string, string | null]> = [];
    const app = appWith(async (conversationId, machineId) => {
      calls.push([conversationId, machineId]);
      if (machineId === "ghost") return { ok: false as const, status: 400 as const, error: "machine not registered" };
      if (conversationId === "c-missing") return { ok: false as const, status: 404 as const, error: "conversation not found" };
      return { ok: true as const };
    });
    const cookie = await cookieOfApp(app);
    const put = (cid: string, machineId: string | null) =>
      app.request(`/api/conversations/${cid}/execution-machine`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: `otter_session=${cookie}` }, body: JSON.stringify({ machineId }) });

    expect((await put("c-1", "ghost")).status).toBe(400);
    expect((await put("c-missing", "connector-b")).status).toBe(404);
    const ok = await put("c-1", "connector-b");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(calls).toEqual([["c-1", "ghost"], ["c-missing", "connector-b"], ["c-1", "connector-b"]]);

    // machineId=null 回默认 local
    expect((await put("c-1", null)).status).toBe(200);
    expect(calls[3]).toEqual(["c-1", null]);
  });
});

// ─── ：对话当前机 + 远程动作状态端点 ───
describe("执行状态端点（GET execution-machine / remote-actions）", () => {
  function statusApp(current: string | null, actions: Array<{ actionId: string; status: string }>, exists?: () => Promise<boolean>): Hono {
    return rawApp({
      list: () => [{ id: "local", name: "本机" }],
      currentId: () => "local",
      ...(exists ? { conversationExists: exists } : {}),
      getConversationMachine: async () => current,
      listConversationRemoteActions: async (_cid, limit) =>
        actions.slice(-(limit ?? 50)).reverse().map(a => ({
          actionId: a.actionId, deviceId: "connector-b", actionType: "workspace.write",
          status: a.status, error: null, createdAt: "2026-11-18T06:00:00Z", settledAt: "2026-11-18T06:00:01Z",
        })),
    });
  }
  async function cookieOfApp(app: Hono): Promise<string> {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    return cookieOf(login);
  }

  it("GET /execution-machine：返回对话当前机（null=默认 local）", async () => {
    const app = statusApp(null, []);
    const cookie = await cookieOfApp(app);
    const res = await app.request("/api/conversations/c-1/execution-machine", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machineId: null });
  });

  it("GET /remote-actions：最近优先（倒序）+ limit 收口（>200 归 50）", async () => {
    const app = statusApp("connector-b", [
      { actionId: "a-1", status: "succeeded" },
      { actionId: "a-2", status: "unknown" },
      { actionId: "a-3", status: "interrupted" },
    ]);
    const cookie = await cookieOfApp(app);
    const res = await app.request("/api/conversations/c-1/remote-actions?limit=2", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { actions: Array<{ actionId: string }> };
    expect(body.actions.map(a => a.actionId)).toEqual(["a-3", "a-2"]); // 最近优先 + limit=2
    const resBad = await app.request("/api/conversations/c-1/remote-actions?limit=999", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(resBad.status).toBe(200); // 越界 limit 归 50 不 500
  });

  it("未登录 → 401（fail-closed）", async () => {
    const app = statusApp(null, []);
    expect((await app.request("/api/conversations/c-1/execution-machine")).status).toBe(401);
    expect((await app.request("/api/conversations/c-1/remote-actions")).status).toBe(401);
  });

  // GET 404 口径对齐 PUT——不存在对话不再混作「默认 local」
  it("GET 两端点：不存在对话 → 404 conversation not found（对齐 PUT 口径）", async () => {
    const app = statusApp(null, [], async () => false);
    const cookie = await cookieOfApp(app);
    const res1 = await app.request("/api/conversations/ghost/execution-machine", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(res1.status).toBe(404);
    expect(await res1.json()).toEqual({ error: "conversation not found" });
    const res2 = await app.request("/api/conversations/ghost/remote-actions", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(res2.status).toBe(404);
    expect(await res2.json()).toEqual({ error: "conversation not found" });
  });

  it("存在对话 → 200 正常（存在性校验不误伤）", async () => {
    const app = statusApp("connector-b", [], async () => true);
    const cookie = await cookieOfApp(app);
    const res = await app.request("/api/conversations/c-1/execution-machine", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machineId: "connector-b" });
  });
});
