/**
 * weixin contextTokenWarn* 配置边界测试（F20260901wxnt 发现1/4）
 *
 * 覆盖：默认启用 / 显式 0 关闭 / 坏值回退默认 / 非数字抛错
 */
import { describe, it, expect } from "vitest";
import { validate } from "@frameworks/config-service";

function makeValidRaw(weixin?: Record<string, unknown>) {
  return {
    llm: {
      models: [{ alias: "test", provider: "openai", model: "gpt-4" }],
    },
    server: { port: 3000 },
    ...(weixin ? { weixin } : {}),
  };
}

describe("weixin contextTokenWarn* 配置边界 (F20260901wxnt)", () => {
  it("默认未配置：contextTokenWarnMinutes 为 undefined（下游 buildContextTokenWarn 走默认 60）", () => {
    const raw = makeValidRaw({ baseUrl: "https://ilinkai.weixin.qq.com" });
    validate(raw);
    expect(raw.weixin?.contextTokenWarnMinutes).toBeUndefined();
  });

  it("显式 0：validate 通过（0 = 关闭，buildContextTokenWarn 返回 undefined）", () => {
    const raw = makeValidRaw({
      baseUrl: "https://ilinkai.weixin.qq.com",
      contextTokenWarnMinutes: 0,
    });
    expect(() => validate(raw)).not.toThrow();
    expect(raw.weixin?.contextTokenWarnMinutes).toBe(0);
  });

  it("正常值：validate 通过", () => {
    const raw = makeValidRaw({
      baseUrl: "https://ilinkai.weixin.qq.com",
      contextTokenWarnMinutes: 90,
      contextTokenWarnCooldownMinutes: 30,
    });
    expect(() => validate(raw)).not.toThrow();
    expect(raw.weixin?.contextTokenWarnMinutes).toBe(90);
    expect(raw.weixin?.contextTokenWarnCooldownMinutes).toBe(30);
  });

  it("非数字坏值（如 YAML \"60min\"）：validate 抛错（与 server.port 同款防线）", () => {
    const raw = makeValidRaw({
      baseUrl: "https://ilinkai.weixin.qq.com",
      contextTokenWarnMinutes: "60min" as unknown as number,
    });
    expect(() => validate(raw)).toThrow(/contextTokenWarnMinutes.*整数/);
  });

  it("NaN 坏值：validate 抛错", () => {
    const raw = makeValidRaw({
      baseUrl: "https://ilinkai.weixin.qq.com",
      contextTokenWarnMinutes: NaN,
    });
    expect(() => validate(raw)).toThrow(/contextTokenWarnMinutes.*整数/);
  });

  it("Infinity 坏值：validate 抛错", () => {
    const raw = makeValidRaw({
      baseUrl: "https://ilinkai.weixin.qq.com",
      contextTokenWarnMinutes: Infinity,
    });
    expect(() => validate(raw)).toThrow(/contextTokenWarnMinutes.*整数/);
  });
});
