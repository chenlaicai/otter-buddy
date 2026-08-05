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

describe("OutputGuard pause/resume（停表 + ref-count + resume 首字节窗口，F20260805abpp）", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("工具结束 resume re-arm 首字节窗口：post-tool 冷 prefill 超滑动预算不误切（F20260805abpp 事故回归）", () => {
    const guard = new OutputGuard(
      makeConfig({ streamingTimeoutMs: 5000, firstByteTimeoutMs: 30_000 }),
      "otter-1", mockLogger(),
    );
    const abort = vi.fn();

    guard.onDelta(randomText(50, 4), "text_delta", abort);
    vi.advanceTimersByTime(2000);
    guard.pause("tool");
    vi.advanceTimersByTime(600_000); // 工具执行 600s——停表，不计入任何预算
    guard.resume("tool", abort);

    // 旧实现恢复滑动剩余（3s）：大上下文 prefill 静默 3s 即误切（streaming_timeout 事故根因）
    vi.advanceTimersByTime(5001); // 已超滑动预算 5s
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25_000); // 首字节预算 30s 到期
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("first_byte_timeout");
  });

  it("ref-count：两个不同 pause 源，只 resume 一个不重建计时器", () => {
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

  it("并行工具：同原因两次 pause，第一个 end 不重建计时器（PR 检视 S1 回归）", () => {
    const guard = new OutputGuard(
      makeConfig({ streamingTimeoutMs: 3000, firstByteTimeoutMs: 4000 }),
      "otter-1", mockLogger(),
    );
    const abort = vi.fn();

    guard.onDelta(randomText(50, 11), "text_delta", abort);
    // SDK 默认 parallel：一条消息两个 toolCall → start×2 再各自 end
    guard.pause("tool");
    guard.pause("tool");
    guard.resume("tool", abort); // 快工具先结束——慢工具还在跑，不得重建计时器
    vi.advanceTimersByTime(600_000); // 慢工具执行 600s
    expect(abort).not.toHaveBeenCalled();

    guard.resume("tool", abort); // 慢工具结束 → re-arm 首字节窗口（F20260805abpp）
    vi.advanceTimersByTime(3001); // 已超滑动预算，首字节窗口内不误切
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("first_byte_timeout");
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

  it("pause 期间到达 delta：resume 仍 arm 首字节窗口，不受陈旧剩余影响（F20260805abpp）", () => {
    const guard = new OutputGuard(
      makeConfig({ streamingTimeoutMs: 5000, firstByteTimeoutMs: 8000 }),
      "otter-1", mockLogger(),
    );
    const abort = vi.fn();

    guard.onDelta(randomText(50, 12), "text_delta", abort);
    vi.advanceTimersByTime(4500);
    guard.pause("tool");
    guard.onDelta(randomText(50, 13), "text_delta", abort); // pause 期间来的 delta：只更新 abort 引用
    guard.resume("tool", abort);

    vi.advanceTimersByTime(5001); // 超滑动预算不误切（旧冻结语义下按陈旧剩余 500ms 早误杀了）
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000); // 首字节预算 8s 到期
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("first_byte_timeout");
  });

  it("destroy 终态：destroy 后 resume 不复活计时器", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 3000 }), "otter-1", mockLogger());
    const abort = vi.fn();

    guard.onDelta(randomText(50, 14), "text_delta", abort);
    guard.pause("tool");
    guard.destroy();
    guard.resume("tool", abort);
    vi.advanceTimersByTime(10_000);
    expect(abort).not.toHaveBeenCalled();
  });

  it("auto_retry 窗口内的 delta 视为 resume：重试生成挂死时滑动超时生效（第四轮 S1 回归）", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 3000 }), "otter-1", mockLogger());
    const abort = vi.fn();

    guard.onDelta(randomText(50, 17), "text_delta", abort);
    guard.pause("auto_retry"); // SDK：auto_retry_start 在退避 sleep 前发
    vi.advanceTimersByTime(14_000); // 退避期（无 delta）
    expect(abort).not.toHaveBeenCalled();

    // 重试请求开始流式输出——SDK 此刻不发 auto_retry_end（成功路径要等生成跑完）
    guard.onDelta(randomText(50, 18), "text_delta", abort);
    // pause 必须已被释放且滑动计时器已 arm：否则重试生成中途挂死无人管
    vi.advanceTimersByTime(3001);
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("streaming_timeout");
  });

  it("auto_retry 释放后迟到的 auto_retry_end resume 无副作用", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 3000 }), "otter-1", mockLogger());
    const abort = vi.fn();

    guard.onDelta(randomText(50, 19), "text_delta", abort);
    guard.pause("auto_retry");
    guard.onDelta(randomText(50, 20), "text_delta", abort); // 释放 auto_retry pause
    guard.resume("auto_retry", abort); // 生成完成后 SDK 才发的 end——计数已归零，不得重建首字节窗口
    vi.advanceTimersByTime(3001);
    expect(abort).toHaveBeenCalled();
    expect(guard.getMetadata().reason).toBe("streaming_timeout");
  });

  it("auto_retry + tool 混合 pause 时 delta 不释放（保守路径）", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 3000 }), "otter-1", mockLogger());
    const abort = vi.fn();

    guard.onDelta(randomText(50, 21), "text_delta", abort);
    guard.pause("tool");
    guard.pause("auto_retry");
    guard.onDelta(randomText(50, 22), "text_delta", abort); // 混合 pause：走防御分支，不释放
    vi.advanceTimersByTime(10_000);
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("OutputGuard trip 语义（PR 检视 S2/S3 回归）", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("退化 trip 后停表：归因不被覆写、abort 不二次调用", () => {
    const guard = new OutputGuard(makeConfig({ streamingTimeoutMs: 5000 }), "otter-1", mockLogger());
    let abortCalls = 0;
    const abort = vi.fn(() => { abortCalls++; });
    const unit = "Good, the first commit is done. Now let me speak to the user with the progress update. ";

    let tripped = false;
    for (let i = 0; i < 200 && !tripped; i++) tripped = guard.onDelta(unit, "text_delta", abort);
    expect(tripped).toBe(true);
    expect(abortCalls).toBe(1);

    // trip 时 streaming 计时器在跑——若不清表，超时会覆写归因并二次 abort
    vi.advanceTimersByTime(60_000);
    expect(abortCalls).toBe(1);
    expect(guard.getMetadata().reason).toBe("degenerate_output");
  });

  it("compaction re-arm 后首字节埋点按新窗口计时（不覆盖为含 compaction 的长值）", () => {
    const guard = new OutputGuard(
      makeConfig({ streamingTimeoutMs: 2000, firstByteTimeoutMs: 8000 }),
      "otter-1", mockLogger(),
    );
    const abort = vi.fn();

    guard.armFirstByteTimer(abort);
    vi.advanceTimersByTime(200);
    guard.onDelta(randomText(50, 15), "text_delta", abort); // 真实 TTFT 200ms
    expect(guard.getMetadata().firstByteLatencyMs).toBe(200);

    guard.pause("compaction");
    vi.advanceTimersByTime(3000); // compaction 3s
    guard.resume("compaction", abort); // re-arm 首字节窗口
    vi.advanceTimersByTime(150);
    guard.onDelta(randomText(50, 16), "text_delta", abort); // 新窗口 TTFT 150ms

    // 若基准未刷新会报 200+3000+150=3350ms 并覆盖真值
    expect(guard.getMetadata().firstByteLatencyMs).toBe(150);
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

  it("tool_execution_start/end 驱动 pause/resume（resume 为首字节窗口，F20260805abpp）", () => {
    const { session, fire } = makeSession();
    const onAbort = vi.fn();
    attachOutputGuard(
      session, "otter-1",
      makeConfig({ streamingTimeoutMs: 3000, firstByteTimeoutMs: 4000 }),
      mockLogger(), onAbort,
    );

    fire(updateEvent("text_delta", randomText(50, 8)));
    fire({ type: "tool_execution_start", name: "bash" });
    vi.advanceTimersByTime(10_000);
    expect(onAbort).not.toHaveBeenCalled();

    fire({ type: "tool_execution_end", name: "bash" });
    vi.advanceTimersByTime(3001); // 超滑动预算：首字节窗口内不误切
    expect(onAbort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // 首字节预算 4s 到期
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
