/**
 * #1322（F20261016autz）对话域鉴权层测试：身份声明解析 + 路由策略表 + fail-closed 兜底。
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
  IDENTITY_HEADERS,
  IDENTITY_QUERY,
} from "../../../src/interface-adapters/http/identity-middleware";
import { createRouter, type Controllers } from "../../../src/interface-adapters/http/router";

const H_ID = IDENTITY_HEADERS.userId;
const H_ROLE = IDENTITY_HEADERS.role;

describe("resolvePolicy：路由策略表矩阵", () => {
  it("显式档位（public / admin / 族内例外先于族规则）", () => {
    const cases: Array<[string, string, string]> = [
      // public
      ["POST", "/api/inbound/events", "public"],
      ["OPTIONS", "/api/inbound/events", "public"],
      ["GET", "/api/inbound/status", "public"],
      ["POST", "/api/mahjong/rooms", "public"], // #1322 新增面：暂置（见表内翻转锚点）
      ["GET", "/api/mahjong/rooms/r1/view", "public"],
      // admin 族
      ["PUT", "/api/settings", "admin"],
      ["GET", "/api/settings", "admin"], // #1541 处置 1：读面显式收档，不留隐式兜底
      ["GET", "/api/settings/status", "admin"],
      ["POST", "/api/otters", "admin"],
      ["DELETE", "/api/otters/o1", "admin"],
      ["POST", "/api/otters/o1/restart", "admin"],
      ["POST", "/api/scheduled-tasks/t1/trigger", "admin"],
      ["PATCH", "/api/scheduled-tasks/t1", "admin"],
      ["DELETE", "/api/scheduled-tasks/t1", "admin"],
      ["POST", "/api/conversations/c1/scheduled-tasks", "admin"],
      ["POST", "/api/health/scan", "admin"],
      ["POST", "/api/health/signals/s1/triage", "admin"],
      ["POST", "/api/connections", "admin"],
      ["POST", "/api/weixin/login", "admin"],
      ["DELETE", "/api/feishu/apps/a1", "admin"],
      // 族内例外（必须先于同族 admin 命中——顺序敏感）
      ["POST", "/api/otters/o1/retry", "write"],
      ["POST", "/api/connections/c1/enter", "write"],
      ["POST", "/api/connections/c1/leave", "write"],
      // 读语义的 POST 形态不按写兜底
      ["POST", "/api/memory/search/similar", "authenticated"],
    ];
    for (const [method, path, expected] of cases) {
      expect(resolvePolicy(method, path), `${method} ${path}`).toBe(expected);
    }
  });

  it("表外 /api/* 方法级 fail-closed 兜底：读→authenticated、非读→write", () => {
    expect(resolvePolicy("GET", "/api/conversations")).toBe("authenticated");
    expect(resolvePolicy("GET", "/api/attachments/att-1")).toBe("authenticated");
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
  app.get("/api/settings", (c) => c.json({ ok: true }));
  app.post("/api/inbound/events", (c) => c.json({ ok: true }));
  app.options("/api/inbound/events", (c) => c.body(null, 204));
  app.get("/page", (c) => c.text("page"));
  return app;
}

describe("identityMiddleware：身份解析与裁决", () => {
  const app = miniApp();

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
});
