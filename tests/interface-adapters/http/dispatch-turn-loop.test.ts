import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { SendMessage } from "@usecases/conversation/send-message";
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
    send: async () => ({ id: "user-msg-1", talkingStonePassedTo: ["otter-x"] }),
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
    getActiveTurn: async () => null,
    updateLastReadTurnNumber: async () => {},
    updateLastActiveTurnNumber: async () => {},
    getActiveParticipants: async () => [],
  } as unknown as ConversationRepository;
  return { useCase, conversationRepo, systemBodies };
}

const queryOtterStub = { getById: async () => null } as unknown as QueryOtter;
const queryMessageStub = { getMessageById: async () => null } as unknown as QueryMessage;

function postMessage(app: Hono) {
  return app.request("/api/conversations/conv-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-x"], body: "hi" }),
  });
}

describe("dispatchTurnLoop 深度上限", () => {
  it("触顶时停止派发、warn 日志、sendSystem 并推 system.message", async () => {
    const { useCase, conversationRepo, systemBodies } = makeSendMessageUseCase();
    const { logger, warns } = makeLogger();
    /** 发言石永远互传 → 死循环，必须由 maxChainDepth 截断 */
    let dispatchCount = 0;
    const agentInvoker = {
      invokeConversation: async ({ otterId }: { otterId: string }) => {
        dispatchCount++;
        return { messageId: `m-${otterId}`, aggregatedTargets: ["otter-x"] };
      },
    } as unknown as AgentInvoker;

    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo,
      queryMessage: queryMessageStub,
      queryOtter: queryOtterStub,
      logger: logger as never,
      maxChainDepth: 2,
    });

    // 创建 mock broadcaster，捕获 broadcastEvent 调用
    const broadcastEventCalls: Array<{ event: string; data: Record<string, unknown> }> = [];
    const mockBroadcaster = {
      broadcastEvent: (_convId: string, event: { event: string; data: Record<string, unknown> }) => { broadcastEventCalls.push(event); },
      broadcast: async () => {},
      subscribe: () => () => {},
    };

    const ctrl = new MessageController(
      useCase as unknown as SendMessage,
      queryMessageStub,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      agentInvoker,
      logger as never,
      queryOtterStub,
      dispatchChainEngine,
      mockBroadcaster as unknown as MessageBroadcaster,
    );
    const res = await postMessage(createApp(ctrl));
    const sseText = await res.text();

    /** depth=2：只派发 2 跳，第 3 跳被截断 */
    expect(dispatchCount).toBe(2);
    // DispatchChainEngine 和 MessageController 都会记录 warn 日志
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const depthWarn = warns.find(w => w.msg === "发言链达到深度上限，交还用户");
    expect(depthWarn).toBeDefined();
    expect(depthWarn!.data).toMatchObject({ depth: 2, pendingTargets: ["otter-x"] });
    expect(systemBodies).toHaveLength(1);
    expect(systemBodies[0]).toContain("2 跳");
    // system.message 现在通过 broadcastEvent 推送（不在 POST SSE 流中）
    expect(broadcastEventCalls.some(e => e.event === "system.message")).toBe(true);
    expect(sseText).toContain("stream.end");
  });

  it("发言石无目标时正常结束，不发系统消息", async () => {
    const { useCase, conversationRepo, systemBodies } = makeSendMessageUseCase();
    const { logger, warns } = makeLogger();
    let dispatchCount = 0;
    const agentInvoker = {
      invokeConversation: async ({ otterId }: { otterId: string }) => {
        dispatchCount++;
        return { messageId: `m-${otterId}`, aggregatedTargets: [] };
      },
    } as unknown as AgentInvoker;

    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo,
      queryMessage: queryMessageStub,
      queryOtter: queryOtterStub,
      logger: logger as never,
      maxChainDepth: 2,
    });

    const ctrl = new MessageController(
      useCase as unknown as SendMessage,
      queryMessageStub,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      agentInvoker,
      logger as never,
      queryOtterStub,
      dispatchChainEngine,
    );
    const res = await postMessage(createApp(ctrl));
    await res.text();

    expect(dispatchCount).toBe(1);
    expect(systemBodies).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it("派发上下文包含在场成员名册与具名历史", async () => {
    const { useCase, conversationRepo } = makeSendMessageUseCase();
    conversationRepo.getActiveParticipants = async () => [
      { otterId: "otter-x" },
    ] as never;
    conversationRepo.getUnreadMessages = async () => [
      { senderType: "otter", senderId: "otter-x", segments: [{ id: "seg-1", messageId: "msg-1", body: "万象更新", sequenceNum: 0, createdAt: "2026-07-16T00:00:00Z" }] },
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

    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo,
      queryMessage: queryMessageStub,
      queryOtter,
      logger: logger as never,
      maxChainDepth: 2,
    });

    const ctrl = new MessageController(
      useCase as unknown as SendMessage,
      queryMessageStub,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      agentInvoker,
      logger as never,
      queryOtter,
      dispatchChainEngine,
    );
    const res = await postMessage(createApp(ctrl));
    await res.text();

    expect(contexts).toHaveLength(1);
    /** 名册：name 映射在场（F20260803trrf: 去 otterId，speak 改用名字） */
    expect(contexts[0]).toContain("## 在场成员");
    expect(contexts[0]).toContain("- 小獭");
    expect(contexts[0]).not.toContain("otterId:");
    expect(contexts[0]).toContain("'user'");
    /** 历史消息用名字标注，不用 UUID */
    expect(contexts[0]).toContain("[小獭] 万象更新");
    expect(contexts[0]).not.toContain("[otter-x]");
  });
});
