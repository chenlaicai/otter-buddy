import { describe, expect, it } from "vitest";
import { createPlaceholderExecutionEnv } from "@frameworks/agent/placeholder-execution-env";

describe("placeholder execution env", () => {
  it("保留 id/cwd，直接调用执行方法时报显式 machine 缺失", () => {
    const env = createPlaceholderExecutionEnv("/workspace/c1");
    expect(env.id).toBe("unbound");
    expect(env.cwd).toBe("/workspace/c1");

    const face = env as unknown as Record<string, unknown>;
    expect(face.exec).toBeTypeOf("function");
    expect(() => (face.exec as () => unknown)()).toThrow(
      /method `exec` called without a bound machine.*explicit `machine` parameter/,
    );
  });

  it("可选能力检测得到失败桩，调用时不会静默跳过", () => {
    const env = createPlaceholderExecutionEnv("/workspace/c1") as unknown as {
      listFiles?: () => unknown;
      futureExecutionMethod?: () => unknown;
    };
    expect(env.listFiles).toBeTypeOf("function");
    expect(() => env.listFiles?.()).toThrow(/method `listFiles` called without a bound machine/);
    expect(env.futureExecutionMethod).toBeTypeOf("function");
    expect(() => env.futureExecutionMethod?.()).toThrow(/method `futureExecutionMethod` called without a bound machine/);
  });

  it("await 不触发 Promise assimilation 失败", async () => {
    const env = createPlaceholderExecutionEnv("/workspace/c1");
    await expect(Promise.resolve(env)).resolves.toBe(env);
  });

  it("同一方法的失败桩身份稳定", () => {
    const env = createPlaceholderExecutionEnv("/workspace/c1") as unknown as Record<string, unknown>;
    expect(env.openBinaryReader).toBe(env.openBinaryReader);
  });
});
