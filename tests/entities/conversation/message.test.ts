import { describe, it, expect } from "vitest";
import {
  isValidTalkingStonePass,
  isTerminalMessageStatus,
  canAbortMessage,
} from "../../../src/entities/conversation/message";

describe("isTerminalMessageStatus", () => {
  it("completed, failed, aborted are terminal", () => {
    expect(isTerminalMessageStatus("completed")).toBe(true);
    expect(isTerminalMessageStatus("failed")).toBe(true);
    expect(isTerminalMessageStatus("aborted")).toBe(true);
  });

  it("streaming is not terminal", () => {
    expect(isTerminalMessageStatus("streaming")).toBe(false);
  });
});

describe("canAbortMessage", () => {
  it("only streaming can be aborted", () => {
    expect(canAbortMessage("streaming")).toBe(true);
    expect(canAbortMessage("completed")).toBe(false);
    expect(canAbortMessage("failed")).toBe(false);
    expect(canAbortMessage("aborted")).toBe(false);
  });
});

describe("isValidTalkingStonePass", () => {
  it("system sender is always exempt", () => {
    expect(isValidTalkingStonePass([], "completed", "system")).toBe(true);
    expect(isValidTalkingStonePass(null, "completed", "system")).toBe(true);
    expect(isValidTalkingStonePass([], "streaming", "system")).toBe(true);
  });

  it("streaming/failed allows null or empty", () => {
    expect(isValidTalkingStonePass(null, "streaming", "otter")).toBe(true);
    expect(isValidTalkingStonePass([], "streaming", "otter")).toBe(true);
    expect(isValidTalkingStonePass(null, "failed", "user")).toBe(true);
    expect(isValidTalkingStonePass([], "failed", "user")).toBe(true);
  });

  it("completed (user/otter) requires non-null non-empty", () => {
    expect(isValidTalkingStonePass(["otter-A"], "completed", "user")).toBe(true);
    expect(isValidTalkingStonePass(["otter-A"], "completed", "otter")).toBe(true);
    expect(isValidTalkingStonePass(null, "completed", "user")).toBe(false);
    expect(isValidTalkingStonePass([], "completed", "otter")).toBe(false);
  });

  it("aborted (user/otter) requires non-null non-empty (same as completed)", () => {
    expect(isValidTalkingStonePass(["user-1"], "aborted", "otter")).toBe(true);
    expect(isValidTalkingStonePass(null, "aborted", "otter")).toBe(false);
    expect(isValidTalkingStonePass([], "aborted", "otter")).toBe(false);
  });

  it("aborted system sender is exempt", () => {
    expect(isValidTalkingStonePass([], "aborted", "system")).toBe(true);
    expect(isValidTalkingStonePass(null, "aborted", "system")).toBe(true);
  });
});
