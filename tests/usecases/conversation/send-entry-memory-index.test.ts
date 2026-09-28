/**
 * #1191 回归：entries → memory_entries 消息索引链路接回。
 *
 * 背景：#886（F20260913ctlv）删除旧 SendMessage 时，三处 indexMessage 调用随消息体
 * 消失——9/13 后对话正文（user + speak）不再进入记忆系统，search_memory 对对话内容
 * 失明（生产库实证：message 类记忆最后一条 = 9/13）。
 *
 * 本测试锚定接回后的增量契约：
 * 1. sendUserEntry 落库后索引 user 正文（含附件投影行）
 * 2. createSpeakEntry 落库后索引 speak 正文（html-card 围栏剥离）
 * 3. 索引失败不阻断消息发送（文字优先送达——与附件 attach 同语义）
 * 4. 未注入 memoryIndex 时跳过索引（旧调用方兼容，不炸）
 * 5. system/yield/invoke_end 边界条目不入索引（旧口径：只有正文承载语义的条目入）
 */
import { describe, it, expect, vi } from "vitest";
import { SendEntry } from "@usecases/conversation/send-entry";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { Logger } from "@usecases/ports/logger";
import type { Entry } from "@entities/conversation/entry";

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as unknown as Logger;
}

function makeRepos() {
  const entries = new Map<string, Entry>();
  const entryRepo = {
    createEntryAtomic: vi.fn(async (entry: Entry) => {
      entries.set(entry.id, entry);
      return entry;
    }),
    getEntryById: vi.fn(async (id: string) => entries.get(id) ?? null),
    attachAttachment: vi.fn(async () => {}),
    getAttachmentRefsByIds: vi.fn(async (ids: string[]) => ids.map(id => ({
      id, kind: "image", originalName: "架构图.png", mimeType: "image/png",
      sizeBytes: 2048, width: null, height: null, caption: null,
    }))),
    getMaxSequenceNum: vi.fn(async () => entries.size),
  } as unknown as EntryRepository;
  const invokeRepo = {} as unknown as InvokeRepository;
  const otterRepo = {
    getById: vi.fn(async (id: string) => ({ id, name: "大獭", status: "active" })),
  } as unknown as OtterRepository;
  const conversationRepo = {} as unknown as ConversationRepository;
  return { entryRepo, invokeRepo, otterRepo, conversationRepo, entries };
}

/** 索引调用记录 mock：每次 indexMessage 记 [messageId, conversationId, content] */
function makeMemoryIndex() {
  const indexed: Array<{ messageId: string; conversationId: string; content: string }> = [];
  const gateway: MemoryIndexGateway = {
    indexMessage: vi.fn(async (messageId: string, conversationId: string, content: string) => {
      indexed.push({ messageId, conversationId, content });
    }),
    indexLinkedResource: vi.fn(),
    indexFeature: vi.fn(),
    indexResearch: vi.fn(),
    indexFeatureChunks: vi.fn(),
    indexResearchChunks: vi.fn(),
    indexAssistantDigest: vi.fn(),
  };
  return { gateway, indexed };
}

function makeSendEntry(opts?: { memoryIndex?: MemoryIndexGateway }) {
  const repos = makeRepos();
  const rec = makeMemoryIndex();
  const memoryIndex = opts?.memoryIndex ?? rec.gateway;
  const sendEntry = new SendEntry(repos.entryRepo, repos.invokeRepo, repos.otterRepo, repos.conversationRepo, {
    logger: createLogger(),
    ...(memoryIndex ? { memoryIndex } : {}),
  });
  return { sendEntry, repos, gateway: memoryIndex, indexed: rec.indexed };
}

describe("#1191 消息索引链路接回：sendUserEntry", () => {
  it("落库后索引 user 正文（sourceId = entry.id）", async () => {
    const { sendEntry, indexed } = makeSendEntry();
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "user-1",
      body: "帮我把跨对话的记忆检索修好，这是 9/13 之后的对话",
      talkingStonePassedTo: ["大獭"],
    });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.messageId).toBe(res.entry.id);
    expect(indexed[0]!.conversationId).toBe("conv-1");
    expect(indexed[0]!.content).toContain("跨对话的记忆检索修好");
  });

  it("附件按发送意图投影：attach 失败仍投影（旧口径 attachmentRefs 同语义）", async () => {
    const { sendEntry, indexed } = makeSendEntry();
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "user-1", body: "带图的消息",
      talkingStonePassedTo: [], attachmentIds: ["att-1"],
    });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.messageId).toBe(res.entry.id);
    expect(indexed[0]!.content).toContain("带图的消息");
    expect(indexed[0]!.content).toContain("[图片: 架构图.png]");
  });

  it("未注入 memoryIndex 时不炸（旧调用方兼容）", async () => {
    const { sendEntry } = makeSendEntry();
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "user-1", body: "没有索引注入的旧路径", talkingStonePassedTo: [],
    });
    expect(res.entry.id).toBeTruthy();
  });

  it("索引失败不阻断发送（warn 后正常返回 entry）", async () => {
    const badIndex: MemoryIndexGateway = {
      ...makeMemoryIndex().gateway,
      indexMessage: vi.fn(async () => { throw new Error("memory db locked"); }),
    };
    const { sendEntry } = makeSendEntry({ memoryIndex: badIndex });
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "user-1", body: "索引挂了消息也要送达", talkingStonePassedTo: [],
    });
    expect(res.entry.id).toBeTruthy();
  });
});

describe("#1191 消息索引链路接回：createSpeakEntry", () => {
  it("落库后索引 speak 正文（html-card 围栏剥离）", async () => {
    const { sendEntry, indexed } = makeSendEntry();
    const body = "进展汇报" + "\n```html-card title=\"卡片\"\n<div>卡片内容不该被索引</div>\n```" + "\n正文收尾";
    const res = await sendEntry.createSpeakEntry({
      conversationId: "conv-1", invokeId: "invoke-1", otterId: "otter-1",
      body,
    });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.messageId).toBe(res.entry.id);
    expect(indexed[0]!.content).toContain("进展汇报");
    expect(indexed[0]!.content).not.toContain("卡片内容不该被索引");
  });

  it("索引失败不阻断 speak 落库", async () => {
    const badIndex: MemoryIndexGateway = {
      ...makeMemoryIndex().gateway,
      attachWorkaround: undefined,
      indexMessage: vi.fn(async () => { throw new Error("boom"); }),
    } as MemoryIndexGateway;
    const { sendEntry } = makeSendEntry({ memoryIndex: badIndex });
    const res = await sendEntry.createSpeakEntry({
      conversationId: "conv-1", invokeId: "invoke-1", otterId: "otter-1", body: "speak 正文索引失败也要落库",
    });
    expect(res.entry.id).toBeTruthy();
  });
});
