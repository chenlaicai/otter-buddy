/**
 * F20261010gshw：影子接线（观察模式）单测。
 *
 * 覆盖面：
 * 1. 零干预铁律——影子回调抛异常不影响旧链判定返回值（拦与不拦都原样返回）
 * 2. 双向信息量过滤——真误拦候选（旧链拦+求值器会放）落账、EVAL_GAIN（旧链放+
 *    求值器会拦）落账、双方同判/回落不落账
 * 3. 防抖窗——同命令窗内不重复落账
 * 4. context 字段口径——oldVerdict/evaluatorWouldAllow/oldRuleId/commandHead
 * 5. fire-and-forget——sink.create reject 不抛出
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordShadowEval,
  shadowEvaluate,
  buildShadowEvalContext,
  __resetShadowEvalStateForTest,
  SHADOW_EVAL_ERROR_TYPE,
  type ShadowHealingSink,
} from "@frameworks/agent/shadow-eval-recorder";

const ROOT = "/repo";

/** 判定文案样本（真实 MAIN_WRITE_BLOCK_MSG 首句特征——classifyGuardInterceptReason 指纹命中 main_write） */
const MAIN_WRITE_REASON = "当前 bash 工作目录在主仓（未 cd 到 worktree）。落点为主仓的写命令被拦截——若目标在 worktree，请先 cd <worktree 路径> 再执行。";

function mockSink(): ShadowHealingSink & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    create: vi.fn(async (e: Record<string, unknown>) => {
      events.push(e);
    }),
  };
}

/** 防抖缓存是模块级单例——每例前重置（vi.resetModules 场景下用唯一 otterId 也可，这里直接换 id 更稳） */
let seq = 0;
function freshOtter(): string {
  seq += 1;
  return `otter-shadow-${seq}`;
}

/** 防抖/聚合是模块级单例——顶层每例重置隔离（S1/S2 处置：全部 describe 生效） */
beforeEach(() => {
  __resetShadowEvalStateForTest();
});

describe("shadowEvaluate - 三态投影", () => {
  it("evaluated 且落点全在主仓外 → evaluatorWouldAllow", () => {
    const r = shadowEvaluate(`cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`, ROOT);
    expect(r.evaluatorWouldAllow).toBe(true);
    expect(r.evaluatorWouldBlock).toBe(false);
  });

  it("evaluated 且落点命中主仓 → evaluatorWouldBlock + targetPaths", () => {
    const r = shadowEvaluate(`cd ${ROOT}/.otter/worktrees/wt && git add ${ROOT}/docs/x.md`, ROOT);
    expect(r.evaluatorWouldBlock).toBe(true);
    expect(r.evaluatorWouldAllow).toBe(false);
    expect(r.targetPaths.length).toBeGreaterThan(0);
  });

  it("unevaluated（$VAR 拼接后缀爬升，#1381 负门形态）→ 双 false + unevalReason", () => {
    const r = shadowEvaluate(`W=${ROOT}/.otter/worktrees/wt; cd $W/sub && touch foo`, ROOT);
    expect(r.evaluatorWouldAllow).toBe(false);
    expect(r.evaluatorWouldBlock).toBe(false);
    expect(r.unevalReason).toBeTruthy();
  });
});

describe("recordShadowEval - 双向信息量过滤", () => {
  it("真误拦候选（旧链拦 + 求值器会放）→ 落账 errorType=guard_eval_shadow", () => {
    const sink = mockSink();
    const otter = freshOtter();
    // cd worktree 后相对路径 add——求值器 evaluated 放行（worktree 落点）
    recordShadowEval({
      command: `cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`,
      oldBlock: MAIN_WRITE_REASON,
      otterId: otter,
      ids: { messageId: "m1", conversationId: "c1" },
      projectRoot: ROOT,
      sink,
      now: 1_000,
    });
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    expect(ev.errorType).toBe(SHADOW_EVAL_ERROR_TYPE);
    expect(ev.severity).toBe("low");
    const ctx = ev.context as Record<string, unknown>;
    expect(ctx.oldVerdict).toBe("BLOCK");
    expect(ctx.evaluatorWouldAllow).toBe(true);
    expect(ctx.oldRuleId).toBe("main_write"); // 指纹分类命中
    expect(String(ev.description)).toContain("真误拦候选");
  });

  it("EVAL_GAIN（旧链放 + 求值器会拦：cd worktree 后写主仓）→ 落账 EVAL_GAIN", () => {
    const sink = mockSink();
    const otter = freshOtter();
    // 旧链对 cd 豁免后的主仓绝对路径写历史上放行（#1363 灰区）；求值器判主仓写
    recordShadowEval({
      command: `cd ${ROOT}/.otter/worktrees/wt && git add ${ROOT}/docs/x.md`,
      oldBlock: null,
      otterId: otter,
      ids: {},
      projectRoot: ROOT,
      sink,
      now: 1_000,
    });
    expect(sink.events).toHaveLength(1);
    const ev = sink.events[0];
    const ctx = ev.context as Record<string, unknown>;
    expect(ctx.oldVerdict).toBe("ALLOW");
    expect(ctx.oldRuleId).toBe("none");
    expect(ctx.evaluatorWouldBlock).toBe(true);
    expect(String(ev.description)).toContain("EVAL_GAIN");
  });

  it("双方同判拦（旧链 main_write 拦 + 求值器也判拦）→ 落 same_block（S2 处置：三态全量，族内判据逐条证据）", () => {
    const sink = mockSink();
    recordShadowEval({
      command: `git add ${ROOT}/docs/x.md`, // 主仓 cwd 相对路径：求值器判主仓
      oldBlock: MAIN_WRITE_REASON,
      otterId: freshOtter(),
      ids: {},
      projectRoot: ROOT,
      sink,
      now: 1_000,
    });
    expect(sink.events).toHaveLength(1);
    expect((sink.events[0].context as Record<string, unknown>).subkind).toBe("same_block");
  });

  it("求值器 unevaluated 回落：旧链 main_write 拦 → 落 family_fallback；旧链放 → 不落（无信息量）", () => {
    const sink = mockSink();
    recordShadowEval({
      command: `W=${ROOT}/.otter/worktrees/wt; cd $W/sub && touch foo`, // 回落形态
      oldBlock: MAIN_WRITE_REASON,
      otterId: freshOtter(),
      ids: {},
      projectRoot: ROOT,
      sink,
      now: 1_000,
    });
    expect(sink.events).toHaveLength(1);
    expect((sink.events[0].context as Record<string, unknown>).subkind).toBe("family_fallback");
    const sink2 = mockSink();
    recordShadowEval({
      command: `W=${ROOT}/.otter/worktrees/wt; cd $W/sub && touch foo`,
      oldBlock: null,
      otterId: freshOtter(),
      ids: {},
      projectRoot: ROOT,
      sink: sink2,
      now: 1_000,
    });
    expect(sink2.events).toHaveLength(0);
  });
});

describe("recordShadowEval - 防抖与 fail-safe", () => {
  it("同 otter 同命令窗内（<10min）不重复落账；窗过后可再落", () => {
    const sink = mockSink();
    const otter = freshOtter();
    const cmd = `cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`;
    recordShadowEval({ command: cmd, oldBlock: MAIN_WRITE_REASON, otterId: otter, ids: {}, projectRoot: ROOT, sink, now: 1_000 });
    recordShadowEval({ command: cmd, oldBlock: MAIN_WRITE_REASON, otterId: otter, ids: {}, projectRoot: ROOT, sink, now: 2_000 }); // 窗内
    expect(sink.events).toHaveLength(1);
    recordShadowEval({ command: cmd, oldBlock: MAIN_WRITE_REASON, otterId: otter, ids: {}, projectRoot: ROOT, sink, now: 1_000 + 10 * 60 * 1000 + 1 }); // 窗后
    expect(sink.events).toHaveLength(2);
  });

  it("不同 otter 同命令各自落账（防抖按 otter 隔离）", () => {
    const sink = mockSink();
    const cmd = `cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`;
    recordShadowEval({ command: cmd, oldBlock: MAIN_WRITE_REASON, otterId: freshOtter(), ids: {}, projectRoot: ROOT, sink, now: 1_000 });
    recordShadowEval({ command: cmd, oldBlock: MAIN_WRITE_REASON, otterId: freshOtter(), ids: {}, projectRoot: ROOT, sink, now: 1_500 });
    expect(sink.events).toHaveLength(2);
  });

  it("sink.create reject 不抛出（fire-and-forget）", () => {
    const badSink: ShadowHealingSink = {
      create: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    expect(() =>
      recordShadowEval({
        command: `cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`,
        oldBlock: MAIN_WRITE_REASON,
        otterId: freshOtter(),
        ids: {},
        projectRoot: ROOT,
        sink: badSink,
        now: 1_000,
      }),
    ).not.toThrow();
  });

  it("sink=undefined 静默关（无 healing repo 场景）", () => {
    expect(() =>
      recordShadowEval({
        command: `cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`,
        oldBlock: MAIN_WRITE_REASON,
        otterId: freshOtter(),
        ids: {},
        projectRoot: ROOT,
        sink: undefined,
        now: 1_000,
      }),
    ).not.toThrow();
  });
});

describe("buildShadowEvalContext - 口径字段", () => {
  it("拦截事件带 oldRuleId 指纹分类；放行事件记 none；commandHead 脱敏截短；subkind 分桶键在位", () => {
    const outcome = shadowEvaluate(`cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`, ROOT);
    const blocked = buildShadowEvalContext(outcome, `cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`, MAIN_WRITE_REASON, "miss_block_candidate");
    expect(blocked.oldVerdict).toBe("BLOCK");
    expect(blocked.oldRuleId).toBe("main_write");
    expect(blocked.subkind).toBe("miss_block_candidate");
    expect(String(blocked.commandHead).length).toBeLessThanOrEqual(120);
    expect(blocked.hasWorktreePath).toBe(true);

    const allowed = buildShadowEvalContext(outcome, "anything", null, "eval_gain");
    expect(allowed.oldVerdict).toBe("ALLOW");
    expect(allowed.oldRuleId).toBe("none");
  });
});

/** 防抖/聚合状态重置已由顶层 beforeEach 统一覆盖 */
describe("S1 处置：维度过滤——别族拦截不落个体候选，只进聚合计数", () => {
  it("sleep 拦截 + 求值器 wouldAllow → 不落个体（维度外，防假红线）", () => {
    const sink = mockSink();
    recordShadowEval({
      command: "sleep 15",
      oldBlock: "检测到你使用了 sleep 等待（约 15 秒）。裸 sleep 会让搭档看到长时间静默黑盒。",
      otterId: freshOtter(), ids: {}, projectRoot: ROOT, sink, now: 1_000,
    });
    const individuals = sink.events.filter(e => (e.context as Record<string, unknown>).kind === "shadow_eval");
    expect(individuals).toHaveLength(0); // 维度外不落个体
    const aggs = sink.events.filter(e => (e.context as Record<string, unknown>).kind === "shadow_eval_aggregate");
    expect(aggs).toHaveLength(0); // 未到窗不刷（计数在进程内）
  });

  it("kill 族拦截 + 求值器 wouldAllow → 不落个体；data_destructive 同理", () => {
    const sink = mockSink();
    recordShadowEval({ command: "kill 12345", oldBlock: "针对主进程 PID 的终止命令", otterId: freshOtter(), ids: {}, projectRoot: ROOT, sink, now: 1_000 });
    recordShadowEval({ command: "rm -rf data/x", oldBlock: "主仓 data/ 破坏性命令拦截", otterId: freshOtter(), ids: {}, projectRoot: ROOT, sink, now: 1_100 });
    expect(sink.events.filter(e => (e.context as Record<string, unknown>).kind === "shadow_eval")).toHaveLength(0);
  });

  it("main_write 拦 + 求值器 wouldAllow → 仍落 miss_block_candidate（正道不误伤）", () => {
    const sink = mockSink();
    recordShadowEval({
      command: `cd ${ROOT}/.otter/worktrees/wt && git add src/x.ts`,
      oldBlock: MAIN_WRITE_REASON, otterId: freshOtter(), ids: {}, projectRoot: ROOT, sink, now: 1_000,
    });
    const ev = sink.events[0];
    expect((ev.context as Record<string, unknown>).subkind).toBe("miss_block_candidate");
    expect((ev.context as Record<string, unknown>).oldRuleId).toBe("main_write");
  });
});

describe("S2 处置：main_write 三态全量落账 + 聚合计数到窗刷新", () => {


  it("same_block（旧链 main_write 拦+求值器同判拦）→ 落个体 subkind=same_block", () => {
    const sink = mockSink();
    recordShadowEval({
      command: `git add ${ROOT}/docs/x.md`, // 求值器判主仓写
      oldBlock: MAIN_WRITE_REASON, otterId: freshOtter(), ids: {}, projectRoot: ROOT, sink, now: 1_000,
    });
    expect((sink.events[0].context as Record<string, unknown>).subkind).toBe("same_block");
  });

  it("family_fallback（旧链 main_write 拦+求值器回落）→ 落个体 subkind=family_fallback", () => {
    const sink = mockSink();
    recordShadowEval({
      command: `W=${ROOT}/.otter/worktrees/wt; cd $W/sub && touch foo`, // #1381 负门形态：回落
      oldBlock: MAIN_WRITE_REASON, otterId: freshOtter(), ids: {}, projectRoot: ROOT, sink, now: 1_000,
    });
    expect((sink.events[0].context as Record<string, unknown>).subkind).toBe("family_fallback");
  });

  it("聚合计数到阈值窗刷新一条 aggregate 记录（判据③④数据源）", () => {
    const sink = mockSink();
    const otter = freshOtter();
    // 3 条：sleep 维度外 / main_write 同判拦 / EVAL_GAIN；再拼到阈值（500）触发刷新
    recordShadowEval({ command: "sleep 15", oldBlock: "裸 sleep 会让搭档看到长时间静默黑盒", otterId: otter, ids: {}, projectRoot: ROOT, sink, now: 1_000 });
    recordShadowEval({ command: `git add ${ROOT}/docs/x.md`, oldBlock: MAIN_WRITE_REASON, otterId: otter, ids: {}, projectRoot: ROOT, sink, now: 1_100 });
    recordShadowEval({ command: `cd ${ROOT}/.otter/worktrees/wt && git add ${ROOT}/docs/y.md`, oldBlock: null, otterId: otter, ids: {}, projectRoot: ROOT, sink, now: 1_200 });
    for (let i = 0; i < 500; i++) {
      recordShadowEval({ command: `ls -la dir${i}`, oldBlock: null, otterId: otter, ids: {}, projectRoot: ROOT, sink, now: 1_300 + i });
    }
    const aggs = sink.events.filter(e => (e.context as Record<string, unknown>).kind === "shadow_eval_aggregate");
    expect(aggs.length).toBeGreaterThanOrEqual(1);
    const agg = aggs[0].context as Record<string, unknown>;
    expect(agg.total).toBe(500); // 第 500 条触发阈值刷新（计数含触发条）
    expect(agg.dimensionMismatchBlocked).toBe(1);
    expect(agg.mainWriteBlockEvaluated).toBe(1);
    expect(agg.individualsLogged).toBe(2); // 同判拦 + eval_gain
  });
});

describe("零干预接线（attachCircuitBreaker 集成形态）", () => {
  it("影子回调抛异常不影响旧链拦截判定与 abort", async () => {
    const { attachCircuitBreaker } = await import("@frameworks/agent/circuit-breaker-helpers");
    const { DEFAULT_CIRCUIT_BREAKER_CONFIG } = await import("@frameworks/agent/tool-call-circuit-breaker");
    const handlers: Array<(event: unknown) => void> = [];
    const session = {
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      subscribe(fn: (event: unknown) => void) {
        handlers.push(fn);
        return () => undefined;
      },
    };
    attachCircuitBreaker(session, "otter-x", DEFAULT_CIRCUIT_BREAKER_CONFIG, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never, {
      projectRoot: ROOT,
      onShadowEval: () => {
        throw new Error("shadow boom");
      },
    });
    // 主仓写命令（无 cd）——旧链写族正则必拦（git commit 在 GIT_WRITE_SUBCOMMAND 内；
    // 注：git add 不在旧链正则内——那是 Phase 2 求值器补位面，恰好是 EVAL_GAIN 的形态）
    for (const fn of handlers) fn({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: `git commit -m x` } });
    expect(session.abort).toHaveBeenCalled(); // 拦截照常，影子异常被吞
  });

  it("影子回调在旧链放行命令上也收到调用（双向对照数据源）", async () => {
    const { attachCircuitBreaker } = await import("@frameworks/agent/circuit-breaker-helpers");
    const { DEFAULT_CIRCUIT_BREAKER_CONFIG } = await import("@frameworks/agent/tool-call-circuit-breaker");
    const handlers: Array<(event: unknown) => void> = [];
    const session = {
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      subscribe(fn: (event: unknown) => void) {
        handlers.push(fn);
        return () => undefined;
      },
    };
    const shadowCalls: Array<{ command: string; oldBlock: string | null }> = [];
    attachCircuitBreaker(session, "otter-x", DEFAULT_CIRCUIT_BREAKER_CONFIG, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never, {
      projectRoot: ROOT,
      onShadowEval: (input) => shadowCalls.push(input),
    });
    // 安全命令（ls）——旧链放行，影子仍收到调用（oldBlock=null）
    for (const fn of handlers) fn({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la" } });
    expect(session.abort).not.toHaveBeenCalled();
    expect(shadowCalls).toHaveLength(1);
    expect(shadowCalls[0].oldBlock).toBeNull();
  });
});
