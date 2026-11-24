import { describe, it, expect, vi } from "vitest";
import { SendEntry } from "@usecases/conversation/send-entry";
import type { CreateEntryOptions, EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Logger } from "@usecases/ports/logger";
import type { Entry } from "@entities/conversation/entry";

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as unknown as Logger;
}

function makeRepos() {
  const entries = new Map<string, Entry>();
  const outbox = new Map<string, { attachmentIntentIds: string[] }>();
  const entryRepo = {
    createEntryAtomic: vi.fn(async (entry: Entry, options?: CreateEntryOptions) => {
      entries.set(entry.id, entry);
      if (entry.entryType === "user" || entry.entryType === "speak") {
        outbox.set(entry.id, { attachmentIntentIds: options?.attachmentIntentIds ?? [] });
      }
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
  const invokes = new Map<string, { metadata?: Record<string, unknown> }>();
  const invokeRepo = {
    getInvokeById: vi.fn(async (id: string) => invokes.get(id) ?? null),
  } as unknown as InvokeRepository;
  const otterRepo = {
    getById: vi.fn(async (id: string) => ({ id, name: "大獭", status: "active" })),
  } as unknown as OtterRepository;
  const conversationRepo = {
    getById: vi.fn(async (id: string) => ({ id, kind: id === "conv-colink" ? "external" : "normal" })),
  } as unknown as ConversationRepository;
  return { entryRepo, invokeRepo, otterRepo, conversationRepo, entries, invokes, outbox };
}

function makeSendEntry(opts?: {
  onEntryProjectionEnqueued?: (entryId: string) => void;
  unfurlPrefetch?: (urls: string[]) => void;
}) {
  const repos = makeRepos();
  const sendEntry = new SendEntry(repos.entryRepo, repos.invokeRepo, repos.otterRepo, repos.conversationRepo, {
    logger: createLogger(),
    ...(opts?.onEntryProjectionEnqueued ? { onEntryProjectionEnqueued: opts.onEntryProjectionEnqueued } : {}),
    ...(opts?.unfurlPrefetch ? { unfurlPrefetch: opts.unfurlPrefetch } : {}),
  });
  return { sendEntry, repos };
}

describe("user entry durable projection", () => {
  it("persists the entry and attachment intent before worker delivery", async () => {
    const { sendEntry, repos } = makeSendEntry();
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "user-1",
      body: "帮我把跨对话的记忆检索修好，这是新对话",
      talkingStonePassedTo: ["大獭"], attachmentIds: ["att-1"],
    });
    expect(repos.entries.get(res.entry.id)?.body).toContain("跨对话的记忆检索修好");
    expect(repos.outbox.get(res.entry.id)).toEqual({ attachmentIntentIds: ["att-1"] });
  });

  it("keeps attachment intent when display attachment binding fails", async () => {
    const { sendEntry, repos } = makeSendEntry();
    (repos.entryRepo.attachAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("attach db locked"));
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "user-1", body: "带图的消息",
      talkingStonePassedTo: [], attachmentIds: ["att-1"],
    });
    expect(res.entry.id).toBeTruthy();
    expect(repos.outbox.get(res.entry.id)).toEqual({ attachmentIntentIds: ["att-1"] });
  });

  it("does not require an in-process worker callback", async () => {
    const { sendEntry, repos } = makeSendEntry();
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "user-1", body: "启动窗口持久消息", talkingStonePassedTo: [],
    });
    expect(repos.outbox.has(res.entry.id)).toBe(true);
  });

  it("keeps sending when the worker trigger fails", async () => {
    const { sendEntry, repos } = makeSendEntry({
      onEntryProjectionEnqueued: () => { throw new Error("worker unavailable"); },
    });
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "user-1", body: "触发失败也不能丢消息", talkingStonePassedTo: [],
    });
    expect(res.entry.id).toBeTruthy();
    expect(repos.outbox.has(res.entry.id)).toBe(true);
  });
});

describe("external entry isolation handoff", () => {
  it("persists external user entries for policy-driven skipped delivery", async () => {
    const { sendEntry, repos } = makeSendEntry();
    const res = await sendEntry.sendUserEntry({
      conversationId: "conv-colink", senderId: "external:user-1", body: "频道里的秘密不能进全局记忆",
      talkingStonePassedTo: [], source: "external",
    });
    expect(res.entry.source).toBe("external");
    expect(repos.outbox.has(res.entry.id)).toBe(true);
  });

  it("persists restricted speak entries for policy-driven skipped delivery", async () => {
    const { sendEntry, repos } = makeSendEntry();
    repos.invokes.set("invoke-colink", { metadata: { externalProfile: "restricted" } });
    const res = await sendEntry.createSpeakEntry({
      conversationId: "conv-colink", invokeId: "invoke-colink", otterId: "otter-1", body: "外部回复同样隔离",
    });
    expect(res.entry.source).toBe("external");
    expect(repos.outbox.has(res.entry.id)).toBe(true);
  });

  it("does not prefetch bare URLs from external user or speak entries", async () => {
    const prefetched: string[][] = [];
    const { sendEntry, repos } = makeSendEntry({ unfurlPrefetch: urls => prefetched.push(urls) });
    await sendEntry.sendUserEntry({
      conversationId: "conv-colink", senderId: "external:user-1", body: "https://example.com/private",
      talkingStonePassedTo: [], source: "external",
    });
    repos.invokes.set("invoke-colink", { metadata: { externalProfile: "restricted" } });
    await sendEntry.createSpeakEntry({
      conversationId: "conv-colink", invokeId: "invoke-colink", otterId: "otter-1", body: "https://example.com/reply",
    });
    expect(prefetched).toEqual([]);
  });

  it("rejects forbidden external yield targets before persistence", async () => {
    const { sendEntry, repos } = makeSendEntry();
    repos.invokes.set("invoke-colink", { metadata: { externalProfile: "restricted" } });
    for (const input of [
      { yieldTargets: ["another-otter"] },
      { yieldTargets: ["user"], assignmentRole: "reviewer" as const },
    ]) {
      await expect(sendEntry.createYieldEntry({
        conversationId: "conv-colink", invokeId: "invoke-colink", otterId: "otter-1", ...input,
      })).rejects.toMatchObject({ kind: "forbidden" });
    }
    expect(repos.entries.size).toBe(0);
  });
});

describe("speak entry durable projection", () => {
  it("persists original speak source for the shared policy to strip cards", async () => {
    const { sendEntry, repos } = makeSendEntry();
    const body = "进展汇报" + "\n```html-card title=\"卡片\"\n<div>卡片内容不该被索引</div>\n```" + "\n正文收尾";
    const res = await sendEntry.createSpeakEntry({
      conversationId: "conv-1", invokeId: "invoke-1", otterId: "otter-1", body,
    });
    expect(repos.entries.get(res.entry.id)?.body).toBe(body);
    expect(repos.outbox.has(res.entry.id)).toBe(true);
  });

  it("keeps speak persistence when the worker trigger fails", async () => {
    const { sendEntry, repos } = makeSendEntry({
      onEntryProjectionEnqueued: () => { throw new Error("boom"); },
    });
    const res = await sendEntry.createSpeakEntry({
      conversationId: "conv-1", invokeId: "invoke-1", otterId: "otter-1", body: "speak 正文触发失败也要落库",
    });
    expect(res.entry.id).toBeTruthy();
    expect(repos.outbox.has(res.entry.id)).toBe(true);
  });
});
