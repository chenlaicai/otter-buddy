import { describe, it, expect } from "vitest";
import { toMessageDTO, toMessageEventDTO } from "@interface-adapters/http/dto/message-dto";
import { toConversationDTO, toParticipantDTO } from "@interface-adapters/http/dto/conversation-dto";
import { toOtterDTO, toOtterSessionDTO } from "@interface-adapters/http/dto/otter-dto";
import { toMemoryEntryDTO } from "@interface-adapters/http/dto/memory-dto";
import { toLinkedResourceDTO, toKeyInfoDTO } from "@interface-adapters/http/dto/key-info-dto";
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
      body: "Hello",
      sequenceNum: 1, contextTokens: null, contextTokensMax: null,
      source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:02Z",
    };
    const dto = toMessageDTO(msg);
    expect(dto.id).toBe("msg-1");
    expect(dto.st).toBe("user");
    expect(dto.si).toBe("user-1");
    expect(dto.content).toBe("Hello");
    expect(dto.status).toBe("completed");
    expect(dto.ts).toBe("2026-07-16T00:00:00Z");
    expect(dto.dur).toBeNull(); // 用户消息不显示耗时
    expect(dto.seq).toBe(1);
    expect(dto.tsp).toEqual(["otter-1"]);
  });

  it("returns null dur for streaming messages", () => {
    const msg: Message = {
      id: "msg-2", conversationId: "conv-1", turnId: "turn-1",
      senderType: "otter", senderId: "otter-1",
      talkingStonePassedTo: null, status: "streaming",
      body: null,
      sequenceNum: 2, contextTokens: null, contextTokensMax: null,
      source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: null,
    };
    const dto = toMessageDTO(msg);
    expect(dto.dur).toBeNull();
    expect(dto.content).toBeNull();
    expect(dto.st).toBe("otter");
  });

  it("includes sn when senderName provided, omits otherwise", () => {
    const msg: Message = {
      id: "msg-3", conversationId: "conv-1", turnId: "turn-1",
      senderType: "otter", senderId: "otter-1",
      talkingStonePassedTo: ["user-1"], status: "completed",
      body: "你好",
      sequenceNum: 3, contextTokens: null, contextTokensMax: null,
      source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:01Z",
    };
    expect(toMessageDTO(msg, "小獭").sn).toBe("小獭");
    expect(toMessageDTO(msg).sn).toBeUndefined();
  });

  it("maps MessageEvent entity to DTO", () => {
    const evt: MessageEvent = {
      id: "evt-1", messageId: "msg-1",
      eventType: "assistant_text", payload: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      sequenceNum: 1, createdAt: "2026-07-16T00:00:00Z",
    };
    const dto = toMessageEventDTO(evt);
    expect(dto.eventType).toBe("assistant_text");
  });
});

describe("ConversationDTO", () => {
  it("maps conversation entity to DTO", () => {
    const conv: Conversation = {
      id: "conv-1", title: "Test", status: "active",
      summary: null, pinned: false, createdAt: "2026-07-16T00:00:00Z",
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
      lastReadTurnNumber: 0,
    };
    const dto = toParticipantDTO(p, "Big Otter");
    expect(dto.otterId).toBe("otter-1");
    expect(dto.otterName).toBe("Big Otter");
    expect(dto.status).toBe("active");
    expect(dto.otterType).toBeUndefined();
  });

  it("passes through otterType and roleName", () => {
    const p: ConversationParticipant = {
      id: "p-2", conversationId: "conv-1", otterId: "otter-2",
      joinedAtTurnId: null, joinedAtTurnNumber: 0,
      leftAtTurnId: null, leftAtTurnNumber: null,
      status: "active", createdAt: "2026-07-16T00:00:00Z", leftAt: null,
      lastReadTurnNumber: 0,
    };
    const dto = toParticipantDTO(p, "小獭", { otterType: "small", roleName: "审查獭" });
    expect(dto.otterType).toBe("small");
    expect(dto.roleName).toBe("审查獭");
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
    expect(dto.layer).toBe("working");
    expect(dto.score).toBe(0.95);
    expect(dto.source).toBe("both");
    expect(dto.userFlagged).toBeUndefined();
  });

  it("passes through userFlagged when present", () => {
    const entry: MemoryEntry & { userFlagged?: boolean } = {
      id: "mem-2", layer: "historical", contentType: "message",
      sourceId: "msg-2", sourceTable: "messages", conversationId: "conv-1",
      granularity: "fine", content: "Hello", metadata: null,
      createdAt: "2026-07-16T00:00:00Z",
      userFlagged: true,
    };
    const dto = toMemoryEntryDTO(entry);
    expect(dto.layer).toBe("historical");
    expect(dto.userFlagged).toBe(true);
  });
});

describe("KeyInfoDTO", () => {
  it("maps key info combo to DTO", () => {
    const dto = toKeyInfoDTO([]);
    expect(dto.resources).toEqual([]);
  });

  it("maps linked resource to DTO", () => {
    const res = {
      id: "lr-1", conversationId: "conv-1", resourceType: "url",
      url: "https://example.com", title: "Example",
      content: null, category: null, userFlagged: false,
      metadata: null, linkedBy: "otter-1", otterId: "otter-1",
      autoLinked: false, createdAt: "2026-07-16T00:00:00Z",
      status: "active" as const, linkedAtTurnNumber: 0, statusChangedAtTurnNumber: 0,
      groupId: null, supersededBy: null,
    };
    const dto = toLinkedResourceDTO(res);
    expect(dto.url).toBe("https://example.com");
    expect(dto.title).toBe("Example");
  });

  it("maps fact resource to DTO", () => {
    const res = {
      id: "fact-1", conversationId: "conv-1", resourceType: "fact",
      url: null, title: null,
      content: "Important fact", category: "info", userFlagged: true,
      metadata: null, linkedBy: "user-1", otterId: null,
      autoLinked: false, createdAt: "2026-07-16T00:00:00Z",
      status: "active" as const, linkedAtTurnNumber: 0, statusChangedAtTurnNumber: 0,
      groupId: null, supersededBy: null,
    };
    const dto = toLinkedResourceDTO(res);
    expect(dto.resourceType).toBe("fact");
    expect(dto.content).toBe("Important fact");
    expect(dto.category).toBe("info");
    expect(dto.userFlagged).toBe(true);
    expect(dto.url).toBeNull();
  });
});
