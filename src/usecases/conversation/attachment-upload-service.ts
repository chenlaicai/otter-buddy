/**
 * 附件上传管线（多模态 Phase 1，方案 §3.2）。
 *
 * 流程：流式读取（Content-Length 预检 + 流式计数）→ MIME 双路径校验 →
 * 图片 sharp resize 2048px 落盘 / 文档直落盘 → sha256（落盘后字节）→
 * 撞唯一索引返回已有行 id（去重，不重复落盘）。
 *
 * 每轮 ≤2 图为 vision 注入侧的硬限制（dispatch-chain-engine）；
 * 上传侧不限制单次上传图片数（攒多张分多条消息发是合法用法）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Readable } from "node:stream";
import type { Attachment } from "@entities/conversation/attachment";
import { DomainError } from "@entities/errors";
import type { AttachmentRepository } from "./attachment-repository";
import { sniffType, sanitizeOriginalName, sizeLimitFor } from "./upload-validation";
import type { DetectedType } from "./upload-validation";
import type { Logger } from "@usecases/ports/logger";

/** 图片落盘 resize 上限（长短边均不超过；本期妥协：注入尺寸消费策略与资产存储合一） */
const IMAGE_MAX_DIMENSION = 2048;

export interface AttachmentStorageConfig {
  storageRoot: string;
  maxImageBytes: number;
  maxDocumentBytes: number;
}

/** 上传输入：流式字节 + 元信息（来自 multipart 字段） */
export interface UploadInput {
  /** 原始文件字节流（multipart 文件流） */
  stream: Readable;
  /** 客户端声明的原始文件名（不可信，仅作探嗅辅助与展示清洗源） */
  originalName: string;
  /** 客户端声明的 MIME（不可信，服务端双路径校验说了算） */
  declaredMimeType: string;
  /** 上传者（user 或 otter id；飞书 Phase 2 为 sender 身份） */
  uploaderId: string;
}

/** 相对存储路径：attachments/<sha前2>/<sha次2>/<sha>.<ext>（内容寻址分桶） */
function buildRelativePath(sha256: string, ext: string): string {
  return path.posix.join("attachments", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}${ext}`);
}

function extForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "text/plain": return ".txt";
    case "text/markdown": return ".md";
    case "text/csv": return ".csv";
    case "application/json": return ".json";
    default: return "";
  }
}

export class AttachmentUploadService {
  constructor(
    private readonly repo: AttachmentRepository,
    private readonly config: AttachmentStorageConfig,
    private readonly logger: Logger,
  ) {}

  /** 确保存储根目录存在 */
  private ensureRoot(): void {
    fs.mkdirSync(this.config.storageRoot, { recursive: true });
  }

  /** 单文件上传主流程 */
  async upload(input: UploadInput): Promise<Attachment> {
    this.ensureRoot();
    const originalName = sanitizeOriginalName(input.originalName);

    // 1. 流式落临时文件（上限先按 document 最大值粗收，探嗅后按 kind 精判）
    const hardCap = Math.max(this.config.maxImageBytes, this.config.maxDocumentBytes);
    const { tempPath, size } = await this.spoolSimple(input.stream, hardCap);

    try {
      // 2-4. 探嗅 + 双路径校验 + 精确大小校验
      const detected = this.detectAndValidate(tempPath, size, originalName);

      // 5. 落盘（图片 resize 2048px；文档直移）→ 最终字节即存储字节
      const sha256 = await this.persist(tempPath, detected.kind, detected.mimeType);

      // 6. 查重：sha256+uploader 命中返回已有行（不重复落库）
      const existing = await this.repo.findBySha256(sha256, input.uploaderId);
      if (existing) {
        this.logger.info("Attachment deduplicated (sha256 hit)", { sha256, existingId: existing.id });
        return existing;
      }

      // 7. 落库
      return await this.insertAttachment(tempPath, sha256, detected, originalName, input.uploaderId);
    } finally {
      // 临时目录清理（persist 成功时文件已移走；失败时清掉残留）
      try { fs.rmSync(path.dirname(tempPath), { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    }
  }

  /** 探嗅头部 + 双路径 MIME 校验 + 按 kind 精确大小校验 */
  private detectAndValidate(tempPath: string, size: number, originalName: string): DetectedType {
    // 探嗅头部（前 64KB 足够 magic bytes + NUL 探嗅）
    const fd = fs.openSync(tempPath, "r");
    let head: Buffer;
    try {
      head = Buffer.alloc(Math.min(size, 65536));
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }

    const detected = sniffType(head, originalName);
    if (!detected) {
      throw new DomainError(
        `不支持的文件类型：${originalName}（白名单：png/jpeg/webp/gif 图片；txt/md/csv/json 文档）`,
        "validation",
      );
    }

    // 按 kind 精确大小校验（document 的 NUL 探嗅已在 sniffType 内做：含 NUL 判二进制拒绝）
    const limit = sizeLimitFor(detected.kind, this.config);
    if (size > limit) {
      throw new DomainError(`文件超过大小上限（${detected.kind === "image" ? "图片" : "文档"} 限 ${limit} 字节，实际 ${size}）`, "validation");
    }
    return detected;
  }

  /** 组装实体 + 落库（撞唯一索引竞态返回已有行） */
  private async insertAttachment(
    tempPath: string,
    sha256: string,
    detected: DetectedType,
    originalName: string,
    uploaderId: string,
  ): Promise<Attachment> {
    // 尺寸：图片落盘后真实尺寸；文档 null
    const { width, height } = detected.kind === "image"
      ? await this.imageDimensions(tempPath)
      : { width: null as number | null, height: null as number | null };

    const finalSize = fs.statSync(tempPath).size;
    const attachment: Attachment = {
      id: crypto.randomUUID(),
      sha256,
      filePath: buildRelativePath(sha256, extForMime(detected.mimeType)),
      originalName,
      mimeType: detected.mimeType,
      kind: detected.kind,
      sizeBytes: finalSize,
      width, height,
      caption: null, // Phase 2 异步 worker 回填
      uploaderId,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.repo.insert(attachment);
    } catch (err) {
      // 撞唯一索引竞态（并发同内容上传）：返回已有行
      if (err instanceof Error && err.message.includes("Attachment duplicate")) {
        const dup = await this.repo.findBySha256(sha256, uploaderId);
        if (dup) return dup;
      }
      throw err;
    }

    this.logger.info("Attachment stored", {
      id: attachment.id, kind: attachment.kind, mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes, width, height,
    });
    return attachment;
  }

  /** 流式落临时文件：计数 + 上限中止（简单直白的 pipe 实现） */
  private async spoolSimple(stream: Readable, limitBytes: number): Promise<{ tempPath: string; size: number }> {
    const dir = fs.mkdtempSync(path.join(this.config.storageRoot, ".tmp-"));
    const tempPath = path.join(dir, "upload.bin");
    let size = 0;
    try {
      const out = fs.createWriteStream(tempPath);
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limitBytes) {
            stream.destroy();
            reject(new DomainError(`文件超过大小上限（限 ${limitBytes} 字节）`, "validation"));
            return;
          }
          if (!out.write(chunk)) {
            stream.pause();
            out.once("drain", () => stream.resume());
          }
        });
        stream.on("end", () => {
          out.end(() => resolve());
        });
        stream.on("error", reject);
        out.on("error", reject);
      });
    } catch (err) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原错误 */ }
      throw err;
    }
    return { tempPath, size };
  }

  /** 落盘：图片 resize 后写最终路径，返回最终字节 sha256；文档直移到最终路径。
   *  filePath 由 mimeType 决定扩展名（与 upload() 主流程的 buildRelativePath(extForMime) 一致） */
  private async persist(tempPath: string, kind: "image" | "document", mimeType: string): Promise<string> {
    const { default: sharp } = await import("sharp");
    if (kind === "image") {
      // resize 2048px（fit inside，不放大）；输出保持原格式（gif 动图 resize 会丢帧——sharp 默认取首帧，接受）
      const resized = sharp(tempPath).resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      });
      // 先算目标 hash：流式输出到 buffer 求哈希再写文件（图片 ≤2048px 后体量可控）
      const buf: Buffer = await resized.toBuffer();
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      const ext = extForMimeKind(buf);
      const finalPath = path.join(this.config.storageRoot, buildRelativePath(sha256, ext));
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(finalPath, buf);
      // 把最终内容写回 tempPath 供后续尺寸读取统一走文件
      fs.writeFileSync(tempPath, buf);
      return sha256;
    }
    // document：直移（ext 按 mimeType，与 buildRelativePath(extForMime(mimeType)) 同源）
    const buf = fs.readFileSync(tempPath);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const finalPath = path.join(this.config.storageRoot, buildRelativePath(sha256, extForMime(mimeType)));
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.copyFileSync(tempPath, finalPath);
    return sha256;
  }

  /** 图片尺寸（落盘后真实尺寸） */
  private async imageDimensions(filePath: string): Promise<{ width: number; height: number }> {
    const { default: sharp } = await import("sharp");
    const meta = await sharp(filePath).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0 };
  }
}

/** 从 buffer 判断图片扩展（resize 后与源格式一致，按 magic bytes 判） */
function extForMimeKind(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49) return ".gif";
  return ".webp";
}

export { containsNul } from "./upload-validation";
