import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  handleError,
  HttpError,
} from "@interface-adapters/http/http-error";
import { DomainError } from "@entities/errors";

/**
 * 构建测试用 Hono 应用，在路由中触发不同错误类型并由 handleError 统一处理。
 * 这样可以验证端到端的 HTTP 状态码与响应体。
 */
function createTestApp(): Hono {
  const app = new Hono();

  // DomainError 路由：通过路径参数传递 kind
  app.get("/test-domain/:kind", (c) => {
    const kind = c.req.param("kind") as any;
    return handleError(c, new DomainError("test error", kind));
  });

  // HttpError 路由
  app.get("/test-http/:status", (c) => {
    const status = parseInt(c.req.param("status"), 10);
    return handleError(c, new HttpError("http error", status));
  });

  // 普通 Error 路由
  app.get("/test-plain-error", (c) => {
    return handleError(c, new Error("something broke"));
  });

  // 未知类型（非 Error）路由
  app.get("/test-unknown", (c) => {
    return handleError(c, "string error");
  });

  return app;
}

describe("handleError", () => {
  const app = createTestApp();

  // ─── DomainError -> 对应状态码 ───

  it("DomainError(not_found) -> 404", async () => {
    const res = await app.request("/test-domain/not_found");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("test error");
  });

  it("DomainError(validation) -> 400", async () => {
    const res = await app.request("/test-domain/validation");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("test error");
  });

  it("DomainError(conflict) -> 409", async () => {
    const res = await app.request("/test-domain/conflict");
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("test error");
  });

  it("DomainError(forbidden) -> 403", async () => {
    const res = await app.request("/test-domain/forbidden");
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("test error");
  });

  // ─── HttpError -> 指定状态码 ───

  it("HttpError(422) -> 422", async () => {
    const res = await app.request("/test-http/422");
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("http error");
  });

  // ─── 普通 Error -> 500 ───

  it("plain Error -> 500 并返回原始错误消息", async () => {
    const res = await app.request("/test-plain-error");
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("something broke");
  });

  // ─── 未知类型 -> 500 + 兜底消息 ───

  it("unknown value -> 500 且返回 'Internal server error'", async () => {
    const res = await app.request("/test-unknown");
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Internal server error");
  });
});
