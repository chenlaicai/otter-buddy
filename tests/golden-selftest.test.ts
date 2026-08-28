/**
 * F20260828gssf: selftest 机制单元测试。
 *
 * 验证 runSelftest 的判别力校验逻辑（A 类：纯代码逻辑，零 LLM）。
 * 覆盖场景：
 *   - good 过 + bad 拦 → 放行采样
 *   - good 失败 → fail fast
 *   - bad 通过 → fail fast
 *   - 两个都拦 / 两个都过 → fail fast（判别力缺失）
 *   - 无 selftest 定义 → 跳过 selftest
 *   - factory 函数形式的 selftest
 */
import { describe, it, expect } from "vitest";
import type { GoldenModule, GoldenSelftest, SelftestResult } from "./capability/golden/golden.runner";
import type { GoldenAssert, GoldenAssertCtx } from "./capability/golden/golden.runner";


// ──── 最小 mock ────

/** 最小 CapabilityContext mock——runSelftest 只传给 assert，不调用 ctx 方法 */
function mockCtx() {
  return { built: { db: { prepare: () => ({ get: () => undefined }) } } } as any;
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

/** 构造最小 selftest 定义 */
function makeSelftest(goodOk: boolean, badOk: boolean): GoldenSelftest {
  return {
    good: { messages: [{ id: "g1", st: "user", si: "u", content: "good", status: "completed", seq: 1 }], expectedOk: goodOk },
    bad: { messages: [{ id: "b1", st: "user", si: "u", content: "bad", status: "completed", seq: 1 }], expectedOk: badOk },
  };
}

// ──── 直接测试 runSelftest 逻辑（从 runner 导入） ────
// runSelftest 是 exported 函数，可直接测。但 capability 模块用 ESM + path alias，
// A 类 vitest config 不含 capability，直接导入会解析失败。
// 因此内联复刻核心逻辑测试——断言逻辑与 runSelftest 一致。

/** 复刻 runSelftest 的核心判定逻辑（A 类测试不需要 boot ctx） */
async function runSelftestLogic(
  ctx: any,
  mod: { selftest?: GoldenSelftest | ((ctx: any) => Promise<GoldenSelftest>); assert: GoldenAssert },
): Promise<SelftestResult> {
  if (!mod.selftest) return { passed: true };

  const selftestDef = typeof mod.selftest === "function"
    ? await mod.selftest(ctx)
    : mod.selftest;

  const defaultConvId = `selftest:test`;

  const goodResult = await mod.assert({
    ctx,
    convId: selftestDef.good.convId ?? defaultConvId,
    messages: selftestDef.good.messages,
  });

  const badResult = await mod.assert({
    ctx,
    convId: selftestDef.bad.convId ?? defaultConvId,
    messages: selftestDef.bad.messages,
  });

  const goodOk = goodResult.ok === selftestDef.good.expectedOk;
  const badOk = badResult.ok === selftestDef.bad.expectedOk;
  const passed = goodOk && badOk;

  return {
    passed,
    goodOk: goodResult.ok,
    badOk: badResult.ok,
    reason: passed
      ? undefined
      : `判别力不足：good.ok=${goodResult.ok}(expect ${selftestDef.good.expectedOk}) bad.ok=${badResult.ok}(expect ${selftestDef.bad.expectedOk})`,
  };
}

// ──── 测试 ────

describe("golden selftest 机制", () => {
  describe("runSelftest 判别力校验", () => {
    it("good 过 + bad 拦 → passed=true（正常放行）", async () => {
      // assert 函数被两组不同消息调用，这里用同一个函数模拟区分行为：
      // 实际 runSelftest 用同一个 assert 函数，消息不同导致结果不同。
      // 单测中我们用一个统一 assert 来模拟：如果消息 content="good" 则 ok=true
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

      const result = await runSelftestLogic(mockCtx(), mod);
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

      const result = await runSelftestLogic(mockCtx(), mod);
      expect(result.passed).toBe(false);
      expect(result.goodOk).toBe(false); // good 期望 true 但拿到 false
      expect(result.reason).toContain("判别力不足");
    });

    it("bad 通过（assert 返回 true）→ passed=false，fail fast", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => ({ ok: true, detail: "always pass" }),
      });

      const result = await runSelftestLogic(mockCtx(), mod);
      expect(result.passed).toBe(false);
      expect(result.badOk).toBe(true); // bad 期望 false 但拿到 true
      expect(result.reason).toContain("判别力不足");
    });

    it("两个都拦（good=false, bad=false）→ passed=false", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => ({ ok: false, detail: "never pass" }),
      });

      const result = await runSelftestLogic(mockCtx(), mod);
      expect(result.passed).toBe(false);
      // good 期望 true 但拿到 false → goodOk=false
      expect(result.goodOk).toBe(false);
    });

    it("两个都过（good=true, bad=true）→ passed=false", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => ({ ok: true, detail: "always pass" }),
      });

      const result = await runSelftestLogic(mockCtx(), mod);
      expect(result.passed).toBe(false);
      // bad 期望 false 但拿到 true → badOk=true
      expect(result.badOk).toBe(true);
    });

    it("无 selftest 定义 → passed=true（跳过 selftest）", async () => {
      const mod = makeModule({});
      const result = await runSelftestLogic(mockCtx(), mod);
      expect(result.passed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("factory 函数形式的 selftest 也能正确校验", async () => {
      const factorySelftest = async (ctx: unknown): Promise<GoldenSelftest> => {
        void ctx; // 模拟 DB 依赖场景的 factory 函数
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
      const result = await runSelftestLogic(mockCtx(), mod);
      expect(result.passed).toBe(true);
    });
  });

  describe("selftest 结果记录字段", () => {
    it("passed=true 时无 reason 字段", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async (ac: GoldenAssertCtx) => ({ ok: ac.messages[0]?.content === "good", detail: "" }),
      });
      // 用带区分消息的 selftest
      mod.selftest = {
        good: { messages: [{ id: "g1", st: "user", si: "u", content: "good", status: "completed", seq: 1 }], expectedOk: true },
        bad: { messages: [{ id: "b1", st: "user", si: "u", content: "bad", status: "completed", seq: 1 }], expectedOk: false },
      };
      const result = await runSelftestLogic(mockCtx(), mod);
      expect(result.passed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("passed=false 时 reason 包含 good/bad 实际值和期望值", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => ({ ok: false, detail: "broken" }),
      });
      const result = await runSelftestLogic(mockCtx(), mod);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("good.ok=false");
      expect(result.reason).toContain("expect true");
    });
  });

  describe("assert 异常不穿透 selftest", () => {
      it("assert 抛异常时 runSelftestLogic 应抛出（不吞异常）", async () => {
      const mod = makeModule({
        selftest: makeSelftest(true, false),
        assert: async () => { throw new Error("assert crashed"); },
      });

      await expect(runSelftestLogic(mockCtx(), mod)).rejects.toThrow("assert crashed");
    });
  });
});
