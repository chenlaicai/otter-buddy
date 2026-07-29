import { describe, it, expect, vi } from "vitest";
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
function sdkToolStart(toolName: string, args: unknown = {}) {
  return { type: "tool_execution_start", toolCallId: `tc-${toolName}`, toolName, args };
}

function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  return { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides };
}

describe("attachCircuitBreaker", () => {
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

  it("bash 连击不同命令不触发 steer（t002 事故现场复现：排查式工作序列）", () => {
    const session = mockSession();
    attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig({ maxConsecutiveIdentical: 3, maxToolCalls: 100 }),
      mockLogger(),
    );

    const commands = [
      "git status",
      "git add package-lock.json && git commit -m a",
      "git branch --show-current",
      "git checkout -b fix/x && git add y && git commit -m b",
      "git branch -D fix/x && git checkout -b fix/x && git commit -m c",
      "cat .husky/commit-msg",
      "ls .githooks",
    ];
    for (const command of commands) {
      session.emit(sdkToolStart("bash", { command }));
    }

    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
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

  it("abortOverride 收到 circuit_break:<trigger> 作为 abort 原因", () => {
    const session = mockSession();
    const abortOverride = vi.fn();
    attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig({ maxConsecutiveIdentical: 1, maxRepeatAfterWarning: 1, maxToolCalls: 100 }),
      mockLogger(),
      abortOverride,
    );

    const stuck = () => session.emit(sdkToolStart("bash", { command: "git commit -m x" }));
    stuck(); // allow
    stuck(); // steer（strike 1）
    stuck(); // strike 2 > 1 → terminate

    expect(abortOverride).toHaveBeenCalledOnce();
    expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:ignored_steer");
  });

  it("tool_call_limit 硬顶 terminate 的原因为 circuit_break:tool_call_limit", () => {
    const session = mockSession();
    const abortOverride = vi.fn();
    attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig({ maxToolCalls: 2, warningThreshold: 100, maxRepeatAfterWarning: 100 }),
      mockLogger(),
      abortOverride,
    );

    for (let i = 0; i < 6; i++) session.emit(sdkToolStart(`tool_${i}`));

    expect(abortOverride).toHaveBeenCalledOnce();
    expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:tool_call_limit");
  });

  it("per-event 超时：单次工具调用超时触发 abort(event_timeout)", () => {
    vi.useFakeTimers();
    try {
      const session = mockSession();
      const abortOverride = vi.fn();
      attachCircuitBreaker(
        session,
        "otter-1",
        makeConfig({ maxPerEventTimeMs: 5000, maxToolCalls: 100, maxRepeatAfterWarning: 100 }),
        mockLogger(),
        abortOverride,
      );

      // 触发一次工具调用，启动 timer
      session.emit(sdkToolStart("tool_1"));
      expect(abortOverride).not.toHaveBeenCalled();

      // 推进时间到超时阈值
      vi.advanceTimersByTime(5001);
      expect(abortOverride).toHaveBeenCalledOnce();
      expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-event 超时：下一次工具调用重置 timer，不误触发", () => {
    vi.useFakeTimers();
    try {
      const session = mockSession();
      const abortOverride = vi.fn();
      attachCircuitBreaker(
        session,
        "otter-1",
        makeConfig({ maxPerEventTimeMs: 5000, maxToolCalls: 100, maxRepeatAfterWarning: 100 }),
        mockLogger(),
        abortOverride,
      );

      // 第一次调用
      session.emit(sdkToolStart("tool_1"));
      // 推进 4 秒（未超时）
      vi.advanceTimersByTime(4000);
      // 第二次调用重置 timer
      session.emit(sdkToolStart("tool_2"));
      // 再推进 4 秒（从第二次算起未超时）
      vi.advanceTimersByTime(4000);
      expect(abortOverride).not.toHaveBeenCalled();

      // 再推进 2 秒（从第二次算起共 6 秒，超过 5 秒阈值）
      vi.advanceTimersByTime(2000);
      expect(abortOverride).toHaveBeenCalledOnce();
      expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("steer 后行为纠正则不再 abort（事件驱动，无死亡定时器）", () => {
    const session = mockSession();
    attachCircuitBreaker(
      session,
      "otter-1",
      makeConfig({ maxConsecutiveIdentical: 2, maxRepeatAfterWarning: 1, maxToolCalls: 100 }),
      mockLogger(),
    );

    session.emit(sdkToolStart("bash", { command: "git commit -m x" }));
    session.emit(sdkToolStart("bash", { command: "git commit -m x" }));
    session.emit(sdkToolStart("bash", { command: "git commit -m x" })); // steer
    expect(session.steer).toHaveBeenCalledOnce();

    // 纠正：换命令继续工作，随后大量正常调用也不触发 terminate
    session.emit(sdkToolStart("bash", { command: "git status" }));
    for (let i = 0; i < 10; i++) session.emit(sdkToolStart("read", { path: `/f${i}.ts` }));
    expect(session.abort).not.toHaveBeenCalled();
  });
});
