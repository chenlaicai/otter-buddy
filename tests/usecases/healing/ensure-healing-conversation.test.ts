import { describe, it, expect, vi } from "vitest";
import { ensureHealingConversation } from "@usecases/healing/ensure-healing-conversation";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { Logger } from "@usecases/ports/logger";
import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { HEALING_CONVERSATION_KEY, HEALING_BIG_OTTER_ID_KEY } from "@usecases/healing/constants";

/** 大獭 mock */
function mockBigOtter(): Otter {
  return {
    id: "otter-big-001",
    name: "大獭",
    type: "big",
    status: "active",
    role: null,
    parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z",
    dissolvedAt: null,
  };
}

/** 已有 active 对话 */
function existingConversation(): Conversation {
  return {
    id: "conv-existing",
    title: "🩺 Self-Healing",
    status: "active",
    summary: null,
    pinned: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    archivedAt: null,
  };
}

/** 新建对话 */
function newConversation(): Conversation {
  return {
    id: "conv-new",
    title: "🩺 Self-Healing",
    status: "active",
    summary: null,
    pinned: false,
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:00Z",
    completedAt: null,
    archivedAt: null,
  };
}

/** 参与者 mock */
function mockParticipant(otterId: string, conversationId: string): ConversationParticipant {
  return {
    id: "participant-1",
    conversationId,
    otterId,
    joinedAtTurnId: null,
    joinedAtTurnNumber: 0,
    leftAtTurnId: null,
    leftAtTurnNumber: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    leftAt: null,
    lastReadTurnNumber: 0,
  };
}

/** Logger mock（带 spy） */
function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => mockLogger()),
  } as unknown as Logger;
}

describe("ensureHealingConversation - pin 行为", () => {
  it("existing 路径：settings 有已有 healing 对话 ID 且对话 active 时，调用 manageConversation.pin", async () => {
    const conv = existingConversation();
    const bigOtterId = "otter-big-001";

    const manageConversation = {
      create: vi.fn(),
      getById: vi.fn(async () => conv),
      pin: vi.fn(async () => {}),
    } as unknown as ManageConversation;

    const convRepo = {
      getActiveParticipants: vi.fn(),
    } as unknown as ConversationRepository;

    const otterRepo = {
      getById: vi.fn(),
    } as unknown as OtterRepository;

    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === HEALING_CONVERSATION_KEY) return conv.id;
        if (key === HEALING_BIG_OTTER_ID_KEY) return bigOtterId;
        return null;
      }),
      update: vi.fn(),
      getAll: vi.fn(async () => ({})),
    } as unknown as SettingsRepository;

    const sendMessage = {
      sendSystem: vi.fn(),
    } as unknown as SendMessage;

    const logger = mockLogger();

    const result = await ensureHealingConversation({
      manageConversation,
      convRepo,
      otterRepo,
      settings,
      sendMessage,
      logger,
    });

    expect(result.conversationId).toBe(conv.id);
    expect(result.bigOtterId).toBe(bigOtterId);
    expect(manageConversation.pin).toHaveBeenCalled();
    expect(manageConversation.create).not.toHaveBeenCalled();
  });

  it("create 路径：无已有 ID，创建新对话后调用 manageConversation.pin", async () => {
    const conv = newConversation();
    const otter = mockBigOtter();

    const manageConversation = {
      create: vi.fn(async () => conv),
      getById: vi.fn(),
      pin: vi.fn(async () => {}),
    } as unknown as ManageConversation;

    const convRepo = {
      getActiveParticipants: vi.fn(async () => [mockParticipant(otter.id, conv.id)]),
    } as unknown as ConversationRepository;

    const otterRepo = {
      getById: vi.fn(async () => otter),
    } as unknown as OtterRepository;

    const settings = {
      get: vi.fn(async () => null),
      update: vi.fn(),
      getAll: vi.fn(async () => ({})),
    } as unknown as SettingsRepository;

    const sendMessage = {
      sendSystem: vi.fn(),
    } as unknown as SendMessage;

    const logger = mockLogger();

    const result = await ensureHealingConversation({
      manageConversation,
      convRepo,
      otterRepo,
      settings,
      sendMessage,
      logger,
    });

    expect(result.conversationId).toBe(conv.id);
    expect(result.bigOtterId).toBe(otter.id);
    expect(manageConversation.pin).toHaveBeenCalled();
    expect(manageConversation.create).toHaveBeenCalled();
    expect(settings.update).toHaveBeenCalled();
    expect(sendMessage.sendSystem).toHaveBeenCalled();
  });

  it("pin 失败不中断 ensure：manageConversation.pin 抛错时，ensure 仍正常返回，logger.warn 被调用", async () => {
    const conv = existingConversation();
    const bigOtterId = "otter-big-001";

    const manageConversation = {
      create: vi.fn(),
      getById: vi.fn(async () => conv),
      pin: vi.fn(async () => {
        throw new Error("pin failed");
      }),
    } as unknown as ManageConversation;

    const convRepo = {
      getActiveParticipants: vi.fn(),
    } as unknown as ConversationRepository;

    const otterRepo = {
      getById: vi.fn(),
    } as unknown as OtterRepository;

    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === HEALING_CONVERSATION_KEY) return conv.id;
        if (key === HEALING_BIG_OTTER_ID_KEY) return bigOtterId;
        return null;
      }),
      update: vi.fn(),
      getAll: vi.fn(async () => ({})),
    } as unknown as SettingsRepository;

    const sendMessage = {
      sendSystem: vi.fn(),
    } as unknown as SendMessage;

    const logger = mockLogger();

    const result = await ensureHealingConversation({
      manageConversation,
      convRepo,
      otterRepo,
      settings,
      sendMessage,
      logger,
    });

    expect(result.conversationId).toBe(conv.id);
    expect(result.bigOtterId).toBe(bigOtterId);
    expect(logger.warn).toHaveBeenCalled();
  });
});
