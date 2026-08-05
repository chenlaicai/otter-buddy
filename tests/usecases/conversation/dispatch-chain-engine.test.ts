import { describe, it, expect, vi } from "vitest";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Turn } from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return { id: "turn-1", conversationId: "conv-1", turnNumber: 5, status: "closed", createdAt: "", closedAt: null, ...overrides };
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "m-1", conversationId: "conv-1", turnId: "turn-1", senderId: "otter-1",
    senderType: "otter", status: "completed", body: "hi", sequenceNum: 1,
    talkingStonePassedTo: [], contextTokens: null, contextTokensMax: null,
    source: "web", createdAt: "", completedAt: "",
    ...overrides,
  };
}

function makeMocks() {
  const updateLastReadTurnNumber = vi.fn().mockResolvedValue(undefined);
  const getTurnById = vi.fn().mockResolvedValue(makeTurn());
  const getMessageById = vi.fn().mockResolvedValue(makeMsg());
  const getLastMessageBySender = vi.fn().mockResolvedValue(makeMsg());
  const getActiveTurn = vi.fn().mockResolvedValue(null);

  const conversationRepo = {
    getActiveParticipants: vi.fn().mockResolvedValue([]),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getTurnById, updateLastReadTurnNumber, getLastMessageBySender,
    getActiveTurn, getMessageById,
    getParticipant: vi.fn().mockResolvedValue(null),
  } as unknown as ConversationRepository;

  const sendMessage = {} as unknown as SendMessage;
  const queryMessage = { getMessageById, getLastMessageBySender } as unknown as QueryMessage;
  const queryOtter = { getById: vi.fn().mockResolvedValue(null) } as unknown as QueryOtter;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  return { sendMessage, conversationRepo, queryMessage, queryOtter, logger, updateLastReadTurnNumber, getTurnById, getMessageById, getLastMessageBySender, getActiveTurn };
}

/** 提取 mock 首次调用的参数（避免 toHaveBeenCalledWith 绑定实现细节的 lint 规则） */
function firstCallArgs(fn: ReturnType<typeof vi.fn>): unknown[] {
  return (fn.mock.calls[0] as unknown[]) ?? [];
}

describe("DispatchChainEngine markBatchRead（F20260803trrf: 时序修复）", () => {
  it("fulfilled 结果：turn 已关闭时仍用 turnId 反查推进 last_read", async () => {
    const m = makeMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-1"],
      invokeFn: async () => ({ messageId: "m-1" }),
    });

    /** 核心修复点：不依赖 getActiveTurn（turn 已关闭返回 null） */
    expect(m.getActiveTurn).not.toHaveBeenCalled();
    expect(m.getTurnById).toHaveBeenCalled();
    expect(m.updateLastReadTurnNumber).toHaveBeenCalled();
    const [convId, otterId, turnNum] = firstCallArgs(m.updateLastReadTurnNumber);
    expect([convId, otterId, turnNum]).toEqual(["conv-1", "otter-1", 5]);
  });

  it("rejected 结果：用 getLastMessageBySender 反查仍推进 last_read", async () => {
    const m = makeMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-1"],
      invokeFn: async () => { throw new Error("invoke failed"); },
    });

    expect(m.getLastMessageBySender).toHaveBeenCalled();
    const [rConvId, rOtterId] = firstCallArgs(m.getLastMessageBySender);
    expect([rConvId, rOtterId]).toEqual(["conv-1", "otter-1"]);
    expect(m.updateLastReadTurnNumber).toHaveBeenCalled();
  });

  it("getTurnById 返回 null 时不推进（防御性）", async () => {
    const m = makeMocks();
    m.getTurnById.mockResolvedValue(null);
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-1"],
      invokeFn: async () => ({ messageId: "m-1" }),
    });

    expect(m.updateLastReadTurnNumber).not.toHaveBeenCalled();
  });

  it("多 targets：各自 last_read 独立推进到自己的 turn", async () => {
    const m = makeMocks();
    m.getMessageById.mockImplementation(async (id: string) => {
      if (id === "m-1") return makeMsg({ id: "m-1", senderId: "otter-1", turnId: "turn-1" });
      if (id === "m-2") return makeMsg({ id: "m-2", senderId: "otter-2", turnId: "turn-2" });
      return null;
    });
    m.getTurnById.mockImplementation(async (turnId: string) => {
      if (turnId === "turn-1") return makeTurn({ id: "turn-1", turnNumber: 5 });
      if (turnId === "turn-2") return makeTurn({ id: "turn-2", turnNumber: 7 });
      return null;
    });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-1", "otter-2"],
      invokeFn: async ({ otterId }) => ({ messageId: otterId === "otter-1" ? "m-1" : "m-2" }),
    });

    const calls = m.updateLastReadTurnNumber.mock.calls as Array<[string, string, number]>;
    expect(calls).toHaveLength(2);
    const byOtter = new Map(calls.map(([, otterId, turnNum]) => [otterId, turnNum]));
    expect(byOtter.get("otter-1")).toBe(5);
    expect(byOtter.get("otter-2")).toBe(7);
  });
});
