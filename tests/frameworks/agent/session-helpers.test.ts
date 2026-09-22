import { describe, it, expect } from "vitest";
import { shouldInjectSessionPreamble } from "@frameworks/agent/session-helpers";

describe("shouldInjectSessionPreamble（F20260922ctxi 换世首轮判定）", () => {
  it("空 session（新世首轮）→ 注入前情", () => {
    expect(shouldInjectSessionPreamble([])).toBe(true);
  });

  it("仅有 assistant/toolResult（user 消息尚未持久化）→ 注入", () => {
    expect(shouldInjectSessionPreamble([
      { type: "message", id: "1", message: { role: "assistant" } },
      { type: "message", id: "2", message: { role: "toolResult" } },
    ])).toBe(true);
  });

  it("已有 user 消息（非首轮，历史里已有前情原文）→ 不再注入", () => {
    expect(shouldInjectSessionPreamble([
      { type: "message", id: "1", message: { role: "user" } },
      { type: "message", id: "2", message: { role: "assistant" } },
    ])).toBe(false);
  });

  it("非 message 类型条目不干扰判定", () => {
    expect(shouldInjectSessionPreamble([{ type: "session", id: "s" }])).toBe(true);
    expect(shouldInjectSessionPreamble([
      { type: "session", id: "s" },
      { type: "message", id: "m", message: { role: "user" } },
    ])).toBe(false);
  });
});
