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

/** mulberry32 伪随机：生成每个 100 字符窗口都唯一的文本（阴性喂入） */
function randomText(length: number, seed = 42): string {
  let a = seed;
  const rand = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = "abcdefghijklmnop";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

/** SDK 真实事件形状：delta 在 assistantMessageEvent 内层（F20260804dglp 根因 2） */
function updateEvent(deltaType: string, delta: string) {
  return { type: "message_update", assistantMessageEvent: { type: deltaType, delta } };
}

describe("OutputGuard 退化检测", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("text_delta 精确重复触发 abort（机制 A）", () => {
    const guard = new OutputGuard(makeConfig(), "otter-1", mockLogger());
    const abort = vi.fn();
    const unit = "Good, the first commit is done. Now let me speak to the user with the progress update. ";

    let tripped = false;
    for (let i = 0; i < 200 && !tripped; i++) {
      tripped = guard.onDelta(unit, "text_delta", abort);
    }
    expect(tripped).toBe(true);
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("degenerate_output");
  });

  it("thinking_delta 同样进重复检测（4e8c3ff3 型防护）", () => {
    const guard = new OutputGuard(makeConfig(), "otter-1", mockLogger());
    const abort = vi.fn();
    const unit = "Let me reconsider the approach again and rethink the whole plan once more. ";

    let tripped = false;
    for (let i = 0; i < 300 && !tripped; i++) {
      tripped = guard.onDelta(unit, "thinking_delta", abort);
    }
    expect(tripped).toBe(true);
    expect(abort).toHaveBeenCalled();
  });

  it("toolcall_delta 只作活跃信号，不进重复检测（合法大文件写入防误伤）", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 5000 }), "otter-1", mockLogger());
    const abort = vi.fn();
    // 大量重复的 toolcall 参数流（合法写文件场景）：不应判退化
    const repeatedArgs = `{"content":"${"x".repeat(500)}"}`;
    for (let i = 0; i < 500; i++) {
      expect(guard.onDelta(repeatedArgs, "toolcall_delta", abort)).toBe(false);
    }
    expect(abort).not.toHaveBeenCalled();
    expect(guard.getMetadata().reason).not.toBe("degenerate_output");
  });

  it("正常文本不触发", () => {
    const guard = new OutputGuard(makeConfig(), "otter-1", mockLogger());
    const abort = vi.fn();
    expect(guard.onDelta(randomText(50_000), "text_delta", abort)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it("text_start/thinking_start 重置检测器块边界", () => {
    const guard = new OutputGuard(makeConfig(), "otter-1", mockLogger());
    const abort = vi.fn();
    guard.onDelta("q".repeat(500), "text_delta", abort);
    expect(guard.getMetadata().totalLength).toBe(500);
    guard.onBlockBoundary();
    expect(guard.getMetadata().totalLength).toBe(0);
  });

  it("disabled 时不检测", () => {
    const guard = new OutputGuard(makeConfig({ enabled: false }), "otter-1", mockLogger());
    const abort = vi.fn();
    const unit = "F".repeat(100);
    for (let i = 0; i < 100; i++) {
      expect(guard.onDelta(unit, "text_delta", abort)).toBe(false);
    }
    expect(abort).not.toHaveBeenCalled();
  });

  it("trip 后后续 onDelta 恒返回 true", () => {
    const guard = new OutputGuard(makeConfig(), "otter-1", mockLogger());
    const abort = vi.fn();
    const unit = "H".repeat(100);
    let tripped = false;
    for (let i = 0; i < 300 && !tripped; i++) tripped = guard.onDelta(unit, "text_delta", abort);
    expect(tripped).toBe(true);
    expect(guard.onDelta("anything", "text_delta", abort)).toBe(true);
  });
});

describe("OutputGuard 超时体系", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("首字节超时：prompt 后无 delta 触发 first_byte_timeout", () => {
    const guard = new OutputGuard(makeConfig({ firstByteTimeoutMs: 10_000 }), "otter-1", mockLogger());
    const abort = vi.fn();

    guard.armFirstByteTimer(abort);
    vi.advanceTimersByTime(10_001);
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("first_byte_timeout");
  });

  it("首个 delta 到达后切换为滑动超时，并记录首字节延迟埋点", () => {
    const guard = new OutputGuard(
      makeConfig({ firstByteTimeoutMs: 10_000, streamingTimeoutMs: 2000 }),
      "otter-1", mockLogger(),
    );
    const abort = vi.fn();

    guard.armFirstByteTimer(abort);
    vi.advanceTimersByTime(6000); // 6s 后首个 delta（未超 10s 首字节预算）
    guard.onDelta("hello", "text_delta", abort);
    expect(guard.getMetadata().firstByteLatencyMs).toBe(6000);

    // 滑动预算 2s：超过则触发 streaming_timeout
    vi.advanceTimersByTime(2001);
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("streaming_timeout");
  });

  it("delta 持续到达重置滑动计时器", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 5000 }), "otter-1", mockLogger());
    const abort = vi.fn();

    guard.onDelta(randomText(50, 1), "text_delta", abort);
    vi.advanceTimersByTime(3000);
    guard.onDelta(randomText(50, 2), "text_delta", abort);
    vi.advanceTimersByTime(3000);
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2001);
    expect(abort).toHaveBeenCalled();
  });

  it("destroy() 清理计时器", () => {
    const guard = new OutputGuard(makeConfig({ firstByteTimeoutMs: 5000 }), "otter-1", mockLogger());
    const abort = vi.fn();
    guard.armFirstByteTimer(abort);
    guard.destroy();
    vi.advanceTimersByTime(10_000);
    expect(abort).not.toHaveBeenCalled();
  });

  it("isCompacting 兜底：fire 时 compaction 进行中则抑制并重新 arm", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 2000 }), "otter-1", mockLogger());
    const abort = vi.fn();
    let compacting = true;
    guard.setIsCompacting(() => compacting);

    guard.onDelta(randomText(50, 3), "text_delta", abort);
    vi.advanceTimersByTime(2001);
    expect(abort).not.toHaveBeenCalled(); // 被兜底抑制

    compacting = false;
    vi.advanceTimersByTime(2001); // 重新 arm 的计时器到期
    expect(abort).toHaveBeenCalled();
  });
});

describe("OutputGuard pause/resume（冻结语义 + ref-count，F20260804dglp 根因 2b）", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("pause 时长不计入 elapsed：pause 超过 timeout 后 resume 不误杀（存量 bug 回归）", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 5000 }), "otter-1", mockLogger());
    const abort = vi.fn();

    guard.onDelta(randomText(50, 4), "text_delta", abort);
    vi.advanceTimersByTime(2000); // 消耗 2s，剩余 3s
    guard.pause("tool");
    vi.advanceTimersByTime(600_000); // 工具执行 600s（远超 timeout）——旧实现 resume 后 1s 必误杀
    guard.resume("tool", abort);

    vi.advanceTimersByTime(2999);
    expect(abort).not.toHaveBeenCalled(); // 冻结语义：剩余 3s 没用完
    vi.advanceTimersByTime(2);
    expect(abort).toHaveBeenCalled();
  });

  it("ref-count：两个 pause 源，只 resume 一个不重建计时器", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 5000 }), "otter-1", mockLogger());
    const abort = vi.fn();

    guard.onDelta(randomText(50, 5), "text_delta", abort);
    guard.pause("tool");
    guard.pause("compaction"); // 叠加 pause
    guard.resume("tool", abort); // 还剩 compaction，不应 resume
    vi.advanceTimersByTime(10_000);
    expect(abort).not.toHaveBeenCalled();

    guard.resume("compaction", abort); // compaction 结束 → re-arm 首字节窗口（默认 300s）
    vi.advanceTimersByTime(10_000);
    expect(abort).not.toHaveBeenCalled(); // 首字节预算 300s 未到
  });

  it("compaction_end 后 re-arm 首字节窗口（冷 prefill）", () => {
    const guard = new OutputGuard(
      makeConfig({ streamingTimeoutMs: 2000, firstByteTimeoutMs: 8000 }),
      "otter-1", mockLogger(),
    );
    const abort = vi.fn();

    guard.onDelta(randomText(50, 6), "text_delta", abort);
    guard.pause("compaction");
    vi.advanceTimersByTime(60_000); // compaction 耗时 60s
    guard.resume("compaction", abort);

    // 若沿用滑动剩余（2s）会立刻误杀；re-arm 首字节（8s）则 5s 时不触发
    vi.advanceTimersByTime(5000);
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3001);
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("first_byte_timeout");
  });

  it("auto_retry_end 后同样 re-arm 首字节窗口", () => {
    const guard = new OutputGuard(
      makeConfig({ streamingTimeoutMs: 2000, firstByteTimeoutMs: 8000 }),
      "otter-1", mockLogger(),
    );
    const abort = vi.fn();

    guard.onDelta(randomText(50, 7), "text_delta", abort);
    guard.pause("auto_retry");
    vi.advanceTimersByTime(14_000); // 退避 14s
    guard.resume("auto_retry", abort);

    vi.advanceTimersByTime(5000); // > 滑动预算 2s，但首字节预算 8s 未到
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3001);
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("first_byte_timeout");
  });
});

describe("attachOutputGuard（SDK 事件契约）", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeSession() {
    let handler: (event: unknown) => void = () => {};
    const session = {
      subscribe: vi.fn((fn: (event: unknown) => void) => { handler = fn; return () => {}; }),
    };
    return { session, fire: (e: unknown) => handler(e) };
  }

  it("disabled 时不订阅", () => {
    const { session } = makeSession();
    const { cleanup } = attachOutputGuard(session, "otter-1", makeConfig({ enabled: false }), mockLogger(), vi.fn());
    expect(() => cleanup()).not.toThrow();
    expect(session.subscribe).not.toHaveBeenCalled();
  });

  it("从 assistantMessageEvent 内层取 delta（嵌套形状触发检测）", () => {
    const { session, fire } = makeSession();
    const onAbort = vi.fn();
    attachOutputGuard(session, "otter-1", makeConfig(), mockLogger(), onAbort);

    const unit = "I".repeat(100);
    for (let i = 0; i < 300 && !onAbort.mock.calls.length; i++) {
      fire(updateEvent("text_delta", unit));
    }
    expect(onAbort).toHaveBeenCalled();
  });

  it("回归：外层 event.delta 形状不触发（初版字段 bug 的反向断言）", () => {
    const { session, fire } = makeSession();
    const onAbort = vi.fn();
    attachOutputGuard(session, "otter-1", makeConfig({ streamingTimeoutMs: 1000 }), mockLogger(), onAbort);

    // 初版 bug 的形状：delta 挂在外层——新实现应读不到它（不启动计时器、不检测）
    fire({ type: "message_update", delta: "J".repeat(100) });
    vi.advanceTimersByTime(10_000);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("tool_execution_start/end 驱动 pause/resume", () => {
    const { session, fire } = makeSession();
    const onAbort = vi.fn();
    attachOutputGuard(session, "otter-1", makeConfig({ streamingTimeoutMs: 3000 }), mockLogger(), onAbort);

    fire(updateEvent("text_delta", randomText(50, 8)));
    fire({ type: "tool_execution_start", name: "bash" });
    vi.advanceTimersByTime(10_000);
    expect(onAbort).not.toHaveBeenCalled();

    fire({ type: "tool_execution_end", name: "bash" });
    vi.advanceTimersByTime(3001);
    expect(onAbort).toHaveBeenCalled();
  });

  it("compaction_start/end 驱动 pause/re-arm（首字节窗口）", () => {
    const { session, fire } = makeSession();
    const onAbort = vi.fn();
    attachOutputGuard(
      session, "otter-1",
      makeConfig({ streamingTimeoutMs: 2000, firstByteTimeoutMs: 8000 }),
      mockLogger(), onAbort,
    );

    fire(updateEvent("text_delta", randomText(50, 9)));
    fire({ type: "compaction_start" });
    vi.advanceTimersByTime(60_000);
    expect(onAbort).not.toHaveBeenCalled();

    fire({ type: "compaction_end" });
    vi.advanceTimersByTime(5000); // > 滑动 2s，< 首字节 8s
    expect(onAbort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3001);
    expect(onAbort).toHaveBeenCalled();
  });

  it("session.isCompacting getter 被接入兜底", () => {
    let handler: (event: unknown) => void = () => {};
    const session = {
      subscribe: vi.fn((fn: (event: unknown) => void) => { handler = fn; return () => {}; }),
      isCompacting: true,
    };
    const onAbort = vi.fn();
    attachOutputGuard(session, "otter-1", makeConfig({ streamingTimeoutMs: 1000 }), mockLogger(), onAbort);

    handler(updateEvent("text_delta", randomText(50, 10)));
    vi.advanceTimersByTime(5000);
    expect(onAbort).not.toHaveBeenCalled(); // 兜底抑制
  });
});
