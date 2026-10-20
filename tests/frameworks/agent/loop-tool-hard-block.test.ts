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

describe("检测器报警 → 粘滞标记 → 门物理截断（集成，直攻主场景）", () => {
  it("create_linked_resource 连发命中循环 → 记入 Map → 后续同工具被门阻断；speak/yield 放行", () => {
    const loopBlockedTools = new Map<string, string>();
    const session = mockSession();
    attachCircuitBreaker(
      session as never,
      "otter-loop-1",
      { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, maxConsecutiveIdentical: 5 },
      createTestLogger(),
      { loopBlockedTools },
    );

    // 6 连发 create_linked_resource（签名 == 工具名，常量）→ 第 6 次触发连续相同报警
    for (let i = 0; i < 6; i++) {
      session.emit(sdkToolStart("create_linked_resource", { content: `垃圾${i}` }));
    }

    // 报警已把签名记入粘滞 Map（独立于 steerStrikes，穿插 speak 不清零）
    const sig = buildToolSignature("create_linked_resource", {});
    expect(loopBlockedTools.has(sig)).toBe(true);

    // 门对后续同工具物理阻断（工具不执行）
    const store = makeStore(loopBlockedTools);
    const blocked = loopBlockGuard(store, "create_linked_resource", {});
    expect(blocked?.block).toBe(true);

    // 逃生口：speak / yield 不被阻断
    expect(loopBlockGuard(store, "speak", {})).toBeUndefined();
    expect(loopBlockGuard(store, "yield", {})).toBeUndefined();
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

  it("粘滞：报警后穿插 speak（allow）不清零，relapse 同工具仍被阻断（修发作 2 逃逸）", () => {
    const loopBlockedTools = new Map<string, string>();
    const session = mockSession();
    attachCircuitBreaker(
      session as never,
      "otter-loop-1",
      { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, maxConsecutiveIdentical: 5 },
      createTestLogger(),
      { loopBlockedTools },
    );

    for (let i = 0; i < 6; i++) {
      session.emit(sdkToolStart("create_linked_resource", { content: `g${i}` }));
    }
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
