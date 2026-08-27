import { describe, it, expect } from "vitest";
import { sniffType, sanitizeOriginalName, containsNul, sizeLimitFor } from "@usecases/conversation/upload-validation";

/** 1x1 透明 PNG（真实 magic bytes） */
const PNG_1PX = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
]);

/** JPEG 头 */
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** GIF 头（GIF89a） */
const GIF_HEAD = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

/** WebP RIFF 容器头 */
const WEBP_HEAD = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, // "RIFF" + size
  0x57, 0x45, 0x42, 0x50, // "WEBP"
]);

describe("sniffType（MIME 双路径校验）", () => {
  it("PNG magic bytes 识别", () => {
    expect(sniffType(PNG_1PX, "x.bin")).toEqual({ kind: "image", mimeType: "image/png" });
  });

  it("JPEG magic bytes 识别", () => {
    expect(sniffType(JPEG_HEAD, "x.bin")).toEqual({ kind: "image", mimeType: "image/jpeg" });
  });

  it("GIF magic bytes 识别", () => {
    expect(sniffType(GIF_HEAD, "x.bin")).toEqual({ kind: "image", mimeType: "image/gif" });
  });

  it("WebP RIFF 容器识别", () => {
    expect(sniffType(WEBP_HEAD, "x.bin")).toEqual({ kind: "image", mimeType: "image/webp" });
  });

  it("客户端假声明（.txt 扩展名）不影响 PNG 内容判定", () => {
    expect(sniffType(PNG_1PX, "evil.txt")).toEqual({ kind: "image", mimeType: "image/png" });
  });

  it("文本文件按扩展名白名单识别", () => {
    expect(sniffType(Buffer.from("hello"), "a.txt")).toEqual({ kind: "document", mimeType: "text/plain" });
    expect(sniffType(Buffer.from("# hi"), "a.md")).toEqual({ kind: "document", mimeType: "text/markdown" });
    expect(sniffType(Buffer.from("a,b"), "a.csv")).toEqual({ kind: "document", mimeType: "text/csv" });
    expect(sniffType(Buffer.from("{}"), "a.json")).toEqual({ kind: "document", mimeType: "application/json" });
  });

  it("扩展名大小写不敏感", () => {
    expect(sniffType(Buffer.from("hello"), "A.TXT")).toEqual({ kind: "document", mimeType: "text/plain" });
  });

  it("白名单外扩展名拒绝（如 .exe / .svg）", () => {
    expect(sniffType(Buffer.from("MZ.."), "a.exe")).toBeNull();
    expect(sniffType(Buffer.from("<svg/>"), "a.svg")).toBeNull();
  });

  it("含 NUL 字节的文本拒绝（二进制伪装）", () => {
    expect(sniffType(Buffer.concat([Buffer.from("he"), Buffer.from([0x00]), Buffer.from("llo")]), "a.txt")).toBeNull();
  });

  it("无法识别的内容拒绝（非图片头 + 非白名单扩展）", () => {
    expect(sniffType(Buffer.from([0xde, 0xad, 0xbe, 0xef]), "x.bin")).toBeNull();
  });
});

describe("sanitizeOriginalName（路径穿越防御）", () => {
  it("普通文件名保持不变", () => {
    expect(sanitizeOriginalName("photo.png")).toBe("photo.png");
  });

  it("中文名保持", () => {
    expect(sanitizeOriginalName("屏幕截图.png")).toBe("屏幕截图.png");
  });

  it("Unix 路径穿越剥离（../../etc/passwd）", () => {
    expect(sanitizeOriginalName("../../etc/passwd")).toBe("passwd");
  });

  it("Windows 路径穿越剥离（反斜杠分隔取末段）", () => {
    expect(sanitizeOriginalName("C:\\evil\\x.png")).toBe("x.png");
  });

  it("危险字符被清洗（空格/分号/引号等）", () => {
    expect(sanitizeOriginalName('a b;c"d.png')).toBe("abcd.png");
  });

  it("控制字符被清洗", () => {
    expect(sanitizeOriginalName("a\nb\r\tc.png")).toBe("abc.png");
  });

  it("清洗后为空时兜底 file", () => {
    expect(sanitizeOriginalName("///")).toBe("file");
    expect(sanitizeOriginalName("...")).toBe("file");
  });

  it("超长名截断到 190 字符", () => {
    expect(sanitizeOriginalName("a".repeat(500)).length).toBeLessThanOrEqual(190);
  });
});

describe("containsNul", () => {
  it("纯文本无 NUL", () => {
    expect(containsNul(Buffer.from("hello world"))).toBe(false);
  });

  it("含 NUL 检出", () => {
    expect(containsNul(Buffer.from("he\0llo"))).toBe(true);
  });

  it("空缓冲安全", () => {
    expect(containsNul(Buffer.alloc(0))).toBe(false);
  });
});

describe("sizeLimitFor", () => {
  const config = { maxImageBytes: 10, maxDocumentBytes: 20 };
  it("按 kind 取上限", () => {
    expect(sizeLimitFor("image", config)).toBe(10);
    expect(sizeLimitFor("document", config)).toBe(20);
  });
});
