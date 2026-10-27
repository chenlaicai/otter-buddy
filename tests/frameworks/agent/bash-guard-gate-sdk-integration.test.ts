/**
 * F20261026gobs delta-r1（检视獭1646 S3）：SDK 集成层钉死「双拦时 LLM 可见 toolResult 显式落痕」。
 *
 * 背景（检视獭静态源码依据，本测试转为动态背书）：SDK 时序上 tool_execution_start
 * （abort 兜底链挂载点）先于 beforeToolCall（tool_call 门挂载点）执行，且 prepareToolCall 内
 * signal.aborted 检查先于 beforeResult.block（pi-agent-core agent-loop.js L500 vs L507）——
 * 若 abort 链对同一命令先 abort，门的显式 reason 会被 "Operation aborted" 覆盖，
 * 「显式落痕」落不到 LLM 面。
 *
 * 修法（单点接管）：门激活（guardGateActive）时 abort 链对 bash 守卫判定 deferred
 * （不 abort、事件流继续计数），门以显式 reason 单点拦下；门失活时 abort 链兜底。
 *
 * 本文件用真实 runToolCall（prepareToolCall 同一代码路径）+ 真实 attachCircuitBreaker
 * 守卫接线钉死：
 *  ① 双拦判定面（守卫判拦 + abort 链同判）→ LLM 可见 toolResult 含「被安全守卫拦截
 *    （命令未执行）」且不含 "Operation aborted"，execute 未跑、session.abort 未调；
 *  ② 兜底面：门失活（guardGateActive=false）→ abort 链照旧 abort（降级不降安全）；
 *  ③ 对照面：abort 先行（signal 已 abort）时 SDK signal 检查胜出、reason 被
 *    "Operation aborted" 覆盖——这正是单点接管的根据（保留此对照防未来 SDK 升级误判）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { runToolCall, type AgentTool, type AgentToolCall, type BeforeToolCallContext, type BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { attachCircuitBreaker } from "@frameworks/agent/circuit-breaker-helpers";
import { bashGuardGate, type OtterInvokeContext } from "@frameworks/agent/model-runtime-registry";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@frameworks/agent/tool-call-circuit-breaker";
import { createTestLogger } from "../../helpers/logger";

let projectRoot: string;

/** 最小 session mock（同 loop-tool-hard-block 模式）：记录 subscribe 回调以手动派发事件 */
function mockSession() {
  const handlers: Array<(event: unknown) => void> = [];
  const state = { abortCount: 0, steerCount: 0 }; // 副作用断言状态（lint 禁 mock 调用次数断言）
  return {
    state,
    steer: vi.fn<(text: string) => Promise<void>>(async () => { state.steerCount += 1; }),
    abort: vi.fn(async () => { state.abortCount += 1; }),
    subscribe(fn: (event: unknown) => void) {
      handlers.push(fn);
      return () => {};
    },
    emit(event: unknown) {
      for (const fn of handlers) fn(event);
    },
  };
}

function makeStore(extra: Partial<OtterInvokeContext> = {}): OtterInvokeContext {
  return {
    otterPromptConfig: undefined,
    identityPrefix: "",
    otterId: "otter-s3",
    guardProjectRoot: projectRoot,
    guardSessionCwd: path.join(os.tmpdir(), "guard-s3-ws"),
    guardSandboxed: false,
    ...extra,
  };
}

/** 生产等价门链适配：pi 扩展 `pi.on("tool_call")` 的事件形 → beforeToolCall 钩子形 */
function gateAsBeforeToolCall(store: OtterInvokeContext) {
  return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> =>
    bashGuardGate(store, ctx.toolCall.name, ctx.toolCall.arguments);
}

/** bash 工具桩：execute 一旦被调用即为「拦失败」（被拦命令不得执行） */
function makeBashStub() {
  const state = { executed: false };
  const execute = vi.fn(async () => {
    state.executed = true;
    return { content: [{ type: "text" as const, text: "SHOULD_NOT_RUN" }] };
  });
  const tool = {
    name: "bash",
    label: "bash",
    description: "stub",
    parameters: Type.Object({ command: Type.String() }),
    execute,
  } as unknown as AgentTool;
  return { tool, state };
}

function guardBlockCall(): AgentToolCall {
  return { type: "toolCall", id: "tc-s3-1", name: "bash", arguments: { command: "pkill -f otter-buddy" } } as AgentToolCall;
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "guard-s3-root-"));
  fs.writeFileSync(path.join(projectRoot, ".otter-buddy.pid"), "4242");
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("S3 集成：双拦下 LLM 可见 toolResult 显式落痕（runToolCall 真实 prepareToolCall 路径）", () => {
  it("① 守卫拦 + abort 链同判 → toolResult 含「被安全守卫拦截（命令未执行）」而非 Operation aborted", async () => {
    const store = makeStore();
    const session = mockSession();
    const intercepts: string[] = [];
    attachCircuitBreaker(
      session as never,
      "otter-s3",
      DEFAULT_CIRCUIT_BREAKER_CONFIG,
      createTestLogger(),
      {
        projectRoot,
        sessionCwd: store.guardSessionCwd,
        sandboxGuarded: false,
        guardGateActive: () => true, // 门激活（生产接线：store.guardProjectRoot != null）
        onGuardIntercept: (input) => { intercepts.push(input.reason); },
      },
    );

    // 双拦判定面第一步：abort 链在 tool_execution_start 对同一命令判拦
    session.emit({ type: "tool_execution_start", toolCallId: "tc-s3-1", toolName: "bash", args: { command: "pkill -f otter-buddy" } });
    // S3 核心：门激活时 abort 链 deferred——session.abort 不得被调（否则 reason 被覆盖）
    expect(session.state.abortCount).toBe(0);

    // 第二步：LLM 可见面——runToolCall 走真实 prepareToolCall（L500/L507 同一代码路径）
    const { tool, state } = makeBashStub();
    const outcome = await runToolCall(guardBlockCall(), {
      tools: [tool],
      beforeToolCall: gateAsBeforeToolCall(store),
      assistantMessage: {} as never,
      context: {} as never,
    });

    expect(outcome.isError).toBe(true);
    const shown = JSON.stringify(outcome.result);
    expect(shown).toContain("被安全守卫拦截（命令未执行）"); // 显式落痕抵达 LLM 面
    expect(shown).not.toContain("Operation aborted"); // 未被 abort 文案覆盖
    expect(state.executed).toBe(false); // 被拦命令未执行（副作用断言）
    expect(session.state.abortCount).toBe(0); // 全程无 abort
    // delta-r2（N1）：abort 链 deferred 不得落 healing——本拦截只由门单点落账，双落会污染 6h 升级计数
    expect(intercepts).toEqual([]);
  });

  it("② 兜底面：门失活（guardGateActive=false）→ abort 链照旧 abort（降级不降安全）", () => {
    const session = mockSession();
    attachCircuitBreaker(
      session as never,
      "otter-s3",
      DEFAULT_CIRCUIT_BREAKER_CONFIG,
      createTestLogger(),
      {
        projectRoot,
        sessionCwd: path.join(os.tmpdir(), "guard-s3-ws"),
        sandboxGuarded: false,
        guardGateActive: () => false, // 门失活（store 缺失等 fail-open 形态）
      },
    );

    session.emit({ type: "tool_execution_start", toolCallId: "tc-s3-2", toolName: "bash", args: { command: "pkill -f otter-buddy" } });
    expect(session.state.abortCount).toBe(1); // 兜底 abort 仍活
  });

  it("③ 对照面：abort 先行（signal 已 abort）时 reason 被 Operation aborted 覆盖——单点接管的根据", async () => {
    const store = makeStore();
    const { tool, state } = makeBashStub();
    const aborted = new AbortController();
    aborted.abort();

    const outcome = await runToolCall(guardBlockCall(), {
      tools: [tool],
      beforeToolCall: gateAsBeforeToolCall(store),
      assistantMessage: {} as never,
      context: {} as never,
      signal: aborted.signal,
    });

    // SDK 既定语义：signal.aborted 检查先于 beforeResult.block（agent-loop.js L500 先于 L507）
    expect(outcome.isError).toBe(true);
    const shown = JSON.stringify(outcome.result);
    expect(shown).toContain("Operation aborted");
    expect(shown).not.toContain("被安全守卫拦截");
    expect(state.executed).toBe(false); // 命令同样未执行——丢的只是显式文案（副作用断言）
  });

  it("④ 放行命令不受门影响：execute 正常跑（门不误伤）", async () => {
    const store = makeStore();
    const { tool, state } = makeBashStub();
    const outcome = await runToolCall(
      { type: "toolCall", id: "tc-s3-4", name: "bash", arguments: { command: "git log --oneline -5" } } as AgentToolCall,
      {
        tools: [tool],
        beforeToolCall: gateAsBeforeToolCall(store),
        assistantMessage: {} as never,
        context: {} as never,
      },
    );
    expect(outcome.isError).toBeFalsy();
    expect(state.executed).toBe(true); // 放行命令真跑了（副作用断言）
  });
});
