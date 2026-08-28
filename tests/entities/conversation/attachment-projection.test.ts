import { describe, it, expect } from "vitest";
import { projectAttachments } from "@entities/conversation/attachment-projection";
import type { AttachmentRef } from "@entities/conversation/attachment";

function imageRef(overrides: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    id: "att-1", kind: "image", originalName: "photo.png", mimeType: "image/png",
    sizeBytes: 1024, width: 100, height: 100, caption: null, ...overrides,
  };
}

function docRef(overrides: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    id: "att-2", kind: "document", originalName: "notes.md", mimeType: "text/markdown",
    sizeBytes: 2048, width: null, height: null, caption: null, ...overrides,
  };
}

describe("projectAttachments（附件文本投影，多模态 Phase 1）", () => {
  it("空数组返回空串", () => {
    expect(projectAttachments([])).toBe("");
  });

  it("undefined 安全（历史消息无 attachments 字段）", () => {
    expect(projectAttachments(undefined as unknown as AttachmentRef[])).toBe("");
  });

  it("图片：caption 缺席时降级文件名", () => {
    expect(projectAttachments([imageRef()])).toBe("[图片: photo.png]");
  });

  it("图片：caption 存在时优先（Phase 2 worker 回填后生效）", () => {
    expect(projectAttachments([imageRef({ caption: "白板上画的架构图" })]))
      .toBe("[图片: 白板上画的架构图]");
  });

  it("caption 空白串视为缺席（降级文件名）", () => {
    expect(projectAttachments([imageRef({ caption: "   " })])).toBe("[图片: photo.png]");
  });

  it("文档：name (size) 格式，size 人类可读", () => {
    expect(projectAttachments([docRef({ sizeBytes: 2048 })])).toBe("[文件: notes.md (2.0KB)]");
  });

  it("大文档走 MB 单位", () => {
    expect(projectAttachments([docRef({ sizeBytes: 5 * 1024 * 1024 })])).toBe("[文件: notes.md (5.0MB)]");
  });

  it("小文件走 B 单位", () => {
    expect(projectAttachments([docRef({ sizeBytes: 100 })])).toBe("[文件: notes.md (100B)]");
  });

  it("多附件逐行拼接（每附件一行）", () => {
    const out = projectAttachments([imageRef(), docRef()]);
    expect(out).toBe("[图片: photo.png]\n[文件: notes.md (2.0KB)]");
  });

  it("中文名保持原样", () => {
    expect(projectAttachments([imageRef({ originalName: "屏幕截图.png" })])).toBe("[图片: 屏幕截图.png]");
  });
});
