/**
 * F20260913ctlv 补漏回归：sendUserEntry 的点火依据落库测试。
 *
 * test09 阻断问题回归锚：user entry 必须把解析后的 talkingStonePassedTo 写进
 * entry.yieldTargets——信号路由（SignalRouter.loadSignalView）读此字段点火。
 * 上轮切换只把 tsp 放在返回值，没落 entry → 路由器读 messages 查不到 → 大獭无反应。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SendEntry } from "@usecases/conversation/send-entry";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Logger } from "@usecases/ports/logger";
import type { Entry } from "@entities/conversation/entry";
import type { ResolveTargetsDeps } from "@usecases/conversation/resolve-send-targets";

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
    attachAttachment: vi.fn(async (entryId: string, attachmentId: string) => {
      const e = entries.get(entryId);
      if (e) e.attachments = [...(e.attachments ?? []), { id: attachmentId, kind: "image", originalName: "a.png", mimeType: "image/png", sizeBytes: 1, width: null, height: null, caption: null }];
    }),
    getEntriesByTurnId: vi.fn(async () => [...entries.values()]),
    updateEntryMetadata: vi.fn(async () => {}),
    getMaxSequenceNum: vi.fn(async () => entries.size),
  } as unknown as EntryRepository;
  const invokeRepo = {
    getInvokesByTurnId: vi.fn(async () => []),
  } as unknown as InvokeRepository;
  const otterRepo = {
    getById: vi.fn(async (id: string) => ({ id, name: "大獭", status: "active" })),
  } as unknown as OtterRepository;
  const conversationRepo = {
    getActiveTurn: vi.fn(async () => ({ id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "active", createdAt: "", closedAt: null })),
    closeTurn: vi.fn(async () => {}),
  } as unknown as ConversationRepository;
  return { entryRepo, invokeRepo, otterRepo, conversationRepo, entries };
}

function makeSendEntry(resolveDeps?: ResolveTargetsDeps) {
  const repos = makeRepos();
  const sendEntry = new SendEntry(repos.entryRepo, repos.invokeRepo, repos.otterRepo, repos.conversationRepo, {
    logger: createLogger(),
    ...(resolveDeps ? { resolveDeps } : {}),
  });
  return { sendEntry, repos };
}

/** 终审修复测试用：独立实例（避免与上例 mock 状态串扰） */
function makeRepos2() {
  return makeSendEntry();
}

describe("sendUserEntry 点火依据落库（F20260913ctlv 补漏）", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("显式目标落 entry.yieldTargets（信号路由点火依据）", async () => {
    const { sendEntry, repos } = makeSendEntry();
    const { entry, talkingStonePassedTo } = await sendEntry.sendUserEntry({
      conversationId: "conv-1",
      senderId: "user-1",
      body: "hi",
      source: "web",
      talkingStonePassedTo: ["otter-big"],
    });

    expect(talkingStonePassedTo).toEqual(["otter-big"]);
    // 落库的 entry 必须携带点火目标（test09 回归锚）
    expect(entry.yieldTargets).toEqual(["otter-big"]);
    expect(repos.entries.get(entry.id)?.yieldTargets).toEqual(["otter-big"]);
  });
  it("F20260913ctlv 终审修复：attachmentIds 下沉 attach + 重查返回带投影（IM 路径附件不再悬空）", async () => {
    const { sendEntry, repos } = makeSendEntry();
    const { entry } = await sendEntry.sendUserEntry({
      conversationId: "conv-1",
      senderId: "user-1",
      body: "带图",
      source: "feishu",
      talkingStonePassedTo: ["otter-big"],
      attachmentIds: ["att-1", "att-2"],
    });

    // attach 被调用（每个附件一次，带序号语义由 repo 承载）
    expect(repos.entryRepo.attachAttachment).toHaveBeenCalled();
    // 返回的 entry 重查后带 attachments 投影（SSE 载荷数据源）
    expect(entry.attachments?.map(a => a.id)).toEqual(["att-1", "att-2"]);
  });

  it("F20260913ctlv 终审修复：无附件时不重查（返回原子创建结果）", async () => {
    const { sendEntry } = makeRepos2();
    const { entry } = await sendEntry.sendUserEntry({
      conversationId: "conv-1",
      senderId: "user-1",
      body: "纯文本",
      source: "web",
    });
    expect(entry.attachments).toBeUndefined();
  });


  it("无显式目标 + resolveDeps 注入 → 解析结果同样落 entry.yieldTargets", async () => {
    const resolveDeps = {
      getActiveParticipants: async () => [{ otterId: "otter-big" }],
      getOtterById: async (id: string) => ({ id, status: "active", name: "大獭", type: "big" }),
      getLastSpeakEntry: async () => ({ senderId: "otter-big" }),
      getRecentSpeakSenders: async () => ["otter-big"],
      getRunningOtterIds: async () => [],
    };
    const { sendEntry, repos } = makeSendEntry(resolveDeps);
    const { entry } = await sendEntry.sendUserEntry({
      conversationId: "conv-1",
      senderId: "user-1",
      body: "在吗",
      source: "web",
      talkingStonePassedTo: [],
    });

    // 默认派发链解析出目标（最后发言獭）并落库
    expect(entry.yieldTargets).toBeTruthy();
    expect(entry.yieldTargets!.length).toBeGreaterThan(0);
    expect(repos.entries.get(entry.id)?.yieldTargets).toEqual(entry.yieldTargets);
  });

  it("空目标（无 resolveDeps 且显式为空）→ yieldTargets 为空数组（可容忍：默认派发兜底前）", async () => {
    const { sendEntry } = makeSendEntry();
    const { entry } = await sendEntry.sendUserEntry({
      conversationId: "conv-1",
      senderId: "user-1",
      body: "hi",
      source: "web",
      talkingStonePassedTo: [],
    });
    expect(entry.yieldTargets).toEqual([]);
  });
});
