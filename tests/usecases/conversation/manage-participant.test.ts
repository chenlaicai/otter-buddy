import { describe, it, expect, vi } from "vitest";
import { ManageParticipant } from "@usecases/conversation/manage-participant";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { Turn, ConversationParticipant } from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
import type { Otter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";

/** 创建活跃 Turn */
function mockTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    conversationId: "conv-1",
    turnNumber: 1,
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

/** 创建参与者实体 */
function mockParticipant(overrides: Partial<ConversationParticipant> = {}): ConversationParticipant {
  return {
    id: "participant-1",
    conversationId: "conv-1",
    otterId: "otter-1",
    joinedAtTurnId: "turn-1",
    joinedAtTurnNumber: 1,
    leftAtTurnId: null,
    leftAtTurnNumber: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    leftAt: null,
    ...overrides,
  };
}

/** 创建 Otter 实体 */
function mockOtter(overrides: Partial<Otter> = {}): Otter {
  return {
    id: "otter-1",
    name: "小獭",
    type: "small",
    status: "active",
    role: null,
    parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z",
    dissolvedAt: null,
    ...overrides,
  };
}

/** 创建带状态追踪的 ConversationRepository mock */
function mockRepo(opts: {
  activeTurn?: Turn | null;
  existingParticipant?: ConversationParticipant | null;
  activeParticipants?: ConversationParticipant[];
} = {}): ConversationRepository & {
  _participants: ConversationParticipant[];
  _messages: Message[];
  _leftParticipants: Array<{ participantId: string; leftAtTurnId: string; leftAtTurnNumber: number; leftAt: string }>;
  _closedTurns: string[];
} {
  const participants: ConversationParticipant[] = [];
  const messages: Message[] = [];
  const leftParticipants: Array<{ participantId: string; leftAtTurnId: string; leftAtTurnNumber: number; leftAt: string }> = [];
  const closedTurns: string[] = [];

  return {
    _participants: participants,
    _messages: messages,
    _leftParticipants: leftParticipants,
    _closedTurns: closedTurns,

    create: vi.fn(),
    getById: vi.fn(),
    updateStatus: vi.fn(),
    getIdsByOtterId: vi.fn(async () => []),
    getAllIds: vi.fn(async () => []),
    getOtterIds: vi.fn(async () => []),
    createTurn: vi.fn(),
    getActiveTurn: vi.fn(async () => (opts.activeTurn !== undefined ? opts.activeTurn : mockTurn())),
    closeTurn: vi.fn(async (turnId: string) => {
      closedTurns.push(turnId);
    }),
    getMaxTurnNumber: vi.fn(async () => 1),
    getMessagesByTurnId: vi.fn(async () => []),
    createCompletedMessage: vi.fn(async (msg: Message) => {
      messages.push(msg);
    }),
    createStreamingMessage: vi.fn(),
    startSpeaking: vi.fn(async () => {}),
    completeMessage: vi.fn(),
    failMessage: vi.fn(),
    abortMessage: vi.fn(),
    getMaxSequenceNum: vi.fn(async () => 0),
    getMessageById: vi.fn(async () => null),
    getMessages: vi.fn(async () => []),
    getMessagesBefore: vi.fn(async () => []),
    getMessagesAfter: vi.fn(async () => []),
    appendEvent: vi.fn(),
    getMessageEvents: vi.fn(async () => []),
    getMessageEventsByMessageIds: vi.fn(async () => []),
    getMaxEventSequenceNum: vi.fn(async () => 0),
    searchMessages: vi.fn(async () => []),
    getTurnHistory: vi.fn(async () => []),
    linkResource: vi.fn(),
    getLinkedResources: vi.fn(async () => []),
    getLinkedResourceById: vi.fn(async () => null),
    getLinkedResourcesByGroup: vi.fn(async () => []),
    updateResourceStatus: vi.fn(),
    supersedeLinkedResource: vi.fn(),
    deleteLinkedResource: vi.fn(),
    flagResource: vi.fn(),
    createParticipant: vi.fn(async (p: ConversationParticipant) => {
      participants.push(p);
    }),
    createParticipants: vi.fn(),
    getParticipant: vi.fn(async () => opts.existingParticipant ?? null),
    getActiveParticipants: vi.fn(async () => opts.activeParticipants ?? []),
    updateParticipantLeave: vi.fn(async (participantId: string, leftAtTurnId: string, leftAtTurnNumber: number, leftAt: string) => {
      leftParticipants.push({ participantId, leftAtTurnId, leftAtTurnNumber, leftAt });
    }),
    updateTokenUsage: vi.fn(async () => {}),
  };
}

/** 创建 OtterRepository mock */
function mockOtterRepo(otters: Map<string, Otter> = new Map()): OtterRepository {
  return {
    createOtter: vi.fn(),
    getById: vi.fn(async (id: string) => otters.get(id) ?? null),
    dissolve: vi.fn(),
    deleteOtter: vi.fn(),
    createSession: vi.fn(),
    getActiveSession: vi.fn(async () => null),
    archiveSession: vi.fn(),
    getSessionHistory: vi.fn(async () => []),
    getSessionById: vi.fn(async () => null),
    setHandoffSummary: vi.fn(),
    restoreSessionStatus: vi.fn(),
    deleteSession: vi.fn(),
  };
}

describe("ManageParticipant", () => {
  describe("join", () => {
    it("创建参与者记录 + 系统消息，返回两者", async () => {
      const repo = mockRepo();
      const otterRepo = mockOtterRepo();
      const mp = new ManageParticipant(repo, otterRepo);

      const result = await mp.join("conv-1", "otter-1", "小獭进场了");

      expect(result.participant.otterId).toBe("otter-1");
      expect(result.participant.status).toBe("active");
      expect(result.participant.conversationId).toBe("conv-1");

      /** 验证系统消息 */
      expect(result.systemMessage.senderType).toBe("system");
      expect(result.systemMessage.body).toBe("小獭进场了");
      expect(result.systemMessage.status).toBe("completed");
      expect(result.systemMessage.talkingStonePassedTo).toEqual([]);

      /** 验证 repo 状态：参与者已创建，系统消息已存储 */
      expect(repo._participants).toHaveLength(1);
      expect(repo._messages).toHaveLength(1);
    });

    it("已进场的 Otter 再次进场抛出 conflict 错误", async () => {
      const existing = mockParticipant();
      const repo = mockRepo({ existingParticipant: existing });
      const otterRepo = mockOtterRepo();
      const mp = new ManageParticipant(repo, otterRepo);

      await expect(
        mp.join("conv-1", "otter-1", "小獭又来了"),
      ).rejects.toThrow(DomainError);

      await expect(
        mp.join("conv-1", "otter-1", "小獭又来了"),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "conflict");
    });

    it("无活跃 Turn 时抛出 validation 错误", async () => {
      const repo = mockRepo({ activeTurn: null });
      const otterRepo = mockOtterRepo();
      const mp = new ManageParticipant(repo, otterRepo);

      await expect(
        mp.join("conv-1", "otter-1", "小獭进场"),
      ).rejects.toThrow(DomainError);

      await expect(
        mp.join("conv-1", "otter-1", "小獭进场"),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });
  });

  describe("leave", () => {
    it("更新参与者状态为 left + 创建系统消息", async () => {
      const participant = mockParticipant();
      const repo = mockRepo({ existingParticipant: participant });
      const otterRepo = mockOtterRepo();
      const mp = new ManageParticipant(repo, otterRepo);

      const result = await mp.leave("conv-1", "otter-1", "小獭退场了");

      expect(result.participant.status).toBe("left");
      expect(result.participant.leftAtTurnId).toBe("turn-1");
      expect(result.participant.leftAtTurnNumber).toBe(1);
      expect(result.participant.leftAt).toBeTruthy();

      /** 验证 repo 状态：退场记录已更新 */
      expect(repo._leftParticipants).toHaveLength(1);
      expect(repo._leftParticipants[0].participantId).toBe(participant.id);

      /** 验证系统消息 */
      expect(result.systemMessage.body).toBe("小獭退场了");
      expect(result.systemMessage.senderType).toBe("system");
    });

    it("非活跃参与者退场抛出 validation 错误", async () => {
      /** 已退场的参与者 */
      const leftParticipant = mockParticipant({ status: "left" });
      const repo = mockRepo({ existingParticipant: leftParticipant });
      const otterRepo = mockOtterRepo();
      const mp = new ManageParticipant(repo, otterRepo);

      await expect(
        mp.leave("conv-1", "otter-1", "小獭退场"),
      ).rejects.toThrow(DomainError);

      await expect(
        mp.leave("conv-1", "otter-1", "小獭退场"),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });

    it("不存在的参与者退场抛出 validation 错误", async () => {
      /** getParticipant 返回 null */
      const repo = mockRepo({ existingParticipant: null });
      const otterRepo = mockOtterRepo();
      const mp = new ManageParticipant(repo, otterRepo);

      await expect(
        mp.leave("conv-1", "otter-unknown", "未知獭退场"),
      ).rejects.toThrow(DomainError);
    });
  });

  describe("getActiveParticipants", () => {
    it("返回带 Otter 名称的参与者列表", async () => {
      const participants = [
        mockParticipant({ id: "p1", otterId: "otter-1" }),
        mockParticipant({ id: "p2", otterId: "otter-2" }),
      ];
      const otters = new Map([
        ["otter-1", mockOtter({ id: "otter-1", name: "小獭A" })],
        ["otter-2", mockOtter({ id: "otter-2", name: "小獭B" })],
      ]);
      const repo = mockRepo({ activeParticipants: participants });
      const otterRepo = mockOtterRepo(otters);
      const mp = new ManageParticipant(repo, otterRepo);

      const result = await mp.getActiveParticipants("conv-1");

      expect(result).toHaveLength(2);
      expect(result[0].otterName).toBe("小獭A");
      expect(result[1].otterName).toBe("小獭B");
      expect(result[0].participant.otterId).toBe("otter-1");
    });

    it("Otter 不存在时使用回退名称", async () => {
      const participants = [
        mockParticipant({ id: "p1", otterId: "otter-missing-abc12345" }),
      ];
      const repo = mockRepo({ activeParticipants: participants });
      const otterRepo = mockOtterRepo(new Map()); // 空 otter 存储
      const mp = new ManageParticipant(repo, otterRepo);

      const result = await mp.getActiveParticipants("conv-1");

      expect(result).toHaveLength(1);
      /** 回退名称格式：Otter {id.slice(0,8)} */
      expect(result[0].otterName).toBe("Otter otter-mi");
    });
  });
});
