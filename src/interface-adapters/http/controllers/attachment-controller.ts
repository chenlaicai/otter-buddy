/**
 * 附件 HTTP 端点（多模态 Phase 1，方案 §3.3）。
 *
 * POST /api/conversations/:id/attachments  multipart/form-data 上传（busboy 流式解析）
 * GET  /api/attachments/:id                文件流（nosniff；document 强制 attachment 下载）
 *
 * 访问控制假设（方案 §3.2 显式声明）：Phase 1 附件端点不做独立鉴权，
 * 安全性依赖三重前提——①部署网络隔离；②UUIDv4 122bit 不可猜；
 * ③附件直链不脱离 Web 同源体系（egress 投影只给对话页链接）。
 */

import type { Context } from "hono";
import Busboy from "busboy";
import { Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";
import type { AttachmentRepository } from "@usecases/conversation/attachment-repository";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";

/** 单次上传文件数上限（multipart 批量；防滥用，与每轮 2 图注入限制解耦） */
const MAX_FILES_PER_UPLOAD = 5;

interface UploadOutcome {
  results: Array<Record<string, unknown>>;
  errors: Array<{ originalName: string; error: string }>;
}

export class AttachmentController {
  constructor(
    private readonly uploadService: AttachmentUploadService,
    private readonly attachmentRepo: AttachmentRepository,
    private readonly storageRoot: string,
    private readonly logger: Logger,
  ) {}

  /** multipart 上传：Content-Type/Length 预检 + 流式解析（不全量读内存） */
  async upload(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const uploaderId = c.req.query("uploaderId") ?? "user";

      // Content-Type 预检
      const contentType = c.req.header("Content-Type") ?? "";
      if (!contentType.startsWith("multipart/form-data")) {
        return c.json({ error: "Content-Type 必须是 multipart/form-data" }, 400);
      }
      // Content-Length 预检（busboy 流式计数是第二道防线）
      const declaredLength = Number(c.req.header("Content-Length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > 120 * 1024 * 1024) {
        return c.json({ error: "请求体过大" }, 413);
      }

      const { results, errors } = await this.parseMultipart(c, contentType, uploaderId);

      if (results.length === 0 && errors.length > 0) {
        return c.json({ error: errors[0].error, errors }, 400);
      }

      this.logger.info("Attachments uploaded", {
        conversationId, uploaderId, count: results.length,
        ...(errors.length > 0 && { failedCount: errors.length }),
      });
      return c.json({ attachments: results, ...(errors.length > 0 && { errors }) }, 201);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** busboy 流式解析 multipart：逐文件走上传管线（MIME 校验/大小限制/sha256 去重在管线内） */
  private async parseMultipart(c: Context, contentType: string, uploaderId: string): Promise<UploadOutcome> {
    const results: Array<Record<string, unknown>> = [];
    const errors: Array<{ originalName: string; error: string }> = [];

    await new Promise<void>((resolve, reject) => {
      const busboy = Busboy({
        headers: { "content-type": contentType },
        limits: { files: MAX_FILES_PER_UPLOAD, fileSize: 25 * 1024 * 1024 },
      });

      busboy.on("file", (_name, stream, info) => {
        const originalName = info.filename || "file";
        this.uploadService
          .upload({
            stream: Readable.from(stream),
            originalName,
            declaredMimeType: info.mimeType || "application/octet-stream",
            uploaderId,
          })
          .then(att => {
            results.push({
              id: att.id, kind: att.kind, mimeType: att.mimeType,
              originalName: att.originalName, sizeBytes: att.sizeBytes,
              ...(att.width != null && { width: att.width }),
              ...(att.height != null && { height: att.height }),
            });
          })
          .catch(err => {
            errors.push({ originalName, error: err instanceof Error ? err.message : String(err) });
          });
      });

      busboy.on("error", reject);
      busboy.on("close", () => resolve());

      // 原始 body 流喂给 busboy（流式，不缓冲）
      const nodeStream = c.req.raw.body
        ? Readable.fromWeb(c.req.raw.body as never)
        : Readable.from([]);
      nodeStream.pipe(busboy);
    });

    return { results, errors };
  }

  /** 文件流：内容寻址 immutable；nosniff 全局 + document 强制 attachment */
  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const att = await this.attachmentRepo.getById(id);
      if (!att) {
        return c.json({ error: "Attachment not found" }, 404);
      }

      const absPath = path.join(this.storageRoot, att.filePath);
      if (!fs.existsSync(absPath)) {
        this.logger.error("Attachment file missing on disk", undefined, { id, filePath: att.filePath });
        return c.json({ error: "Attachment file missing" }, 410);
      }

      const stat = fs.statSync(absPath);
      const headers: Record<string, string> = {
        "Content-Type": att.mimeType,
        "Content-Length": String(stat.size),
        // nosniff：防 MIME 嗅探把文本/图片渲染成可执行向量
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=31536000, immutable",
        // document 强制下载（清洗后文件名）；image inline（白名单已排除可执行向量）
        ...(att.kind === "document" && {
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(att.originalName)}`,
        }),
      };

      const stream = fs.createReadStream(absPath);
      return new Response(stream as unknown as ReadableStream, { headers });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
