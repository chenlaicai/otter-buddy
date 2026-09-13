import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, json, createMockDeps } from "./helpers";
import type { TestDeps } from "./helpers";

/** F20260913ctlv 终审修复：entries 时间线端点 DTO 投影锁定
 *  （含 attachments 透出——终审发现的测试盲区：写入链完整但读出链断，回归不可见） */

const entryFixture = {
  id: "entry-1",
  conversationId: "conv-1",
  sequenceNum: 1,
  entryType: "user",
  senderType: "user",
  senderId: "user-1",
  body: "看图",
  invokeId: null,
  yieldTargets: ["otter-big"],
  turnId: "turn-1",
  status: "completed",
  source: "web",
  metadata: null,
  senderName: "",
  contextTokens: null,
  contextTokensMax: null,
  createdAt: "2026-09-13T02:00:00Z",
  completedAt: "2026-09-13T02:00:00Z",
  // 终审修复：repo attachAttachments 填充的投影
  attachments: [
    { id: "att-1", kind: "image", originalName: "a.png", mimeType: "image/png", sizeBytes: 100, width: 100, height: 100, caption: null },
  ],
};

const speakFixture = {
  ...entryFixture,
  id: "entry-2",
  sequenceNum: 2,
  entryType: "speak",
  senderType: "otter",
  senderId: "otter-big",
  senderName: "大獭",
  attachments: undefined,
};

function makeEntryRepo(overrides: Record<string, unknown> = {}) {
  return {
    getEntries: vi.fn().mockResolvedValue([entryFixture, speakFixture]),
    ...overrides,
  };
}

describe("Entries API（F20260913ctlv 终审修复：DTO 投影）", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  describe("GET /api/conversations/:id/entries", () => {
    it("user entry 投影含 attachments（附件读出链——终审断链回归锚）", async () => {
      deps.entryRepo = makeEntryRepo();
      app = createTestApp(deps);

      const res = await app.request("/api/conversations/conv-1/entries");
      expect(res.status).toBe(200);
      const body = await json(res);
      const userEntry = body.entries.find((e: { id: string }) => e.id === "entry-1");
      // 核心断言：附件投影透出（kind/originalName/mimeType/sizeBytes——与 MessageDTO.atts 同形）
      expect(userEntry.attachments).toHaveLength(1);
      expect(userEntry.attachments[0]).toMatchObject({
        id: "att-1", kind: "image", originalName: "a.png", mimeType: "image/png", sizeBytes: 100,
      });
      expect(body.hasMore).toBe(false);
    });

    it("无附件条目不携带 attachments 字段（仅非空时携带）", async () => {
      deps.entryRepo = makeEntryRepo();
      app = createTestApp(deps);

      const res = await app.request("/api/conversations/conv-1/entries");
      const body = await json(res);
      const speakEntry = body.entries.find((e: { id: string }) => e.id === "entry-2");
      expect(speakEntry.attachments).toBeUndefined();
    });

    it("attachment 投影字段全量（width/height 透传，caption 不外泄）", async () => {
      deps.entryRepo = makeEntryRepo();
      app = createTestApp(deps);

      const res = await app.request("/api/conversations/conv-1/entries");
      const body = await json(res);
      const att = body.entries.find((e: { id: string }) => e.id === "entry-1").attachments[0];
      expect(att.width).toBe(100);
      expect(att.height).toBe(100);
      expect(att.caption).toBeUndefined(); // DTO 不含 caption（从简，对照 EntryAttachmentDTO）
    });
  });
});
