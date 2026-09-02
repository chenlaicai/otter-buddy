import { describe, it, expect, vi, afterEach } from "vitest";
import { FeishuUserInfoClient } from "@frameworks/feishu/user-info-client";
import type { FeishuAccessTokenManager } from "@frameworks/feishu/access-token-manager";

/**
 * #490 在途请求合并（in-flight dedup）行为测试（fetch 全 mock，不出网）。
 * 锁定：同 open_id 并发只发一次 API / 成功后入缓存 / 失败（业务码/网络异常）
 * 不缓存且在途表已清（下次调用重新发起）/ 不同 open_id 不互相合并 /
 * 缓存命中与空参数防御不出网。
 * API 调用次数用 fetch mock 的副作用计数器断言（仓规禁 toHaveBeenCalledTimes）。
 */

function makeClient(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const tokenManager = {
    getAccessToken: vi.fn().mockResolvedValue("t-xxx"),
  } as unknown as FeishuAccessTokenManager;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { client: new FeishuUserInfoClient(tokenManager, logger as never), logger };
}

function feishuUserResponse(name: string): Response {
  return new Response(JSON.stringify({ code: 0, msg: "ok", data: { user: { name } } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FeishuUserInfoClient 在途请求合并（#490）", () => {
  it("同 open_id 并发请求只发一次 API，结果共享", async () => {
    let calls = 0;
    let release!: (value: Response) => void;
    // 手动闸门：让首个请求悬在网络上，制造真实的并发窗口
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { client } = makeClient((async () => {
      calls += 1;
      return gate;
    }) as unknown as typeof fetch);

    const pending = Promise.all([
      client.getUserName("ou_1"),
      client.getUserName("ou_1"),
      client.getUserName("ou_1"),
    ]);
    release(feishuUserResponse("张三"));
    const names = await pending;

    expect(calls).toBe(1);
    expect(names).toEqual(["张三", "张三", "张三"]);
  });

  it("成功后写缓存：后续同 id 调用命中缓存不出网", async () => {
    let calls = 0;
    const { client } = makeClient((async () => {
      calls += 1;
      return feishuUserResponse("李四");
    }) as unknown as typeof fetch);

    expect(await client.getUserName("ou_2")).toBe("李四");
    expect(await client.getUserName("ou_2")).toBe("李四");
    expect(calls).toBe(1);
  });

  it("API 业务失败：并发共享同一 null，之后在途已清、失败不缓存可重试", async () => {
    let calls = 0;
    const { client, logger } = makeClient((async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 99991672, msg: "no permission" }));
    }) as unknown as typeof fetch);

    const wave1 = await Promise.all([client.getUserName("ou_3"), client.getUserName("ou_3")]);
    expect(wave1).toEqual([null, null]);
    expect(calls).toBe(1);
    expect(logger.warn).toHaveBeenCalled();

    expect(await client.getUserName("ou_3")).toBeNull();
    expect(calls).toBe(2);
  });

  it("网络异常：并发共享同一 null 降级，之后在途已清可重试", async () => {
    let calls = 0;
    const { client } = makeClient((async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);

    const wave1 = await Promise.all([client.getUserName("ou_4"), client.getUserName("ou_4")]);
    expect(wave1).toEqual([null, null]);
    expect(calls).toBe(1);

    expect(await client.getUserName("ou_4")).toBeNull();
    expect(calls).toBe(2);
  });

  it("不同 open_id 并发不互相合并：各发一次", async () => {
    const requestedUrls: string[] = [];
    const { client } = makeClient((async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(String(input));
      return feishuUserResponse("王五");
    }) as unknown as typeof fetch);

    const names = await Promise.all([client.getUserName("ou_a"), client.getUserName("ou_b")]);
    expect(names).toEqual(["王五", "王五"]);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls.some((u) => u.includes("ou_a"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("ou_b"))).toBe(true);
  });

  it("空 id / unknown：直接 null 不出网", async () => {
    let calls = 0;
    const { client } = makeClient((async () => {
      calls += 1;
      return feishuUserResponse("x");
    }) as unknown as typeof fetch);

    expect(await client.getUserName("")).toBeNull();
    expect(await client.getUserName("unknown")).toBeNull();
    expect(calls).toBe(0);
  });
});
