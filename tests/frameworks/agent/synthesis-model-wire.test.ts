import { createTestExecutionMachineRegistry } from "../../helpers/execution-machine";
/**
 * F20261111mwire（#1854）：合成模型覆盖到达线缆——红测。
 *
 * 事故链（#1852 检视 B1）：durable 运行时按 (provider, modelId) 从 models 源重解析
 * 模型（harness/generation.js:138），durable-session 的 agentChange() 只传
 * {provider, modelId}——合成模型副本上的 maxTokens/thinkingLevelMap 覆盖被丢弃，
 * 线缆实际走池模板值（maxTokens 128000 + 空 thinkingLevelMap）。
 *
 * 守护的行为：
 * 1. runSynthesisAttempt 传给 DurableSession.open 的 models 源必须是「按 (provider,id)
 *    覆盖的包装源」——harness 的 runtime.models.getModel(provider, id) 命中合成副本
 *    （maxTokens 8192 + 能力表），线缆请求因此携带显式预算与能力词表。
 * 2. 覆盖不泄漏：非目标 (provider,id) 的解析委托底层源（原样返回，含 undefined）；
 *    底层源对象本身不被修改（合成 session 是一次性实例，但共享 models 源来自
 *    WeakMap 池缓存——绝不能就地改）。
 * 3. streamSimple 等其余成员透传（Proxy get 委托 + bind 到底层，auth/凭据链路不受影响）。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@frameworks/config", () => ({ getConfig: () => ({ circuitBreaker: {} }) }));

import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { PiSessionFactory } from "@frameworks/agent/pi-session-factory";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { withModelOverride } from "@frameworks/agent/durable-model-runtime";
import { createModels } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";

const KIMI_K3_TRUTH_MAP = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } as const;

const KIMI_CUSTOM_MODEL = {
  id: "k3.1-pro",
  provider: "kimi",
  api: "openai-responses",
  baseUrl: "https://api.kimi.com/coding/v1",
  reasoning: true,
  thinkingLevelMap: {},
  contextWindow: 1_048_576,
} as unknown as Model<Api>;

type ShadowSession = {
  prompt: (text: string, opts?: unknown, stream?: { apply: (view: unknown, ops?: unknown[]) => Promise<void> }) => Promise<void>;
  subscribe: (fn: (event: unknown) => void) => () => void;
  dispose: () => void;
  state: Record<string, unknown>;
  close: () => Promise<void>;
  setThinkingLevel: (level: string) => void;
  thinkingLevel: string;
};

function makeShadowSession(opts: { emitText?: string } = {}): ShadowSession {
  const s = {
    subscribe: () => () => {},
    prompt: async (_text: string, _opts: unknown, stream?: { apply: (view: unknown, ops?: unknown[]) => Promise<void> }) => {
      if (opts.emitText && stream) {
        await stream.apply({ entries: [{ id: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: opts.emitText }] }] }] }, []);
      }
    },
    dispose: () => {},
    state: {},
    setThinkingLevel: (level: string) => { s.thinkingLevel = level; },
    thinkingLevel: "off",
    close: async () => {},
  } as ShadowSession;
  return s;
}

async function makeFactoryWithSessionQueue(sessions: ShadowSession[], modelPool?: { getModel: () => Model<Api>; hasModel?: () => boolean }) {
  const db = createTestDb();
  const factory = new PiSessionFactory({
    executionMachines: createTestExecutionMachineRegistry(),
    db,
    sessionDir: ":memory:",
    otterToolClient: {} as never,
    model: KIMI_CUSTOM_MODEL,
    modelPool: (modelPool ?? { getModel: () => KIMI_CUSTOM_MODEL, hasModel: () => true }) as never,
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
  const internals = factory as unknown as { modelRuntimeRegistry: unknown; ensurePiCodingAgent: () => Promise<void> };
  const { DurableSession } = await import("@frameworks/agent/durable-session");
  (DurableSession as unknown as { open: (options: Record<string, unknown>) => Promise<unknown> }).open = async (options) => {
    openCalls.push(options);
    return sessions[Math.min(cursor++, sessions.length - 1)];
  };
  internals.ensurePiCodingAgent = async () => {};
  internals.modelRuntimeRegistry = {
    getPiCodingAgent: () => ({
      SessionManager: { inMemory: () => ({}), create: vi.fn(), open: vi.fn() },
      createAgentSession: async (opts: Record<string, unknown>) => { openCalls.push(opts); return { session: sessions[0] }; },
    }),
    getResourceLoader: () => null,
    getModelRuntime: () => null,
    getSettingsManager: () => null,
  };
  return { factory, openCalls };
}

describe("F20261111mwire #1854 合成模型覆盖到达线缆", () => {
  it("线缆：合成 session 的 models 源对 (kimi, k3.1-pro) 返回带 8192+能力表的副本", async () => {
    const session = makeShadowSession({ emitText: "## 会话摘要\n（七段）" });
    const { factory, openCalls } = await makeFactoryWithSessionQueue([session]);

    await factory.runCompactionSynthesis("o1", "合成 prompt");

    expect(openCalls.length).toBeGreaterThan(0);
    const models = openCalls[0].models as { getModel: (p: string, id: string) => unknown };
    expect(typeof models.getModel).toBe("function");
    // 红点：今天 models 是原样底层源，getModel("kimi","k3.1-pro") 返回 undefined（无 provider 注册），
    // 线缆拿不到 8192/能力表——包装后必须命中合成副本
    const resolved = models.getModel("kimi", "k3.1-pro") as Model<Api> & { maxTokens?: number; thinkingLevelMap?: Record<string, string | null> };
    expect(resolved).toBeDefined();
    expect(resolved.maxTokens).toBe(8192);
    expect(resolved.thinkingLevelMap).toEqual(KIMI_K3_TRUTH_MAP);
    // 档位照旧显式选 low（F1 语义不变）
    expect((openCalls[0].model as Record<string, unknown>).maxTokens).toBe(8192);
    expect(openCalls[0].thinkingLevel).toBe("low");
  });

  it("不泄漏：非目标 (provider,id) 委托底层源原样返回；底层源对象不被修改", async () => {
    const session = makeShadowSession({ emitText: "ok" });
    const { factory, openCalls } = await makeFactoryWithSessionQueue([session]);
    await factory.runCompactionSynthesis("o1", "prompt");

    const models = openCalls[0].models as unknown as { getModel: (p: string, id: string) => unknown };
    // 底层空源：其他 id 解析结果 = 底层原样（undefined），不因包装而生造
    expect(models.getModel("kimi", "other-model")).toBeUndefined();
    expect(models.getModel("other-provider", "k3.1-pro")).toBeUndefined();
  });

  it("S1（检视建议采纳）：覆盖经 pi-durable harness 的 withClientIdentity 包装层后仍命中（真实链 harness.js:93）", async () => {
    // 检视獭-1855 S1：Harness.open 内部会 withClientIdentity(models, identity) 再包一层，
    // 其 wrapped.getModel 委托底层——本测试把该层钉进回归（防未来 pi-ai 改包装方式时静默断链）
    const identityMod = await import("@earendil-works/pi-ai/utils/identity");
    const session = makeShadowSession({ emitText: "ok" });
    const { factory, openCalls } = await makeFactoryWithSessionQueue([session]);
    await factory.runCompactionSynthesis("o1", "prompt");

    const models = openCalls[0].models as unknown as { getModel: (p: string, id: string) => unknown };
    const harnessView = identityMod.withClientIdentity(
      models as never,
      { name: "regression-test", version: "1" } as never,
    ) as unknown as { getModel: (p: string, id: string) => unknown };
    const resolved = harnessView.getModel("kimi", "k3.1-pro") as { maxTokens?: number } | undefined;
    expect(resolved).toBeDefined();
    expect(resolved!.maxTokens).toBe(8192);
    // 非目标仍委托原样
    expect(harnessView.getModel("kimi", "nope")).toBeUndefined();
  });

  it("单元：withModelOverride 覆盖命中 + 透传成员委托底层 + 不改底层", () => {
    const base = createModels() as { getModel: (p: string, i: string) => unknown; setProvider: (p: unknown) => void; extra?: never };
    const override = { ...KIMI_CUSTOM_MODEL, maxTokens: 8192, thinkingLevelMap: { ...KIMI_K3_TRUTH_MAP } } as unknown as Model<Api>;
    const wrapped = withModelOverride(base as never, override) as unknown as typeof base;

    expect(wrapped.getModel("kimi", "k3.1-pro")).toBe(override);
    expect(wrapped.getModel("kimi", "nope")).toBe(base.getModel("kimi", "nope"));
    expect(wrapped.getModel("anthropic", "k3.1-pro")).toBe(base.getModel("anthropic", "k3.1-pro"));
    // 透传成员可调用（bind 到底层，不炸）
    expect(typeof wrapped.setProvider).toBe("function");
    expect(() => (wrapped as unknown as { deleteProvider: (id: string) => void }).deleteProvider("x")).not.toThrow();
    // 底层未被就地修改
    expect(base.getModel("kimi", "k3.1-pro")).toBeUndefined();
  });
});
