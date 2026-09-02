import { describe, it, expect, vi } from "vitest";
import { WeixinMediaClient, mimeFromFileName } from "@frameworks/weixin/media-client";
import type { WeixinCdnClient } from "@frameworks/weixin/cdn/cdn-client";
import type { Logger } from "@usecases/ports/logger";

/** issue #608：微信入站媒体四类全量下载测试。
 *  CDN 客户端全 mock（不出网）；silk 转码失败用 spy 验证降级语义。 */

const CDN_FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const CDN_FAKE_MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), Buffer.alloc(64, 0x02)]);
const CDN_FAKE_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(48, 0x03)]);

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeClient(downloaded: Buffer) {
  const downloadAndDecrypt = vi.fn(async () => downloaded);
  const downloadPlain = vi.fn(async () => downloaded);
  const cdn = { downloadAndDecrypt, downloadPlain } as unknown as WeixinCdnClient;
  const client = new WeixinMediaClient({ cdn, logger: makeLogger() });
  return { client, downloadAndDecrypt, downloadPlain };
}

describe("WeixinMediaClient 四类下载（#608 恢复）", () => {
  it("voice：下载解密 + silk→wav 转码产物（mimeType=audio/wav）", async () => {
    // 真 SILK 字节（silk-wasm encode 生成 200ms 静音 PCM）——解码必须拿到合法 SILK
    const { encode } = await import("silk-wasm");
    const pcm = Buffer.alloc(24000 * 2 * 200 / 1000);
    const encoded = await encode(pcm, 24000);
    const { client } = makeClient(Buffer.from(encoded.data));
    const out = await client.downloadMediaItem({
      type: 3,
      voice_item: { media: { encrypt_query_param: "eq", aes_key: "b64" } },
    });
    expect(out.mimeType).toBe("audio/wav");
    expect(out.fileName.endsWith(".wav")).toBe(true);
    expect(out.buffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(out.buffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("voice：silk 转码失败时抛错（原始 SILK 不在白名单，走单项降级）", async () => {
    const silkMod = await import("@frameworks/weixin/silk-transcode");
    const spy = vi.spyOn(silkMod, "silkToWav").mockResolvedValue(null);
    try {
      const { client } = makeClient(Buffer.from("SILK-BYTES"));
      const err = await client.downloadMediaItem({
        type: 3,
        voice_item: { media: { encrypt_query_param: "eq", aes_key: "b64" } },
      }).catch(e => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("silk→wav 转码失败");
    } finally {
      spy.mockRestore();
    }
  });

  it("video：下载解密产物 mimeType=video/mp4", async () => {
    const { client } = makeClient(CDN_FAKE_MP4);
    const out = await client.downloadMediaItem({
      type: 5,
      video_item: { media: { encrypt_query_param: "eq", aes_key: "b64" } },
    });
    expect(out.mimeType).toBe("video/mp4");
    expect(out.fileName.endsWith(".mp4")).toBe(true);
  });

  it("file：file_name 保留 + PDF 后缀映射 application/pdf", async () => {
    const { client } = makeClient(CDN_FAKE_PDF);
    const out = await client.downloadMediaItem({
      type: 4,
      file_item: { file_name: "年报.pdf", media: { encrypt_query_param: "eq", aes_key: "b64" } },
    });
    expect(out.fileName).toBe("年报.pdf");
    expect(out.mimeType).toBe("application/pdf");
  });

  it("image：无 aeskey 时明文下载分支", async () => {
    const { client, downloadPlain } = makeClient(CDN_FAKE_PNG);
    const out = await client.downloadMediaItem({
      type: 2,
      image_item: { media: { encrypt_query_param: "eq", full_url: "https://cdn/x" } },
    });
    expect(downloadPlain).toHaveBeenCalledOnce();
    expect(out.mimeType).toBe("image/png");
  });

  it("text 类型不支持（下载层只收媒体 item）", async () => {
    const { client } = makeClient(CDN_FAKE_PNG);
    await expect(client.downloadMediaItem({ type: 1, text_item: { text: "hi" } })).rejects.toThrow("unsupported media item type");
  });

  it("voice 缺 aes_key 抛错（无法解密）", async () => {
    const { client } = makeClient(CDN_FAKE_PNG);
    await expect(client.downloadMediaItem({
      type: 3,
      voice_item: { media: { encrypt_query_param: "eq" } },
    })).rejects.toThrow("aes_key missing");
  });
});

describe("mimeFromFileName（#608 恢复）", () => {
  it("常见后缀映射", () => {
    expect(mimeFromFileName("a.pdf")).toBe("application/pdf");
    expect(mimeFromFileName("b.MP4")).toBe("video/mp4");
    expect(mimeFromFileName("c.wav")).toBe("audio/wav");
    expect(mimeFromFileName("d.mp3")).toBe("audio/mpeg");
    expect(mimeFromFileName("e.docx")).toContain("wordprocessingml");
    expect(mimeFromFileName("noext")).toBe("application/octet-stream");
    expect(mimeFromFileName("x/y/z.txt")).toBe("text/plain");
  });
});
