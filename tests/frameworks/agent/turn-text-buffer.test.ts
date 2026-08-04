import { describe, it, expect } from "vitest";
import { updateTurnText, extractAssistantTextFromMessageEnd, type AgentEvent } from "@frameworks/agent/pi-session-factory";

/** F20260804hcob: speak 外卡片检测的接线层——缓冲按 assistant 消息维护（message_start 清零、message_end 累积） */
describe("updateTurnText（speak 外卡片检测接线）", () => {
  const assistantTextMsg = (text: string): AgentEvent => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

  it("message_end 累积 assistant 文本块", () => {
    const buf = { text: "" };
    updateTurnText(buf, assistantTextMsg("第一段"));
    updateTurnText(buf, assistantTextMsg("第二段"));
    expect(buf.text).toBe("第一段\n第二段");
  });

  it("assistant message_start 清零缓冲：上一条消息的 stray 围栏不污染下一条（防误拒/livelock）", () => {
    const buf = { text: "" };
    updateTurnText(buf, assistantTextMsg("```html-card title=\"草稿\"\n<div>x</div>\n```"));
    updateTurnText(buf, { type: "message_start", message: { role: "assistant", content: [] } });
    expect(buf.text).toBe("");
    updateTurnText(buf, assistantTextMsg("没有卡片的普通文本"));
    expect(buf.text).toBe("没有卡片的普通文本");
  });

  it("user / toolResult 的 message_start 不清零，message_end 不累积", () => {
    const buf = { text: "已有" };
    updateTurnText(buf, { type: "message_start", message: { role: "user", content: [] } });
    expect(buf.text).toBe("已有");
    updateTurnText(buf, { type: "message_start", message: { role: "toolResult", content: [] } });
    expect(buf.text).toBe("已有");
    updateTurnText(buf, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "用户话" }] } });
    updateTurnText(buf, { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "工具结果" }] } });
    expect(buf.text).toBe("已有");
  });

  it("与 speak 同消息的文本在 message_end 时已入缓冲（SDK 事件顺序：message_end 先于工具执行）", () => {
    const buf = { text: "" };
    updateTurnText(buf, { type: "message_start", message: { role: "assistant", content: [] } });
    updateTurnText(buf, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "```html-card title=\"方案\"\n<div>x</div>\n```" },
          { type: "toolCall", name: "speak", arguments: { body: "摘要" } },
        ],
      },
    });
    expect(buf.text).toContain("```html-card");
  });

  it("assistantMessageEvent 形状（message_update 同款包装）也能提取", () => {
    const buf = { text: "" };
    updateTurnText(buf, {
      type: "message_end",
      assistantMessageEvent: { role: "assistant", content: [{ type: "text", text: "包装形态" }] },
    });
    expect(buf.text).toBe("包装形态");
  });
});

describe("extractAssistantTextFromMessageEnd", () => {
  it("无 content / 非文本块时返回空串", () => {
    expect(extractAssistantTextFromMessageEnd({ type: "message_end" })).toBe("");
    expect(extractAssistantTextFromMessageEnd({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "toolCall", name: "speak" }] },
    })).toBe("");
  });
});
