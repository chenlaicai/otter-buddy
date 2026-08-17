import { describe, it, expect } from "vitest";
import { runWithTrace, getTraceContext, newTraceId, traceLogFields } from "@usecases/ports/trace-context";

describe("TraceContext (F20260814mtrc)", () => {
  it("newTraceId 格式：t_ + 12 位 hex", () => {
    const id = newTraceId();
    expect(id).toMatch(/^t_[0-9a-f]{12}$/);
    expect(newTraceId()).not.toBe(id);
  });

  it("runWithTrace defined-only merge：子 scope 增量字段，父字段保留", async () => {
    await runWithTrace({ traceId: "t_abc", source: "chain" }, async () => {
      expect(getTraceContext()).toEqual({ traceId: "t_abc", source: "chain" });
      await runWithTrace({ messageId: "msg-1" }, async () => {
        expect(getTraceContext()).toEqual({ traceId: "t_abc", source: "chain", messageId: "msg-1" });
      });
      // undefined 不覆盖父字段
      await runWithTrace({ traceId: undefined }, async () => {
        expect(getTraceContext().traceId).toBe("t_abc");
      });
      expect(getTraceContext().messageId).toBeUndefined();
    });
  });

  it("无 scope 时返回空对象，不抛异常", () => {
    expect(getTraceContext()).toEqual({});
    expect(traceLogFields()).toEqual({});
  });

  it("await 后仍在 scope 内（promise 续体继承）", async () => {
    await runWithTrace({ traceId: "t_keep" }, async () => {
      await new Promise(resolve => setImmediate(resolve));
      expect(traceLogFields().traceId).toBe("t_keep");
    });
  });

  it("并行 scope 互不串扰", async () => {
    const seen: Array<string | undefined> = [];
    await Promise.all([
      runWithTrace({ traceId: "t_a" }, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        seen.push(getTraceContext().traceId);
      }),
      runWithTrace({ traceId: "t_b" }, async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        seen.push(getTraceContext().traceId);
      }),
    ]);
    expect(seen.sort()).toEqual(["t_a", "t_b"]);
  });
});
