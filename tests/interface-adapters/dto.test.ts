import { describe, it, expect } from "vitest";
import { toMessageDTO, toMessageEventDTO } from "@interface-adapters/http/dto/message-dto";
import { toConversationDTO, toParticipantDTO } from "@interface-adapters/http/dto/conversation-dto";
import { toOtterDTO, toOtterSessionDTO } from "@interface-adapters/http/dto/otter-dto";
import { toMemoryEntryDTO } from "@interface-adapters/http/dto/memory-dto";
import { toKeyFactDTO, toLinkedResourceDTO, toKeyInfoDTO } from "@interface-adapters/http/dto/key-info-dto";
import type { Message, MessageEvent } from "@entities/conversation/message";
import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { MemoryEntry } from "@entities/memory/memory-entry";

describe("MessageDTO", () => {
  it("maps entity fields to frontend short field names (D57)", () => {
    const msg: Message = {
      id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
      senderType: "user", senderId: "user-1",
      talkingStonePassedTo: ["otter-1"], status: "completed",
      body: "Hello", attachments: null,
      sequenceNum: 1, contextTokens: null, contextTokensMax: null,
      createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:02Z",
    };
    const dto = toMessageDTO(msg);
    expect(dto.id).toBe("msg-1");
    expect(dto.st).toBe("user");
    expect(dto.si).toBe("user-1");
    expect(dto.content).toBe("Hello");
    expect(dto.status).toBe("completed");
    expect(dto.ts).toBe("2026-07-16T00:00:00Z");
    expect(dto.dur).toBe("2.0s");
    expect(dto.seq).toBe(1);
    expect(dto.tsp).toEqual(["otter-1"]);
  });

  it("returns null dur for streaming messages", () => {
    const msg: Message = {
      id: "msg-2", conversationId: "conv-1", turnId: "turn-1",
      senderType: "otter", senderId: "otter-1",
      talkingStonePassedTo: null, status: "streaming",
      body: null, attachments: null,
      sequenceNum: 2, contextTokens: null, contextTokensMax: null,
      createdAt: "2026-07-16T00:00:00Z", completedAt: null,
    };
    const dto = toMessageDTO(msg);
    expect(dto.dur).toBeNull();
    expect(dto.content).toBeNull();
    expect(dto.st).toBe("otter");
  });

  it("maps MessageEvent entity to DTO", () => {
    const evt: MessageEvent = {
      id: "evt-1", messageId: "msg-1",
      eventType: "text_delta", payload: { text: "Hello" },
      sequenceNum: 1, createdAt: "2026-07-16T00:00:00Z",
    };
    const dto = toMessageEventDTO(evt);
    expect(dto.eventType).toBe("text_delta");
    expect(dto.payload.text).toBe("Hello");
  });
});

describe("ConversationDTO", () => {
  it("maps conversation entity to DTO", () => {
    const conv: Conversation = {
      id: "conv-1", title: "Test", status: "active",
      summary: null, createdAt: "2026-07-16T00:00:00Z",
      updatedAt: "2026-07-16T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    const dto = toConversationDTO(conv);
    expect(dto.id).toBe("conv-1");
    expect(dto.title).toBe("Test");
    expect(dto.status).toBe("active");
  });

  it("maps participant entity to DTO", () => {
    const p: ConversationParticipant = {
      id: "p-1", conversationId: "conv-1", otterId: "otter-1",
      joinedAtTurnId: null, joinedAtTurnNumber: 0,
      leftAtTurnId: null, leftAtTurnNumber: null,
      status: "active", createdAt: "2026-07-16T00:00:00Z", leftAt: null,
    };
    const dto = toParticipantDTO(p);
    expect(dto.otterId).toBe("otter-1");
    expect(dto.status).toBe("active");
  });
});

describe("OtterDTO", () => {
  it("maps otter entity to DTO", () => {
    const otter: Otter = {
      id: "otter-1", name: "Big Otter", type: "big", status: "active",
      role: { name: "Coordinator", responsibilities: ["manage"] },
      parentOtterId: null, createdAt: "2026-07-16T00:00:00Z", dissolvedAt: null,
    };
    const dto = toOtterDTO(otter);
    expect(dto.id).toBe("otter-1");
    expect(dto.type).toBe("big");
    expect(dto.role?.name).toBe("Coordinator");
  });

  it("maps otter session entity to DTO", () => {
    const session: OtterSession = {
      id: "sess-1", otterId: "otter-1", status: "active",
      previousSessionId: null, startedAt: "2026-07-16T00:00:00Z",
      archivedAt: null, archiveReason: null, isNegativeCase: false, summary: null, handoffSummary: null,
    };
    const dto = toOtterSessionDTO(session);
    expect(dto.id).toBe("sess-1");
    expect(dto.status).toBe("active");
  });
});

describe("MemoryDTO", () => {
  it("maps memory entry to DTO with score and source", () => {
    const entry: MemoryEntry = {
      id: "mem-1", layer: "working", contentType: "message",
      sourceId: "msg-1", sourceTable: "messages", conversationId: "conv-1",
      granularity: "fine", content: "Hello", metadata: null,
      createdAt: "2026-07-16T00:00:00Z",
    };
    const dto = toMemoryEntryDTO(entry, 0.95, "both");
    expect(dto.id).toBe("mem-1");
    expect(dto.score).toBe(0.95);
    expect(dto.source).toBe("both");
  });
});

describe("KeyInfoDTO", () => {
  it("maps key fact to DTO", () => {
    const fact = {
      id: "kf-1", conversationId: "conv-1", content: "Important fact",
      category: "info", userFlagged: false, createdBy: "user-1",
      otterId: null, createdAt: "2026-07-16T00:00:00Z",
    };
    const dto = toKeyFactDTO(fact);
    expect(dto.content).toBe("Important fact");
    expect(dto.category).toBe("info");
  });

  it("maps key info combo to DTO", () => {
    const info = { keyFacts: [], linkedResources: [] };
    const dto = toKeyInfoDTO(info);
    expect(dto.keyFacts).toEqual([]);
    expect(dto.linkedResources).toEqual([]);
  });

  it("maps linked resource to DTO", () => {
    const res = {
      id: "lr-1", conversationId: "conv-1", resourceType: "url",
      url: "https://example.com", title: "Example",
      metadata: null, linkedBy: "otter-1", otterId: "otter-1",
      autoLinked: false, createdAt: "2026-07-16T00:00:00Z",
    };
    const dto = toLinkedResourceDTO(res);
    expect(dto.url).toBe("https://example.com");
    expect(dto.title).toBe("Example");
  });
});
