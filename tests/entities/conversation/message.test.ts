import { describe, it, expect } from "vitest";
import {
  isValidTalkingStonePass,
  isValidCompletedMessageTalkingStone,
} from "../../../src/entities/conversation/message";

describe("isValidTalkingStonePass", () => {
  it("returns true for non-empty array", () => {
    expect(isValidTalkingStonePass(["otter-A"])).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(isValidTalkingStonePass([])).toBe(false);
  });
});

describe("isValidCompletedMessageTalkingStone", () => {
  it("returns true for non-empty array", () => {
    expect(isValidCompletedMessageTalkingStone(["otter-A"])).toBe(true);
  });

  it("returns false for null", () => {
    expect(isValidCompletedMessageTalkingStone(null)).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(isValidCompletedMessageTalkingStone([])).toBe(false);
  });
});
