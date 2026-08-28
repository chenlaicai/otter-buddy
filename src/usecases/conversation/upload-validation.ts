/**
 * 上传校验纯函数（多模态 Phase 1）。
 *
 * MIME 双路径校验（不信客户端 Content-Type）：
 * - image：magic bytes（PNG/JPEG/GIF/WebP RIFF 容器）；白名单排除 SVG（XSS）
 * - document：无可靠 magic bytes，走扩展名白名单 + NUL 探嗅（含 NUL 判二进制拒绝）
 *
 * original_name 清洗：basename + 白名单字符集 [a-zA-Z0-9._-\u4e00-\u9fa5]，
 * 仅展示用，禁参与路径拼接（路径穿越防御）。
 */

/** image MIME 白名单（排除 image/svg+xml——SVG XSS 向量，本期不支持） */
export const IMAGE_MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** document MIME 白名单（纯文本类，可提取注入 LLM） */
export const DOCUMENT_MIME_WHITELIST = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json",
]);

/** document 扩展名白名单（与 MIME 白名单一一对应） */
const DOCUMENT_EXTENSION_MAP: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

/** original_name 白名单字符集：字母数字 . _ - 和 CJK（清洗路径分隔符与控制字符） */
const NAME_SAFE_RE = /[^\w.\-\u4e00-\u9fa5]/g;

/** PNG: 89 50 4E 47 */
function isPng(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

/** JPEG: FF D8 FF */
function isJpeg(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** GIF: 47 49 46（GIF87a / GIF89a） */
function isGif(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
}

/** WebP：RIFF 容器（....WEBP）——"RIFF" 头 + 8-11 字节 "WEBP"（变体签名 VP8/VP8L/VP8X 不需逐个判） */
function isWebp(buf: Uint8Array): boolean {
  return buf.length >= 12
    && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
}

/** 按扩展名推断 document MIME（扩展名白名单之外返回 null） */
function documentMimeByExtension(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [ext, mime] of Object.entries(DOCUMENT_EXTENSION_MAP)) {
    if (lower.endsWith(ext)) return mime;
  }
  return null;
}

export interface DetectedType {
  kind: "image" | "document";
  mimeType: string;
}

/**
 * 内容探嗅：按文件头字节判定类型。
 * 优先按客户端声明 kind 的路径校验；两路径都无法确认时互换路径再试一次
 * （客户端 MIME 不可信，内容说了算——假声明的 .txt 里塞 PNG 会被按 image 落库）。
 */
export function sniffType(head: Uint8Array, declaredName: string): DetectedType | null {
  // image 路径：magic bytes
  if (isPng(head)) return { kind: "image", mimeType: "image/png" };
  if (isJpeg(head)) return { kind: "image", mimeType: "image/jpeg" };
  if (isGif(head)) return { kind: "image", mimeType: "image/gif" };
  if (isWebp(head)) return { kind: "image", mimeType: "image/webp" };

  // document 路径：扩展名白名单 + NUL 探嗅
  if (!containsNul(head)) {
    const mime = documentMimeByExtension(declaredName);
    if (mime) return { kind: "document", mimeType: mime };
  }
  return null;
}

/** 缓冲区内是否含 NUL 字节（文本文件不应含；截断探嗅头即可判定） */
export function containsNul(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 清洗 original_name：basename（剥任何路径成分）+ 白名单字符集过滤 + 长度截断。
 * 清洗后仅用于展示与 Content-Disposition，禁参与路径拼接。
 * 清洗后为空时给 "file" 兜底名。
 */
export function sanitizeOriginalName(rawName: string): string {
  // basename：取最后一段路径成分（兼容 / 与 \）；再剥 Unix 隐藏前缀与 Windows 盘符残留
  const base = rawName.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(NAME_SAFE_RE, "").replace(/^[.]+/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned.slice(0, 190);
}

/** 按 kind 取大小上限 */
export function sizeLimitFor(kind: "image" | "document", config: { maxImageBytes: number; maxDocumentBytes: number }): number {
  return kind === "image" ? config.maxImageBytes : config.maxDocumentBytes;
}
