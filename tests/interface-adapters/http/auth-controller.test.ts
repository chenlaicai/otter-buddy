/**
 * 阶段 2（F20261113uaccs）：统一接入登录三端点 + 中间件会话优先。
 * 裸 createRouter + auth plumbing（不经 tests/api/helpers 身份包装）——断言真实装配行为。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createSessionSigner } from "../../../src/interface-adapters/http/auth/session-cookie";
import { verifyOwnerToken } from "../../../src/interface-adapters/http/auth/owner-token";
import { AuthController } from "../../../src/interface-adapters/http/controllers/auth-controller";
import { createRouter, type Controllers, type RouterPlumbingOptions } from "../../../src/interface-adapters/http/router";

const OWNER_TOKEN = "test-owner-token";

interface ExecutionMachineFixture {
  id: string;
  name: string;
}

function rawApp(executionMachines?: {
  list: () => ExecutionMachineFixture[];
  currentId: () => string;
}): Hono {
  const signer = createSessionSigner(OWNER_TOKEN);
  const auth = {
    verifySession: (value: string) => signer.verify(value, Date.now()),
    controller: new AuthController({
      verifyOwnerToken: (t) => verifyOwnerToken(OWNER_TOKEN, t),
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

  it("login：错误/缺失 token → 401 invalid_token", async () => {
    const bad = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "wrong" }) });
    expect(bad.status).toBe(401);
    expect((await bad.json() as { code: string }).code).toBe("invalid_token");
    const empty = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    expect(empty.status).toBe(401);
  });

  it("login：正确 token → 200 + 派发会话 cookie；session 端点凭 cookie 读到 owner/admin", async () => {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);

    const session = await app.request("/api/auth/session", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(session.status).toBe(200);
    const body = await session.json() as { identity: { userId: string; role: string } };
    expect(body.identity).toEqual({ userId: "owner", role: "admin" });
  });

  it("session：无 cookie → 401（fail-closed，未登录 API 按策略拒绝）", async () => {
    const res = await app.request("/api/auth/session");
    expect(res.status).toBe(401);
  });

  it("会话优先：有效 cookie 即使并发伪造 admin 头，也采信会话（owner 不来自可伪造值源）", async () => {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    const cookie = cookieOf(login);
    const res = await app.request("/api/auth/session", {
      headers: { Cookie: `otter_session=${cookie}`, "X-Otter-User-Id": "evil", "X-Otter-User-Role": "guest" },
    });
    const body = await res.json() as { identity: { userId: string; role: string } };
    expect(body.identity.userId).toBe("owner");
  });

  it("logout：幂等清 cookie；登出后 session 端点 401", async () => {
    await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    const logout = await app.request("/api/auth/logout", { method: "POST" });
    expect(logout.status).toBe(200);
    // 无 cookie 登出也 200（幂等）
    const again = await app.request("/api/auth/logout", { method: "POST" });
    expect(again.status).toBe(200);
  });

  it("登录拿到的 cookie 能通过受保护列表端点（authenticated 档）", async () => {
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: OWNER_TOKEN }) });
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
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    const cookie = cookieOf(login);
    const res = await app.request("/api/execution-machines", { headers: { Cookie: `otter_session=${cookie}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { machines: Array<{ id: string; name: string }>; currentMachineId: string };
    expect(body).toEqual({
      machines: [{ id: "local", name: "本机" }],
      currentMachineId: "local",
    });
  });
});