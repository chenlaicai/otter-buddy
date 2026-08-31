import { describe, it, expect, vi, afterEach } from "vitest";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "@frameworks/weixin/cdn/aes-ecb";
import { buildCdnDownloadUrl, buildCdnUploadUrl } from "@frameworks/weixin/cdn/cdn-url";
import { WeixinCdnClient, parseCdnAesKey, WEIXIN_MEDIA_MAX_BYTES, __crypto } from "@frameworks/weixin/cdn/cdn-client";
import type { WeixinApiClient } from "@frameworks/weixin/api-client";
import type { Logger } from "@usecases/ports/logger";

/**
 * CDN 媒体协议单测（issue #567）。
 * fetch 全 mock 不出网。AES 语义与 openclaw-weixin cdn/aes-ecb.ts 对齐
 * （PKCS7 默认、密文 16 字节对齐）。
 */

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };

describe("aes-ecb", () => {
  it("加解密 roundtrip（任意长度 + PKCS7 对齐）", () => {
    const key = Buffer.alloc(16, 7);
    for (const size of [0, 1, 15, 16, 17, 1000]) {
      const plain = Buffer.alloc(size, 0xab);
      const cipher = encryptAesEcb(plain, key);
      expect(cipher.length).toBe(aesEcbPaddedSize(size));
      expect(cipher.length % 16).toBe(0);
      expect(decryptAesEcb(cipher, key).equals(plain)).toBe(true);
    }
  });

  it("paddedSize 语义：补到 16 边界（0 → 16）", () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
    expect(aesEcbPaddedSize(15)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
  });
});

describe("cdn-url", () => {
  it("下载 URL：encrypt_query_param 需 URL 编码", () => {
    const url = buildCdnDownloadUrl("a b&c=d");
    expect(url).toContain("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=");
    expect(url).toContain(encodeURIComponent("a b&c=d"));
  });

  it("上传 URL：upload_param + filekey", () => {
    const url = buildCdnUploadUrl({ uploadParam: "p1", filekey: "fk1" });
    expect(url).toContain("/upload?encrypted_query_param=p1&filekey=fk1");
  });
});

describe("parseCdnAesKey（协议在野两种编码）", () => {
  const raw16 = Buffer.alloc(16, 0x11);
  it("base64(raw 16 bytes)——图片场景", () => {
    expect(parseCdnAesKey(raw16.toString("base64")).equals(raw16)).toBe(true);
  });
  it("base64(hex 字符串 32 字符)——文件/语音/视频场景", () => {
    const hexStr = raw16.toString("hex"); // 32 chars
    expect(parseCdnAesKey(Buffer.from(hexStr, "ascii").toString("base64")).equals(raw16)).toBe(true);
  });
  it("非法长度抛错", () => {
    expect(() => parseCdnAesKey(Buffer.alloc(8).toString("base64"))).toThrow(/16 raw bytes/);
  });
});

describe("WeixinCdnClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  const api = {
    getUploadUrl: vi.fn(),
  } as unknown as WeixinApiClient;
  const cdn = () => new WeixinCdnClient({ api: api as never, logger });

  it("uploadFile：md5/aeskey 生成 → getuploadurl → CDN PUT → 下载参数", async () => {
    const fileKeyBytes = Buffer.alloc(16, 9);
    const aesKey = Buffer.alloc(16, 0x33);
    const spy = vi.spyOn(__crypto, "randomBytes");
    spy.mockReturnValueOnce(fileKeyBytes as never).mockReturnValueOnce(aesKey as never);
    const put = vi.fn(async () => new Response("", { status: 200, headers: { "x-encrypted-param": "dl-param-1" } }));
    vi.stubGlobal("fetch", put);
    (api.getUploadUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ ret: 0, upload_param: "up-1" });

    const uploaded = await cdn().uploadFile({ buffer: Buffer.from("hello"), toUserId: "u-1", mediaType: "IMAGE" });

    expect(uploaded.downloadParam).toBe("dl-param-1");
    expect(uploaded.aesKeyHex).toBe(aesKey.toString("hex"));
    expect(uploaded.fileSize).toBe(5);
    expect(uploaded.fileSizeCiphertext).toBe(16);
    // getuploadurl 请求体语义
    const req = (api.getUploadUrl as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req).toMatchObject({ media_type: 1, to_user_id: "u-1", rawsize: 5, filesize: 16, no_need_thumb: true });
    expect(req.filekey).toBe(fileKeyBytes.toString("hex"));
    expect(req.rawfilemd5).toHaveLength(32);
    spy.mockRestore();
  });

  it("uploadFile：CDN 5xx 重试后成功", async () => {
    const aesKey = Buffer.alloc(16, 0x44);
    const spy = vi.spyOn(__crypto, "randomBytes");
    spy.mockReset();
    spy.mockReturnValueOnce(Buffer.alloc(16, 1) as never).mockReturnValueOnce(aesKey as never);
    let calls = 0;
    const put = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("boom", { status: 500 });
      return new Response("", { status: 200, headers: { "x-encrypted-param": "dl-2" } });
    });
    vi.stubGlobal("fetch", put);
    (api.getUploadUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ ret: 0, upload_full_url: "https://cdn.example/put" });

    const uploaded = await cdn().uploadFile({ buffer: Buffer.from("x"), toUserId: "u-1", mediaType: "FILE" });
    expect(calls).toBe(3); // 副作用计数：两次 5xx 后第三次成功
    expect(uploaded.downloadParam).toBe("dl-2");
    spy.mockRestore();
  });

  it("uploadFile：CDN 4xx client error 不重试直接抛", async () => {
    const spy = vi.spyOn(__crypto, "randomBytes");
    spy.mockReset();
    spy.mockReturnValueOnce(Buffer.alloc(16, 2) as never).mockReturnValueOnce(Buffer.alloc(16, 3) as never);
    let calls = 0;
    const put = vi.fn(async () => { calls += 1; return new Response("bad", { status: 403 }); });
    vi.stubGlobal("fetch", put);
    (api.getUploadUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ ret: 0, upload_full_url: "https://cdn.example/put" });

    await expect(cdn().uploadFile({ buffer: Buffer.from("y"), toUserId: "u-1", mediaType: "FILE" })).rejects.toThrow(/client error 403/);
    expect(calls).toBe(1); // 副作用计数：4xx 无重试
    spy.mockRestore();
  });

  it("downloadAndDecrypt：full_url 优先 + 解密 roundtrip + 无 full_url 时拼参数", async () => {
    const key = Buffer.alloc(16, 0x55);
    const cipher = encryptAesEcb(Buffer.from("secret-media"), key);
    const fetchedUrls: string[] = [];
    const get = vi.fn(async (url: string | URL | Request) => {
      fetchedUrls.push(String(url));
      return new Response(new Uint8Array(cipher));
    });
    vi.stubGlobal("fetch", get);

    const buf = await cdn().downloadAndDecrypt({ aesKeyBase64: key.toString("base64"), fullUrl: "https://cdn.example/f" });
    expect(buf.toString()).toBe("secret-media");

    // 无 full_url 时拼 encrypt_query_param
    await cdn().downloadAndDecrypt({ aesKeyBase64: key.toString("base64"), encryptQueryParam: "q=1" });
    expect(fetchedUrls[1]).toContain("encrypted_query_param=");

    // 超限拒收语义存在性
    expect(WEIXIN_MEDIA_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});
