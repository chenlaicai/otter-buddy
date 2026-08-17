import { describe, it, expect } from "vitest";
import pino from "pino";
import { PinoLogger } from "@frameworks/logger";
import { runWithTrace } from "@usecases/ports/trace-context";

/** 捕获输出的 pino 目标流 */
function captureStream() {
  const lines: string[] = [];
  const stream = {
    write: (line: string) => { lines.push(line); },
    flushSync: () => {},
  };
  return { lines, stream };
}

describe("PinoLogger trace 富化（F20260814mtrc）", () => {
  it("trace scope 内的日志自动携带 traceId/messageId", async () => {
    const { lines, stream } = captureStream();
    const logger = new PinoLogger(pino({ level: "info" }, stream as unknown as NodeJS.WriteStream));

    await runWithTrace({ traceId: "t_abc123", messageId: "msg-9", source: "chain" }, async () => {
      logger.info("inside scope");
      logger.warn("with explicit ctx", { foo: 1 });
    });
    logger.info("outside scope");

    const inside = JSON.parse(lines[0]);
    expect(inside.traceId).toBe("t_abc123");
    expect(inside.messageId).toBe("msg-9");
    expect(inside.source).toBeUndefined(); // source 不入日志（metrics 维度）

    const withCtx = JSON.parse(lines[1]);
    expect(withCtx.traceId).toBe("t_abc123");
    expect(withCtx.foo).toBe(1);

    const outside = JSON.parse(lines[2]);
    expect(outside.traceId).toBeUndefined();
  });

  it("显式 context 的同名字段优先于 trace 字段", async () => {
    const { lines, stream } = captureStream();
    const logger = new PinoLogger(pino({ level: "info" }, stream as unknown as NodeJS.WriteStream));

    await runWithTrace({ messageId: "msg-auto" }, async () => {
      logger.info("explicit wins", { messageId: "msg-explicit" });
    });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.messageId).toBe("msg-explicit");
  });
});
