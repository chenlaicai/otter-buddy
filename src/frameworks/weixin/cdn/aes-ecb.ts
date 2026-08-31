import { createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES-128-ECB 工具（微信 CDN 媒体加密，issue #567）。
 * 协议审计来源：openclaw-weixin src/cdn/aes-ecb.ts（MIT）。
 * Node 默认 PKCS7 padding——与协议一致（密文大小按 16 字节对齐）。
 */

/** 加密（PKCS7 默认） */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 解密（PKCS7） */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 明文大小 → 密文大小（PKCS7 补到 16 字节边界；上传声明 filesize 用） */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
