/**
 * F20260828gssf: selftest 机制单元测试。
 *
 * 直接 import 真实 runSelftest 测试（检视獭实验证伪了"A 类环境导入会解析失败"的论断：
 * vitest.config.ts 的 exclude 只作用于测试文件发现，不阻止模块解析）。
 *
 * 覆盖场景：
 *   - good 过 + bad 拦 → 放行采样
 *   - good 失败 → fail fast
 *   - bad 通过 → fail fast
 *   - 两个都拦 / 两个都过 → fail fast（判别力缺失）
 *   - 无 selftest 定义 → 跳过 selftest
 *   - factory 函数形式的 selftest
 *   - bad 数组形式（多条 bad 轨迹）
 */
import { describe, it, expect } from "vitest";
import type { GoldenModule, GoldenSelftest } from "./capability/golden/golden.runner";
import type { GoldenAssert, GoldenAssertCtx } from "./capability/golden/golden.runner";
import { runSelftest } from "./capability/golden/golden.runner";

// ──── 最小 mock ────

/** 最小 CapabilityContext mock——runSelftest 只传给 assert，不调用 ctx 方法 */
function mockCtx() {
  return { built: {} } as any;
}

/** 构造最小 GoldenModule */
function makeModule(opts: {
  selftest?: GoldenSelftest | ((ctx: any) => Promise<GoldenSelftest>);
  assert?: GoldenAssert;
}): GoldenModule {
  return {
    golden: {
      id: "test-scenario",
      source: { type: "scar", ref: "test" },
      originTest: "test.ts",
      input: "test",
      sampling: { n: 3, minSuccess: 2 },
      modelTag: "test",
      manualReview: false,
    },
    assert: opts.assert ?? (async () => ({ ok: true, detail: "" })),
    ...(opts.selftest !== undefined ? { selftest: opts.selftest } : {}),
  };
}

/** 构造最小 selftest 定义（单条 bad） */
function makeSelftest(goodOk: boolean, badOk: boolean): GoldenSelftest {
  return {
    good: { messages: [{ id: "g1", st: "user", si: "u", content: "good", status: "completed", seq: 1 }], expectedOk: goodOk },
    bad: { messages: [{ id: "b1", st: "user", si: "u", content: "bad", status: "completed", seq: 1 }], expectedOk: badOk },
  };
}

// ──── 测试 ────

describe("golden selftest 机制", () => {
  describe("runSelftest 判别力校验", () => {
    it("good 过 + bad 拦 → passed=true（正常放行）", async () => {
      const unifiedAssert: GoldenAssert = async (ac: GoldenAssertCtx) => ({
        ok: ac.messages[0]?.content === "good",
        detail: "",
      });

      const mod = makeModule({
        selftest: {
          good: { messages: [{ id: "g1", st: "user", si: "u", content: "good", status: "completed", seq: 1 }], expectedOk: true },
          bad: { messages: [{ id: "b1", st: "user", si: "u", content: "bad", status: "completed", seq: 1 }], expectedOk: false },
        },
        assert: unifiedAssert,
      });

      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(true);
      expect(result.goodOk).toBe(true);
      expect(result.badOk).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it("good 失败（assert 返回 false）→ passed=false，fail fast", async () => {
      const mod = makeModule({
        selftest: makeSelftest(/*goodExpectedOk=*/ true, /*badExpectedOk=*/ false),
        assert: async () => ({ ok: false, detail: "always fail" }),
      });

      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(false);
      expect(result.goodOk).toBe(false);
      expect(result.reason).toContain("判别力不足");
    });

    it("bad 通过（assert 返回 true）→ passed=false，fail fast", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => ({ ok: true, detail: "always pass" }),
      });

      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(false);
      expect(result.badOk).toBe(true);
      expect(result.reason).toContain("判别力不足");
    });

    it("两个都拦（good=false, bad=false）→ passed=false", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => ({ ok: false, detail: "never pass" }),
      });

      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(false);
      expect(result.goodOk).toBe(false);
    });

    it("两个都过（good=true, bad=true）→ passed=false", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => ({ ok: true, detail: "always pass" }),
      });

      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(false);
      expect(result.badOk).toBe(true);
    });

    it("无 selftest 定义 → passed=true（跳过 selftest）", async () => {
      const mod = makeModule({});
      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("factory 函数形式的 selftest 也能正确校验", async () => {
      const factorySelftest = async (ctx: unknown): Promise<GoldenSelftest> => {
        void ctx;
        return {
          good: {
            messages: [{ id: "g1", st: "user", si: "u", content: "factory-good", status: "completed", seq: 1 }],
            expectedOk: true,
            convId: "factory-conv",
          },
          bad: {
            messages: [{ id: "b1", st: "user", si: "u", content: "factory-bad", status: "completed", seq: 1 }],
            expectedOk: false,
            convId: "factory-conv",
          },
        };
      };

      const unifiedAssert: GoldenAssert = async (ac: GoldenAssertCtx) => ({
        ok: ac.messages[0]?.content === "factory-good",
        detail: `convId=${ac.convId}`,
      });

      const mod = makeModule({ selftest: factorySelftest, assert: unifiedAssert });
      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(true);
    });

    it("bad 数组形式——多条 bad 轨迹独立校验", async () => {
      // 两条 bad，第一条 expectedOk=false 但 assert 返回 true（不匹配），
      // 第二条 expectedOk=false 且 assert 返回 false（匹配）。
      // 任一 bad 失败即判别力不足。
      const unifiedAssert: GoldenAssert = async (ac: GoldenAssertCtx) => {
        // "bad-always-pass" → ok=true, 其他 → ok=false
        return { ok: ac.messages[0]?.content === "bad-always-pass", detail: "" };
      };

      const mod = makeModule({
        selftest: {
          good: { messages: [{ id: "g1", st: "user", si: "u", content: "good", status: "completed", seq: 1 }], expectedOk: true },
          bad: [
            { messages: [{ id: "b1", st: "user", si: "u", content: "bad-always-pass", status: "completed", seq: 1 }], expectedOk: false },
            { messages: [{ id: "b2", st: "user", si: "u", content: "bad-other", status: "completed", seq: 1 }], expectedOk: false },
          ],
        },
        assert: unifiedAssert,
      });

      const result = await runSelftest(mockCtx(), mod);
      // 第一条 bad: assert 返回 true, expectedOk=false → 不匹配 → 判别力不足
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("判别力不足");
    });

    it("bad 数组全部通过 → passed=true", async () => {
      const unifiedAssert: GoldenAssert = async (ac: GoldenAssertCtx) => ({
        ok: ac.messages[0]?.content === "good",
        detail: "",
      });

      const mod = makeModule({
        selftest: {
          good: { messages: [{ id: "g1", st: "user", si: "u", content: "good", status: "completed", seq: 1 }], expectedOk: true },
          bad: [
            { messages: [{ id: "b1", st: "user", si: "u", content: "bad1", status: "completed", seq: 1 }], expectedOk: false },
            { messages: [{ id: "b2", st: "user", si: "u", content: "bad2", status: "completed", seq: 1 }], expectedOk: false },
          ],
        },
        assert: unifiedAssert,
      });

      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(true);
    });
  });

  describe("selftest 结果记录字段", () => {
    it("passed=true 时无 reason 字段", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async (ac: GoldenAssertCtx) => ({ ok: ac.messages[0]?.content === "good", detail: "" }),
      });
      mod.selftest = {
        good: { messages: [{ id: "g1", st: "user", si: "u", content: "good", status: "completed", seq: 1 }], expectedOk: true },
        bad: { messages: [{ id: "b1", st: "user", si: "u", content: "bad", status: "completed", seq: 1 }], expectedOk: false },
      };
      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("passed=false 时 reason 包含 good/bad 实际值和期望值", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => ({ ok: false, detail: "broken" }),
      });
      const result = await runSelftest(mockCtx(), mod);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("good.ok=false");
      expect(result.reason).toContain("expect true");
    });
  });

  describe("assert 异常不穿透 selftest", () => {
    it("assert 抛异常时 runSelftest 应抛出（不吞异常）", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => { throw new Error("assert crashed"); },
      });

      await expect(runSelftest(mockCtx(), mod)).rejects.toThrow("assert crashed");
    });
  });
});
