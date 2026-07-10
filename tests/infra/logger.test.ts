import { describe, it, expect } from "vitest";
import { logger } from "@infra/logger";

describe("logger", () => {
  it("暴露 info/warn/error/debug 四个方法", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("各方法可正常调用不抛异常", () => {
    expect(() => logger.info("info message")).not.toThrow();
    expect(() => logger.warn("warn message")).not.toThrow();
    expect(() => logger.error("error message")).not.toThrow();
    expect(() => logger.debug("debug message")).not.toThrow();
  });

  it("支持额外参数", () => {
    expect(() => logger.info("msg", 1, { a: 2 })).not.toThrow();
    expect(() => logger.warn("msg", "extra")).not.toThrow();
  });
});
