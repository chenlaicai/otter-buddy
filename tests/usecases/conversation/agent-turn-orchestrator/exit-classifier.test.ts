import { describe, it, expect } from "vitest";
import { classifyExit, extractGuardReason } from "@usecases/conversation/agent-turn-orchestrator/exit-classifier";

describe("classifyExit", () => {
  const noAbort = new Set<string>();
  const noInternalReason = () => undefined;

  it("消息在 userAbortedMessages 中 → user_abort", () => {
    const aborted = new Set(["msg-1"]);
    const reason = classifyExit(
      { messageId: "msg-1", toolCallCount: 0 },
      aborted,
      noInternalReason,
    );
    expect(reason.kind).toBe("user_abort");
  });

  it("user_abort + 底层有 err → underlyingError 为 api_error", () => {
    const aborted = new Set(["msg-1"]);
    const err = new Error("429 Too Many Requests");
    const reason = classifyExit(
      { messageId: "msg-1", result: { text: "" }, err, toolCallCount: 0 },
      aborted,
      noInternalReason,
    );
    expect(reason.kind).toBe("user_abort");
    if (reason.kind === "user_abort") {
      expect(reason.underlyingError).toBeDefined();
      expect(reason.underlyingError?.kind).toBe("api_error");
      if (reason.underlyingError?.kind === "api_error") {
        expect(reason.underlyingError.errorMessage).toContain("429");
      }
    }
  });

  it("user_abort + 底层有 guardReason → underlyingError 为 guard_abort", () => {
    const aborted = new Set(["msg-1"]);
    const reason = classifyExit(
      { messageId: "msg-1", result: { text: "" }, toolCallCount: 0 },
      aborted,
      () => "streaming_timeout",
    );
    expect(reason.kind).toBe("user_abort");
    if (reason.kind === "user_abort") {
      expect(reason.underlyingError).toBeDefined();
      expect(reason.underlyingError?.kind).toBe("guard_abort");
      if (reason.underlyingError?.kind === "guard_abort") {
        expect(reason.underlyingError.guardReason).toBe("streaming_timeout");
      }
    }
  });

  it("user_abort + toolCallCount=0 无 err 无 guardReason → underlyingError 为 no_yield", () => {
    const aborted = new Set(["msg-1"]);
    const reason = classifyExit(
      { messageId: "msg-1", result: { text: "" }, toolCallCount: 0 },
      aborted,
      noInternalReason,
    );
    expect(reason.kind).toBe("user_abort");
    if (reason.kind === "user_abort") {
      expect(reason.underlyingError).toBeDefined();
      expect(reason.underlyingError?.kind).toBe("no_yield");
    }
  });

  it("user_abort + toolCallCount>0 无 err → underlyingError 为 undefined（正常执行中被中断）", () => {
    const aborted = new Set(["msg-1"]);
    const reason = classifyExit(
      { messageId: "msg-1", result: { text: "" }, toolCallCount: 5 },
      aborted,
      noInternalReason,
    );
    expect(reason.kind).toBe("user_abort");
    if (reason.kind === "user_abort") {
      expect(reason.underlyingError).toBeUndefined();
    }
  });

  it("未中止 + guardReason 存在 → guard_abort", () => {
    const reason = classifyExit(
      { messageId: "msg-1", result: { text: "" }, toolCallCount: 0 },
      noAbort,
      () => "bash_safety:kill",
    );
    expect(reason.kind).toBe("guard_abort");
  });

  it("未中止 + 无 guardReason + 有 err → api_error", () => {
    const reason = classifyExit(
      { messageId: "msg-1", result: { text: "" }, err: new Error("500"), toolCallCount: 0 },
      noAbort,
      noInternalReason,
    );
    expect(reason.kind).toBe("api_error");
  });

  it("未中止 + 无 guardReason + 无 err → no_yield", () => {
    const reason = classifyExit(
      { messageId: "msg-1", result: { text: "" }, toolCallCount: 3 },
      noAbort,
      noInternalReason,
    );
    expect(reason.kind).toBe("no_yield");
  });
});

describe("extractGuardReason", () => {
  it("从 result._guardAbortReason 提取", () => {
    const reason = extractGuardReason(
      "msg-1",
      { _guardAbortReason: "streaming_timeout" } as unknown,
      undefined,
      () => undefined,
    );
    expect(reason).toBe("streaming_timeout");
  });

  it("从 err._guardAbortReason 提取", () => {
    const err = new Error("test") as Error & { _guardAbortReason?: string };
    err._guardAbortReason = "circuit_break:max_retries";
    const reason = extractGuardReason("msg-1", undefined, err, () => undefined);
    expect(reason).toBe("circuit_break:max_retries");
  });

  it("从 getInternalAbortReason 提取", () => {
    const reason = extractGuardReason(
      "msg-1",
      undefined,
      undefined,
      () => "degenerate_output",
    );
    expect(reason).toBe("degenerate_output");
  });

  it("无任何 guardReason → undefined", () => {
    const reason = extractGuardReason(
      "msg-1",
      undefined,
      undefined,
      () => undefined,
    );
    expect(reason).toBeUndefined();
  });
});
