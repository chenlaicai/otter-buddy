import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCircuitBreaker } from "@frameworks/agent/circuit-breaker-helpers";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@frameworks/agent/tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "@frameworks/agent/tool-call-circuit-breaker";
import { createTestLogger } from "../../helpers/logger";

function mockSession() {
  const handlers: Array<(event: unknown) => void> = [];
  return {
    abort: vi.fn(async () => {}),
    subscribe(fn: (event: unknown) => void) {
      handlers.push(fn);
      return () => {
        const index = handlers.indexOf(fn);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    emit(event: unknown) {
      for (const handler of handlers) handler(event);
    },
  };
}

function start(toolCallId: string, toolName: string, args: unknown = {}) {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function end(toolCallId: string, toolName: string) {
  return { type: "tool_execution_end", toolCallId, toolName };
}

function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  return { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides };
}

describe("attachCircuitBreaker - 工具显式 deadline 对齐（#1838）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(maxPerEventTimeMs = 600_000) {
    const session = mockSession();
    const abortOverride = vi.fn();
    attachCircuitBreaker(
      session,
      "otter-deadline",
      makeConfig({ maxPerEventTimeMs }),
      createTestLogger(),
      { abortOverride },
    );
    return { session, abortOverride };
  }

  it("bash timeout=1800 不在固定 600 秒被外层杀，工具完成后正常清理", () => {
    const { session, abortOverride } = setup();
    session.emit(start("bash-ci", "bash", { command: "gh pr checks --watch", timeout: 1800 }));

    vi.advanceTimersByTime(600_001);
    expect(abortOverride).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_199_999);
    session.emit(end("bash-ci", "bash"));
    vi.advanceTimersByTime(30_001);
    expect(abortOverride).not.toHaveBeenCalled();
  });

  it("bash timeout=600 自身到时可先返回结果，不与外层压线竞争", () => {
    const { session, abortOverride } = setup();
    session.emit(start("bash-self-timeout", "bash", { command: "npm test", timeout: 600 }));

    vi.advanceTimersByTime(600_000);
    session.emit(end("bash-self-timeout", "bash"));
    vi.advanceTimersByTime(30_000);

    expect(abortOverride).not.toHaveBeenCalled();
  });

  it("bash 自身到时后未收尾，外层在 30 秒裕量耗尽时仍中断", () => {
    const { session, abortOverride } = setup();
    session.emit(start("bash-no-cleanup", "bash", { command: "npm test", timeout: 600 }));

    vi.advanceTimersByTime(600_000);
    expect(abortOverride).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29_999);
    expect(abortOverride).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(abortOverride).toHaveBeenCalledOnce();
    expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
  });

  it("超大 bash timeout 受一小时加收尾裕量的总硬上限约束", () => {
    const { session, abortOverride } = setup();
    session.emit(start("bash-over-cap", "bash", { command: "npm test", timeout: 7200 }));

    vi.advanceTimersByTime(600_000);
    expect(abortOverride).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_029_999);
    expect(abortOverride).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(abortOverride).toHaveBeenCalledOnce();
    expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
  });

  it("wait 不读取 bash timeout 语义，不能成为看门狗逃逸通道", () => {
    const { session, abortOverride } = setup();
    session.emit(start("wait-long", "wait", { seconds: 3600, timeout: 1800 }));

    vi.advanceTimersByTime(600_000);
    expect(abortOverride).toHaveBeenCalledOnce();
    expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
  });

  it("非法 bash timeout 不延长默认硬兜底", () => {
    const { session, abortOverride } = setup();
    session.emit(start("bash-invalid", "bash", { command: "npm test", timeout: 0 }));

    vi.advanceTimersByTime(600_000);
    expect(abortOverride).toHaveBeenCalledOnce();
    expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
  });

  it("SDK 可 coerce 的数字字符串 timeout 与数字形态获得同一外层预算", () => {
    const { session, abortOverride } = setup();
    session.emit(start("bash-coerced", "bash", { command: "gh pr checks --watch", timeout: "1800" }));

    vi.advanceTimersByTime(600_001);
    expect(abortOverride).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_199_999);
    session.emit(end("bash-coerced", "bash"));
    vi.advanceTimersByTime(30_001);
    expect(abortOverride).not.toHaveBeenCalled();
  });

  it("非数字字符串 timeout 仍不延长默认硬兜底", () => {
    const { session, abortOverride } = setup();
    session.emit(start("bash-invalid-string", "bash", { command: "npm test", timeout: "not-a-number" }));

    vi.advanceTimersByTime(600_000);
    expect(abortOverride).toHaveBeenCalledOnce();
    expect(abortOverride.mock.calls[0][0]).toBe("circuit_break:event_timeout");
  });

  it("自定义 maxPerEventTimeMs 大于工具预算加裕量时保留配置下限", () => {
    const { session, abortOverride } = setup(900_000);
    session.emit(start("bash-custom-floor", "bash", { command: "npm test", timeout: 600 }));

    vi.advanceTimersByTime(630_000);
    expect(abortOverride).not.toHaveBeenCalled();
    vi.advanceTimersByTime(270_000);
    expect(abortOverride).toHaveBeenCalledOnce();
  });

  it("自定义 maxPerEventTimeMs 大于通用硬上限时不被反向截短", () => {
    const { session, abortOverride } = setup(4_000_000);
    session.emit(start("bash-custom-cap", "bash", { command: "npm test", timeout: 7200 }));

    vi.advanceTimersByTime(3_630_000);
    expect(abortOverride).not.toHaveBeenCalled();
    vi.advanceTimersByTime(370_000);
    expect(abortOverride).toHaveBeenCalledOnce();
  });

  it("较小自定义 maxPerEventTimeMs 仍可被合法工具预算和裕量延长", () => {
    const { session, abortOverride } = setup(10_000);
    session.emit(start("bash-small-default", "bash", { command: "npm test", timeout: 1 }));

    vi.advanceTimersByTime(10_000);
    expect(abortOverride).not.toHaveBeenCalled();
    vi.advanceTimersByTime(21_000);
    expect(abortOverride).toHaveBeenCalledOnce();
  });

  it("并行长 bash 与普通工具各自计时，普通工具 end 不清除长任务看门狗", () => {
    const { session, abortOverride } = setup();
    session.emit(start("bash-parallel", "bash", { command: "gh run watch", timeout: 1800 }));
    session.emit(start("read-parallel", "read", { path: "/tmp/a" }));

    vi.advanceTimersByTime(300_000);
    session.emit(end("read-parallel", "read"));
    vi.advanceTimersByTime(300_001);
    expect(abortOverride).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_199_999);
    session.emit(end("bash-parallel", "bash"));
    vi.advanceTimersByTime(30_001);
    expect(abortOverride).not.toHaveBeenCalled();
  });
});
