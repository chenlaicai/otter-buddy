import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Readable } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

/** 上传管线集成测试：真 sqlite + 真文件系统 + 真 sharp。
 *  覆盖：MIME 校验/大小限制（流式计数）/sha256 去重/resize 落盘/repository CRUD。 */

import { SqliteAttachmentRepository, AttachmentDuplicateError } from "@frameworks/db/attachment/sqlite-attachment-repository";
import { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";

/** 生成真实 PNG（sharp 渲染）：宽高可控 */
async function makePng(width: number, height: number, color = "red"): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: { width, height, channels: 4, background: color },
  }).png().toBuffer();
}

describe("AttachmentUploadService（上传管线集成，多模态 Phase 1）", () => {
  let db: Database.Database;
  let repo: SqliteAttachmentRepository;
  let service: AttachmentUploadService;
  let tmpRoot: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteAttachmentRepository(db);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "att-test-"));
    service = new AttachmentUploadService(
      repo,
      { storageRoot: tmpRoot, maxImageBytes: 1024 * 1024, maxDocumentBytes: 2 * 1024 * 1024 },
      createTestLogger(),
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("PNG 上传：识别为 image，落盘 resize 后尺寸正确", async () => {
    const png = await makePng(3000, 1000);
    const att = await service.upload({
      stream: Readable.from(png),
      originalName: "big.png",
      declaredMimeType: "application/octet-stream", // 假声明，magic bytes 说了算
      uploaderId: "user-1",
    });
    expect(att.kind).toBe("image");
    expect(att.mimeType).toBe("image/png");
    // resize 2048px inside：3000x1000 → 2048x683（不放大）
    expect(att.width).toBeLessThanOrEqual(2048);
    expect(att.height).toBeLessThanOrEqual(2048);
    // 落盘文件存在且 sha256 匹配最终字节
    const abs = path.join(tmpRoot, att.filePath);
    expect(fs.existsSync(abs)).toBe(true);
    expect(att.sizeBytes).toBe(fs.statSync(abs).size);
    expect(att.sizeBytes).toBeLessThan(png.length); // resize 压缩后更小
  });

  it("同内容同 uploader 二次上传：sha256 去重返回已有 id", async () => {
    const png = await makePng(100, 100);
    const first = await service.upload({
      stream: Readable.from(png), originalName: "a.png", declaredMimeType: "image/png", uploaderId: "user-1",
    });
    const second = await service.upload({
      stream: Readable.from(png), originalName: "b.png", declaredMimeType: "image/png", uploaderId: "user-1",
    });
    expect(second.id).toBe(first.id);
    // 只有一行
    expect(repo.getById != null).toBe(true);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM attachments").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("同内容不同 uploader：不去重（sha256+uploader 联合键）", async () => {
    const png = await makePng(100, 100);
    const a = await service.upload({
      stream: Readable.from(png), originalName: "a.png", declaredMimeType: "image/png", uploaderId: "user-1",
    });
    const b = await service.upload({
      stream: Readable.from(png), originalName: "a.png", declaredMimeType: "image/png", uploaderId: "user-2",
    });
    expect(b.id).not.toBe(a.id);
  });

  it("超限图片：流式计数中止并报错（不留半文件）", async () => {
    const png = await makePng(50, 50);
    const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]); // 2MB > 1MB 限制（探嗅仍 PNG）
    await expect(service.upload({
      stream: Readable.from(big),
      originalName: "big.png",
      declaredMimeType: "image/png",
      uploaderId: "user-1",
    })).rejects.toThrow(/大小上限|超过/);
    // 无残留行
    const count = (db.prepare("SELECT COUNT(*) AS c FROM attachments").get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("白名单外类型拒绝（exe）", async () => {
    await expect(service.upload({
      stream: Readable.from(Buffer.from([0x4d, 0x5a, 0x90, 0x00])),
      originalName: "evil.exe",
      declaredMimeType: "application/octet-stream",
      uploaderId: "user-1",
    })).rejects.toThrow(/不支持的文件类型/);
  });

  it("SVG 内容拒绝（XSS 防御：无 magic bytes 且 .svg 不在白名单）", async () => {
    await expect(service.upload({
      stream: Readable.from(Buffer.from('<svg onload="alert(1)"></svg>')),
      originalName: "evil.svg",
      declaredMimeType: "image/svg+xml",
      uploaderId: "user-1",
    })).rejects.toThrow(/不支持的文件类型/);
  });

  it("文本文档上传：直落盘不 resize", async () => {
    const att = await service.upload({
      stream: Readable.from(Buffer.from("hello 多模态", "utf8")),
      originalName: "notes.txt",
      declaredMimeType: "text/plain",
      uploaderId: "user-1",
    });
    expect(att.kind).toBe("document");
    expect(att.mimeType).toBe("text/plain");
    expect(att.width).toBeNull();
    expect(att.height).toBeNull();
    const abs = path.join(tmpRoot, att.filePath);
    expect(fs.readFileSync(abs, "utf8")).toBe("hello 多模态");
  });


  // ── #608：audio/video/pdf 白名单扩展 ──

  it("WAV 音频上传：识别为 audio，直落盘不重编码（#608）", async () => {
    // 44 字节 WAV 头 + 少量 PCM 数据
    const wav = Buffer.concat([Buffer.from([0x52,0x49,0x46,0x46,0x24,0x00,0x00,0x00,0x57,0x41,0x56,0x45]), Buffer.alloc(64, 0x01)]);
    const att = await service.upload({
      stream: Readable.from(wav),
      originalName: "weixin-voice-1.wav",
      declaredMimeType: "application/octet-stream", // 假声明，magic bytes 说了算
      uploaderId: "user-1",
    });
    expect(att.kind).toBe("audio");
    expect(att.mimeType).toBe("audio/wav");
    expect(att.width).toBeNull();
    const abs = path.join(tmpRoot, att.filePath);
    expect(att.filePath.endsWith(".wav")).toBe(true);
    expect(fs.statSync(abs).size).toBe(wav.length); // 直落盘不 resize
  });

  it("MP4 视频上传：识别为 video（#608）", async () => {
    const mp4 = Buffer.concat([Buffer.from([0x00,0x00,0x00,0x20,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d]), Buffer.alloc(128, 0x02)]);
    const att = await service.upload({
      stream: Readable.from(mp4),
      originalName: "weixin-video-1.mp4",
      declaredMimeType: "video/mp4",
      uploaderId: "user-1",
    });
    expect(att.kind).toBe("video");
    expect(att.mimeType).toBe("video/mp4");
  });

  it("PDF 上传：识别为 document kind，落盘原字节（#608）", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100, 0x03)]);
    const att = await service.upload({
      stream: Readable.from(pdf),
      originalName: "report.pdf",
      declaredMimeType: "application/pdf",
      uploaderId: "user-1",
    });
    expect(att.kind).toBe("document");
    expect(att.mimeType).toBe("application/pdf");
    expect(att.filePath.endsWith(".pdf")).toBe(true);
  });

  it("original_name 路径穿越清洗（../../secret/notes.txt → notes.txt）", async () => {
    const att = await service.upload({
      stream: Readable.from(Buffer.from("hello")),
      originalName: "../../secret/notes.txt",
      declaredMimeType: "text/plain",
      uploaderId: "user-1",
    });
    expect(att.originalName).toBe("notes.txt");
  });
});

describe("SqliteAttachmentRepository CRUD", () => {
  let db: Database.Database;
  let repo: SqliteAttachmentRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteAttachmentRepository(db);
  });

  afterEach(() => db.close());

  function fixture(overrides: Partial<Parameters<SqliteAttachmentRepository["insert"]>[0]> = {}) {
    return {
      id: crypto.randomUUID(),
      sha256: "a".repeat(64),
      filePath: "attachments/aa/bb/" + "a".repeat(64) + ".png",
      originalName: "x.png",
      mimeType: "image/png",
      kind: "image" as const,
      sizeBytes: 123,
      width: 10, height: 10,
      caption: null,
      uploaderId: "user-1",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("insert + getById 往返", async () => {
    const att = fixture();
    await repo.insert(att);
    const got = await repo.getById(att.id);
    expect(got).not.toBeNull();
    expect(got!.originalName).toBe("x.png");
    expect(got!.kind).toBe("image");
  });

  it("sha256+uploader 唯一索引：直接 insert 撞车抛 AttachmentDuplicateError（携带已有行）", async () => {
    const a = fixture();
    await repo.insert(a);
    const b = fixture({ id: crypto.randomUUID() }); // 同 sha256 同 uploader
    try {
      await repo.insert(b);
      expect.unreachable("应抛 AttachmentDuplicateError");
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentDuplicateError);
      expect((err as AttachmentDuplicateError).existing.id).toBe(a.id);
    }
  });

  it("getByIds 批量查询（空数组安全）", async () => {
    expect(await repo.getByIds([])).toEqual([]);
    const a1 = fixture({ sha256: "b".repeat(64) });
    const a2 = fixture({ sha256: "c".repeat(64) });
    await repo.insert(a1);
    await repo.insert(a2);
    const got = await repo.getByIds([a1.id, a2.id, "nonexistent"]);
    expect(got.map(a => a.id).sort()).toEqual([a1.id, a2.id].sort());
  });

  it("linkMessageAttachments + getAttachmentRefsByMessageIds（按 sequence_num 排序）", async () => {
    // 建消息行（FK 约束需要 messages 存在）
    const convId = "conv-att";
    const turnId = "turn-att";
    const msgId = "msg-att";
    db.prepare("INSERT INTO conversations (id, title, status) VALUES (?, 't', 'active')").run(convId);
    db.prepare("INSERT INTO turns (id, conversation_id, turn_number, status) VALUES (?, ?, 1, 'open')").run(turnId, convId);
    db.prepare("INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id) VALUES (?, ?, 'user', 'u', 'completed', 1, ?)").run(msgId, convId, turnId);

    const a1 = fixture({ sha256: "d".repeat(64), originalName: "first.png" });
    const a2 = fixture({ sha256: "e".repeat(64), originalName: "second.png" });
    await repo.insert(a1);
    await repo.insert(a2);

    await repo.linkMessageAttachments(msgId, [a2.id, a1.id]); // 故意倒序传
    const map = await repo.getAttachmentRefsByMessageIds([msgId]);
    const refs = map.get(msgId)!;
    expect(refs.map(r => r.originalName)).toEqual(["second.png", "first.png"]); // 按插入序 = sequence_num
    // ref 投影不含 filePath/sha256（最小投影）
    expect(refs[0]).not.toHaveProperty("filePath");
  });

  it("消息删除级联清理 message_attachments（FK CASCADE）", async () => {
    const convId = "conv-att2";
    const turnId = "turn-att2";
    const msgId = "msg-att2";
    db.prepare("INSERT INTO conversations (id, title, status) VALUES (?, 't', 'active')").run(convId);
    db.prepare("INSERT INTO turns (id, conversation_id, turn_number, status) VALUES (?, ?, 1, 'open')").run(turnId, convId);
    db.prepare("INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id) VALUES (?, ?, 'user', 'u', 'completed', 1, ?)").run(msgId, convId, turnId);

    const a1 = fixture({ sha256: "f".repeat(64) });
    await repo.insert(a1);
    await repo.linkMessageAttachments(msgId, [a1.id]);

    db.prepare("DELETE FROM messages WHERE id = ?").run(msgId);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM message_attachments").get() as { c: number };
    expect(rows.c).toBe(0); // 级联清理
    // attachments 行保留（附件生命周期独立于消息）
    expect(await repo.getById(a1.id)).not.toBeNull();
  });
});
