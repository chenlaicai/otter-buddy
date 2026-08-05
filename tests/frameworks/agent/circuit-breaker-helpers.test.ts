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

/** 构造 pi-coding-agent SDK 形状的 tool_execution_end 事件 */
function sdkToolEnd(toolName: string) {
  return { type: "tool_execution_end", toolCallId: `tc-${toolName}`, toolName };
}

function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  return { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides };
}

describe("attachCircuitBreaker - 工具名识别与兼容", () => {
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
});

describe("attachCircuitBreaker - 终止策略与 abort 原因", () => {
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
});

describe("attachCircuitBreaker - per-event 超时（基础）", () => {
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

  it("per-event 超时：tool_execution_end 清除 timer，LLM 思考时间不计入", () => {
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

      // 第一次工具调用：执行 3 秒后完成
      session.emit(sdkToolStart("tool_1"));
      vi.advanceTimersByTime(3000);
      session.emit(sdkToolEnd("tool_1"));

      // LLM 思考 8 秒（超过阈值，但不计入 per-event 超时）
      vi.advanceTimersByTime(8000);
      expect(abortOverride).not.toHaveBeenCalled();

      // 第二次工具调用：执行 4 秒后完成
      session.emit(sdkToolStart("tool_2"));
      vi.advanceTimersByTime(4000);
      session.emit(sdkToolEnd("tool_2"));
      expect(abortOverride).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-event 超时：单次工具执行超过阈值即触发（不含思考时间）", () => {
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

      // 工具执行 4 秒后完成
      session.emit(sdkToolStart("tool_1"));
      vi.advanceTimersByTime(4000);
      session.emit(sdkToolEnd("tool_1"));

      // LLM 思考 3 秒
      vi.advanceTimersByTime(3000);

      // 第二次工具执行，这次超过阈值
      session.emit(sdkToolStart("tool_2"));
      vi.advanceTimersByTime(5001);
      expect(abortOverride).toHaveBeenCalledOnce();
      expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("attachCircuitBreaker - per-event 超时（清理）", () => {
  it("per-event 超时：unregisterToolCall 后 timer 不再触发", () => {
    vi.useFakeTimers();
    try {
      const session = mockSession();
      const abortOverride = vi.fn();
      const { unregisterToolCall } = attachCircuitBreaker(
        session,
        "otter-1",
        makeConfig({ maxPerEventTimeMs: 5000, maxToolCalls: 100, maxRepeatAfterWarning: 100 }),
        mockLogger(),
        abortOverride,
      );

      // 触发一次工具调用，启动 timer
      session.emit(sdkToolStart("tool_1"));
      // unregister 清除 timer
      unregisterToolCall?.();
      // 推进超过阈值，timer 不应触发
      vi.advanceTimersByTime(10000);
      expect(abortOverride).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-event 超时：clearEventTimer 可由外部调用清除 timer", () => {
    vi.useFakeTimers();
    try {
      const session = mockSession();
      const abortOverride = vi.fn();
      const { clearEventTimer } = attachCircuitBreaker(
        session,
        "otter-1",
        makeConfig({ maxPerEventTimeMs: 5000, maxToolCalls: 100, maxRepeatAfterWarning: 100 }),
        mockLogger(),
        abortOverride,
      );

      // 触发一次工具调用，启动 timer
      session.emit(sdkToolStart("tool_1"));
      // 外部调用 clearEventTimer（模拟 OutputGuard/用户 abort 场景）
      clearEventTimer();
      // 推进超过阈值，timer 不应触发
      vi.advanceTimersByTime(10000);
      expect(abortOverride).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("attachCircuitBreaker - per-event 超时（并行工具调用）", () => {
  it("per-event 超时：并行工具调用各自独立计时（issue #140）", () => {
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

      // 并行启动两个工具调用
      session.emit(sdkToolStart("tool_A"));
      session.emit(sdkToolStart("tool_B"));
      expect(abortOverride).not.toHaveBeenCalled();

      // tool_A 在 3 秒后完成
      vi.advanceTimersByTime(3000);
      session.emit(sdkToolEnd("tool_A"));
      expect(abortOverride).not.toHaveBeenCalled();

      // tool_B 在 4 秒后完成（总计 7 秒，超过阈值，但 tool_B 自己只执行了 4 秒）
      vi.advanceTimersByTime(1000);
      session.emit(sdkToolEnd("tool_B"));
      expect(abortOverride).not.toHaveBeenCalled();

      // 验证：两个工具都正常完成，没有触发超时
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-event 超时：并行工具调用中单个超时不影响其他（issue #140）", () => {
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

      // 并行启动两个工具调用
      session.emit(sdkToolStart("tool_A"));
      session.emit(sdkToolStart("tool_B"));
      expect(abortOverride).not.toHaveBeenCalled();

      // tool_A 正常完成（3 秒）
      vi.advanceTimersByTime(3000);
      session.emit(sdkToolEnd("tool_A"));
      expect(abortOverride).not.toHaveBeenCalled();

      // tool_B 超时（再过 3 秒，总计 6 秒超过阈值）
      vi.advanceTimersByTime(3001);
      expect(abortOverride).toHaveBeenCalledOnce();
      expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-event 超时：同一 toolCallId 重复 start 覆盖计时器（防御性）", () => {
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

      // 第一次 start
      session.emit(sdkToolStart("tool_1"));
      // 推进 3秒
      vi.advanceTimersByTime(3000);
      // 同一 toolCallId 重复 start（覆盖计时器）
      session.emit(sdkToolStart("tool_1"));
      // 再推进 3秒（总计 6秒，但第二次 start 后只过了 3秒）
      vi.advanceTimersByTime(3000);
      expect(abortOverride).not.toHaveBeenCalled();

      // 再推进 3秒（第二次 start 后共 6秒，超过阈值）
      vi.advanceTimersByTime(2001);
      expect(abortOverride).toHaveBeenCalledOnce();
      expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-event 超时：事件乱序（end 先于 start）不崩溃", () => {
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

      // 先发 end（toolCallId="tc-tool_1"）
      session.emit(sdkToolEnd("tool_1"));
      // 再发 start
      session.emit(sdkToolStart("tool_1"));
      // 推进超过阈值
      vi.advanceTimersByTime(5001);
      expect(abortOverride).toHaveBeenCalledOnce();
      expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-event 超时：terminate 清除所有并行计时器", () => {
    vi.useFakeTimers();
    try {
      const session = mockSession();
      const abortOverride = vi.fn();
      attachCircuitBreaker(
        session,
        "otter-1",
        makeConfig({ maxPerEventTimeMs: 5000, maxToolCalls: 2, maxRepeatAfterWarning: 100, maxConsecutiveIdentical: 100 }),
        mockLogger(),
        abortOverride,
      );

      // 并行启动两个工具
      session.emit(sdkToolStart("tool_A"));
      session.emit(sdkToolStart("tool_B"));
      // 超过 maxToolCalls + 3 触发 terminate
      session.emit(sdkToolStart("tool_C"));
      session.emit(sdkToolStart("tool_D"));
      session.emit(sdkToolStart("tool_E"));
      session.emit(sdkToolStart("tool_F"));
      expect(abortOverride).toHaveBeenCalledOnce();
      expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:tool_call_limit");

      // 推进超过阈值，验证没有二次 abort
      abortOverride.mockClear();
      vi.advanceTimersByTime(10000);
      expect(abortOverride).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-event 超时：toolCallId 缺失时记录警告并跳过计时器", () => {
    vi.useFakeTimers();
    try {
      const session = mockSession();
      const abortOverride = vi.fn();
      const logger = mockLogger();
      const warnSpy = vi.spyOn(logger, "warn");
      attachCircuitBreaker(
        session,
        "otter-1",
        makeConfig({ maxPerEventTimeMs: 5000, maxToolCalls: 100, maxRepeatAfterWarning: 100 }),
        logger,
        abortOverride,
      );

      // 发送缺少 toolCallId 的事件
      session.emit({ type: "tool_execution_start", toolName: "tool_1" });
      expect(warnSpy).toHaveBeenCalled();

      // 推进超过阈值，验证没有超时 abort
      vi.advanceTimersByTime(10000);
      expect(abortOverride).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("attachCircuitBreaker - steer 行为纠正", () => {
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
