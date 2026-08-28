import { describe, it, expect } from "vitest";
import { projectForChannel } from "@entities/conversation/message-body-projection";
import type { AttachmentRef } from "@entities/conversation/attachment";
import { toMessageDTO } from "@interface-adapters/http/dto/message-dto";
import type { Message } from "@entities/conversation/message";

function att(overrides: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    id: "att-1", kind: "image", originalName: "photo.png", mimeType: "image/png",
    sizeBytes: 1024, width: 100, height: 100, caption: null, ...overrides,
  };
}

describe("egress 投影：附件在 projectForChannel 流水线内、truncate 之前注入（多模态 Phase 1）", () => {
  it("带附件消息投影含占位行（truncate 前注入）", () => {
    const out = projectForChannel("看这张图", {
      webBaseUrl: "https://otter.app",
      conversationId: "conv-1",
      attachments: [att()],
    });
    expect(out).toContain("[图片: photo.png]");
  });

  it("链接形态 = 对话页链接（非附件直链）：附件 ID 不出现在投影中", () => {
    const out = projectForChannel("看这张图", {
      webBaseUrl: "https://otter.app",
      conversationId: "conv-1",
      attachments: [att({ id: "secret-uuid" })],
    });
    expect(out).toContain("👉 https://otter.app/conversations/conv-1");
    expect(out).not.toContain("secret-uuid");
    expect(out).not.toContain("/api/attachments/");
  });

  it("webBaseUrl 缺失：降级无链接纯文本（不拼 undefined）", () => {
    const out = projectForChannel("看这张图", {
      conversationId: "conv-1",
      attachments: [att()],
    });
    expect(out).toContain("[图片: photo.png]");
    expect(out).not.toContain("👉");
    expect(out).not.toContain("undefined");
  });

  it("顺序验收：超长正文触发截断时，附件占位仍在（在 truncate 之前注入）", () => {
    // 30000 字节中文正文（远超 25000 默认上限），附件占位必须在截断后存活
    const longBody = "长".repeat(30000);
    const out = projectForChannel(longBody, {
      webBaseUrl: "https://otter.app",
      conversationId: "conv-1",
      attachments: [att({ originalName: "must-survive.png" })],
    });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(25000);
    expect(out).toContain("must-survive.png");
    expect(out).toContain("已截断");
  });

  it("多附件共享一条对话页链接", () => {
    const out = projectForChannel("两份", {
      webBaseUrl: "https://otter.app",
      conversationId: "conv-1",
      attachments: [att(), att({ id: "att-2", kind: "document", originalName: "notes.md", mimeType: "text/markdown", sizeBytes: 2048 })],
    });
    expect(out).toContain("[图片: photo.png]");
    expect(out).toContain("[文件: notes.md (2.0KB)]");
    // 只一条链接
    expect(out.split("👉").length - 1).toBe(1);
  });

  it("无附件消息：投影行为与旧版完全一致", () => {
    expect(projectForChannel("普通消息", { webBaseUrl: "https://x.app", conversationId: "c" })).toBe("普通消息");
  });

  it("空 body + 附件：附件行独立成文", () => {
    const out = projectForChannel("", {
      webBaseUrl: "https://otter.app",
      conversationId: "conv-1",
      attachments: [att()],
    });
    expect(out.trim()).toBe("[图片: photo.png]\n👉 https://otter.app/conversations/conv-1");
  });
});

describe("MessageDTO 扩展（多模态 Phase 1）", () => {
  function msg(overrides: Partial<Message> = {}): Message {
    return {
      id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
      senderType: "user", senderId: "user-1", talkingStonePassedTo: null,
      status: "completed",
      segments: [{ id: "seg-1", messageId: "msg-1", body: "带图消息", sequenceNum: 0, createdAt: "2026-08-27T00:00:00Z" }],
      sequenceNum: 1, contextTokens: null, contextTokensMax: null,
      source: "web", senderName: "", createdAt: "2026-08-27T00:00:00Z", completedAt: null,
      ...overrides,
    };
  }

  it("消息带附件时 atts 透出", () => {
    const dto = toMessageDTO(msg({ attachments: [att(), att({ id: "att-2", kind: "document", originalName: "n.md", mimeType: "text/markdown", sizeBytes: 100, width: null, height: null })] }));
    expect(dto.atts).toHaveLength(2);
    expect(dto.atts![0]).toMatchObject({ id: "att-1", kind: "image", originalName: "photo.png" });
    expect(dto.atts![1].kind).toBe("document");
  });

  it("无附件消息不带 atts 字段（向后兼容）", () => {
    const dto = toMessageDTO(msg());
    expect(dto.atts).toBeUndefined();
  });

  it("空数组附件不带 atts 字段", () => {
    const dto = toMessageDTO(msg({ attachments: [] }));
    expect(dto.atts).toBeUndefined();
  });
});
