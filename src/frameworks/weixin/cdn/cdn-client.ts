import { createHash, randomBytes } from "node:crypto";

/** 测试 seam：隔离 crypto 便于 mock（生产代码零改动） */
export const __crypto = { randomBytes };
import type { Logger } from "@usecases/ports/logger";
import type { WeixinApiClient } from "../api-client";
import { WeixinUploadMediaType, type WeixinUploadedMedia } from "../types";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "./aes-ecb";
import { buildCdnUploadUrl, buildCdnDownloadUrl } from "./cdn-url";

/**
 * 微信 CDN 媒体客户端（issue #567）。
 *
 * 上传管线（平移自 openclaw-weixin cdn/upload.ts + cdn-upload.ts，MIT）：
 *   读文件 → md5 → 随机 aeskey → getuploadurl → AES-ECB 加密 → CDN PUT
 *   → 返回下载参数（拼发送 item）
 * 下载管线（平移自 cdn/pic-decrypt.ts）：
 *   encrypt_query_param/full_url → GET 密文 → AES-ECB 解密 → 明文 Buffer
 *
 * CDN PUT 语义：Content-Type octet-stream 密文单次 PUT；下载参数在响应头
 * x-encrypted-param；4xx 立即失败（client error），5xx/网络错重试 ≤3 次。
 */

const UPLOAD_MAX_RETRIES = 3;
/** 入站媒体大小上限（对齐 openclaw-weixin 默认 100MB） */
export const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** CDN 上传产物（拼发送 item 的全部字段） */
export class WeixinCdnClient {
  constructor(
    private readonly deps: {
      api: WeixinApiClient;
      logger: Logger;
    },
  ) {}

  /** 上传本地文件到 CDN。mediaType 决定 getuploadurl 的 media_type 枚举 */
  async uploadFile(params: {
    buffer: Buffer;
    toUserId: string;
    mediaType: keyof typeof WeixinUploadMediaType;
  }): Promise<WeixinUploadedMedia> {
    const { buffer, toUserId, mediaType } = params;
    const rawsize = buffer.length;
    const rawfilemd5 = createHash("md5").update(buffer).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = __crypto.randomBytes(16).toString("hex");
    const aesKey = __crypto.randomBytes(16);

    this.deps.logger.debug("Weixin CDN upload start", { filekey, rawsize, filesize, mediaType });

    const resp = await this.deps.api.getUploadUrl({
      filekey,
      media_type: WeixinUploadMediaType[mediaType],
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
    });
    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new Error(`weixin getuploadurl ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
    }
    const uploadFullUrl = resp.upload_full_url?.trim();
    if (!uploadFullUrl && !resp.upload_param) {
      throw new Error("weixin getuploadurl returned no upload URL (need upload_full_url or upload_param)");
    }

    const downloadParam = await this.putCdn({
      ciphertext: encryptAesEcb(buffer, aesKey),
      uploadFullUrl: uploadFullUrl || undefined,
      uploadParam: resp.upload_param,
      filekey,
    });

    this.deps.logger.info("Weixin CDN upload done", { filekey, rawsize });
    return {
      filekey,
      downloadParam,
      aesKeyHex: aesKey.toString("hex"),
      fileSize: rawsize,
      fileSizeCiphertext: filesize,
    };
  }

  /** CDN PUT（密文单次；4xx 不重试，5xx/网络错 ≤3 次） */
  private async putCdn(params: {
    ciphertext: Buffer;
    uploadFullUrl?: string;
    uploadParam?: string;
    filekey: string;
  }): Promise<string> {
    const url = params.uploadFullUrl ?? buildCdnUploadUrl({ uploadParam: params.uploadParam!, filekey: params.filekey });
    let lastError: unknown;

    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      try {
        return await this.putOnce(url, params.ciphertext);
      } catch (err) {
        lastError = err;
        // client error 立即放弃
        if (err instanceof Error && err.message.includes("client error")) throw err;
        if (attempt < UPLOAD_MAX_RETRIES) {
          this.deps.logger.warn("Weixin CDN upload retry", { attempt, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Weixin CDN upload failed after retries");
  }

  /** 单次 PUT：4xx/非 200/缺下载参数抛错（client error 语义上游识别） */
  private async putOnce(url: string, ciphertext: Buffer): Promise<string> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal: AbortSignal.timeout(60_000),
    });
    const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
    // 4xx client error：请求本身有错（签名/参数），重试无意义
    if (res.status >= 400 && res.status < 500) {
      throw new Error(`Weixin CDN upload client error ${res.status}: ${errMsg}`);
    }
    if (res.status !== 200) {
      throw new Error(`Weixin CDN upload server error: ${errMsg}`);
    }
    const downloadParam = res.headers.get("x-encrypted-param");
    if (!downloadParam) {
      throw new Error("Weixin CDN upload response missing x-encrypted-param header");
    }
    return downloadParam;
  }

  /** 下载 + 解密入站媒体。aesKeyBase64 两种编码都收（见 parseCdnAesKey） */
  async downloadAndDecrypt(params: {
    encryptQueryParam?: string;
    aesKeyBase64?: string;
    fullUrl?: string;
  }): Promise<Buffer> {
    if (!params.aesKeyBase64) throw new Error("Weixin CDN download: aes_key missing");
    const key = parseCdnAesKey(params.aesKeyBase64);
    const url = params.fullUrl ?? buildCdnDownloadUrl(params.encryptQueryParam ?? "");
    const encrypted = await this.fetchCdnBytes(url);
    const decrypted = decryptAesEcb(encrypted, key);
    if (decrypted.length > WEIXIN_MEDIA_MAX_BYTES) {
      throw new Error(`Weixin CDN media too large: ${decrypted.length} bytes`);
    }
    return decrypted;
  }

  /** 下载明文（无 aes_key 的场景，如部分缩略图） */
  async downloadPlain(params: { encryptQueryParam?: string; fullUrl?: string }): Promise<Buffer> {
    const url = params.fullUrl ?? buildCdnDownloadUrl(params.encryptQueryParam ?? "");
    return this.fetchCdnBytes(url);
  }

  private async fetchCdnBytes(url: string): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`Weixin CDN download ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * 解析 CDNMedia.aes_key → 16 字节 AES key。
 * 协议在野两种编码（openclaw-weixin pic-decrypt.ts 审计注释）：
 *   - base64(raw 16 bytes)          → 图片（media.aes_key）
 *   - base64(hex 字符串 32 字符)     → 文件/语音/视频
 */
export function parseCdnAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Weixin aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`);
}
