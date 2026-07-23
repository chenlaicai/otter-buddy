import { describe, it, expect } from "vitest";
import {
  rowToConversation,
  rowToMessage,
  rowToMessageEvent,
  rowToLinkedResource,
  rowToTurn,
  rowToParticipant,
} from "@frameworks/db/conversation/conversation-mapper";
import type {
  ConversationRow,
  MessageRow,
  MessageEventRow,
  LinkedResourceRow,
  TurnRow,
  ParticipantRow,
} from "@frameworks/db/conversation/conversation-mapper";

describe("rowToConversation", () => {
  it("将 snake_case 行映射为 camelCase 对话实体", () => {
    const row: ConversationRow = {
      id: "conv-1",
      title: "测试对话",
      status: "active",
      summary: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      completed_at: null,
      archived_at: null,
    };

    const result = rowToConversation(row);

    expect(result.id).toBe("conv-1");
    expect(result.title).toBe("测试对话");
    expect(result.status).toBe("active");
    expect(result.summary).toBeNull();
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.updatedAt).toBe("2026-01-01T00:00:00Z");
    expect(result.completedAt).toBeNull();
    expect(result.archivedAt).toBeNull();
  });

  it("status 被类型转换为 ConversationStatus", () => {
    const row: ConversationRow = {
      id: "c2",
      title: "t",
      status: "completed",
      summary: "概述",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      completed_at: "2026-01-02T00:00:00Z",
      archived_at: null,
    };

    const result = rowToConversation(row);
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("概述");
    expect(result.completedAt).toBe("2026-01-02T00:00:00Z");
  });
});

describe("rowToMessage", () => {
  const baseRow: MessageRow = {
    id: "msg-1",
    conversation_id: "conv-1",
    sender_type: "user",
    sender_id: "user-1",
    status: "completed",
    body: "你好",
    attachments: null,
    sequence_num: 1,
    turn_id: "turn-1",
    talking_stone_passed_to: null,
    context_tokens: null,
    context_tokens_max: null,
    created_at: "2026-01-01T00:00:00Z",
    completed_at: null,
  };

  it("将 snake_case 行映射为 camelCase 消息实体", () => {
    const result = rowToMessage(baseRow);

    expect(result.id).toBe("msg-1");
    expect(result.conversationId).toBe("conv-1");
    expect(result.turnId).toBe("turn-1");
    expect(result.senderType).toBe("user");
    expect(result.senderId).toBe("user-1");
    expect(result.status).toBe("completed");
    expect(result.body).toBe("你好");
    expect(result.sequenceNum).toBe(1);
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("talking_stone_passed_to 为字符串时 JSON.parse 为数组", () => {
    const row: MessageRow = {
      ...baseRow,
      talking_stone_passed_to: '["otter-1","otter-2"]',
    };

    const result = rowToMessage(row);
    expect(result.talkingStonePassedTo).toEqual(["otter-1", "otter-2"]);
  });

  it("talking_stone_passed_to 为 null 时返回 null", () => {
    const result = rowToMessage(baseRow);
    expect(result.talkingStonePassedTo).toBeNull();
  });

  it("attachments 为字符串时 JSON.parse 为数组", () => {
    const row: MessageRow = {
      ...baseRow,
      attachments: '[{"type":"image","url":"https://example.com/img.png"}]',
    };

    const result = rowToMessage(row);
    expect(result.attachments).toEqual([
      { type: "image", url: "https://example.com/img.png" },
    ]);
  });

  it("attachments 为 null 时返回 null", () => {
    const result = rowToMessage(baseRow);
    expect(result.attachments).toBeNull();
  });

  it("contextTokens 和 contextTokensMax 正确映射", () => {
    const row: MessageRow = {
      ...baseRow,
      context_tokens: 1500,
      context_tokens_max: 4096,
    };

    const result = rowToMessage(row);
    expect(result.contextTokens).toBe(1500);
    expect(result.contextTokensMax).toBe(4096);
  });
});

describe("rowToMessageEvent", () => {
  it("将 snake_case 行映射为 camelCase 事件实体", () => {
    const row: MessageEventRow = {
      id: "evt-1",
      message_id: "msg-1",
      event_type: "assistant_text",
      payload: '{"text":"你好"}',
      sequence_num: 1,
      created_at: "2026-01-01T00:00:00Z",
    };

    const result = rowToMessageEvent(row);

    expect(result.id).toBe("evt-1");
    expect(result.messageId).toBe("msg-1");
    expect(result.eventType).toBe("assistant_text");
    expect(result.sequenceNum).toBe(1);
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("payload 字段通过 JSON.parse 解析为对象", () => {
    const row: MessageEventRow = {
      id: "evt-2",
      message_id: "msg-1",
      event_type: "tool_result",
      payload: '{"toolName":"search","result":"found"}',
      sequence_num: 2,
      created_at: "2026-01-01T00:01:00Z",
    };

    const result = rowToMessageEvent(row);
    expect(result.payload).toEqual({ toolName: "search", result: "found" });
  });

  it("payload 可以解析为嵌套对象", () => {
    const row: MessageEventRow = {
      id: "evt-3",
      message_id: "msg-1",
      event_type: "error",
      payload: '{"error":{"code":500,"message":"内部错误"}}',
      sequence_num: 3,
      created_at: "2026-01-01T00:02:00Z",
    };

    const result = rowToMessageEvent(row);
    expect(result.payload).toEqual({
      error: { code: 500, message: "内部错误" },
    });
  });
});

describe("rowToLinkedResource", () => {
  const baseRow: LinkedResourceRow = {
    id: "res-1",
    conversation_id: "conv-1",
    resource_type: "fact",
    url: null,
    title: "标题",
    content: "内容",
    category: null,
    user_flagged: 0,
    metadata: null,
    linked_by: "otter-1",
    otter_id: null,
    auto_linked: 0,
    created_at: "2026-01-01T00:00:00Z",
    status: "active",
    linked_at_turn_number: 1,
    status_changed_at_turn_number: 1,
    group_id: null,
    superseded_by: null,
  };

  it("将 snake_case 行映射为 camelCase 链接资源实体", () => {
    const result = rowToLinkedResource(baseRow);

    expect(result.id).toBe("res-1");
    expect(result.conversationId).toBe("conv-1");
    expect(result.resourceType).toBe("fact");
    expect(result.title).toBe("标题");
    expect(result.content).toBe("内容");
    expect(result.linkedBy).toBe("otter-1");
    expect(result.status).toBe("active");
    expect(result.linkedAtTurnNumber).toBe(1);
    expect(result.statusChangedAtTurnNumber).toBe(1);
  });

  it("user_flagged: 1 转为 true", () => {
    const row: LinkedResourceRow = { ...baseRow, user_flagged: 1 };
    const result = rowToLinkedResource(row);
    expect(result.userFlagged).toBe(true);
  });

  it("user_flagged: 0 转为 false", () => {
    const result = rowToLinkedResource(baseRow);
    expect(result.userFlagged).toBe(false);
  });

  it("auto_linked: 1 转为 true", () => {
    const row: LinkedResourceRow = { ...baseRow, auto_linked: 1 };
    const result = rowToLinkedResource(row);
    expect(result.autoLinked).toBe(true);
  });

  it("auto_linked: 0 转为 false", () => {
    const result = rowToLinkedResource(baseRow);
    expect(result.autoLinked).toBe(false);
  });

  it("metadata 为字符串时 JSON.parse 为对象", () => {
    const row: LinkedResourceRow = {
      ...baseRow,
      metadata: '{"source":"manual","confidence":0.95}',
    };
    const result = rowToLinkedResource(row);
    expect(result.metadata).toEqual({ source: "manual", confidence: 0.95 });
  });

  it("metadata 为 null 时返回 null", () => {
    const result = rowToLinkedResource(baseRow);
    expect(result.metadata).toBeNull();
  });

  it("可选字段为 null 时正确传递", () => {
    const row: LinkedResourceRow = {
      ...baseRow,
      url: null,
      category: null,
      otter_id: null,
      group_id: null,
      superseded_by: null,
    };
    const result = rowToLinkedResource(row);
    expect(result.url).toBeNull();
    expect(result.category).toBeNull();
    expect(result.otterId).toBeNull();
    expect(result.groupId).toBeNull();
    expect(result.supersededBy).toBeNull();
  });
});

describe("rowToTurn", () => {
  it("将 snake_case 行映射为 camelCase 轮次实体", () => {
    const row: TurnRow = {
      id: "turn-1",
      conversation_id: "conv-1",
      turn_number: 3,
      status: "open",
      created_at: "2026-01-01T00:00:00Z",
      closed_at: null,
    };

    const result = rowToTurn(row);

    expect(result.id).toBe("turn-1");
    expect(result.conversationId).toBe("conv-1");
    expect(result.turnNumber).toBe(3);
    expect(result.status).toBe("open");
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.closedAt).toBeNull();
  });

  it("closed 状态的轮次有 closedAt 时间", () => {
    const row: TurnRow = {
      id: "turn-2",
      conversation_id: "conv-1",
      turn_number: 1,
      status: "closed",
      created_at: "2026-01-01T00:00:00Z",
      closed_at: "2026-01-01T00:05:00Z",
    };

    const result = rowToTurn(row);
    expect(result.status).toBe("closed");
    expect(result.closedAt).toBe("2026-01-01T00:05:00Z");
  });
});

describe("rowToParticipant", () => {
  const baseRow: ParticipantRow = {
    id: "part-1",
    conversation_id: "conv-1",
    otter_id: "otter-1",
    joined_at_turn_id: null,
    joined_at_turn_number: 0,
    left_at_turn_id: null,
    left_at_turn_number: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    left_at: null,
    last_read_sequence_num: 0,
  };

  it("将 snake_case 行映射为 camelCase 参与者实体", () => {
    const result = rowToParticipant(baseRow);

    expect(result.id).toBe("part-1");
    expect(result.conversationId).toBe("conv-1");
    expect(result.otterId).toBe("otter-1");
    expect(result.joinedAtTurnId).toBeNull();
    expect(result.joinedAtTurnNumber).toBe(0);
    expect(result.leftAtTurnId).toBeNull();
    expect(result.leftAtTurnNumber).toBeNull();
    expect(result.status).toBe("active");
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.leftAt).toBeNull();
  });

  it("已退场的参与者有退场信息", () => {
    const row: ParticipantRow = {
      ...baseRow,
      status: "left",
      joined_at_turn_id: "turn-1",
      joined_at_turn_number: 1,
      left_at_turn_id: "turn-3",
      left_at_turn_number: 3,
      left_at: "2026-01-01T00:15:00Z",
    };

    const result = rowToParticipant(row);
    expect(result.status).toBe("left");
    expect(result.joinedAtTurnId).toBe("turn-1");
    expect(result.joinedAtTurnNumber).toBe(1);
    expect(result.leftAtTurnId).toBe("turn-3");
    expect(result.leftAtTurnNumber).toBe(3);
    expect(result.leftAt).toBe("2026-01-01T00:15:00Z");
  });
});
