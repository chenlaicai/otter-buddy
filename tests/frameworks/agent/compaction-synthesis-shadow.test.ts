/**
 * F20260912nlb896：压缩合成影子通道（runCompactionSynthesis）单测。
 *
 * 守护的行为（PR #897 delta 复核发现 A：影子通道本体零测试）：
 * 1. 影子 session 用 inMemory SessionManager 创建——不写共享 jsonl、不入池、不触锁；
 * 2. 模型解析链：otter 显式 modelAlias → 池默认（与 _createSessionWithTools 同链）；
 * 3. 结果组装：directText 来自 turnText 捕获、lastStopReason 从 session branch 提取；
 * 4. 失败路径：session 错误经 checkSessionError 抛出（调用方 fail-closed 降级）。
 *
 * 策略：mock piCodingAgent 模块边界（createAgentSession/SessionManager.inMemory），
 * 驱动真实 runCompactionSynthesis 本体——与 pool-hit-path 同款的「mock SDK 接触面」原则。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import type { Model, Api } from "@earendil-works/pi-ai";

type ShadowSession = {
  prompt: (text: string, opts?: { expandPromptTemplates?: boolean }) => Promise<void>;
  subscribe: (fn: (event: unknown) => void) => () => void;
  dispose: () => void;
  state: { errorMessage?: string };
  sessionManager: { getBranch: () => Array<Record<string, unknown>> };
  /** F20260924thnk：thinkingLevel 注入链 */
  setThinkingLevel: (level: string) => void;
  thinkingLevel: string;
  /** 测试侧控制：prompt 时经 subscribe 回调推 message 事件喂 turnText */
  _emit: (event: unknown) => void;
  _promptCalls: Array<{ text: string; opts?: { expandPromptTemplates?: boolean } }>;
  _disposed: boolean;
};

function makeShadowSession(opts: { emitText?: string; stopReason?: string; promptError?: Error; usage?: { input: number; output: number; reasoning?: number }; appliedThinkingLevel?: string } = {}): ShadowSession {
  let handler: ((event: unknown) => void) | null = null;
  const s: ShadowSession = {
    _promptCalls: [],
    _disposed: false,
    _emit: (event) => handler?.(event),
    subscribe: (fn) => { handler = fn; return () => { handler = null; }; },
    prompt: async (text, popts) => {
      s._promptCalls.push({ text, opts: popts });
      if (opts.promptError) throw opts.promptError;
      if (opts.emitText) {
        // 与真实 message_end 事件同构：turnText 捕获助手直出文本
        s._emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: opts.emitText }] } });
      }
    },
    dispose: () => { s._disposed = true; },
    state: {},
    // setThinkingLevel 记录请求值；applied 档默认回显 off（空 map 生产路径），可注入 clamp 行为
    setThinkingLevel: (level) => { s.thinkingLevel = opts.appliedThinkingLevel ?? level; },
    thinkingLevel: "medium",
    sessionManager: {
      getBranch: () => opts.stopReason || opts.usage
        ? [{ type: "message", message: {
            role: "assistant",
            ...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
            ...(opts.usage ? { usage: opts.usage } : {}),
          } }]
        : [],
    },
  };
  return s;
}

function makeFactoryForShadow(shadow: ShadowSession, modelPool?: { getModel: (alias: string | null | undefined) => Model<Api> }) {
  const db = createTestDb();
  const defaultModel = { id: "default-model", contextWindow: 200_000 } as unknown as Model<Api>;
  const factory = new PiSessionFactory({
    db,
    sessionDir: ":memory:",
    otterToolClient: {} as never,
    model: defaultModel,
    modelPool: modelPool as never,
    createTools: () => [],
    otterConfigProvider: {
      getConfig: () => ({ systemPrompt: undefined, otterType: "big", modelAlias: "kimi" }),
      setConfig: () => {},
      deleteConfig: () => {},
    } as never,
    otterRepo: new SqliteOtterRepository(db),
  }, createTestLogger());

  const inMemoryCalls: unknown[][] = [];
  const createSessionCalls: Array<Record<string, unknown>> = [];
  const internals = factory as unknown as {
    modelRuntimeRegistry: {
      getPiCodingAgent: () => unknown;
      getResourceLoader: () => null;
      getModelRuntime: () => null;
      getSettingsManager: () => null;
    };
    ensurePiCodingAgent: () => Promise<void>;
  };
  internals.ensurePiCodingAgent = async () => {};
  internals.modelRuntimeRegistry = {
    getPiCodingAgent: () => ({
      SessionManager: {
        inMemory: (...args: unknown[]) => { inMemoryCalls.push(args); return { kind: "inMemory-session-manager" }; },
        create: vi.fn(), open: vi.fn(),
      },
      createAgentSession: async (opts: Record<string, unknown>) => { createSessionCalls.push(opts); return { session: shadow }; },
    }),
    getResourceLoader: () => null,
    getModelRuntime: () => null,
    getSettingsManager: () => null,
  };
  return { factory, db, inMemoryCalls, createSessionCalls, defaultModel };
}

describe("F20260912nlb896 压缩合成影子通道（runCompactionSynthesis）", () => {
  it("inMemory session 直调 LLM：不入池不触锁，prompt 关闭模板展开，直出文本与 stopReason 正确组装", async () => {
    const shadow = makeShadowSession({ emitText: "七段合成摘要文本", stopReason: "stop" });
    const { factory, db, inMemoryCalls, createSessionCalls } = makeFactoryForShadow(shadow);

    const result = await factory.runCompactionSynthesis("o1", "合成 prompt 正文");

    // inMemory SessionManager（无 jsonl、无持久化）——副作用证据：inMemory 被用于创建
    expect(inMemoryCalls).toHaveLength(1);
    // createAgentSession 收到 inMemory manager + 空工具集（无 customTools，无编码工具）
    const createArgs = createSessionCalls[0] as { sessionManager: unknown; tools: unknown[]; customTools: unknown[] };
    expect(createArgs.sessionManager).toEqual({ kind: "inMemory-session-manager" });
    expect(createArgs.tools).toEqual([]);
    expect(createArgs.customTools).toEqual([]);
    // prompt 关闭模板展开（合成 prompt 是机械构建的完整文本，/ 开头也不许被当命令）
    expect(shadow._promptCalls[0]?.opts?.expandPromptTemplates).toBe(false);
    expect(shadow._promptCalls[0]?.text).toBe("合成 prompt 正文");
    // 结果组装
    expect(result.directText).toBe("七段合成摘要文本");
    expect(result.lastStopReason).toBe("stop");
    // 清理：session dispose（释放内部状态）
    expect(shadow._disposed).toBe(true);
    db.close();
  });

  it("模型解析走 modelPool.getModel（otter 显式 alias），与 _createSessionWithTools 同链", async () => {
    const shadow = makeShadowSession({ emitText: "x" });
    const poolModel = { id: "pool-model", contextWindow: 300_000 } as unknown as Model<Api>;
    const getModelCalls: Array<string | null | undefined> = [];
    const getModel = (alias: string | null | undefined) => { getModelCalls.push(alias); return poolModel; };
    const { factory, db, createSessionCalls } = makeFactoryForShadow(shadow, { getModel });

    await factory.runCompactionSynthesis("o1", "prompt");

    expect(getModelCalls).toEqual(["kimi"]); // otterConfig.modelAlias
    const createArgs = createSessionCalls[0] as { model: unknown };
    // F20260924swin 改动点1：合成 model 显式 maxTokens=4,096（否则 SDK falsy 跳过分支，服务端默认预留吃掉 25% 窗口）
    expect(createArgs.model).toEqual({ ...poolModel, maxTokens: 4_096 });
    db.close();
  });

  it("F20260924swin 严重5 修复：modelOverride 优先于 otter 配置（换模型重启预算模型 = 执行模型）", async () => {
    const shadow = makeShadowSession({ emitText: "x" });
    const poolModel = { id: "pool-model", contextWindow: 300_000 } as unknown as Model<Api>;
    const getModelCalls: Array<string | null | undefined> = [];
    const getModel = (alias: string | null | undefined) => { getModelCalls.push(alias); return poolModel; };
    const { factory, db } = makeFactoryForShadow(shadow, { getModel });

    await factory.runCompactionSynthesis("o1", "prompt", "kimi-1m-override");

    expect(getModelCalls).toEqual(["kimi-1m-override"]); // override 优先，非 otterConfig 的 kimi
    db.close();
  });

  it("prompt 抛错（LLM API 失败）时异常透传（调用方 fail-closed 降级），session 仍被清理", async () => {
    const shadow = makeShadowSession({ promptError: new Error("LLM API 502") });
    const { factory, db } = makeFactoryForShadow(shadow);

    await expect(factory.runCompactionSynthesis("o1", "prompt")).rejects.toThrow("LLM API 502");
    expect(shadow._disposed).toBe(true); // finally 清理不受异常影响
    db.close();
  });
});

describe("F20260924thnk 合成影子通道 thinking 关闭（观测三件套）", () => {
  it("改动点1：session 创建后显式 setThinkingLevel('off') 且生效（空 map 生产路径）——思考型模型不再烧光 maxTokens 致正文 0 字", async () => {
    const shadow = makeShadowSession({ emitText: "七段合成摘要", stopReason: "stop" });
    const { factory, db, createSessionCalls } = makeFactoryForShadow(shadow);

    const result = await factory.runCompactionSynthesis("o1", "合成 prompt");

    // off 请求已发且生效（mock 回显默认 off——空 thinkingLevelMap 生产路径）
    expect(shadow.thinkingLevel).toBe("off");
    // maxTokens 回归钉：显式合成预算仍在（F20260924swin 改动点1 不回退）且为有限数（无 NaN——simple-options off 档 budgets['off']=undefined 边界）
    const model = (createSessionCalls[0] as { model: { maxTokens?: number } }).model;
    expect(model.maxTokens).toBe(4096);
    expect(Number.isFinite(model.maxTokens)).toBe(true);
    // 结果组装不受影响
    expect(result.directText).toBe("七段合成摘要");
    expect(result.lastStopReason).toBe("stop");
    db.close();
  });

  it("严重2 防线：off 被 clamp 到其他档时 warn 日志落锚（k3 系正主模板风险，静默失效变可见）", async () => {
    const warnCalls: Array<Record<string, unknown>> = [];
    const shadow = makeShadowSession({ appliedThinkingLevel: "low" }); // 模拟 kimi-coding 正主 map[off]=null → clamp
    const { factory, db } = makeFactoryForShadow(shadow);
    (factory as unknown as { logger: { warn: (msg: string, data: Record<string, unknown>) => void } }).logger.warn =
      (msg: string, data: Record<string, unknown>) => { warnCalls.push({ msg, ...data }); };

    await factory.runCompactionSynthesis("o1", "prompt");

    expect(shadow.thinkingLevel).toBe("low"); // clamp 生效（模拟）
    const clampWarn = warnCalls.find((w) => String(w.msg).includes("thinking off clamped"));
    expect(clampWarn).toBeTruthy(); // applied ≠ off 必报——静默失效变可见
    expect(clampWarn!.applied).toBe("low");
    db.close();
  });

  it("观测三件套：starting 打 resolved 模型 + applied thinkingLevel；completed 补 usage（reasoning 可证伪 thinking）", async () => {
    const infoCalls: Array<Record<string, unknown>> = [];
    const shadow = makeShadowSession({
      emitText: "摘要", stopReason: "stop",
      usage: { input: 82_000, output: 1_024, reasoning: 0 },
    });
    const poolModel = { id: "glm-5.3", contextWindow: 1_048_576 } as unknown as Model<Api>;
    const { factory, db } = makeFactoryForShadow(shadow, { getModel: () => poolModel });
    (factory as unknown as { logger: { info: (msg: string, data: Record<string, unknown>) => void } }).logger.info =
      (msg: string, data: Record<string, unknown>) => { infoCalls.push({ msg, ...data }); };

    await factory.runCompactionSynthesis("o1", "prompt");

    const starting = infoCalls.find((l) => String(l.msg).includes("shadow channel starting"));
    expect(starting).toBeTruthy();
    expect(starting!.modelAlias).toBe("kimi"); // resolved 真实模型（otter config alias），非 getModelAliasForLog 的 config 值——观测不再误导
    expect(starting!.thinkingLevel).toBe("off"); // applied 档落锚
    const completed = infoCalls.find((l) => String(l.msg).includes("shadow channel completed"));
    expect(completed).toBeTruthy();
    expect((completed!.usage as { input: number }).input).toBe(82_000);
    expect((completed!.usage as { reasoning?: number }).reasoning).toBe(0); // thinking 未烧预算的直接证据
    db.close();
  });

  it("override 场景：resolved 模型打 override 值（换模型重启时观测与执行一致）", async () => {
    const infoCalls: Array<Record<string, unknown>> = [];
    const shadow = makeShadowSession({ emitText: "x", stopReason: "stop" });
    const poolModel = { id: "glm-5.3" } as unknown as Model<Api>;
    const { factory, db } = makeFactoryForShadow(shadow, { getModel: () => poolModel });
    (factory as unknown as { logger: { info: (msg: string, data: Record<string, unknown>) => void } }).logger.info =
      (msg: string, data: Record<string, unknown>) => { infoCalls.push({ msg, ...data }); };

    await factory.runCompactionSynthesis("o1", "prompt", "glm");

    const starting = infoCalls.find((l) => String(l.msg).includes("shadow channel starting"));
    expect(starting!.modelAlias).toBe("glm"); // override 优先——14:16 现场显示 mimo-pro 但执行 glm 的观测失真不复存在
    db.close();
  });
});
