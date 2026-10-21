import { describe, it, expect } from "vitest";
import { shouldInjectSessionPreamble, buildMessageWithContext, TASK_BRIEF_FRESHNESS_REMINDER } from "@frameworks/agent/session-helpers";

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

describe("buildMessageWithContext（F20261021gtbf 换世任务简报时效提醒）", () => {
  it("换世首轮（带 sessionSummary）→ 注入时效提醒段（幽灵工单防御机制层）", () => {
    const out = buildMessageWithContext("", "用户消息", { sessionSummary: "前世档案正文" });
    expect(out).toContain("## 会话摘要\n前世档案正文");
    expect(out).toContain("## 任务简报时效提醒（换世核验）");
    expect(out).toContain("幽灵工单");
  });

  it("首世（无 sessionSummary）→ 不注入时效提醒段（任务简报是新鲜的）", () => {
    const out = buildMessageWithContext("", "用户消息", { workspacePath: "/tmp/ws" });
    expect(out).not.toContain("任务简报时效提醒");
  });

  it("无 dynamicContext（纯消息）→ 不注入时效提醒段", () => {
    const out = buildMessageWithContext("", "用户消息");
    expect(out).not.toContain("任务简报时效提醒");
    expect(out).toBe("用户消息");
  });

  it("拼装顺序不回归：会话摘要 → 时效提醒 → 用户消息殿后", () => {
    const out = buildMessageWithContext("", "用户消息", { sessionSummary: "S" });
    const iSummary = out.indexOf("## 会话摘要");
    const iReminder = out.indexOf("## 任务简报时效提醒");
    const iMsg = out.indexOf("用户消息");
    expect(iSummary).toBeGreaterThanOrEqual(0);
    expect(iReminder).toBeGreaterThan(iSummary);
    expect(iMsg).toBeGreaterThan(iReminder);
  });

  it("提醒文案不含 F/R 编号锚点（注入面 lint-prompt-anchors 口径）", () => {
    expect(TASK_BRIEF_FRESHNESS_REMINDER).not.toMatch(/F20\d{6}|R20\d{6}/);
  });
});
