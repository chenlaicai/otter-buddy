import { describe, it, expect } from "vitest";
import {
  isValidTalkingStonePass,
} from "../../../src/entities/conversation/message";

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
});
