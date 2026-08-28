import { describe, it, expect, vi } from "vitest";
import { FeishuResourceClient } from "@frameworks/feishu/resource-client";
import type { FeishuAccessTokenManager } from "@frameworks/feishu/access-token-manager";

/** 多模态 Phase 2：飞书资源下载客户端行为测试（fetch 全 mock，不出网）。
 *  锁定：成功路径字节透传 / HTTP 错误 null 降级 / 空体 null / 网络异常 null。 */

function makeClient(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const tokenManager = {
    getAccessToken: vi.fn().mockResolvedValue("t-xxx"),
  } as unknown as FeishuAccessTokenManager;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { client: new FeishuResourceClient(tokenManager, logger as never), logger };
}

describe("FeishuResourceClient（多模态 Phase 2）", () => {
  it("成功路径：返回字节 buffer + 空 fileName（命名归调用方）", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { client } = makeClient((async () => new Response(png, { status: 200 })) as unknown as typeof fetch);

    const result = await client.downloadMessageResource("om_1", "img_v2_abc", "image");

    expect(result?.buffer.equals(png)).toBe(true);
    expect(result?.fileName).toBe("");
  });

  it("HTTP 错误（权限缺失 40002）：null 降级不抛错", async () => {
    const { client, logger } = makeClient((async () => new Response(
      JSON.stringify({ code: 40002, msg: "permission denied" }),
      { status: 403 },
    )) as unknown as typeof fetch);

    const result = await client.downloadMessageResource("om_1", "img_v2_abc", "image");

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("空字节体：null 降级", async () => {
    const { client } = makeClient((async () => new Response(new ArrayBuffer(0), { status: 200 })) as unknown as typeof fetch);

    const result = await client.downloadMessageResource("om_1", "img_v2_abc", "image");

    expect(result).toBeNull();
  });

  it("网络异常：null 降级（不重试不抛错）", async () => {
    const { client } = makeClient((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);

    const result = await client.downloadMessageResource("om_1", "img_v2_abc", "image");

    expect(result).toBeNull();
  });

  it("空参数防御：messageId/resourceKey 缺失直接 null（不出网）", async () => {
    const fetchSpy = vi.fn();
    const { client } = makeClient(fetchSpy as unknown as typeof fetch);

    expect(await client.downloadMessageResource("", "img_v2_abc", "image")).toBeNull();
    expect(await client.downloadMessageResource("om_1", "", "image")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("URL 拼装：messageId 与 resourceKey 均 encodeURIComponent", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(Buffer.from([1, 2, 3]), { status: 200 }));
    const { client } = makeClient(fetchSpy as unknown as typeof fetch);

    await client.downloadMessageResource("om/1", "img v2+abc", "image");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("om%2F1");
    expect(url).toContain("img%20v2%2Babc");
    expect(url).toContain("type=image");
  });
});
