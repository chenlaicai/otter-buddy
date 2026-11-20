/**
 * 对话域鉴权层测试：身份声明解析 + 路由策略表 + fail-closed 兜底。
 *
 * 三个层次：
 *  1. resolvePolicy 纯矩阵——策略表档位与顺序（例外先于族规则）、方法级兜底、非 /api 直通；
 *  2. identityMiddleware 行为（mini app 裸挂中间件）——401/403/public/直链 query/非法值降级；
 *  3. 真实 createRouter 裸 app（不经测试身份包装）——门禁在真实路由装配上生效。
 *
 * 注意：本文件必须用**裸 app**——tests/api/helpers 的 createTestApp 已注入默认身份
 * （withIdentity），那层是给业务用例免身份噪声用的，不能用于鉴权断言。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  identityMiddleware,
  resolvePolicy,
  allowsDeclaredIdentity,
  IDENTITY_HEADERS,
  IDENTITY_QUERY,
} from "../../../src/interface-adapters/http/identity-middleware";
import { createRouter, type Controllers } from "../../../src/interface-adapters/http/router";
import type { Context } from "hono";

const H_ID = IDENTITY_HEADERS.userId;
const H_ROLE = IDENTITY_HEADERS.role;

describe("resolvePolicy：路由策略表矩阵", () => {
  it("显式档位（public / admin / 族内例外先于族规则）", () => {
    const cases: Array<[string, string, string]> = [
      // public
      ["GET", "/api/ping", "public"],
      ["POST", "/api/inbound/events", "public"],
      ["OPTIONS", "/api/inbound/events", "public"],
      ["GET", "/api/inbound/status", "public"],
      ["POST", "/api/mahjong/rooms", "public"], // 新增面：暂置（见表内翻转锚点）
      ["GET", "/api/mahjong/rooms/r1/view", "public"],
      // admin 族
      ["PUT", "/api/settings", "admin"],
      ["GET", "/api/settings", "admin"], // 处置 1：读面显式收档，不留隐式兜底
      ["GET", "/api/settings/status", "admin"],
      ["POST", "/api/otters", "admin"],
      ["DELETE", "/api/otters/o1", "admin"],
      ["POST", "/api/otters/o1/restart", "admin"],
      ["POST", "/api/scheduled-tasks/t1/trigger", "admin"],
      ["PATCH", "/api/scheduled-tasks/t1", "admin"],
      ["DELETE", "/api/scheduled-tasks/t1", "admin"],
      ["POST", "/api/conversations/c1/scheduled-tasks", "admin"],
      ["PUT", "/api/conversations/c1/workspace/mcp-external", "admin"],
      ["POST", "/api/health/scan", "admin"],
      ["POST", "/api/health/signals/s1/triage", "admin"],
      // POST /api/connections（create）已下线，矩阵行删除；
      // identity-middleware.ts 的 admin 兼规则保留作防御纵深（防误挂降级），见源码注释。
      ["POST", "/api/weixin/login", "admin"],
      ["DELETE", "/api/feishu/apps/a1", "admin"],
      // 族内例外（必须先于同族 admin 命中——顺序敏感）
      ["POST", "/api/otters/o1/retry", "write"],
      ["POST", "/api/connections/c1/enter", "write"],
      // POST :id/leave 已下线，矩阵行删除（enter 保留为活端点）
      // 阅读语义的 POST 形态与读面同档（全库记忆正文）
      ["POST", "/api/memory/search/similar", "write"],
      // 读面显式收档：业务正文（对话/时间线/invoke 流水/记忆）至少 user 档，guest 不得读
      ["GET", "/api/conversations", "write"],
      ["HEAD", "/api/conversations", "write"],
      ["GET", "/api/conversations/c1", "write"],
      ["GET", "/api/conversations/c1/entries", "write"],
      ["GET", "/api/conversations/c1/invokes", "write"],
      ["GET", "/api/invokes/i1/events", "write"],
      ["GET", "/api/entries/e1", "write"],
      ["GET", "/api/memory/stats", "write"],
      ["GET", "/api/memory/dark-entries", "write"],
      // 对话族的写/admin 规则不被读档盖住（方法维度限定）
      ["POST", "/api/conversations", "write"],
      // 其余业务正文读口（与对话/记忆同级的私有数据面）
      ["GET", "/api/otters/o1", "write"],
      ["GET", "/api/otters/o1/sessions", "write"],
      ["GET", "/api/otters/o1/profile", "write"],
      ["GET", "/api/scheduled-tasks/t1", "write"],
      ["GET", "/api/scheduled-tasks/t1/executions", "write"],
      ["GET", "/api/connections/c1", "write"],
      ["GET", "/api/connections/c1/conversations", "write"],
      ["GET", "/api/skills", "write"],
      ["GET", "/api/prompts", "write"],
      ["GET", "/api/health/memory", "write"],
      ["GET", "/api/activity/healing", "write"],
      ["GET", "/api/weixin/accounts", "write"],
      ["GET", "/api/feishu/apps", "write"],
      ["GET", "/api/channels/status", "write"],
      ["GET", "/api/execution-machines", "write"],
      // 显式说明保持 authenticated 的三处（表内写明理由，不靠兑底）
      ["GET", "/api/attachments/a1", "authenticated"],
      ["GET", "/api/auth/session", "authenticated"],
      ["GET", "/api/unfurl", "authenticated"],
    ];
    for (const [method, path, expected] of cases) {
      expect(resolvePolicy(method, path), `${method} ${path}`).toBe(expected);
    }
  });

  it("表外 /api/* 方法级 fail-closed 兜底：读→authenticated、非读→write", () => {
    expect(resolvePolicy("GET", "/api/nonexistent-new-read")).toBe("authenticated");
    expect(resolvePolicy("POST", "/api/conversations")).toBe("write"); // 建会话
    expect(resolvePolicy("POST", "/api/conversations/c1/messages")).toBe("write");
    expect(resolvePolicy("PATCH", "/api/conversations/c1/archive")).toBe("write");
    expect(resolvePolicy("PUT", "/api/whatever-new")).toBe("write"); // 未来新写口
    expect(resolvePolicy("HEAD", "/api/x")).toBe("authenticated");
  });

  it("非 /api/*（静态/SPA/metrics）不在鉴权域，直通", () => {
    expect(resolvePolicy("GET", "/metrics")).toBe("public");
    expect(resolvePolicy("GET", "/conversations/abc")).toBe("public");
    expect(resolvePolicy("GET", "/mahjong")).toBe("public");
    expect(resolvePolicy("GET", "/")).toBe("public");
  });
});

/** 裸挂中间件的最小 app——下游 handler 回显 identity 供断言 */
function miniApp(): Hono {
  const app = new Hono();
  app.use("*", identityMiddleware());
  app.get("/api/things", (c) => c.json({ ok: true, identity: c.get("identity" as never) }));
  app.post("/api/things", (c) => c.json({ ok: true }));
  app.put("/api/settings", (c) => c.json({ ok: true }));
  app.put("/api/conversations/:id/workspace/mcp-external", (c) => c.json({ ok: true }));
  app.get("/api/settings", (c) => c.json({ ok: true }));
  app.post("/api/inbound/events", (c) => c.json({ ok: true }));
  app.options("/api/inbound/events", (c) => c.body(null, 204));
  app.get("/page", (c) => c.text("page"));
  return app;
}

describe("identityMiddleware：身份解析与裁决", () => {
  const app = miniApp();

  it("External MCP 配置写：admin 200、普通 user 403、匿名 401", async () => {
    const path = "/api/conversations/c1/workspace/mcp-external";
    expect((await app.request(path, { method: "PUT", headers: { [H_ID]: "ops", [H_ROLE]: "admin" } })).status).toBe(200);
    expect((await app.request(path, { method: "PUT", headers: { [H_ID]: "alice", [H_ROLE]: "user" } })).status).toBe(403);
    expect((await app.request(path, { method: "PUT" })).status).toBe(401);
  });

  it("无身份读 → 401，{error, code:unauthorized}", async () => {
    const res = await app.request("/api/things");
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe("unauthorized");
    expect(body.error).toBeTruthy();
  });

  it("合法身份头读 → 200，下游 context 可见 identity（接缝）", async () => {
    const res = await app.request("/api/things", { headers: { [H_ID]: "alice" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { identity: { userId: string; role: string } };
    expect(body.identity).toEqual({ userId: "alice", role: "guest" }); // 缺 role 降级 guest
  });

  it("非法 id（含空格 / 超 128 字符）→ 视同未声明 401", async () => {
    expect((await app.request("/api/things", { headers: { [H_ID]: "bad id" } })).status).toBe(401);
    expect((await app.request("/api/things", { headers: { [H_ID]: "x".repeat(129) } })).status).toBe(401);
  });

  it("缺 role 的身份：读 200、写 403（默认非读=write 档）", async () => {
    expect((await app.request("/api/things", { headers: { [H_ID]: "bob" } })).status).toBe(200);
    const post = await app.request("/api/things", { method: "POST", headers: { [H_ID]: "bob" } });
    expect(post.status).toBe(403);
    expect((await post.json() as { code: string }).code).toBe("forbidden");
  });

  it("role=user：写过、admin 档 403", async () => {
    const ok = await app.request("/api/things", { method: "POST", headers: { [H_ID]: "bob", [H_ROLE]: "user" } });
    expect(ok.status).toBe(200);
    const denied = await app.request("/api/settings", { method: "PUT", headers: { [H_ID]: "bob", [H_ROLE]: "user" } });
    expect(denied.status).toBe(403);
  });

  it("role=admin：admin 档通过", async () => {
    const res = await app.request("/api/settings", { method: "PUT", headers: { [H_ID]: "root", [H_ROLE]: "admin" } });
    expect(res.status).toBe(200);
  });

  it("GET /api/settings 读面显式 admin 档：guest/user 403、admin 200（钉住 #1541 处置 1）", async () => {
    const guest = await app.request("/api/settings", { headers: { [H_ID]: "read-only" } });
    expect(guest.status).toBe(403); // 缺 role=guest，不落在隐式 authenticated 兜底
    const user = await app.request("/api/settings", { headers: { [H_ID]: "user1", [H_ROLE]: "user" } });
    expect(user.status).toBe(403);
    const admin = await app.request("/api/settings", { headers: { [H_ID]: "root", [H_ROLE]: "admin" } });
    expect(admin.status).toBe(200);
  });

  it("role 非法值 → 降级 guest（不放行高档）", async () => {
    const res = await app.request("/api/settings", { method: "PUT", headers: { [H_ID]: "mallory", [H_ROLE]: "root" } });
    expect(res.status).toBe(403);
  });

  it("通道整体性：头在场则 query 不参与（URL 参数不得越权上抬角色）", async () => {
    const res = await app.request(`/api/things?${IDENTITY_QUERY.userId}=from-query&${IDENTITY_QUERY.role}=admin`, {
      headers: { [H_ID]: "from-header" },
    });
    const body = await res.json() as { identity: { userId: string; role: string } };
    expect(body.identity.userId).toBe("from-header");
    expect(body.identity.role).toBe("guest"); // 头侧无 role，query 的 admin 不越权上抬
  });

  it("直链 query 通道：附件场景等价生效；query 非法 id 同样 401", async () => {
    const ok = await app.request(`/api/things?${IDENTITY_QUERY.userId}=direct-link&${IDENTITY_QUERY.role}=admin`);
    expect(ok.status).toBe(200);
    const bad = await app.request(`/api/things?${IDENTITY_QUERY.userId}=${encodeURIComponent("bad id")}`);
    expect(bad.status).toBe(401);
  });

  it("public 面免身份：inbound 回调（含 OPTIONS 预检）与非 /api 路径直通", async () => {
    expect((await app.request("/api/inbound/events", { method: "POST" })).status).toBe(200);
    expect((await app.request("/api/inbound/events", { method: "OPTIONS" })).status).toBe(204);
    expect((await app.request("/page")).status).toBe(200);
  });
});

/** 真实装配里 node-server 适配器把原始 IncomingMessage 挂在 env.incoming；测试用 env 注入模拟来源。 */
type NodeEnv = { incoming: { socket: { remoteAddress: string } } };
function envFrom(remoteAddress: string): NodeEnv {
  return { incoming: { socket: { remoteAddress } } };
}

describe("声明式通道来源闸：只对本机直连开", () => {
  const app = miniApp();
  /** 无 env 注入的内存 app（模拟“拿不到对端地址”的装配面） */
  const bareApp = new Hono();
  bareApp.use("*", identityMiddleware());
  bareApp.get("/api/things", (c) => c.json({ ok: true }));
  const bareRequest = (path: string, init?: RequestInit, env?: unknown) =>
    bareApp.request(path, init, env as never);

  it("回环对端（IPv4 / IPv6 / IPv4-mapped）保留声明式头通道", async () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await app.request("/api/things", { headers: { [H_ID]: "script", [H_ROLE]: "admin" } }, envFrom(addr));
      expect(res.status, addr).toBe(200);
    }
  });

  it("非回环对端带假 admin 头 → 401（修复前为 200）", async () => {
    const res = await app.request(
      "/api/things",
      { headers: { [H_ID]: "mallory", [H_ROLE]: "admin" } },
      envFrom("203.0.113.9"),
    );
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe("unauthorized");
  });

  it("反代形态（对端回环 + 转发头）视同外部来源：头/query 均不采信", async () => {
    const viaHeader = await app.request(
      "/api/things",
      { headers: { [H_ID]: "mallory", [H_ROLE]: "admin", "x-forwarded-for": "203.0.113.9" } },
      envFrom("127.0.0.1"),
    );
    expect(viaHeader.status).toBe(401);
    const viaQuery = await app.request(
      `/api/things?${IDENTITY_QUERY.userId}=mallory&${IDENTITY_QUERY.role}=admin`,
      { headers: { "x-real-ip": "203.0.113.9" } },
      envFrom("127.0.0.1"),
    );
    expect(viaQuery.status).toBe(401);
  });

  it("外部来源仍可用 owner 会话 cookie 通过（闸只斩声明式通道，不斩真凭据）", async () => {
    const sessioned = new Hono();
    sessioned.use("*", identityMiddleware((cookie) =>
      cookie === "signed-session" ? { userId: "owner", role: "admin" } : null));
    sessioned.get("/api/things", (c) => c.json({ ok: true, identity: c.get("identity" as never) }));
    const res = await sessioned.request(
      "/api/things",
      { headers: { cookie: "otter_session=signed-session" } },
      envFrom("203.0.113.9"),
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { identity: { userId: string } }).identity.userId).toBe("owner");
    // 无效会话 + 外部来源 = 401（无声明式回退）
    const bad = await sessioned.request(
      "/api/things",
      { headers: { cookie: "otter_session=forged", [H_ID]: "owner", [H_ROLE]: "admin" } },
      envFrom("203.0.113.9"),
    );
    expect(bad.status).toBe(401);
  });

  it("public 面不受来源闸影响：平台回调仍无身份可达", async () => {
    expect((await app.request("/api/inbound/events", { method: "POST" }, envFrom("203.0.113.9"))).status).toBe(200);
  });

  it("空值转发头也算反代痕迹：头在场即拒声明式通道（按值判等于留绕过口）", async () => {
    for (const header of ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host"]) {
      const res = await bareRequest("/api/things", { headers: { [H_ID]: "local", [header]: "" } });
      expect(res.status, `${header} 空值`).toBe(401);
    }
  });

  it("allowsDeclaredIdentity 单判据（直测，不经中间件）：无对端地址放行、非回环拒、任一转发现场即拒", () => {
    const fake = (headers: Record<string, string>, remoteAddress?: string) => ({
      req: { header: (n: string) => headers[n.toLowerCase()] },
      env: remoteAddress === undefined ? {} : envFrom(remoteAddress),
    }) as unknown as Context;
    expect(allowsDeclaredIdentity(fake({}))).toBe(true);
    expect(allowsDeclaredIdentity(fake({}, "127.0.0.1"))).toBe(true);
    expect(allowsDeclaredIdentity(fake({}, "198.51.100.7"))).toBe(false);
    expect(allowsDeclaredIdentity(fake({ "x-forwarded-for": "" }, "127.0.0.1"))).toBe(false);
    expect(allowsDeclaredIdentity(fake({ "x-real-ip": "203.0.113.9" }, "127.0.0.1"))).toBe(false);
  });
});

/** 真实路由装配（裸 createRouter——不经 tests/api/helpers 的身份包装） */
function rawRouter(): Hono {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  const controllers = {
    conversation: {
      list: async (ctx: { json: (b: unknown) => Response }) => ctx.json({ items: [], nextCursor: null }),
      create: async (ctx: { json: (b: unknown, s?: number) => Response }) => ctx.json({ id: "c-new" }, 201),
    },
    inbound: {
      optionsEvents: (c: { body: (b: null, s: number) => Response }) => c.body(null, 204),
      receiveEvents: async (c: { json: (b: unknown) => Response }) => c.json({ ok: true }),
      getStatus: async (c: { json: (b: unknown) => Response }) => c.json({ ok: true }),
    },
  } as unknown as Controllers;
  return createRouter(controllers, logger as never);
}

describe("真实 createRouter 裸 app：门禁在装配层生效", () => {
  const app = rawRouter();

  it("修复前裸奔面：无身份 GET 对话清单 → 401（修复前为 200，见 Verification 复现）", async () => {
    const res = await app.request("/api/conversations");
    expect(res.status).toBe(401);
  });

  it("带身份 GET → 200；query 直链身份同样放行", async () => {
    expect((await app.request("/api/conversations", { headers: { [H_ID]: "web-ui", [H_ROLE]: "admin" } })).status).toBe(200);
    expect((await app.request(`/api/conversations?${IDENTITY_QUERY.userId}=web-ui&${IDENTITY_QUERY.role}=admin`)).status).toBe(200);
  });

  it("建会话（默认 write 档）：guest 403 / admin 201", async () => {
    const guest = await app.request("/api/conversations", {
      method: "POST",
      headers: { [H_ID]: "guest-user" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(guest.status).toBe(403);
    const admin = await app.request("/api/conversations", {
      method: "POST",
      headers: { [H_ID]: "web-ui", [H_ROLE]: "admin" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(admin.status).toBe(201);
  });

  it("未知 /api 路径 fail-closed：无身份 401（先认证后 404）、带身份 404", async () => {
    expect((await app.request("/api/nonexistent-endpoint")).status).toBe(401);
    expect((await app.request("/api/nonexistent-endpoint", { headers: { [H_ID]: "web-ui" } })).status).toBe(404);
  });

  it("麻将面暂置 public：无身份请求穿透到路由层（404≠401，证明未被门禁拦）", async () => {
    expect((await app.request("/api/mahjong/rooms/r1/view")).status).toBe(404);
  });

  it("inbound 公开：平台回调无身份可达", async () => {
    expect((await app.request("/api/inbound/events", { method: "POST", body: "{}" })).status).toBe(200);
  });

  it("探活端点公开（阶段 6a）：无身份 /api/ping → 200 {ok:true,pid,uptimeSec}", async () => {
    const res = await app.request("/api/ping");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; pid: number; uptimeSec: number };
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(typeof body.uptimeSec).toBe("number");
  });
});
