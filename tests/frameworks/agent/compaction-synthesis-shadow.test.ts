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
  /** 测试侧控制：prompt 时经 subscribe 回调推 message 事件喂 turnText */
  _emit: (event: unknown) => void;
  _promptCalls: Array<{ text: string; opts?: { expandPromptTemplates?: boolean } }>;
  _disposed: boolean;
};

function makeShadowSession(opts: { emitText?: string; stopReason?: string; promptError?: Error } = {}): ShadowSession {
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
    sessionManager: {
      getBranch: () => opts.stopReason
        ? [{ type: "message", message: { role: "assistant", stopReason: opts.stopReason } }]
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
    expect(createArgs.model).toBe(poolModel);
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
