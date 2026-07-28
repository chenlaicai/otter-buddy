import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachCircuitBreaker } from "@frameworks/agent/circuit-breaker-helpers";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@frameworks/agent/tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "@frameworks/agent/tool-call-circuit-breaker";
import type { Logger } from "@usecases/ports/logger";

function mockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => mockLogger(),
  };
}

/** 构造最小可用的 session mock：记录 subscribe 回调以便手动派发事件 */
function mockSession() {
  const handlers: Array<(event: unknown) => void> = [];
  return {
    steer: vi.fn<(text: string) => Promise<void>>(async () => {}),
    abort: vi.fn(async () => {}),
    subscribe(fn: (event: unknown) => void) {
      handlers.push(fn);
      return () => {
        const i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    emit(event: unknown) {
      for (const fn of handlers) fn(event);
    },
  };
}

/** 构造 pi-coding-agent SDK 形状的 tool_execution_start 事件（字段为 toolName） */
function sdkToolStart(toolName: string) {
  return { type: "tool_execution_start", toolCallId: `tc-${toolName}`, toolName, args: {} };
}

function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  return { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides };
}

describe("attachCircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("从 SDK 事件的 toolName 字段取工具名（回归：不同工具交替调用不触发连续相同误判）", () => {
    const session = mockSession();
    const { circuitBreaker } = attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      mockLogger(),
    );

    // 模拟真实工作负载：bash / read / edit 交替，远超 maxConsecutiveIdentical
    const tools = ["bash", "read", "edit"];
    for (let i = 0; i < 12; i++) {
      session.emit(sdkToolStart(tools[i % 3]));
    }

    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(circuitBreaker.getCallHistory()).toEqual(
      Array.from({ length: 12 }, (_, i) => tools[i % 3]),
    );
  });

  it("SDK 事件下同名单工具连续超限仍会 steer（不误伤真实检测能力）", () => {
    const session = mockSession();
    attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      mockLogger(),
    );

    for (let i = 0; i < 3; i++) session.emit(sdkToolStart("search_memory"));
    expect(session.steer).not.toHaveBeenCalled();

    session.emit(sdkToolStart("search_memory"));
    expect(session.steer).toHaveBeenCalledOnce();
    expect(session.steer.mock.calls[0][0]).toContain("search_memory");
  });

  it("兼容旧版 name 字段事件", () => {
    const session = mockSession();
    const { circuitBreaker } = attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig(),
      mockLogger(),
    );

    session.emit({ type: "tool_execution_start", name: "legacy_tool" });
    expect(circuitBreaker.getCallHistory()).toEqual(["legacy_tool"]);
  });

  it("字段缺失时兜底为 unknown", () => {
    const session = mockSession();
    const { circuitBreaker } = attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig(),
      mockLogger(),
    );

    session.emit({ type: "tool_execution_start" });
    expect(circuitBreaker.getCallHistory()).toEqual(["unknown"]);
  });

  it("terminate 动作调用 abort", () => {
    const session = mockSession();
    attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig({ maxToolCalls: 2, warningThreshold: 1 }),
      mockLogger(),
    );

    // maxToolCalls + 3 次内是 steer，第 maxToolCalls + 4 次 terminate
    for (let i = 0; i < 5; i++) session.emit(sdkToolStart(`tool_${i}`));
    expect(session.abort).not.toHaveBeenCalled();

    session.emit(sdkToolStart("tool_5"));
    expect(session.abort).toHaveBeenCalledOnce();
  });
});
