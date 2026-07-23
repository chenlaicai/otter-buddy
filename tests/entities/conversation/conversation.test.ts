import { describe, it, expect } from "vitest";
import {
  canCompleteConversation,
  canArchiveConversation,
  isTurnActive,
  canAddMessageToTurn,
  canCloseTurn,
  canJoinConversation,
  canLeaveConversation,
  canTransitionArtifactStatus,
  isArtifactActive,
  isArtifactVisible,
} from "../../../src/entities/conversation/conversation";

describe("canCompleteConversation", () => {
  it("active can be completed", () => {
    expect(canCompleteConversation("active")).toBe(true);
  });

  it("completed cannot be completed again", () => {
    expect(canCompleteConversation("completed")).toBe(false);
  });

  it("archived cannot be completed", () => {
    expect(canCompleteConversation("archived")).toBe(false);
  });
});

describe("canArchiveConversation", () => {
  it("completed can be archived", () => {
    expect(canArchiveConversation("completed")).toBe(true);
  });

  it("active cannot be archived", () => {
    expect(canArchiveConversation("active")).toBe(false);
  });

  it("archived cannot be archived again", () => {
    expect(canArchiveConversation("archived")).toBe(false);
  });
});

describe("isTurnActive", () => {
  it("open turn is active", () => {
    expect(isTurnActive("open")).toBe(true);
  });

  it("closed turn is not active", () => {
    expect(isTurnActive("closed")).toBe(false);
  });
});

describe("canAddMessageToTurn", () => {
  it("open turn accepts messages", () => {
    expect(canAddMessageToTurn("open")).toBe(true);
  });

  it("closed turn rejects messages", () => {
    expect(canAddMessageToTurn("closed")).toBe(false);
  });
});

describe("canCloseTurn", () => {
  it("can close when all messages are terminal", () => {
    expect(canCloseTurn(true)).toBe(true);
  });

  it("cannot close when some messages are not terminal", () => {
    expect(canCloseTurn(false)).toBe(false);
  });
});

describe("canJoinConversation", () => {
  it("can join when no existing participant", () => {
    expect(canJoinConversation(null)).toBe(true);
  });

  it("cannot join when participant already exists", () => {
    const existing = {
      id: "p-1",
      conversationId: "c-1",
      otterId: "o-1",
      joinedAtTurnId: null,
      joinedAtTurnNumber: 0,
      leftAtTurnId: null,
      leftAtTurnNumber: null,
      status: "active" as const,
      createdAt: new Date().toISOString(),
      leftAt: null,
      lastReadTurnNumber: 0,
    };
    expect(canJoinConversation(existing)).toBe(false);
  });
});

describe("canLeaveConversation", () => {
  it("cannot leave when participant is null", () => {
    expect(canLeaveConversation(null)).toBe(false);
  });

  it("active participant can leave", () => {
    const participant = {
      id: "p-1",
      conversationId: "c-1",
      otterId: "o-1",
      joinedAtTurnId: null,
      joinedAtTurnNumber: 0,
      leftAtTurnId: null,
      leftAtTurnNumber: null,
      status: "active" as const,
      createdAt: new Date().toISOString(),
      leftAt: null,
      lastReadTurnNumber: 0,
    };
    expect(canLeaveConversation(participant)).toBe(true);
  });

  it("left participant cannot leave again", () => {
    const participant = {
      id: "p-1",
      conversationId: "c-1",
      otterId: "o-1",
      joinedAtTurnId: null,
      joinedAtTurnNumber: 0,
      leftAtTurnId: "turn-1",
      leftAtTurnNumber: 1,
      status: "left" as const,
      createdAt: new Date().toISOString(),
      leftAt: new Date().toISOString(),
      lastReadTurnNumber: 0,
    };
    expect(canLeaveConversation(participant)).toBe(false);
  });
});

describe("canTransitionArtifactStatus", () => {
  it("active -> superseded is valid", () => {
    expect(canTransitionArtifactStatus("active", "superseded")).toBe(true);
  });

  it("active -> archived is valid", () => {
    expect(canTransitionArtifactStatus("active", "archived")).toBe(true);
  });

  it("active -> active is invalid (same state)", () => {
    expect(canTransitionArtifactStatus("active", "active")).toBe(false);
  });

  it("superseded -> archived is valid", () => {
    expect(canTransitionArtifactStatus("superseded", "archived")).toBe(true);
  });

  it("superseded -> active is invalid (no backward)", () => {
    expect(canTransitionArtifactStatus("superseded", "active")).toBe(false);
  });

  it("superseded -> superseded is invalid (same state)", () => {
    expect(canTransitionArtifactStatus("superseded", "superseded")).toBe(false);
  });

  it("archived is terminal — cannot transition to anything", () => {
    expect(canTransitionArtifactStatus("archived", "active")).toBe(false);
    expect(canTransitionArtifactStatus("archived", "superseded")).toBe(false);
    expect(canTransitionArtifactStatus("archived", "archived")).toBe(false);
  });
});

describe("isArtifactActive", () => {
  it("active is active", () => {
    expect(isArtifactActive("active")).toBe(true);
  });

  it("superseded is not active", () => {
    expect(isArtifactActive("superseded")).toBe(false);
  });

  it("archived is not active", () => {
    expect(isArtifactActive("archived")).toBe(false);
  });
});

describe("isArtifactVisible", () => {
  it("active is visible", () => {
    expect(isArtifactVisible("active")).toBe(true);
  });

  it("superseded is visible", () => {
    expect(isArtifactVisible("superseded")).toBe(true);
  });

  it("archived is not visible", () => {
    expect(isArtifactVisible("archived")).toBe(false);
  });
});
