/**
 * listen() 绑定地址测试：缺省只绑回环。
 *
 * 为什么是断言而非约定：中枢端口一度用 `serve({ port })` 默认行为绑全部接口，
 * 于是 3000 直接对公网敞开。这里钉住「默认值就是回环」，并把「显式放开非回环」
 * 限定成要自己写配置的动作（且必须留一条告警）。
 */
import { describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { listen } from "../../src/bootstrap/server";
import type { Logger } from "../../src/usecases/ports/logger";
import { createTestLogger } from "../helpers/logger";

function bytesOnSameHost(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  // node 对回环绑定可能回 "127.0.0.1" 或 "::ffff:127.0.0.1"（系统双栈形态）
  return a === b || a.endsWith(`:${b}`) || a === `::ffff:${b}`;
}

describe("listen() 绑定地址", () => {
  it("不传 host：实际绑 127.0.0.1（而不是全部接口）", async () => {
    const logger: Logger = createTestLogger();
    const server = listen(new Hono(), 0, logger);
    await vi.waitFor(() => {
      if (server.address() === null) throw new Error("not bound yet");
    });
    const address = server.address() as AddressInfo;
    expect(bytesOnSameHost(address.address, "127.0.0.1")).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("显式 host 生效：绑全接口时告警（把暴露面变成显式选择）", async () => {
    const logger: Logger = createTestLogger();
    const warnSpy = vi.spyOn(logger, "warn");
    const server = listen(new Hono(), 0, logger, undefined, "0.0.0.0");
    await vi.waitFor(() => {
      if (server.address() === null) throw new Error("not bound yet");
    });
    expect((server.address() as AddressInfo).address).toBe("0.0.0.0");
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("非回环"))).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    warnSpy.mockRestore();
  });

  it("回环 host 不告警", async () => {
    const logger: Logger = createTestLogger();
    const warnSpy = vi.spyOn(logger, "warn");
    const server = listen(new Hono(), 0, logger, undefined, "127.0.0.1");
    await vi.waitFor(() => {
      if (server.address() === null) throw new Error("not bound yet");
    });
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("非回环"))).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    warnSpy.mockRestore();
  });
});
