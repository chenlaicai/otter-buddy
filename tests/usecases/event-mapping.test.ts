import { describe, it, expect } from "vitest";
import { mapToInvokeEventInput, mapToSSEEvent } from "@usecases/conversation/agent-turn-orchestrator/event-mapping";

/**
 * F20260918sesp：message_start(role=user) → user_injection 落库映射验证。
 * pi 源码锚点：agent-session._handleAgentEvent 对 steering/followUp 出队后的
 * user 消息照发 message_start（steer/followUp/触发 prompt 三态同路）。
 */

describe("mapToInvokeEventInput · user_injection（F20260918sesp）", () => {
  it("message_start role=user（content 块数组）→ user_injection，content 拼接", () => {
    const r = mapToInvokeEventInput({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "【急讯 msg:1】来自 chen：先停一下" }], timestamp: 1_723_000_000_000 },
    } as never);
    expect(r).toEqual({
      eventType: "user_injection",
      payload: { content: "【急讯 msg:1】来自 chen：先停一下", timestamp: 1_723_000_000_000 },
    });
  });

  it("message_start role=user（content 字符串形态）→ user_injection", () => {
    const r = mapToInvokeEventInput({
      type: "message_start",
      message: { role: "user", content: "触发本次 invoke 的首条 prompt" },
    } as never);
    expect(r).toMatchObject({ eventType: "user_injection", payload: { content: "触发本次 invoke 的首条 prompt" } });
  });

  it("message_start role=assistant → null（不落库，与既有行为一致）", () => {
    const r = mapToInvokeEventInput({
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "…" }] },
    } as never);
    expect(r).toBeNull();
  });

  it("queue_update → null（不落库——与 message_start 必然重复，见特性文档取舍）", () => {
    const r = mapToInvokeEventInput({
      type: "queue_update",
      steering: ["x"],
      followUp: [],
    } as never);
    expect(r).toBeNull();
  });
});

describe("mapToSSEEvent · user 侧事件不广播（F20260918sesp）", () => {
  it("message_start(user) 不进 SSE 广播（仅落库，Session 弹窗独享）", () => {
    expect(
      mapToSSEEvent({
        type: "message_start",
        message: { role: "user", content: "x" },
      } as never),
    ).toBeNull();
  });
});

describe("mapToInvokeEventInput · message_start 边界（检视建议 1）", () => {
  it("message_start role=toolResult → null", () => {
    const r = mapToInvokeEventInput({
      type: "message_start",
      message: { role: "toolResult", content: [{ type: "toolResult", toolCallId: "t1" }] },
    } as never);
    expect(r).toBeNull();
  });

  it("message_start role=user content=[] → 空字符串（防御性，不崩）", () => {
    const r = mapToInvokeEventInput({
      type: "message_start",
      message: { role: "user", content: [] },
    } as never);
    expect(r).toMatchObject({ eventType: "user_injection", payload: { content: "" } });
  });
});
