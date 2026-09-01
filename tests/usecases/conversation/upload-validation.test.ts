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


/** #608：WAV 头（RIFF....WAVE） */
const WAV_HEAD = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, // "RIFF" + size
  0x57, 0x41, 0x56, 0x45, // "WAVE"
  0x66, 0x6d, 0x74, 0x20, // "fmt "
]);

/** #608：MP3 ID3v2 头 */
const MP3_ID3_HEAD = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

/** #608：MP3 裸帧同步头（MPEG1 Layer III 128kbps：FF FB） */
const MP3_SYNC_HEAD = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

/** #608：MP4 ISO-BMFF 头（size + "ftyp" + brand） */
const MP4_HEAD = Buffer.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // size + "ftyp"
  0x69, 0x73, 0x6f, 0x6d, // "isom"
]);

/** #608：PDF 头 */
const PDF_HEAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

describe("sniffType（#608 扩展：audio/video/pdf magic bytes）", () => {
  it("WAV RIFF-WAVE 容器识别", () => {
    expect(sniffType(WAV_HEAD, "x.bin")).toEqual({ kind: "audio", mimeType: "audio/wav" });
  });

  it("MP3 ID3v2 头识别", () => {
    expect(sniffType(MP3_ID3_HEAD, "x.bin")).toEqual({ kind: "audio", mimeType: "audio/mpeg" });
  });

  it("MP3 裸帧同步识别（无 ID3 tag）", () => {
    expect(sniffType(MP3_SYNC_HEAD, "x.bin")).toEqual({ kind: "audio", mimeType: "audio/mpeg" });
  });

  it("MP4 ftyp 容器识别", () => {
    expect(sniffType(MP4_HEAD, "x.bin")).toEqual({ kind: "video", mimeType: "video/mp4" });
  });

  it("PDF magic bytes 识别（kind=document）", () => {
    expect(sniffType(PDF_HEAD, "report.pdf")).toEqual({ kind: "document", mimeType: "application/pdf" });
  });

  it("WAV 与 WebP 同 RIFF 头靠子类型区分（不互串）", () => {
    expect(sniffType(WEBP_HEAD, "x.bin")?.mimeType).toBe("image/webp");
    expect(sniffType(WAV_HEAD, "x.bin")?.mimeType).toBe("audio/wav");
  });

  it("假扩展名不影响 magic bytes 判定（.txt 里塞 MP4）", () => {
    expect(sniffType(MP4_HEAD, "evil.txt")).toEqual({ kind: "video", mimeType: "video/mp4" });
  });

  it("MP3 帧同步误报防御：layer=reserved（FF 06）不识别", () => {
    // 0x06 = version 非 reserved 但 layer=00（reserved）——应拒绝
    expect(sniffType(Buffer.from([0xff, 0x06, 0x90, 0x00]), "x.bin")).toBeNull();
  });

  it("WMA/OGG/FLAC 等其他音频格式仍拒绝（白名单外）", () => {
    expect(sniffType(Buffer.from("OggS".split("").map(c => c.charCodeAt(0))), "a.ogg")).toBeNull();
    expect(sniffType(Buffer.from("fLaC".split("").map(c => c.charCodeAt(0))), "a.flac")).toBeNull();
  });
});

describe("sizeLimitFor", () => {
  const config = { maxImageBytes: 10, maxDocumentBytes: 20 };
  it("按 kind 取上限", () => {
    expect(sizeLimitFor("image", config)).toBe(10);
    expect(sizeLimitFor("document", config)).toBe(20);
  });
});
