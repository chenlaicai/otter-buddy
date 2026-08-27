/**
 * 附件注入服务（多模态 Phase 1，方案 §3.4——审视修复 R4/R7 后的策略归位）。
 *
 * 职责：attachmentIds → 当前任务消息的注入载荷（image 真图 + document 文本）。
 * 这是 usecases 层策略（方案 §3.4 分层原则「组装是策略，放 usecases」）：
 * - ≤2 图服务端硬限制在此执行（controller 只透传调用，不再自判）
 * - document 提取注入 LLM（plain-text extractor + 16KB/文件截断，方案 §3.4①）
 *
 * 消费方：message-controller（sendMessage/retry）——HTTP 层薄壳；
 * Phase 2 飞书 ingress 复用本服务（sendMessage 直调路径不再绕过限制）。
 *
 * 读盘失败的降级语义：附件信息不丢（文本投影占位仍在），仅真图/真文本缺席。
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { MAX_IMAGES_PER_TURN } from "./dispatch-chain-engine";
import type { AttachmentRepository } from "./attachment-repository";
import type { Logger } from "@usecases/ports/logger";

/** ImageContent（与 sdk-invoke-port.InvokeOptions.images 同构） */
export interface InjectionImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** 注入载荷：image 真图 + document 文本块（追加在消息文本之后） */
export interface InjectionPayload {
  images?: InjectionImage[];
  /** document 提取文本块（每文件一行占位 + 内容，16KB/文件截断；方案 §3.4①） */
  documentBlock?: string;
}

/** document 单文件注入截断（方案 §3.4①：16KB/文件） */
const DOCUMENT_MAX_BYTES = 16 * 1024;

/** 依赖注入（均为可选装配物——缺 repo 时附件注入整体关闭） */
export interface AttachmentInjectionDeps {
  attachmentRepo?: AttachmentRepository;
  /** 附件存储根（config.attachments.storageRoot） */
  storageRoot?: string;
  logger: Logger;
}

export class AttachmentInjectionService {
  constructor(private readonly deps: AttachmentInjectionDeps) {}

  get available(): boolean {
    return !!this.deps.attachmentRepo;
  }

  /**
   * 前置校验 + 组装一次完成（controller sendMessage 入口用）。
   * @returns 错误消息字符串（拒绝）或注入载荷（undefined 表示无附件/未装配）
   */
  async validateAndBuild(attachmentIds?: string[]): Promise<string | InjectionPayload | undefined> {
    const err = await this.validateForSend(attachmentIds);
    if (err) return err;
    return this.buildInjectionPayload(attachmentIds);
  }

  /**
   * 前置校验（存在性 + 每轮 ≤2 图硬限制）。
   * @returns 错误消息（拒绝）或 null（通过）
   */
  async validateForSend(attachmentIds?: string[]): Promise<string | null> {
    if (!attachmentIds || attachmentIds.length === 0) return null;
    if (!this.deps.attachmentRepo) {
      // 附件子系统未装配但请求带 attachmentIds：透传给 SendMessage（其会报 validation）
      return null;
    }
    const atts = await this.deps.attachmentRepo.getByIds(attachmentIds);
    const foundIds = new Set(atts.map(a => a.id));
    if (atts.length === 0 || attachmentIds.some(aid => !foundIds.has(aid))) {
      return "attachmentIds 含不存在的附件";
    }
    const imageCount = atts.filter(a => a.kind === "image").length;
    if (imageCount > MAX_IMAGES_PER_TURN) {
      return `图片附件超过每轮上限（${MAX_IMAGES_PER_TURN} 张），请减少后重试`;
    }
    return null;
  }

  /**
   * 组装注入载荷：image → base64 真图；document → 提取文本块（16KB/文件截断）。
   * 调用前应先过 validateForSend（限制已在入口拒绝，此处不再重复判）。
   * 单次读盘后多獭共享（dispatch-chain 对每獭复用同一份载荷——优于方案 §3.4③ 的 3 獭 3 次读盘）。
   */
  async buildInjectionPayload(attachmentIds?: string[]): Promise<InjectionPayload | undefined> {
    if (!attachmentIds || attachmentIds.length === 0) return undefined;
    if (!this.deps.attachmentRepo) return undefined;

    const atts = await this.deps.attachmentRepo.getByIds(attachmentIds);
    if (atts.length === 0) return undefined;

    const images: InjectionImage[] = [];
    const docLines: string[] = [];

    for (const a of atts) {
      if (a.kind === "image") {
        this.pushImage(images, await this.readAttachmentFile(a.filePath), a.mimeType);
        continue;
      }
      // document：提取文本（plain-text extractor——白名单 MIME 均为纯文本类，直接 utf8 解码）
      await this.pushDocumentLine(docLines, a, await this.readAttachmentFile(a.filePath));
    }

    if (images.length === 0 && docLines.length === 0) return undefined;
    return {
      ...(images.length > 0 && { images }),
      ...(docLines.length > 0 && { documentBlock: docLines.join("\n\n") }),
    };
  }

  /** 图片入载荷（≤MAX_IMAGES_PER_TURN 防御：validate 已拒，此处兜底截断；读盘失败跳过） */
  private pushImage(images: InjectionImage[], data: Buffer | null, mimeType: string): void {
    if (data == null) return;
    if (images.length >= MAX_IMAGES_PER_TURN) return;
    images.push({ type: "image", data: data.toString("base64"), mimeType });
  }

  /** document 提取行入载荷（读盘失败跳过；16KB/文件截断） */
  private async pushDocumentLine(
    docLines: string[],
    a: { originalName: string; filePath: string },
    raw: Buffer | null,
  ): Promise<void> {
    if (raw == null) return;
    docLines.push(`[文件: ${a.originalName}]\n${this.truncateDocumentBytes(raw)}`);
  }

  /** 读盘（async，审视修复 R12：不阻塞事件循环；失败降级 null：占位投影仍在，真图/真文本缺席——warn 留痕） */
  private async readAttachmentFile(filePath: string): Promise<Buffer | null> {
    const abs = path.join(this.deps.storageRoot ?? "./data/attachments", filePath);
    try {
      return await fsp.readFile(abs);
    } catch (err) {
      this.deps.logger.warn("Attachment file read failed, degrading to text-only projection", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** 16KB/文件截断（UTF-8 字节级，不切断多字节字符；方案 §3.4①） */
  private truncateDocumentBytes(raw: Buffer): string {
    if (raw.length <= DOCUMENT_MAX_BYTES) return raw.toString("utf8");
    let end = DOCUMENT_MAX_BYTES;
    // continuation byte 形如 10xxxxxx (0x80–0xBF)；回退到字符边界
    while (end > 0 && (raw[end] & 0xc0) === 0x80) end--;
    return `${raw.subarray(0, end).toString("utf8")}\n…(文件过大已截断)`;
  }
}
