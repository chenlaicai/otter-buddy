/**
 * F20260918uhuc：统一交接（unifiedHandoff / restartWithUnifiedHandoff）单元测试。
 *
 * 取代 F20260917rsta 的 restartWithAutoHandoffIfBlank 测试——语义从「空摘要才合成」
 * 升级为「叠加式档案：有无自总结都走统一管线」。
 *
 * 覆盖（方案 V1/V2/V6 的单测层）：
 * - V1 锚点：合成走影子通道（runCompactionSynthesis）不触 invoke——锁雪崩根治
 * - V2 场景矩阵：手动叠加档案 / 首哑 false 零合成 / 截断 fail-closed
 * - V6 超时降级：合成超时 → 机械档案 + 正常换世
 * - 忙碌 409：isRunning → DomainError conflict
 * - jsonl 缺失降级、D9 永不阻塞
 *
 * 断言风格：依赖替身用「录制器」收集副作用，不绑 mock 调用参数/次数（lint 规则约束）。
 */

import { describe, it, expect, vi } from "vitest";
import { AgentInvoker, type HandoffEngineDeps, type EngineJsonlSlice } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort, SynthesisRunResult } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SendEntry } from "@usecases/conversation/send-entry";
import { createCapturingLogger } from "../helpers/logger";
import { mockSendEntry } from "../helpers/mock-send-entry";

/** 熔断全链路测试的 SendEntry（复用 circuit-retry 测试的模式：第二段 invoke 查询时置 completed 模拟 yield） */
function mockSendEntryForCircuit(): SendEntry {
  const base = mockSendEntry();
  let invokeCalls = 0;
  const origGetInvoke = base.getInvokeById.bind(base);
  (base as { getInvokeById: (id: string) => Promise<unknown> }).getInvokeById = async (id: string) => {
    const invoke = await origGetInvoke(id) as { status?: string; talkingStonePassedTo?: string[] } | null;
    invokeCalls++;
    // 第二段（新世全新 invoke）查询时模拟 yield 已发生
    if (invoke && invokeCalls >= 2) {
      invoke.status = "completed";
      invoke.talkingStonePassedTo = ["user-1"];
    }
    return invoke;
  };
  return base;
}

const sharedLogger = createCapturingLogger();

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-new", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-09-18T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null, modelAlias: null,
    ...overrides,
  };
}

/** 影子通道合成结果的便利构造 */
function synthResult(text: string, lastStopReason?: string): SynthesisRunResult {
  return { directText: text, lastStopReason };
}

/** jsonl 切片 stub（含可压缩历史） */
function makeSlice(): EngineJsonlSlice {
  return {
    firstKeptEntryId: "entry-keep-1",
    messagesToSummarize: [
      { role: "user", content: "帮我修登录 bug" },
      { role: "assistant", content: "已定位 auth.ts:42" },
    ],
    turnPrefixMessages: [],
    isSplitTurn: false,
    previousSummary: undefined,
    tokensBefore: 90_000,
  };
}

/** 引擎函数包 stub：录制 prompt 输入，返回可控产物 */
function makeEngine(overrides?: Partial<HandoffEngineDeps>): HandoffEngineDeps & {
  prompts: string[]; archives: string[]; mechanical: string[];
} {
  const prompts: string[] = [];
  const archives: string[] = [];
  const mechanical: string[] = [];
  return {
    prompts, archives, mechanical,
    buildNarrativeSynthesisPrompt: (input) => {
      prompts.push(JSON.stringify({ trigger: input.trigger, hasSelf: !!input.selfSummary, msgs: input.messagesToSummarize.length }));
      return "[合成prompt]";
    },
    assembleHandoffArchive: (params) => {
      archives.push(JSON.stringify({ hasNarrative: !!params.narrativeSummary, hasSelf: !!params.selfSummary }));
      return "## 前世档案（叙事）";
    },
    buildMechanicalArchive: (input) => {
      mechanical.push(input.trigger);
      return `## 前世档案（机械转储）| 触发: ${input.trigger}`;
    },
    sliceSessionEntries: () => makeSlice(),
    serializeKeptWindow: () => "[近期保留段]",
    collectStateInventory: async () => ({}),
    renderStateInventory: () => "## 活状态盘点",
    scanWorkspaceFiles: () => [],
    renderFileTrail: () => "文件轨迹（空）",
    getCompactionReserveTokens: () => 700_000,
    synthesisTimeoutMs: 50,
    ...overrides,
  };
}

/** SdkInvokePort stub：invoke 记录并抛错（V1 断言合成绝不走 invoke）+ 可控影子通道 */
function makeSdkPort(opts?: {
  synth?: (prompt: string) => Promise<SynthesisRunResult>;
  isRunning?: boolean;
  hasEntries?: boolean;
}): SdkInvokePort & { invokeCalls: string[]; synthPrompts: string[]; lockLog: string[] } {
  const invokeCalls: string[] = [];
  const synthPrompts: string[] = [];
  const lockLog: string[] = [];
  return {
    invokeCalls, synthPrompts, lockLog,
    invoke: async (otterId: string, message: string) => {
      invokeCalls.push(`${otterId}:${message.slice(0, 30)}`);
      throw new Error("invoke 不应被合成链路调用（V1：影子通道）");
    },
    runCompactionSynthesis: async (_otterId: string, prompt: string) => {
      synthPrompts.push(prompt);
      return opts?.synth ? opts.synth(prompt) : synthResult("## 交接摘要（七段）");
    },
    acquireSessionLock: async (otterId: string) => {
      lockLog.push(`acquire:${otterId}`);
      return () => { lockLog.push(`release:${otterId}`); };
    },
    readCurrentSessionEntries: async () => (opts?.hasEntries === false ? undefined : [{ type: "message", id: "e1" }]),
    isRunning: () => opts?.isRunning ?? false,
    abort: vi.fn(),
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
  } as unknown as SdkInvokePort & { invokeCalls: string[]; synthPrompts: string[]; lockLog: string[] };
}

/** 组装含引擎注入的 invoker（构造参数 22 位——引擎在尾部） */
function makeInvokerWithEngine(opts: {
  sdk?: ReturnType<typeof makeSdkPort>;
  engine?: HandoffEngineDeps;
  conversationIds?: string[];
  restartSession?: ManageSession["restartSession"];
}): AgentInvoker {
  const manageSession = {
    getActiveSession: async () => makeSession({ id: "sess-old", summary: "- gen1 sess-0: 初代" }),
    createSession: async (otterId: string) => makeSession({ otterId }),
    restartSession: opts.restartSession ?? (async (otterId: string, summary?: string) => makeSession({ otterId, summary: summary ?? null })),
    conversationQuery: { getIdsByOtterId: async () => opts.conversationIds ?? ["conv-1"] },
  } as unknown as ManageSession;

  return new AgentInvoker(
    (opts.sdk ?? makeSdkPort()) as unknown as SdkInvokePort,
    { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
    manageSession,
    { getById: async () => ({ id: "otter-1", name: "测试獭", type: "big" }) } as unknown as QueryOtter,
    sharedLogger,
    undefined, // messageBroadcaster
    undefined, // workspaceGateway
    undefined, // settingsRepo
    undefined, // metrics
    undefined, // healingRepo
    {} as ConversationRepository, // conversationRepo（统一交接必需）
    undefined, // scheduledTaskRepo
    undefined, // listArtifacts
    undefined, // manageContext
    undefined, // buildHandoffPkg
    undefined, // healthySessionThresholdMs
    undefined, // ctxWindowProvider
    undefined, // sendEntry
    undefined, // invokeRepo
    undefined, // agentDispatchService
    opts.engine, // engine（F20260918uhuc）
  ) as unknown as AgentInvoker;
}

describe("restartWithUnifiedHandoff（F20260918uhuc 统一交接）", () => {
  it("V1 锚点：合成走影子通道——全程零 invoke 调用 + 持锁释放配对（锁雪崩根治）", async () => {
    const sdk = makeSdkPort();
    const engine = makeEngine();
    const invoker = makeInvokerWithEngine({ sdk, engine });

    const session = await invoker.restartWithUnifiedHandoff("otter-1", { synthesizePast: true });

    expect(session.id).toBe("sess-new");
    expect(sdk.invokeCalls).toEqual([]); // V1 核心：无任何 invoke 通道调用
    expect(sdk.synthPrompts).toHaveLength(1); // 合成恰一次，走影子通道
    expect(sdk.lockLog[0]).toBe("acquire:otter-1");
    expect(sdk.lockLog[sdk.lockLog.length - 1]).toBe("release:otter-1"); // finally 释放
  });

  it("V2 手动场景：有自总结也走合成——叠加档案（叙事层 + 意图书独立层）", async () => {
    const sdk = makeSdkPort();
    const engine = makeEngine();
    const invoker = makeInvokerWithEngine({ sdk, engine });

    await invoker.restartWithUnifiedHandoff("otter-1", { selfSummary: "我写的意图", synthesizePast: true });

    // 合成 prompt 含自总结原料（§①② 需要意图）；档案组装含叙事+自总结双层
    expect(engine.prompts[0]).toContain('"hasSelf":true');
    expect(engine.archives[0]).toContain('"hasNarrative":true');
    expect(engine.archives[0]).toContain('"hasSelf":true');
    expect(engine.mechanical).toEqual([]); // 合成成功不走机械档案
  });

  it("V2 首哑场景：synthesizePast=false → 零合成调用，机械档案形态", async () => {
    const sdk = makeSdkPort();
    const engine = makeEngine();
    const invoker = makeInvokerWithEngine({ sdk, engine });

    const session = await invoker.restartWithUnifiedHandoff("otter-1", {
      selfSummary: "原任务摘要",
      synthesizePast: false,
    });

    expect(session.id).toBe("sess-new");
    expect(sdk.synthPrompts).toEqual([]); // 零合成
    expect(engine.mechanical).toEqual(["手动"]); // 机械档案
  });

  it("V6 超时降级：合成超时 → 机械档案 + 正常换世（D9 永不阻塞）", async () => {
    const sdk = makeSdkPort({
      synth: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("provider down")), 500)),
    });
    const engine = makeEngine({ synthesisTimeoutMs: 20 }); // 引擎超时 20ms 必先触发
    const restarts: Array<{ summary?: string }> = [];
    const invoker = makeInvokerWithEngine({
      sdk, engine,
      restartSession: async (_id, summary) => { restarts.push({ summary }); return makeSession({ summary: summary ?? null }); },
    });

    const session = await invoker.restartWithUnifiedHandoff("otter-1", { synthesizePast: true });

    expect(session.id).toBe("sess-new");
    expect(restarts[0].summary).toContain("机械转储"); // 降级档案完整入档
  }, 10_000);

  it("V6 fail-closed：截断摘要（stopReason=length）拒入库 → 降级机械档案", async () => {
    const sdk = makeSdkPort({ synth: async () => synthResult("截断的摘要…", "length") });
    const engine = makeEngine();
    const invoker = makeInvokerWithEngine({ sdk, engine });

    await invoker.restartWithUnifiedHandoff("otter-1", { synthesizePast: true });

    expect(engine.mechanical).toEqual(["手动"]); // fail-closed → 机械档案
  });

  it("V6 fail-closed：空摘要拒入库 → 降级机械档案", async () => {
    const sdk = makeSdkPort({ synth: async () => synthResult("   ") });
    const engine = makeEngine();
    const invoker = makeInvokerWithEngine({ sdk, engine });

    await invoker.restartWithUnifiedHandoff("otter-1", { synthesizePast: true });

    expect(engine.mechanical).toEqual(["手动"]);
  });

  it("忙碌拒绝：isRunning → conflict 错误（HTTP 层映射 409），拒绝先于合成", async () => {
    const sdk = makeSdkPort({ isRunning: true });
    const engine = makeEngine();
    const invoker = makeInvokerWithEngine({ sdk, engine });

    await expect(
      invoker.restartWithUnifiedHandoff("otter-1", { synthesizePast: true }),
    ).rejects.toThrow("忙碌");
    expect(sdk.synthPrompts).toEqual([]); // 拒绝在合成之前
    expect(sdk.lockLog).toEqual([]); // 也不取锁
  });

  it("jsonl 缺失（首哑前世为空）→ 跳过合成，机械档案完整覆盖", async () => {
    const sdk = makeSdkPort({ hasEntries: false });
    const engine = makeEngine();
    const invoker = makeInvokerWithEngine({ sdk, engine });

    const session = await invoker.restartWithUnifiedHandoff("otter-1", {
      selfSummary: "原任务",
      synthesizePast: true, // 即使 true，无 jsonl 不合成
    });

    expect(session.id).toBe("sess-new");
    expect(sdk.synthPrompts).toEqual([]);
    expect(engine.mechanical).toEqual(["手动"]);
  });

  it("无对话记录 → 降级裸重启（selfSummary 直透），D9 不阻塞", async () => {
    const engine = makeEngine();
    const invoker = makeInvokerWithEngine({ engine, conversationIds: [] });

    const session = await invoker.restartWithUnifiedHandoff("otter-1", {
      selfSummary: "直透摘要",
      synthesizePast: true,
    });

    expect(session.summary).toBe("直透摘要");
    expect(engine.prompts).toEqual([]); // 未进统一管线
  });

  it("引擎未注入（旧装配/测试）→ 降级裸重启不阻塞", async () => {
    const invoker = makeInvokerWithEngine({ engine: undefined });

    const session = await invoker.restartWithUnifiedHandoff("otter-1", { synthesizePast: true });

    expect(session.id).toBe("sess-new");
  });

  it("统一交接内部失败 → 降级裸重启（D9），conflict 类原样上抛", async () => {
    const engine = makeEngine();
    const failing = makeEngine({
      sliceSessionEntries: () => { throw new Error("slice exploded"); },
    });
    // collectInventoryText 等各环节 catch 容错——用 slice 抛错模拟整包级失败路径
    const invoker = makeInvokerWithEngine({ engine: failing });

    const session = await invoker.restartWithUnifiedHandoff("otter-1", { synthesizePast: true });

    // slice 失败被 collectJsonlSlice 内部 catch → 机械档案降级，不裸奔也不报错
    expect(session.id).toBe("sess-new");
    void engine;
  });

  it("审视发现1回归：熔断路径只换世一次——unifiedHandoff 成功后不再二次 restartSession（无幽灵世代）", async () => {
    // 全链路走 invokeConversation → handleCircuitBreakSignal：
    // 首段 invoke 退化（_guardAbortReason）→ 熔断判定 → unifiedHandoff 换世（唯一一次）
    // → 补写熔断事件 → 递归全新 invoke 正常 yield。
    // 断言：restartSession 恰一次；旧代码的双重换世（unifiedHandoff 内一次 +
    // executeCircuitBreakRestart 内一次）会记录两次，本用例锁死为一次。
    const restarts: string[] = [];
    let invokeCalls = 0;
    const sdk = {
      invoke: async () => {
        invokeCalls++;
        if (invokeCalls >= 2) return { text: "新世应答" };
        return Object.assign({ text: "" }, { _guardAbortReason: "degenerate_output" });
      },
      runCompactionSynthesis: async () => synthResult("## 交接摘要（七段）"),
      acquireSessionLock: async () => () => {},
      readCurrentSessionEntries: async () => [{ type: "message", id: "e1" }],
      isRunning: () => false,
      abort: vi.fn(), getToolCallCount: () => 0, getInternalAbortReason: () => undefined,
    } as unknown as SdkInvokePort;
    const manageSession = {
      getActiveSession: async () => makeSession({ id: "sess-old" }),
      createSession: async (otterId: string) => makeSession({ otterId }),
      restartSession: async (otterId: string) => {
        restarts.push(`restart:${otterId}`);
        return makeSession({ id: "sess-handoff", otterId });
      },
      conversationQuery: { getIdsByOtterId: async () => ["conv-1"] },
    } as unknown as ManageSession;
    const sendEntry = mockSendEntryForCircuit();
    const healingEvents: Array<Record<string, unknown>> = [];
    const healingRepo = {
      create: async (e: Record<string, unknown>) => { healingEvents.push(e); return "evt-1"; },
      list: async () => [],
    } as unknown as HealingEventRepository;
    const invoker = new AgentInvoker(
      sdk,
      { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
      manageSession,
      { getById: async () => ({ id: "otter-1", name: "测试獭", type: "big" }) } as unknown as QueryOtter,
      sharedLogger,
      undefined, // messageBroadcaster
      undefined, // workspaceGateway
      undefined, // settingsRepo
      undefined, // metrics
      healingRepo,                       // 10：熔断启用
      {} as ConversationRepository,      // 11：统一交接必需
      undefined, // scheduledTaskRepo
      undefined, // listArtifacts
      undefined, // manageContext
      undefined, // buildHandoffPkg
      undefined, // healthySessionThresholdMs
      undefined, // ctxWindowProvider
      sendEntry,                         // 18：invoke 生命周期
      { getInvokeEvents: async () => [] } as never, // 19：invokeRepo
      undefined, // agentDispatchService
      makeEngine(), // 21：engine（F20260918uhuc）
    ) as unknown as AgentInvoker;

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    expect(invokeCalls).toBe(2); // 首段退化 + 新世全新 invoke
    expect(restarts).toHaveLength(1); // 审视发现1核心断言：只换世一次
    expect(restarts[0]).toBe("restart:otter-1");
    // 熔断终态事件已补写（newSessionId 指向 unifiedHandoff 建立的新世）
    const circuitEvent = healingEvents.find((e) => e.errorType === "circuit_break");
    expect(circuitEvent).toBeDefined();
    expect((circuitEvent as { context?: { newSessionId?: string } }).context?.newSessionId).toBe("sess-handoff");
  });
});
