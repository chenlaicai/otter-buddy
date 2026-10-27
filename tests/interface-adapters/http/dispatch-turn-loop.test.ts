import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { ManageReadState } from "@usecases/conversation/manage-read-state";

function createApp(controller: MessageController): Hono {
  const app = new Hono();
  app.post("/api/conversations/:id/messages", (c) => controller.sendMessage(c));
  return app;
}

function makeLogger() {
  const warns: Array<{ msg: string; data: unknown }> = [];
  return {
    warns,
    logger: {
      info: vi.fn(),
      warn: (msg: string, data: unknown) => { warns.push({ msg, data }); },
      error: vi.fn(), debug: vi.fn(), child: vi.fn(),
    },
  };
}

function makeSendMessageUseCase() {
  const systemBodies: string[] = [];
  const useCase = {
    send: async () => ({ message: { id: "user-msg-1", talkingStonePassedTo: ["otter-x"] } }),
    sendSystem: async (_convId: string, body: string) => {
      systemBodies.push(body);
      return { id: "sys-msg-1", conversationId: _convId, turnId: "turn-1", senderType: "system" as const, senderId: "system", talkingStonePassedTo: [], status: "completed" as const, segments: [{ id: "sys-msg-1-seg-0", messageId: "sys-msg-1", body, sequenceNum: 0, createdAt: "2026-07-16T00:00:00Z" }], sequenceNum: 99, contextTokens: null, contextTokensMax: null, source: null, createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:00Z" };
    },
  };
  const conversationRepo = {
    getUnreadMessages: async () => [],
    getTurnById: async () => null,
    markParticipantLeft: async () => {},
    getLastMessageBySender: async () => null,
    updateLastReadTurnNumber: async () => {},
    updateLastActiveTurnNumber: async () => {},
    getActiveParticipants: async () => [],
  } as unknown as ConversationRepository;
  return { useCase, conversationRepo, systemBodies };
}

const queryOtterStub = { getById: async () => null } as unknown as QueryOtter;
// F20260904schf：行级出处语义下，链引擎从消息行读 yield 目标——stub 按 messageId 返回带 tsp 的行
//（模拟生产事实：completeMessage 先落库 tsp）；「互传死循环」测试意图因此得以保留。
const queryMessageStub = {
  getMessageById: async (id: string) => {
    // F20260904schf：行级出处语义下，链引擎从消息行读 yield 目标（生产事实：completeMessage 先落库 tsp）。
    // 测试意图升级：旧版用「自指 yield」制造死循环（恰是 #792 要杀的病态，自指守卫下已一轮终止），
    // F20261026ctbg：改为一跳互传后自然收尾（合法信号流，无资源形态截断）。
    if (id === "m-otter-x") {
      return { id, conversationId: "conv-1", turnId: "turn-1", senderId: "otter-x", senderType: "otter", status: "completed", segments: [], sequenceNum: 2, talkingStonePassedTo: ["otter-y"], contextTokens: null, contextTokensMax: null, source: "web", senderName: "Otter X", createdAt: "", completedAt: "" };
    }
    if (id === "m-otter-y") {
      return { id, conversationId: "conv-1", turnId: "turn-1", senderId: "otter-y", senderType: "otter", status: "completed", segments: [], sequenceNum: 3, talkingStonePassedTo: ["otter-x"], contextTokens: null, contextTokensMax: null, source: "web", senderName: "Otter Y", createdAt: "", completedAt: "" };
    }
    return null;
  },
} as unknown as QueryMessage;

function postMessage(app: Hono) {
  return app.request("/api/conversations/conv-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-x"], body: "hi" }),
  });
}

describe("dispatchTurnLoop 链调度（F20261026ctbg：资源形态不判死，链由行为护栏或自然结束收束）", () => {
  it("合法互传链自然收尾：全部 hop 派发、无资源停止告警、不发系统消息", async () => {
    const { conversationRepo, systemBodies } = makeSendMessageUseCase();
    const { logger, warns } = makeLogger();
    /** otter-x ↔ otter-y 互传一跳后收尾——合法协作信号流，第 2 跳显式结束 */
    let dispatchCount = 0;
    let receivedBatchMaxSeq: number | undefined;
    const agentInvoker = {
      invokeConversation: async ({ otterId, batchMaxSeq }: { otterId: string; batchMaxSeq?: number }) => {
        dispatchCount++;
        receivedBatchMaxSeq = batchMaxSeq;
        const invokeId = `inv-${otterId}-${dispatchCount}`;
        const next = dispatchCount === 1 ? (otterId === "otter-x" ? ["otter-y"] : ["otter-x"]) : [];
        (agentInvoker as unknown as { _invokeRows: Map<string, unknown> })._invokeRows.set(invokeId, { id: invokeId, status: "completed", otterId, talkingStonePassedTo: next, endedAt: new Date().toISOString() });
        return { invokeId, messageId: invokeId, aggregatedTargets: next, tokenUsageDelta: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    } as unknown as AgentInvoker;

    // F20260913ctlv 彻底切换：hop 产出判定读 invoke 行（tsp = invoke 的交棒目标）
    const invokeRows = new Map<string, { id: string; status: string; otterId: string; talkingStonePassedTo: string[] | null; endedAt: string | null }>();
    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo,
      queryOtter: queryOtterStub,
      logger: logger as never,
      invokeRepo: { getInvokeById: async (id: string) => invokeRows.get(id) ?? null },
      entryRepo: { getEntries: async () => [], getUnreadEntries: async () => [] },
      // F20261014czgd：空批兜底依赖 idleStatsRepo.getMaxEntrySeq——stub 缺失会触发降级 warn，
      // 污染本用例「不发 warn」断言；补 stub 走正常路径（空对话 max(seq)=0）。
      idleStatsRepo: { getMaxEntrySeq: async () => 0, getLastSpeakBySender: async () => new Map(), getLastInvokeStartedAtByOtter: async () => new Map() },
    });
    (agentInvoker as { _invokeRows?: unknown })._invokeRows = invokeRows;

    // 创建 mock broadcaster，捕获 broadcastEvent 调用
    const broadcastEventCalls: Array<{ event: string; data: Record<string, unknown> }> = [];
    const mockBroadcaster = {
      broadcastEvent: (_convId: string, event: { event: string; data: Record<string, unknown> }) => { broadcastEventCalls.push(event); },
      broadcast: async () => {},
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    };

    const sendEntryStub = {
      sendUserEntry: async (input: { conversationId: string; senderId: string; body: string; talkingStonePassedTo?: string[] }) => ({
        entry: { id: "user-entry-1", sequenceNum: 1, body: input.body, createdAt: "2026-07-16T00:00:00Z" },
        talkingStonePassedTo: input.talkingStonePassedTo ?? [],
        mentionFeedback: undefined,
      }),
      createSystemEntry: async (input: { body: string }) => {
        systemBodies.push(input.body);
        return { entry: { id: "sys-entry-1", sequenceNum: 99, body: input.body } };
      },
    };
    const ctrl = new MessageController(
      queryMessageStub,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      agentInvoker,
      logger as never,
      queryOtterStub,
      dispatchChainEngine,
      mockBroadcaster as unknown as MessageBroadcaster,
      undefined,
      undefined,
      undefined,
      sendEntryStub as never,
    );
    const res = await postMessage(createApp(ctrl));
    const sseText = await res.text();

    /** 两跳全部派发（x→y）后自然收尾：无资源形态停止、无停止系统消息 */
    expect(dispatchCount).toBe(2);
    // F20260922ctxi：dispatchTurnLoop 闭包必须透传 batchMaxSeq（修复前漏传 → pushCursorOnStartup
    // 拿不到批次游标永不推进 → 已注入的未读下轮重复注入；实测 retry 路径重复 ⏳✅ 两条系统条目）
    expect(receivedBatchMaxSeq).not.toBeUndefined();
    expect(warns).toHaveLength(0);
    expect(systemBodies).toHaveLength(0);
    expect(broadcastEventCalls.some(e => e.event === "entry.system")).toBe(false);
    expect(sseText).toContain("stream.end");
  });

  it("发言石无目标时正常结束，不发系统消息", async () => {
    const { conversationRepo, systemBodies } = makeSendMessageUseCase();
    const { logger, warns } = makeLogger();
    let dispatchCount = 0;
    const agentInvoker = {
      invokeConversation: async ({ otterId }: { otterId: string }) => {
        dispatchCount++;
        // F20261026ctbg：补真实形态的 token 计量 delta——无 delta 会被判 telemetry 缺口（仅观测告警，
        //  但污染本用例「零 warn」断言；真实 invokeFn 总是返回 usage）
        return { messageId: `m-${otterId}`, aggregatedTargets: [], tokenUsageDelta: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    } as unknown as AgentInvoker;

    // F20260904schf：本测试场景 = 消息行无行级 yield → 链一轮终止。
    // 不能与触顶测试共享带互传 tsp 的 stub（那会让本场景变 2 跳，测试失真）。
    const noYieldMessageStub = { getMessageById: async () => null } as unknown as QueryMessage;
    // F20260913ctlv 彻底切换：invoke 行无 tsp（无 yield）→ 链一轮终止
    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo,
      queryOtter: queryOtterStub,
      logger: logger as never,

      invokeRepo: { getInvokeById: async () => ({ id: "inv-1", status: "completed", otterId: "otter-x", talkingStonePassedTo: [], endedAt: new Date().toISOString() }) },
      entryRepo: { getEntries: async () => [], getUnreadEntries: async () => [] },
      // F20261014czgd：空批兜底依赖 idleStatsRepo.getMaxEntrySeq——stub 缺失会触发降级 warn，
      // 污染本用例「不发 warn」断言；补 stub 走正常路径（空对话 max(seq)=0）。
      idleStatsRepo: { getMaxEntrySeq: async () => 0, getLastSpeakBySender: async () => new Map(), getLastInvokeStartedAtByOtter: async () => new Map() },
    });

    const sendEntryStub2 = {
      sendUserEntry: async (input: { conversationId: string; senderId: string; body: string; talkingStonePassedTo?: string[] }) => ({
        entry: { id: "user-entry-2", sequenceNum: 1, body: input.body, createdAt: "2026-07-16T00:00:00Z" },
        talkingStonePassedTo: input.talkingStonePassedTo ?? [],
        mentionFeedback: undefined,
      }),
      createSystemEntry: async () => ({ entry: { id: "sys-entry-2", sequenceNum: 2 } }),
    };
    const ctrl = new MessageController(
      noYieldMessageStub,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      agentInvoker,
      logger as never,
      queryOtterStub,
      dispatchChainEngine,
      undefined,
      undefined,
      undefined,
      undefined,
      sendEntryStub2 as never,
    );
    const res = await postMessage(createApp(ctrl));
    await res.text();
    await new Promise(r => setTimeout(r, 50));

    expect(dispatchCount).toBe(1);
    expect(systemBodies).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it("派发上下文包含在场成员名册与具名历史", async () => {
    const { conversationRepo } = makeSendMessageUseCase();
    conversationRepo.getActiveParticipants = async () => [
      { otterId: "otter-x" },
    ] as never;
    const { logger } = makeLogger();
    const queryOtter = { getById: async () => ({ name: "小獭" }) } as unknown as QueryOtter;

    const contexts: string[] = [];
    const agentInvoker = {
      invokeConversation: async ({ userMessageContent }: { userMessageContent: string }) => {
        contexts.push(userMessageContent);
        return { messageId: "m-1", aggregatedTargets: [] };
      },
    } as unknown as AgentInvoker;

    // F20260913ctlv 彻底切换：未读注入读 entries（user/speak/system 条目）
    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo,
      queryOtter,
      logger: logger as never,

      invokeRepo: { getInvokeById: async () => ({ id: "inv-1", status: "completed", otterId: "otter-x", talkingStonePassedTo: [], endedAt: new Date().toISOString() }) },
      entryRepo: {
        getEntries: async () => [],
        getUnreadEntries: async () => [
          { id: "e-1", entryType: "speak", senderType: "otter", senderId: "otter-x", senderName: "Test Otter", body: "万象更新", sequenceNum: 1, invokeId: null, yieldTargets: null },
        ],
      },
    });

    const sendEntryStub3 = {
      sendUserEntry: async (input: { conversationId: string; senderId: string; body: string; talkingStonePassedTo?: string[] }) => ({
        entry: { id: "user-entry-3", sequenceNum: 1, body: input.body, createdAt: "2026-07-16T00:00:00Z" },
        talkingStonePassedTo: input.talkingStonePassedTo ?? [],
        mentionFeedback: undefined,
      }),
      createSystemEntry: async () => ({ entry: { id: "sys-entry-3", sequenceNum: 2 } }),
    };
    const ctrl = new MessageController(
      queryMessageStub,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      agentInvoker,
      logger as never,
      queryOtter,
      dispatchChainEngine,
      undefined,
      undefined,
      undefined,
      undefined,
      sendEntryStub3 as never,
    );
    const res = await postMessage(createApp(ctrl));
    await res.text();
    await new Promise(r => setTimeout(r, 50));

    expect(contexts).toHaveLength(1);
    /** 名册：name 映射在场（F20260803trrf: 去 otterId，speak 改用名字） */
    expect(contexts[0]).toContain("## 在场成员");
    expect(contexts[0]).toContain("- 小獭");
    expect(contexts[0]).not.toContain("otterId:");
    expect(contexts[0]).toContain("'user'");
    /** 历史消息用名字标注，不用 UUID（时间戳形态：[名字]（时间）text，#1431） */
    expect(contexts[0]).toMatch(/\[小獭\]（[^）]*）万象更新/);
    expect(contexts[0]).not.toContain("[otter-x]");
  });
});
