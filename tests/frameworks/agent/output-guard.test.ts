import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OutputGuard,
  DEFAULT_OUTPUT_GUARD_CONFIG,
  attachOutputGuard,
} from "@frameworks/agent/output-guard";
import type { OutputGuardConfig } from "@frameworks/agent/output-guard";
import type { Logger } from "@usecases/ports/logger";

function makeConfig(overrides?: Partial<OutputGuardConfig>): OutputGuardConfig {
  return { ...DEFAULT_OUTPUT_GUARD_CONFIG, ...overrides };
}

function mockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => mockLogger(),
  };
}

/** 生成 N 段各不相同的 100 字符文本 */
function uniqueDeltas(count: number, segmentLength = 100): string {
  let result = "";
  for (let i = 0; i < count; i++) {
    result += String(i).padStart(segmentLength, "x");
  }
  return result;
}

describe("OutputGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("degenerate output detection", () => {
    it("does not trigger on normal unique output (T-1)", () => {
      const guard = new OutputGuard(makeConfig(), "otter-1", mockLogger());
      const abort = vi.fn();

      // Feed unique segments
      const text = uniqueDeltas(30);
      const tripped = guard.check(text, abort);

      expect(tripped).toBe(false);
      expect(abort).not.toHaveBeenCalled();
    });

    it("triggers abort on degenerate repetition (T-2)", () => {
      const guard = new OutputGuard(
        makeConfig({ segmentLength: 100, maxRepeatedSegments: 5, checkInterval: 5 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();
      const segment = "A".repeat(100);

      // Feed 4 identical segments (100 chars each) — below threshold
      for (let i = 0; i < 4; i++) {
        expect(guard.check(segment, abort)).toBe(false);
      }

      // 5th identical segment — triggers check at checkInterval=5
      expect(guard.check(segment, abort)).toBe(true);
      expect(abort).toHaveBeenCalled();
    });

    it("does not trigger when repetition is below threshold (T-3)", () => {
      const guard = new OutputGuard(
        makeConfig({ segmentLength: 100, maxRepeatedSegments: 5, checkInterval: 5 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();
      const segment = "B".repeat(100);

      // Feed 4 identical segments (checkInterval=5, so check runs on 5th)
      for (let i = 0; i < 4; i++) {
        guard.check(segment, abort);
      }

      // 5th segment is different — resets the pattern
      const different = "C".repeat(100);
      expect(guard.check(different, abort)).toBe(false);
      expect(abort).not.toHaveBeenCalled();
    });

    it("checkInterval gates repetition checks (T-10)", () => {
      const guard = new OutputGuard(
        makeConfig({ segmentLength: 50, maxRepeatedSegments: 3, checkInterval: 3 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();
      const segment = "D".repeat(50);

      // First 2 segments — no check yet (checkInterval=3)
      expect(guard.check(segment, abort)).toBe(false);
      expect(guard.check(segment, abort)).toBe(false);

      // 3rd segment — check runs, count=3 >= threshold of 3 → triggers
      expect(guard.check(segment, abort)).toBe(true);
      expect(abort).toHaveBeenCalled();
    });

    it("short deltas accumulate correctly (T-11)", () => {
      const guard = new OutputGuard(
        makeConfig({ segmentLength: 100, maxRepeatedSegments: 3, checkInterval: 2 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();
      const chunk = "E".repeat(10);

      // Feed 10 chunks of 10 chars = 1 segment (100 E's)
      for (let i = 0; i < 10; i++) {
        guard.check(chunk, abort);
      }

      // Feed 10 more identical chunks = 2nd segment, check at checkCount=2
      // occurrences = 2 < 3, not triggered
      expect(guard.check(chunk.repeat(10), abort)).toBe(false);

      // Feed 10 more = 3rd segment, no check (checkCount=3, 3 % 2 !== 0)
      guard.check(chunk.repeat(10), abort);

      // Feed 10 more = 4th segment, check at checkCount=4
      // occurrences = 4 >= 3 → triggers
      expect(guard.check(chunk.repeat(10), abort)).toBe(true);
      expect(abort).toHaveBeenCalled();
    });

    it("disabled config skips detection (T-7)", () => {
      const guard = new OutputGuard(
        makeConfig({ enabled: false }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();
      const segment = "F".repeat(100);

      // Even with massive repetition, should not trigger
      const result = guard.check(segment.repeat(100), abort);
      expect(result).toBe(false);
      expect(abort).not.toHaveBeenCalled();
    });
  });

  describe("streaming timeout", () => {
    it("fires abort after streamingTimeoutMs (T-4)", () => {
      const guard = new OutputGuard(
        makeConfig({ streamingTimeoutMs: 5000 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();

      // First check starts the timer
      guard.check("hello", abort);
      expect(abort).not.toHaveBeenCalled();

      // Advance past timeout
      vi.advanceTimersByTime(5001);
      expect(abort).toHaveBeenCalled();

      const meta = guard.getMetadata();
      expect(meta.tripped).toBe(true);
      expect(meta.reason).toBe("streaming_timeout");
    });

    it("resets timer on new content (T-5)", () => {
      const guard = new OutputGuard(
        makeConfig({ streamingTimeoutMs: 5000 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();

      guard.check("first", abort);
      vi.advanceTimersByTime(3000);

      // New content resets timer
      guard.check("second", abort);
      vi.advanceTimersByTime(3000);

      // Original deadline (5s from first) would have fired, but timer was reset
      expect(abort).not.toHaveBeenCalled();

      // Now advance past new deadline (5s from second)
      vi.advanceTimersByTime(2001);
      expect(abort).toHaveBeenCalled();
    });

    it("destroy() clears timer (T-6)", () => {
      const guard = new OutputGuard(
        makeConfig({ streamingTimeoutMs: 5000 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();

      guard.check("hello", abort);
      guard.destroy();

      vi.advanceTimersByTime(10000);
      expect(abort).not.toHaveBeenCalled();
    });
  });

  describe("tool execution pause", () => {
    it("pauseTimer prevents timeout during tool execution", () => {
      const guard = new OutputGuard(
        makeConfig({ streamingTimeoutMs: 5000 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();

      // Start streaming
      guard.check("hello", abort);

      // Tool execution starts — pause timer
      guard.pauseTimer();

      // Advance well past timeout
      vi.advanceTimersByTime(20000);
      expect(abort).not.toHaveBeenCalled();

      // New message_update after tool execution resumes timer
      guard.check("world", abort);
      vi.advanceTimersByTime(5001);
      expect(abort).toHaveBeenCalled();
    });
  });

  describe("metadata", () => {
    it("reports tripped state for degenerate output (T-8)", () => {
      const guard = new OutputGuard(
        makeConfig({ segmentLength: 50, maxRepeatedSegments: 2, checkInterval: 2 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();
      const seg = "G".repeat(50);

      guard.check(seg, abort);
      guard.check(seg, abort); // triggers

      const meta = guard.getMetadata();
      expect(meta.tripped).toBe(true);
      expect(meta.reason).toBe("degenerate_output");
    });

    it("reports totalLength correctly", () => {
      const guard = new OutputGuard(makeConfig(), "otter-1", mockLogger());
      const abort = vi.fn();

      guard.check("hello", abort);
      guard.check("world", abort);

      expect(guard.getMetadata().totalLength).toBe(10);
    });
  });

  describe("consecutive check returns true after trip", () => {
    it("returns true immediately after tripping", () => {
      const guard = new OutputGuard(
        makeConfig({ segmentLength: 50, maxRepeatedSegments: 2, checkInterval: 2 }),
        "otter-1",
        mockLogger(),
      );
      const abort = vi.fn();
      const seg = "H".repeat(50);

      guard.check(seg, abort);
      guard.check(seg, abort); // trips

      // Subsequent checks return true immediately
      expect(guard.check(seg, abort)).toBe(true);
      expect(guard.check("anything", abort)).toBe(true);
    });
  });
});

describe("attachOutputGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns noop when disabled (T-12)", () => {
    const session = {
      subscribe: vi.fn(),
    };
    const onAbort = vi.fn();

    const { guard, cleanup } = attachOutputGuard(
      session,
      "otter-1",
      makeConfig({ enabled: false }),
      mockLogger(),
      onAbort,
    );

    expect(guard).toBeInstanceOf(OutputGuard);
    // cleanup 应该是空操作（不会抛错）
    expect(() => cleanup()).not.toThrow();
    expect(session.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes to session events when enabled (T-13)", () => {
    const session = {
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    const onAbort = vi.fn();

    const { guard, cleanup } = attachOutputGuard(
      session,
      "otter-1",
      makeConfig(),
      mockLogger(),
      onAbort,
    );

    expect(guard).toBeInstanceOf(OutputGuard);
    expect(typeof cleanup).toBe("function");
  });

  it("calls onAbort on degenerate output via message_update (T-14)", () => {
    let handler: (event: unknown) => void = () => {};
    const session = {
      subscribe: vi.fn((fn: (event: unknown) => void) => { handler = fn; return () => {}; }),
    };
    const onAbort = vi.fn();

    attachOutputGuard(
      session,
      "otter-1",
      makeConfig({ segmentLength: 50, maxRepeatedSegments: 2, checkInterval: 2 }),
      mockLogger(),
      onAbort,
    );

    const seg = "I".repeat(50);
    handler({ type: "message_update", delta: seg });
    handler({ type: "message_update", delta: seg });

    expect(onAbort).toHaveBeenCalled();
  });

  it("ignores non-message_update events (T-15)", () => {
    let handler: (event: unknown) => void = () => {};
    const session = {
      subscribe: vi.fn((fn: (event: unknown) => void) => { handler = fn; return () => {}; }),
    };
    const onAbort = vi.fn();

    attachOutputGuard(
      session,
      "otter-1",
      makeConfig({ streamingTimeoutMs: 1000 }),
      mockLogger(),
      onAbort,
    );

    // Non-message_update events should not start timer or trigger checks
    handler({ type: "tool_execution_start", name: "bash" });
    handler({ type: "tool_execution_end", name: "bash" });
    handler({ type: "message_end" });

    expect(onAbort).not.toHaveBeenCalled();
  });

  it("pauses timer on tool_execution_start", () => {
    let handler: (event: unknown) => void = () => {};
    const session = {
      subscribe: vi.fn((fn: (event: unknown) => void) => { handler = fn; return () => {}; }),
    };
    const onAbort = vi.fn();

    attachOutputGuard(
      session,
      "otter-1",
      makeConfig({ streamingTimeoutMs: 3000 }),
      mockLogger(),
      onAbort,
    );

    // Start streaming
    handler({ type: "message_update", delta: "hello" });

    // Tool starts — should pause timer
    handler({ type: "tool_execution_start", name: "bash" });

    // Advance past timeout — timer is paused, no abort
    vi.advanceTimersByTime(5000);
    expect(onAbort).not.toHaveBeenCalled();

    // tool_execution_end resumes the timer
    handler({ type: "tool_execution_end", name: "bash" });

    // Remaining time fires abort
    vi.advanceTimersByTime(3001);
    expect(onAbort).toHaveBeenCalled();
  });

  it("resumes timer on message_update if no tool_execution_end", () => {
    let handler: (event: unknown) => void = () => {};
    const session = {
      subscribe: vi.fn((fn: (event: unknown) => void) => { handler = fn; return () => {}; }),
    };
    const onAbort = vi.fn();

    attachOutputGuard(
      session,
      "otter-1",
      makeConfig({ streamingTimeoutMs: 3000 }),
      mockLogger(),
      onAbort,
    );

    handler({ type: "message_update", delta: "start" });
    handler({ type: "tool_execution_start", name: "bash" });

    // Timer paused — no abort even after timeout
    vi.advanceTimersByTime(5000);
    expect(onAbort).not.toHaveBeenCalled();

    // message_update resets the timer entirely
    handler({ type: "message_update", delta: "end" });
    vi.advanceTimersByTime(3001);
    expect(onAbort).toHaveBeenCalled();
  });
});
