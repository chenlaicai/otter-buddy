/**
 * 附件 HTTP 端点集成测试（多模态 Phase 1，审视修复 R2/R13）。
 *
 * 真 Hono app + 真 busboy + 真 sharp + 真 sqlite：
 * - 竞态回归（R2 核心）：上传响应必须含附件 ID——close 后 await 全部 in-flight upload
 * - 每轮 ≤2 图硬限制（400 拒绝）
 * - GET 响应头（nosniff / document 强制 attachment / image inline / immutable 缓存）
 * - 会话存在性校验（404）
 * - FTS 时序（R3）：带附件消息经 send 落库后 messages_fts.body 含附件占位
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { SqliteAttachmentRepository } from "@frameworks/db/attachment/sqlite-attachment-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";
import { AttachmentInjectionService } from "@usecases/conversation/attachment-injection-service";
import { AttachmentController } from "@interface-adapters/http/controllers/attachment-controller";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { SendMessage } from "@usecases/conversation/send-message";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { ManageReadState } from "@usecases/conversation/manage-read-state";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { Conversation, Turn, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { vi } from "vitest";

/** multipart body 构造（原生 FormData，Node 22 支持 Blob/File）。
 *  类型注解：body 直接传 FormData（Hono app.request 接受 BodyInit；tsc DOM lib 下 FormData 即合法） */
function multipartBody(files: Array<{ name: string; content: Buffer; type: string }>): FormData {
  const fd = new FormData();
  for (const f of files) {
    fd.append("files", new Blob([new Uint8Array(f.content)], { type: f.type }), f.name);
  }
  return fd;
}

/** 生成真实 PNG（sharp 渲染） */
async function makePng(width = 100, height = 100, color = "#3366cc"): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

describe("附件 HTTP 端点集成（真管线：busboy→upload→sharp→sqlite）", () => {
  let db: Database.Database;
  let attachmentRepo: SqliteAttachmentRepository;
  let convRepo: SqliteConversationRepository;
  let tmpRoot: string;
  let app: Hono;
  let attachmentController: AttachmentController;
  let uploadService: AttachmentUploadService;

  beforeEach(async () => {
    db = createTestDb();
    attachmentRepo = new SqliteAttachmentRepository(db);
    convRepo = new SqliteConversationRepository(db, createTestLogger());
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "att-http-"));
    uploadService = new AttachmentUploadService(
      attachmentRepo,
      { storageRoot: tmpRoot, maxImageBytes: 1024 * 1024, maxDocumentBytes: 2 * 1024 * 1024 },
      createTestLogger(),
    );
    attachmentController = new AttachmentController(uploadService, attachmentRepo, tmpRoot, createTestLogger(), convRepo);

    app = new Hono();
    app.post("/api/conversations/:id/attachments", (c) => attachmentController.upload(c));
    app.get("/api/attachments/:id", (c) => attachmentController.getById(c));

    // 种子会话
    const conv: Conversation = {
      id: "conv-1", title: "测试", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", completedAt: null, archivedAt: null,
    };
    await convRepo.create(conv);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("R2 竞态回归：上传响应含附件 ID（close 后 await 全部 in-flight upload）", async () => {
    // 真图走完整管线（sharp resize 是异步的——正是旧实现竞态的触发源）
    const png = await makePng(800, 600);
    const res = await app.request("/api/conversations/conv-1/attachments?uploaderId=user-1", {
      method: "POST",
      body: multipartBody([{ name: "photo.png", content: png, type: "image/png" }]),
    });
    // FormData 自带正确 Content-Type（含 boundary）；未预检声明的请求同样走流式解析
    expect(res.status).toBe(201);
    const body = await res.json() as { attachments: Array<{ id: string; kind: string }> };
    // 核心断言：附件 ID 必须在响应中（旧实现竞态时为空数组）
    expect(body.attachments).toHaveLength(1);
    expect(typeof body.attachments[0].id).toBe("string");
    expect(body.attachments[0].id.length).toBeGreaterThan(0);
    expect(body.attachments[0].kind).toBe("image");
    // 入库可查
    const row = await attachmentRepo.getById(body.attachments[0].id);
    expect(row).not.toBeNull();
  });

  it("多文件上传：全部 ID 返回（batch 竞态）", async () => {
    const png = await makePng(200, 200);
    const res = await app.request("/api/conversations/conv-1/attachments?uploaderId=user-1", {
      method: "POST",
      body: multipartBody([
        { name: "a.png", content: png, type: "image/png" },
        { name: "b.png", content: png, type: "image/png" }, // 同内容不同名——sha256 去重返回已有 id
        { name: "notes.txt", content: Buffer.from("hello 多模态"), type: "text/plain" },
      ]),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { attachments: Array<{ id: string; kind: string }> };
    expect(body.attachments).toHaveLength(3);
    expect(new Set(body.attachments.map((a: { id: string }) => a.id)).size).toBe(2); // a/b 同 sha 同 uploader 去重
    expect(body.attachments.some((a: { kind: string }) => a.kind === "document")).toBe(true);
  });

  it("非 multipart Content-Type 拒绝 400", async () => {
    const res = await app.request("/api/conversations/conv-1/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("R10 会话不存在：404", async () => {
    const png = await makePng(50, 50);
    const res = await app.request("/api/conversations/no-such-conv/attachments", {
      method: "POST",
      body: multipartBody([{ name: "x.png", content: png, type: "image/png" }]),
    });
    expect(res.status).toBe(404);
  });

  it("GET：image inline + nosniff + immutable 缓存", async () => {
    const png = await makePng(60, 60);
    const up = await uploadService.upload({
      stream: (await import("node:stream")).Readable.from(png),
      originalName: "img.png", declaredMimeType: "image/png", uploaderId: "user-1",
    });
    const res = await app.request(`/api/attachments/${up.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toBeNull(); // image 不强制下载
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBe(up.sizeBytes);
  });

  it("GET：document 强制 attachment 下载（filename* 转义）", async () => {
    const up = await uploadService.upload({
      stream: (await import("node:stream")).Readable.from(Buffer.from("doc content")),
      originalName: "笔记;名.txt", declaredMimeType: "text/plain", uploaderId: "user-2",
    });
    // 清洗语义：';' 不在白名单字符集内，落库名为清洗后的 "笔记名.txt"
    expect(up.originalName).toBe("笔记名.txt");
    const res = await app.request(`/api/attachments/${up.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1] ?? "")).toBe(up.originalName);
    const body = await res.text();
    expect(body).toBe("doc content");
  });

  it("GET：不存在的附件 404", async () => {
    const res = await app.request("/api/attachments/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("sendMessage 附件前置校验 + FTS 时序（R3）", () => {
  let db: Database.Database;
  let attachmentRepo: SqliteAttachmentRepository;
  let convRepo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  let tmpRoot: string;
  let app: Hono;
  let uploadedImageIds: string[] = [];
  let uploadedDocIds: string[] = [];
  let invokeParams: Array<{ images?: unknown[]; content?: string }> = [];

  beforeEach(async () => {
    db = createTestDb();
    attachmentRepo = new SqliteAttachmentRepository(db);
    convRepo = new SqliteConversationRepository(db, createTestLogger());
    otterRepo = new SqliteOtterRepository(db);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "att-send-"));
    uploadedImageIds = [];
    uploadedDocIds = [];
    invokeParams = [];

    // 种子：会话 + 大獭 + participant
    const conv: Conversation = {
      id: "conv-1", title: "测试", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", completedAt: null, archivedAt: null,
    };
    await convRepo.create(conv);
    const otter: Otter = {
      id: "otter-big", name: "大獭", type: "big", status: "active", role: null, parentOtterId: null,
      createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
    };
    await otterRepo.createOtter(otter);
    const p: ConversationParticipant = {
      id: "p-1", conversationId: "conv-1", otterId: "otter-big",
      joinedAtTurnId: null, joinedAtTurnNumber: 0, leftAtTurnId: null, leftAtTurnNumber: null,
      status: "active", createdAt: "2026-01-01T00:00:00Z", leftAt: null,
      lastReadTurnNumber: 0, lastActiveTurnNumber: 0,
    };
    await convRepo.createParticipant(p);
    const turn: Turn = {
      id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await convRepo.createTurn(turn);

    const logger = createTestLogger();
    const uploadService = new AttachmentUploadService(
      attachmentRepo, { storageRoot: tmpRoot, maxImageBytes: 1024 * 1024, maxDocumentBytes: 2 * 1024 * 1024 }, logger,
    );
    const injection = new AttachmentInjectionService({ attachmentRepo, storageRoot: tmpRoot, logger });

    // 真图 ×3（用于超限测试）
    const png = await makePng(100, 100);
    for (let i = 0; i < 3; i++) {
      const att = await uploadService.upload({
        stream: (await import("node:stream")).Readable.from(png),
        originalName: `img${i}.png`, declaredMimeType: "image/png", uploaderId: `seed-${i}`, // 不同 uploader 避免去重
      });
      uploadedImageIds.push(att.id);
    }
    const doc = await uploadService.upload({
      stream: (await import("node:stream")).Readable.from(Buffer.from("文档内容：多模态注入测试")),
      originalName: "spec.txt", declaredMimeType: "text/plain", uploaderId: "doc-seed",
    });
    uploadedDocIds.push(doc.id);

    // stub：memory index（旁路）
    const memoryIndex: MemoryIndexGateway = {
      indexMessage: vi.fn(async () => {}), indexLinkedResource: vi.fn(),
      indexFeature: vi.fn(), indexResearch: vi.fn(), indexFeatureChunks: vi.fn(), indexResearchChunks: vi.fn(),
    };
    const sendMessage = new SendMessage(convRepo, otterRepo, memoryIndex, logger, attachmentRepo);

    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo: convRepo,
      queryMessage: { getMessageById: async () => null, getLastMessageBySender: async () => null } as unknown as QueryMessage,
      queryOtter: { getById: async () => ({ name: "大獭" }) } as unknown as QueryOtter,
      logger: logger as never,
    });
    const agentInvoker = {
      invokeConversation: async (params: { images?: unknown[]; userMessageContent?: string }) => {
        invokeParams.push({ images: params.images, content: params.userMessageContent });
        return { messageId: "otter-msg-1", aggregatedTargets: [] };
      },
    } as unknown as AgentInvoker;

    const messageController = new MessageController(
      sendMessage,
      { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      agentInvoker,
      logger as never,
      { getById: async () => null } as unknown as QueryOtter,
      dispatchChainEngine,
      new MessageBroadcaster(logger) as never,
      injection,
    );

    app = new Hono();
    app.post("/api/conversations/:id/messages", (c) => messageController.sendMessage(c));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function postMessage(attachmentIds?: string[]): Promise<Response> {
    return app.request("/api/conversations/conv-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-big"], body: "看图", ...(attachmentIds && { attachmentIds }) }),
    });
  }

  it("R4 策略归位后仍拒绝 >2 图（400）", async () => {
    const res = await postMessage(uploadedImageIds);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("上限");
    // 请求被拒——不进链
    expect(invokeParams).toHaveLength(0);
  });

  it("R4 ≤2 图通过：真图注入 dispatch 链（base64 ImageContent）", async () => {
    const res = await postMessage(uploadedImageIds.slice(0, 2));
    expect(res.status).toBe(200);
    await res.text(); // 消费 SSE 流
    await new Promise(r => setTimeout(r, 50)); // dispatch 异步启动
    expect(invokeParams.length).toBeGreaterThanOrEqual(1);
    expect(invokeParams[0].images).toHaveLength(2);
    const img = invokeParams[0].images![0] as { type: string; data: string; mimeType: string };
    expect(img.type).toBe("image");
    expect(img.mimeType).toBe("image/png");
    expect(img.data.length).toBeGreaterThan(100); // base64 非空
  });

  it("R9 document 注入（方案 §3.4①）：提取文本拼进当前任务消息", async () => {
    const res = await postMessage(uploadedDocIds);
    expect(res.status).toBe(200);
    await res.text();
    await new Promise(r => setTimeout(r, 50));
    expect(invokeParams.length).toBeGreaterThanOrEqual(1);
    expect(invokeParams[0].content).toContain("看图");
    expect(invokeParams[0].content).toContain("[文件: spec.txt]");
    expect(invokeParams[0].content).toContain("文档内容：多模态注入测试");
    expect(invokeParams[0].images).toBeUndefined(); // 无图附件不注入 images
  });

  it("不存在的 attachmentIds：400", async () => {
    const res = await postMessage(["no-such-id"]);
    expect(res.status).toBe(400);
  });

  it("R3 FTS 时序：带附件消息落库后 messages_fts.body 含附件占位", async () => {
    const res = await postMessage(uploadedImageIds.slice(0, 1));
    expect(res.status).toBe(200);
    await res.text();

    // 直接查 FTS 表（真 sqlite 断言，非 mock）
    const ftsRows = db.prepare(
      "SELECT f.message_id, f.body FROM messages_fts f JOIN messages m ON m.id = f.message_id WHERE m.sender_type = 'user' ORDER BY m.sequence_num DESC LIMIT 1",
    ).all() as Array<{ message_id: string; body: string }>;
    expect(ftsRows).toHaveLength(1);
    expect(ftsRows[0].body).toContain("看图");
    expect(ftsRows[0].body).toContain("[图片: img0.png]");
  });
});
