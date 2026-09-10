/**
 * #889：InboundController JSON null body 防御测试。
 *
 * 背景：req.json() 解析合法 JSON `null` 成功不走 catch，
 * 修复前 null.source 解引用崩 500 并回显 V8 内部错误文本。
 * helpers.ts 的 createTestApp 对 inbound 用 stub，故此处独立建最小 app。
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { InboundController } from "@interface-adapters/http/controllers/inbound-controller";
import { createTestLogger } from "../../helpers/logger";

const API_KEY = "test-inbound-key";

function createInboundApp(): Hono {
  const controller = new InboundController(
    API_KEY,
    { execute: async () => ({ accepted: 0, deduplicated: 0 }) } as never,
    undefined,
    createTestLogger(),
  );
  const app = new Hono();
  app.post("/api/inbound/events", (c) => controller.receiveEvents(c));
  return app;
}

describe("InboundController receiveEvents（#889）", () => {
  it("JSON null body → 400（不崩溃 500）", async () => {
    const app = createInboundApp();
    const res = await app.request("/api/inbound/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Inbound-Key": API_KEY },
      body: "null",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("非法 JSON body → 400（原有行为不回退）", async () => {
    const app = createInboundApp();
    const res = await app.request("/api/inbound/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Inbound-Key": API_KEY },
      body: "not-json{{",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("invalid JSON");
  });
});
