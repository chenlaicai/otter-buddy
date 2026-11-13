import { createTestExecutionMachineRegistry } from "../../helpers/execution-machine";
/**
 * F20261111synth：叙事合成 thinking 能力解析 + 兜底重试 + 预算上调（#1850）。
 *
 * 守护的行为（红测先行，2026-11-11 换世合成 100% 降级事故）：
 * 1. F1 能力层：合成专用模型副本按 (baseUrl host + modelId) 继承 SDK provider 目录的
 *    thinkingLevelMap（api.kimi.com ↔ kimi-coding 目录）——off:null 由 SDK 既有 clamp
 *    抬到 low，不再盲发 reasoning.effort:"none"（端点实测拒收 none/minimal/off）。
 *    未知 host 不继承（kimi-highspeed 聊天路径零改动的同一理由：能力表是目录为
 *    completions 协议写的，不能无差别搬进 responses）。
 * 2. F2 预算层：SYNTHESIS_EXPLICIT_MAX_TOKENS 4096→8192——off 不可表达时合成以 low
 *    档执行，思考与正文共享 maxTokens（9-24 事故：medium 烧光 4096 致 0 字输出）。
 * 3. F3 韧性层：合成传输类失败（4xx/5xx/网络）→ 兜底模型重试一次（缺省 glm）；
 *    非传输类失败不重试（逻辑错误重试无意义）。
 * 4. F4 观测层：机械档案说明段携带降级错误摘要（档案自证，不再依赖进程日志存活）。
 *
 * 策略：与 compaction-synthesis-shadow.test.ts 同款——mock DurableSession.open 接触面，
 * 驱动真实 runCompactionSynthesis 本体。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { buildMechanicalArchive, SYNTHESIS_EXPLICIT_MAX_TOKENS } from "@frameworks/agent/narrative-synthesis-engine";
import { pickSynthesisThinkingLevel } from "@frameworks/agent/synthesis-thinking-capability";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import type { Model, Api } from "@earendil-works/pi-ai";

/** SDK kimi-coding 目录对 k3 全系声明的真值（off:null = 端点无法表达「关思考」） */
const KIMI_K3_TRUTH_MAP = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } as const;

type ShadowSession = {
  prompt: (text: string, opts?: unknown, stream?: { apply: (view: unknown, ops?: unknown[]) => Promise<void> }) => Promise<void>;
  subscribe: (fn: (event: unknown) => void) => () => void;
  dispose: () => void;
  state: { errorMessage?: string };
  lastStopReason?: string;
  tokenUsage?: { input: number; output: number; reasoning?: number };
  close: () => Promise<void>;
  setThinkingLevel: (level: string) => void;
  thinkingLevel: string;
  _emit: (event: unknown) => void;
  _promptCalls: Array<{ text: string }>;
  _disposed: boolean;
};

function makeShadowSession(opts: { emitText?: string; promptError?: Error } = {}): ShadowSession {
  let handler: ((event: unknown) => void) | null = null;
  const s = {
    _promptCalls: [] as Array<{ text: string }>,
    _disposed: false,
    _emit: (event: unknown) => handler?.(event),
    subscribe: (fn: (event: unknown) => void) => { handler = fn; return () => { handler = null; }; },
    prompt: async (text: string, _opts: unknown, stream?: { apply: (view: unknown, ops?: unknown[]) => Promise<void> }) => {
      s._promptCalls.push({ text });
      if (opts.promptError) throw opts.promptError;
      if (opts.emitText && stream) {
        await stream.apply({ entries: [{ id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: opts.emitText }] }] }] }, []);
      }
    },
    dispose: () => { s._disposed = true; },
    state: {},
    setThinkingLevel: (level: string) => { s.thinkingLevel = level; },
    thinkingLevel: "off",
    close: async () => { s._disposed = true; },
  } as ShadowSession;
  return s;
}

const KIMI_CUSTOM_MODEL = {
  id: "k3.1-pro",
  name: "k3.1-pro",
  provider: "kimi",
  api: "openai-responses",
  baseUrl: "https://api.kimi.com/coding/v1",
  reasoning: true,
  thinkingLevelMap: {}, // models-factory 自定义模型空表（事故现场形态）
  contextWindow: 1_048_576,
} as unknown as Model<Api>;

const GLM_MODEL = {
  id: "glm-5.3",
  name: "glm-5.3",
  provider: "glm",
  api: "anthropic-messages",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  thinkingLevelMap: {},
  contextWindow: 1_048_576,
} as unknown as Model<Api>;

async function makeFactoryWithSessionQueue(sessions: ShadowSession[], modelPool?: { getModel: (alias: string | null | undefined) => Model<Api>; hasModel?: (alias: string) => boolean }) {
  const db = createTestDb();
  const factory = new PiSessionFactory({
    executionMachines: createTestExecutionMachineRegistry(),
    db,
    sessionDir: ":memory:",
    otterToolClient: {} as never,
    model: GLM_MODEL,
    modelPool: (modelPool ?? {
      getModel: () => KIMI_CUSTOM_MODEL,
      hasModel: () => true,
    }) as never,
    createTools: () => [],
    otterConfigProvider: {
      getConfig: () => ({ systemPrompt: undefined, otterType: "big", modelAlias: "kimi" }),
      setConfig: () => {},
      deleteConfig: () => {},
    } as never,
    otterRepo: new SqliteOtterRepository(db),
  }, createTestLogger());

  const openCalls: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const internals = factory as unknown as {
    modelRuntimeRegistry: unknown;
    ensurePiCodingAgent: () => Promise<void>;
  };
  const { DurableSession } = await import("@frameworks/agent/durable-session");
  (DurableSession as unknown as { open: (options: Record<string, unknown>) => Promise<unknown> }).open = async (options) => {
    openCalls.push(options);
    const s = sessions[Math.min(cursor++, sessions.length - 1)];
    return s;
  };
  internals.ensurePiCodingAgent = async () => {};
  internals.modelRuntimeRegistry = {
    getPiCodingAgent: () => ({
      SessionManager: { inMemory: () => ({ kind: "inMemory-session-manager" }), create: vi.fn(), open: vi.fn() },
      createAgentSession: async (opts: Record<string, unknown>) => { openCalls.push(opts); return { session: sessions[0] }; },
    }),
    getResourceLoader: () => null,
    getModelRuntime: () => null,
    getSettingsManager: () => null,
  };
  return { factory, openCalls };
}

describe("F20261111synth #1850 叙事合成 thinking 能力/预算/兜底/档案自证", () => {
  it("F1：kimi 自定义模型合成 → 模型副本继承 kimi-coding 目录真值 thinkingLevelMap，且显式选最低可表达档 low（durable 不 clamp，off→省略参数=端点默认开思考，不可依赖）", async () => {
    const session = makeShadowSession({ emitText: "## 会话摘要\n（七段）" });
    const { factory, openCalls } = await makeFactoryWithSessionQueue([session]);

    await factory.runCompactionSynthesis("o1", "合成 prompt");

    expect(openCalls.length).toBeGreaterThan(0);
    const open = openCalls[0];
    const model = open.model as Record<string, unknown>;
    // 红点①：今天空表原样透传（thinkingLevelMap = {}）且盲传 off（→ effort:none 400）
    expect(model.thinkingLevelMap).toEqual(KIMI_K3_TRUTH_MAP);
    // 红点①补：off 不可表达时必须显式选最低可表达档（kimi 真值 → low，端点实测可用）
    expect(open.thinkingLevel).toBe("low");
  });

  it("F1 反例：未知 host（目录不认识）不继承，空表原样且档位 off（不猜能力）", async () => {
    const unknownHostModel = { ...KIMI_CUSTOM_MODEL, id: "some-model", baseUrl: "https://api.example.com/v1" } as unknown as Model<Api>;
    const session = makeShadowSession({ emitText: "ok" });
    const { factory, openCalls } = await makeFactoryWithSessionQueue([session], {
      getModel: () => unknownHostModel,
      hasModel: () => true,
    });

    await factory.runCompactionSynthesis("o1", "prompt");

    const model = openCalls[0].model as Record<string, unknown>;
    expect(model.thinkingLevelMap).toEqual({});
    expect(openCalls[0].thinkingLevel).toBe("off");
  });

  it("F1 选档：pickSynthesisThinkingLevel 全序取最低可表达档；off 可表达/空表/off:null 全序命中", () => {
    // kimi 真值：off 不可表达 → low（全序第一个字符串档）
    expect(pickSynthesisThinkingLevel({ off: null, minimal: null, low: "low", medium: null, high: "high", max: "max" })).toBe("low");
    // 无 low 的退化表：取下一个可表达档
    expect(pickSynthesisThinkingLevel({ off: null, high: "high" })).toBe("high");
    // off 可表达（字符串）→ off 原语义
    expect(pickSynthesisThinkingLevel({ off: "none", low: "low" })).toBe("off");
    // 空表/undefined → off（未知能力不猜档，F3 兑底接传输异常）
    expect(pickSynthesisThinkingLevel(undefined)).toBe("off");
    expect(pickSynthesisThinkingLevel({})).toBe("off");
  });

  it("F2：合成显式 max_tokens 上调至 8192（吸收 low 档思考税），常量与模型副本同值", async () => {
    expect(SYNTHESIS_EXPLICIT_MAX_TOKENS).toBe(8192); // 红点②：今天 4096

    const session = makeShadowSession({ emitText: "ok" });
    const { factory, openCalls } = await makeFactoryWithSessionQueue([session]);
    await factory.runCompactionSynthesis("o1", "prompt");
    const model = openCalls[0].model as Record<string, unknown>;
    expect(model.maxTokens).toBe(8192);
  });

  it("F3：传输类失败（API 400）→ 兜底模型重试一次并成功；两次 open 的模型不同", async () => {
    const badSession = makeShadowSession({ promptError: new Error('kimi API error (400): {"code":"invalid_request_error","message":"reasoning.effort value \\"none\\" is not supported"}') });
    const goodSession = makeShadowSession({ emitText: "## 会话摘要\n兜底成功" });
    const { factory, openCalls } = await makeFactoryWithSessionQueue([badSession, goodSession], {
      getModel: (alias) => (alias === "glm" ? GLM_MODEL : KIMI_CUSTOM_MODEL),
      hasModel: (alias) => alias === "glm" || alias === "kimi",
    });

    const result = await factory.runCompactionSynthesis("o1", "prompt"); // 红点③：今天首次失败直接抛

    expect(openCalls.length).toBe(2);
    expect((openCalls[0].model as Record<string, unknown>).id).toBe("k3.1-pro");
    expect((openCalls[1].model as Record<string, unknown>).id).toBe("glm-5.3");
    expect(result.directText).toContain("兜底成功");
    expect(badSession._disposed).toBe(true); // 失败 session 关闭，不留泄漏
  });

  it("F3 反例：非传输类失败不重试（单次 open，错误上抛由调用方降级）", async () => {
    const badSession = makeShadowSession({ promptError: new Error("some logic error, not transport") });
    const goodSession = makeShadowSession({ emitText: "不应到达" });
    const { factory, openCalls } = await makeFactoryWithSessionQueue([badSession, goodSession], {
      getModel: (alias) => (alias === "glm" ? GLM_MODEL : KIMI_CUSTOM_MODEL),
      hasModel: () => true,
    });

    await expect(factory.runCompactionSynthesis("o1", "prompt")).rejects.toThrow("some logic error");
    expect(openCalls.length).toBe(1);
  });

  it("F4：机械档案说明段携带降级错误摘要（档案自证，脱离进程日志可归因）", () => {
    const archive = buildMechanicalArchive({
      otterName: "大獭",
      trigger: "手动",
      oldSessionId: "0e6fdd91-57b7-4dac-8860-41aa3619170d",
      degradeReason: "synthesis-error",
      degradeErrorDetail: 'kimi-lty API error (400): reasoning.effort value "none" is not supported',
    } as Parameters<typeof buildMechanicalArchive>[0]);

    expect(archive).toContain("叙事合成执行失败");
    expect(archive).toContain('失败原因：kimi-lty API error (400): reasoning.effort value "none" is not supported'); // 红点④：今天无此行
    // 无 detail 时不多出行（user-off/真空等形态不受影响）
    const plain = buildMechanicalArchive({ otterName: "大獭", trigger: "手动", degradeReason: "user-off" } as Parameters<typeof buildMechanicalArchive>[0]);
    expect(plain).not.toContain("失败原因：");
  });
});
