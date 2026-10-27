/**
 * F20261020hlbk：循环工具硬熔断（#1556）——tool_call 门物理截断 + 检测器报警粘滞标记。
 *
 * 直攻主场景（非单测传 id）：attachCircuitBreaker 派发 tool_execution_start 命中
 * create_linked_resource 循环 → loopBlockedTools 记入签名 → loopBlockGuard 对后续
 * 同工具返回 {block}（物理截断）→ speak/yield 仍放行（逃生口）。
 *
 * 负向验证（证非恒真）：无 mark 时 loopBlockGuard 放行（fail-open）；
 * 修复回退（mark 不写）→ 集成断言失败——见 PR Verification 节。
 */
import { describe, it, expect, vi } from "vitest";
import { attachCircuitBreaker } from "@frameworks/agent/circuit-breaker-helpers";
import { loopBlockGuard, type OtterInvokeContext } from "@frameworks/agent/model-runtime-registry";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@frameworks/agent/tool-call-circuit-breaker";
import { buildToolSignature } from "@frameworks/agent/tool-call-circuit-breaker";
import { createTestLogger } from "../../helpers/logger";

/** 最小 session mock：记录 subscribe 回调以便手动派发 tool_execution_start */
function mockSession() {
  const handlers: Array<(event: unknown) => void> = [];
  return {
    steer: vi.fn<(text: string) => Promise<void>>(async () => {}),
    abort: vi.fn(async () => {}),
    subscribe(fn: (event: unknown) => void) {
      handlers.push(fn);
      return () => {};
    },
    emit(event: unknown) {
      for (const fn of handlers) fn(event);
    },
  };
}

function sdkToolStart(toolName: string, args: unknown = {}) {
  return { type: "tool_execution_start", toolCallId: `tc-${toolName}-${Math.random()}`, toolName, args };
}

function makeStore(loopBlockedTools: Map<string, string>): OtterInvokeContext {
  return { otterPromptConfig: undefined, identityPrefix: "", otterId: "otter-loop-1", loopBlockedTools };
}

describe("loopBlockGuard（tool_call 门物理阻断）", () => {
  it("命中 loopBlockedTools → 返回 {block, reason}，理由引导 speak+yield", () => {
    const map = new Map<string, string>([["create_linked_resource", "循环熔断"]]);
    const r = loopBlockGuard(makeStore(map), "create_linked_resource", {});
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain("speak");
    expect(r?.reason).toContain("yield");
  });

  it("speak / yield 豁免（硬熔断后仍能报告 + 交棒逃生）", () => {
    const map = new Map<string, string>([["speak#x", "循环熔断"], ["yield", "循环熔断"]]);
    expect(loopBlockGuard(makeStore(map), "speak", {})).toBeUndefined();
    expect(loopBlockGuard(makeStore(map), "yield", {})).toBeUndefined();
  });

  it("store / loopBlockedTools 缺失 fail-open 放行", () => {
    expect(loopBlockGuard(undefined, "create_linked_resource", {})).toBeUndefined();
    const noMap = { otterPromptConfig: undefined, identityPrefix: "", otterId: "o" } as OtterInvokeContext;
    expect(loopBlockGuard(noMap, "create_linked_resource", {})).toBeUndefined();
  });

  it("未命中的工具放行", () => {
    const map = new Map<string, string>([["create_linked_resource", "x"]]);
    expect(loopBlockGuard(makeStore(map), "search_memory", {})).toBeUndefined();
  });
});

describe("F20261027cbfp S1 补防：glue 层接线（repeatOffender → 写 Map → 门拦截）", () => {
  it("同签名第 2 次 steer 写入 Map → 门拉黑后续同签名；生产语义固化：拦工具不杀 invoke", () => {
    const loopBlockedTools = new Map<string, string>();
    const session = mockSession();
    const abortOverride = vi.fn();
    attachCircuitBreaker(
      session as never,
      "otter-loop-1",
      { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, maxConsecutiveIdentical: 5, maxRepeatAfterWarning: 5 },
      createTestLogger(),
      { loopBlockedTools, abortOverride },
    );

    // 第 1 周期：6 连发（阈值 5）→ 第 6 次起每次调用均 consecutive steer，
    // 但首次 steer 已记集合、同周期后续 steer 即为同签名复犯 → 第 7 次调用起 repeatOffender 写 Map。
    // 这里只发 6 次（恰好 1 次 steer）便于验证「穿插变调后复犯」的完整链路。
    for (let i = 0; i < 6; i++) session.emit(sdkToolStart("create_linked_resource", { content: `垃圾${i}` }));
    expect(session.steer).toHaveBeenCalledOnce();
    expect(loopBlockedTools.size).toBe(0); // 首次 steer 免拉黑（警告可自由纠正）

    // 穿插变调工具（洗 strike 的逃逸形态）。注意工具选择：带路径参数的 read 签名含
    // path 区分度；若用名称兑底工具（search_memory 等，#1399 残余口子）签名全同，
    // 变调本身会触发 B-3 复犯拉黑——那正是检视 D1-1 实测的残余误伤面，不属本用例验证目标。
    for (let i = 0; i < 7; i++) session.emit(sdkToolStart("read", { path: `/var/escape-probe-${i}.ts` }));
    expect(loopBlockedTools.size).toBe(0); // 有区分度的变调不触发拉黑

    // 第 2 周期：再连发同签名 → 首个 steer（第 6 次调用）即复犯 → repeatOffender 写 Map；
    // 后续同周期第 7 次起每次 steer 均为复犯（Map 已写，幂等）
    for (let i = 0; i < 6; i++) session.emit(sdkToolStart("create_linked_resource", { content: `复犯${i}` }));
    const sig = buildToolSignature("create_linked_resource", {});
    expect(loopBlockedTools.has(sig)).toBe(true); // glue：repeatOffender → 写 Map ✓

    // 门拉黑后续同签名（生产顺序：门在 tool_call 层先于 breaker）
    const store = makeStore(loopBlockedTools);
    expect(loopBlockGuard(store, "create_linked_resource", {})?.block).toBe(true);
    // 其他工具不受影响
    expect(loopBlockGuard(store, "search_memory", { query: "x" })).toBeUndefined();

    // 生产语义固化（D1-2）：门拦截后同签名调用到不了 breaker → strike 不再增长
    // → terminate/abort 在此形态下不触发——「拦工具不杀 invoke」。
    // （本测试直驱 tool_execution_start 绕门，但 strike 只到 2 << maxRepeatAfterWarning=5）
    expect(abortOverride).not.toHaveBeenCalled();
  });
});

describe("检测器报警 → 粘滞标记 → 门物理截断（集成，直攻主场景；F20261027cbfp 后：terminate 才写 Map）", () => {
  it("create_linked_resource 持续连发升级 terminate → 记入 Map → 后续同工具被门阻断；speak/yield 放行", () => {
    const loopBlockedTools = new Map<string, string>();
    const session = mockSession();
    const abortOverride = vi.fn();
    attachCircuitBreaker(
      session as never,
      "otter-loop-1",
      { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, maxConsecutiveIdentical: 5, maxRepeatAfterWarning: 3 },
      createTestLogger(),
      { loopBlockedTools, abortOverride },
    );

    // 连发 6 次触发 consecutive steer（警告，不写 Map——#1653 P0-2）；
    // 继续无视 → strike 涨满 3 → terminate → 写入粘滞 Map（#1556 事故场景仍被兑住）
    for (let i = 0; i < 6 + 3; i++) {
      session.emit(sdkToolStart("create_linked_resource", { content: `垃圾${i}` }));
    }

    expect(abortOverride).toHaveBeenCalledOnce(); // terminate 已发生
    const sig = buildToolSignature("create_linked_resource", {});
    expect(loopBlockedTools.has(sig)).toBe(true); // terminate 写入

    // 门对后续同工具物理阻断（工具不执行）
    const store = makeStore(loopBlockedTools);
    const blocked = loopBlockGuard(store, "create_linked_resource", {});
    expect(blocked?.block).toBe(true);

    // 逃生口：speak / yield 不被阻断
    expect(loopBlockGuard(store, "speak", {})).toBeUndefined();
    expect(loopBlockGuard(store, "yield", {})).toBeUndefined();
  });

  it("steer 阶段不写 Map（#1653 P0-2）：警告后穿插纠正调用不产生物理拦截", () => {
    const loopBlockedTools = new Map<string, string>();
    const session = mockSession();
    attachCircuitBreaker(
      session as never,
      "otter-loop-1",
      { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, maxConsecutiveIdentical: 5 },
      createTestLogger(),
      { loopBlockedTools },
    );

    // 6 连发触发 steer（旧版这里就写 Map → 误判放大为持续拦截，#1653 案发面 239 次）
    for (let i = 0; i < 6; i++) {
      session.emit(sdkToolStart("create_linked_resource", { content: `垃圾${i}` }));
    }
    expect(session.steer).toHaveBeenCalledOnce();
    // 新语义：steer 只是警告，不物理拦截后续调用
    expect(loopBlockedTools.size).toBe(0);
    expect(loopBlockGuard(makeStore(loopBlockedTools), "create_linked_resource", {})).toBeUndefined();
  });

  it("负向：无报警（连发次数低于阈值）→ Map 空 → 门放行（证明断言非恒真）", () => {
    const loopBlockedTools = new Map<string, string>();
    const session = mockSession();
    attachCircuitBreaker(
      session as never,
      "otter-loop-1",
      { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, maxConsecutiveIdentical: 5 },
      createTestLogger(),
      { loopBlockedTools },
    );

    // 仅 3 连发（低于阈值 5）→ 不报警
    for (let i = 0; i < 3; i++) {
      session.emit(sdkToolStart("create_linked_resource", { content: `x${i}` }));
    }
    expect(loopBlockedTools.size).toBe(0);
    expect(loopBlockGuard(makeStore(loopBlockedTools), "create_linked_resource", {})).toBeUndefined();
  });

  it("粘滞：terminate 后穿插 speak 不清零，relapse 同工具仍被阻断（修发作 2 逃逸）", () => {
    const loopBlockedTools = new Map<string, string>();
    const session = mockSession();
    attachCircuitBreaker(
      session as never,
      "otter-loop-1",
      { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, maxConsecutiveIdentical: 5, maxRepeatAfterWarning: 3 },
      createTestLogger(),
      { loopBlockedTools },
    );

    // 连发到 terminate → Map 写入
    for (let i = 0; i < 6 + 3; i++) {
      session.emit(sdkToolStart("create_linked_resource", { content: `g${i}` }));
    }
    expect(loopBlockedTools.size).toBe(1);
    // 穿插 speak（allow，会清零 steerStrikes）——但粘滞 Map 不受影响
    session.emit(sdkToolStart("speak", { body: "停手声明" }));

    const store = makeStore(loopBlockedTools);
    // relapse 的 create_linked_resource 仍被物理阻断（粘滞，不因 speak 清零）
    const sig = buildToolSignature("create_linked_resource", {});
    expect(loopBlockedTools.has(sig)).toBe(true);
    expect(loopBlockGuard(store, "create_linked_resource", {})?.block).toBe(true);
    // 而 speak（逃生口）本身放行
    expect(loopBlockGuard(store, "speak", { body: "停手声明" })).toBeUndefined();
  });
});

describe("F20261027lbos（#1656）：门拦截观测落账", () => {
  it("拦截时调 loopBlockOnIntercept 钩子（签名+工具名+理由），放行/speak豁免不调", () => {
    const map = new Map<string, string>([["create_linked_resource", "循环熔断警告"]]);
    const calls: Array<{ toolName: string; signature: string; reason: string }> = [];
    const store: OtterInvokeContext = {
      otterPromptConfig: undefined,
      identityPrefix: "",
      otterId: "otter-obs-1",
      loopBlockedTools: map,
      loopBlockOnIntercept: (input) => calls.push(input),
    } as OtterInvokeContext;

    // 拦截 → 落账钩子带签名/工具名/理由
    const blocked = loopBlockGuard(store, "create_linked_resource", { content: "x" });
    expect(blocked?.block).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].toolName).toBe("create_linked_resource");
    expect(calls[0].reason).toContain("循环熔断警告");
    expect(calls[0].signature).toBeTruthy();

    // speak 豁免 → 不落账
    expect(loopBlockGuard(store, "speak", {})).toBeUndefined();
    expect(calls.length).toBe(1);

    // 未命中工具放行 → 不落账
    expect(loopBlockGuard(store, "search_memory", {})).toBeUndefined();
    expect(calls.length).toBe(1);

    // 钩子缺失（降级配置）→ 拦截仍生效，不抛错（fail-open 落账，不阻断拦截本身）
    const noHook: OtterInvokeContext = { otterPromptConfig: undefined, identityPrefix: "", otterId: "o", loopBlockedTools: map };
    expect(loopBlockGuard(noHook, "create_linked_resource", {})?.block).toBe(true);
  });

  it("重复拦截去重：同签名多次拦截只落账首次（防高频拦截淹漫 healing 池）", () => {
    const map = new Map<string, string>([["create_linked_resource", "循环熔断警告"]]);
    const calls: Array<{ toolName: string; signature: string; reason: string }> = [];
    const store: OtterInvokeContext = {
      otterPromptConfig: undefined,
      identityPrefix: "",
      otterId: "otter-obs-1",
      loopBlockedTools: map,
      loopBlockOnIntercept: (input) => calls.push(input),
    } as OtterInvokeContext;

    // 同签名拦截 5 次 → 仅落账 1 次（去重集合同 Map 生命周期）
    for (let i = 0; i < 5; i++) {
      loopBlockGuard(store, "create_linked_resource", { content: `x${i}` });
    }
    expect(calls.length).toBe(1);
  });
});
