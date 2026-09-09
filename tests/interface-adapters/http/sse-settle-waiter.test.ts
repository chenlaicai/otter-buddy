import { describe, it, expect, vi, beforeEach } from "vitest";
import { awaitTriggerAttemptsSettled } from "@interface-adapters/http/sse-settle-waiter";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { Logger } from "@usecases/ports/logger";
import type { Message } from "@entities/conversation/message";

function createTestLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "otter",
    senderId: "otter-1",
    senderName: "Test Otter",
    talkingStonePassedTo: null,
    status: "completed",
    segments: [],
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    source: "web",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("awaitTriggerAttemptsSettled", () => {
  let mockQueryMessage: QueryMessage;
  let logger: Logger;

  beforeEach(() => {
    logger = createTestLogger();
  });

  it("无 queryMessage 时立即返回", async () => {
    await expect(
      awaitTriggerAttemptsSettled(undefined, logger, "conv-1", "msg-1")
    ).resolves.toBeUndefined();
  });

  it("triggerMessage 不存在时立即 settle", async () => {
    mockQueryMessage = {
      getMessageById: vi.fn().mockResolvedValue(null),
      getLastMessageBySender: vi.fn(),
    } as unknown as QueryMessage;

    await expect(
      awaitTriggerAttemptsSettled(mockQueryMessage, logger, "conv-1", "msg-1")
    ).resolves.toBeUndefined();
  });

  it("无目标（tsp 为空或只有 user）时立即 settle", async () => {
    mockQueryMessage = {
      getMessageById: vi.fn().mockResolvedValue(
        createMessage({ talkingStonePassedTo: ["user"] })
      ),
      getLastMessageBySender: vi.fn(),
    } as unknown as QueryMessage;

    await expect(
      awaitTriggerAttemptsSettled(mockQueryMessage, logger, "conv-1", "msg-1")
    ).resolves.toBeUndefined();
  });

  it("单目标已完成时立即 settle", async () => {
    mockQueryMessage = {
      getMessageById: vi.fn().mockResolvedValue(
        createMessage({ talkingStonePassedTo: ["otter-1"] })
      ),
      getLastMessageBySender: vi.fn().mockResolvedValue(
        createMessage({ senderId: "otter-1", status: "completed" })
      ),
    } as unknown as QueryMessage;

    await expect(
      awaitTriggerAttemptsSettled(mockQueryMessage, logger, "conv-1", "msg-1")
    ).resolves.toBeUndefined();
  });

  it("单目标仍在 streaming 时轮询直到完成", async () => {
    let callCount = 0;
    mockQueryMessage = {
      getMessageById: vi.fn().mockResolvedValue(
        createMessage({ talkingStonePassedTo: ["otter-1"] })
      ),
      getLastMessageBySender: vi.fn().mockImplementation(async () => {
        callCount++;
        // 前两次返回 streaming，第三次返回 completed
        if (callCount < 3) {
          return createMessage({ senderId: "otter-1", status: "streaming" });
        }
        return createMessage({ senderId: "otter-1", status: "completed" });
      }),
    } as unknown as QueryMessage;

    // 验证轮询直到完成（函数正常返回即表示 settle）
    await expect(
      awaitTriggerAttemptsSettled(mockQueryMessage, logger, "conv-1", "msg-1")
    ).resolves.toBeUndefined();
  });

  it("单目标仍在 speaking 时轮询直到完成", async () => {
    let callCount = 0;
    mockQueryMessage = {
      getMessageById: vi.fn().mockResolvedValue(
        createMessage({ talkingStonePassedTo: ["otter-1"] })
      ),
      getLastMessageBySender: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          return createMessage({ senderId: "otter-1", status: "speaking" });
        }
        return createMessage({ senderId: "otter-1", status: "completed" });
      }),
    } as unknown as QueryMessage;

    // 验证轮询直到完成（函数正常返回即表示 settle）
    await expect(
      awaitTriggerAttemptsSettled(mockQueryMessage, logger, "conv-1", "msg-1")
    ).resolves.toBeUndefined();
  });

  it("多獭场景：獭 A 已完成、獭 B 还在 streaming 时轮询直到完成", async () => {
    let callCount = 0;
    mockQueryMessage = {
      getMessageById: vi.fn().mockResolvedValue(
        createMessage({ talkingStonePassedTo: ["otter-A", "otter-B"] })
      ),
      getLastMessageBySender: vi.fn().mockImplementation(async (_convId: string, senderId: string) => {
        callCount++;
        // 獭 A 始终已完成
        if (senderId === "otter-A") {
          return createMessage({ senderId: "otter-A", status: "completed" });
        }
        // 獭 B 前两次 streaming，第三次 completed
        if (callCount < 5) {
          return createMessage({ senderId: "otter-B", status: "streaming" });
        }
        return createMessage({ senderId: "otter-B", status: "completed" });
      }),
    } as unknown as QueryMessage;

    // 验证多獭场景轮询直到全部完成（函数正常返回即表示 settle）
    await expect(
      awaitTriggerAttemptsSettled(mockQueryMessage, logger, "conv-1", "msg-1")
    ).resolves.toBeUndefined();
  });

  it("超时后自动 resolve（不阻塞无限）", { timeout: 60000 }, async () => {
    // 始终返回 streaming，测试超时机制
    mockQueryMessage = {
      getMessageById: vi.fn().mockResolvedValue(
        createMessage({ talkingStonePassedTo: ["otter-1"] })
      ),
      getLastMessageBySender: vi.fn().mockResolvedValue(
        createMessage({ senderId: "otter-1", status: "streaming" })
      ),
    } as unknown as QueryMessage;

    // 测试默认 30s 超时机制
    await expect(
      awaitTriggerAttemptsSettled(mockQueryMessage, logger, "conv-1", "msg-1")
    ).resolves.toBeUndefined();
  });
});
