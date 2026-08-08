import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppConfig } from "../../../src/frameworks/config";

// Sentinel objects to distinguish default vs custom provider paths
const DEFAULT_PROVIDER = { id: "openai-default" };
const CUSTOM_PROVIDER = { id: "openai-custom" };
const CUSTOM_ANTHROPIC_PROVIDER = { id: "anthropic-custom" };

const mockCreateProvider = vi.fn();
const mockSetProvider = vi.fn();
const mockGetModel = vi.fn();

vi.mock("@earendil-works/pi-ai", () => ({
  createModels: () => ({
    setProvider: mockSetProvider,
    getModel: mockGetModel,
  }),
  createProvider: mockCreateProvider,
}));

vi.mock("@earendil-works/pi-ai/providers/openai.models", () => ({
  OPENAI_MODELS: [{ id: "gpt-4o", api: "openai-responses" }],
}));
vi.mock("@earendil-works/pi-ai/api/openai-responses.lazy", () => ({
  openAIResponsesApi: () => ({ id: "openai-responses" }),
}));
vi.mock("@earendil-works/pi-ai/providers/anthropic.models", () => ({
  ANTHROPIC_MODELS: [{ id: "claude-sonnet-4-20250514", api: "anthropic-messages" }],
}));
vi.mock("@earendil-works/pi-ai/api/anthropic-messages.lazy", () => ({
  anthropicMessagesApi: () => ({ id: "anthropic-messages" }),
}));

vi.mock("@earendil-works/pi-ai/providers/openai", () => ({
  openaiProvider: () => DEFAULT_PROVIDER,
}));
vi.mock("@earendil-works/pi-ai/providers/anthropic", () => ({
  anthropicProvider: () => ({ id: "anthropic-default" }),
}));

let initModels: typeof import("../../../src/frameworks/llm/models-factory").initModels;

/** 构造单条目 llm 配置（单模型 = 一条 models[] 条目） */
function makeLlm(entry: Partial<{ alias: string; provider: string; model: string; apiKey: string; apiBaseUrl: string; contextWindow: number; maxTokens: number }> = {}): AppConfig["llm"] {
  const alias = entry.alias ?? "main";
  return {
    default: alias,
    models: [{
      alias,
      provider: entry.provider ?? "openai",
      model: entry.model ?? "gpt-4o",
      apiKey: entry.apiKey,
      apiBaseUrl: entry.apiBaseUrl,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    }],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetModel.mockReturnValue({ id: "gpt-4o" });
  mockCreateProvider.mockReturnValue(CUSTOM_PROVIDER);

  const mod = await import("../../../src/frameworks/llm/models-factory");
  initModels = mod.initModels;
});

describe("initModels — custom provider routing", () => {
  it("uses default provider when no apiBaseUrl or apiKey is set", async () => {
    const result = await initModels(makeLlm());
    // Default provider sentinel is passed to setProvider
    expect(mockSetProvider.mock.calls[0][0]).toBe(DEFAULT_PROVIDER);
    expect(result.model).toEqual({ id: "gpt-4o" });
  });

  it("uses custom provider when apiKey is set", async () => {
    const result = await initModels(makeLlm({ apiKey: "sk-custom" }));

    // Custom provider sentinel is passed to setProvider (not default)
    expect(mockSetProvider.mock.calls[0][0]).toBe(CUSTOM_PROVIDER);
    expect(result.model).toEqual({ id: "gpt-4o" });
  });

  it("uses custom provider when apiBaseUrl is set", async () => {
    await initModels(makeLlm({ apiBaseUrl: "https://proxy.example.com" }));

    expect(mockSetProvider.mock.calls[0][0]).toBe(CUSTOM_PROVIDER);
  });

  it("uses custom provider when both apiBaseUrl and apiKey are set", async () => {
    await initModels(makeLlm({ apiKey: "sk-test", apiBaseUrl: "https://proxy.example.com" }));

    expect(mockSetProvider.mock.calls[0][0]).toBe(CUSTOM_PROVIDER);
  });

  it("loads anthropic custom provider for anthropic config", async () => {
    mockCreateProvider.mockReturnValue(CUSTOM_ANTHROPIC_PROVIDER);
    mockGetModel.mockReturnValue({ id: "claude-sonnet-4-20250514" });

    await initModels(makeLlm({ alias: "ant", provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "sk-ant" }));

    expect(mockSetProvider.mock.calls[0][0]).toBe(CUSTOM_ANTHROPIC_PROVIDER);
  });

  it("throws for unsupported provider in custom path", async () => {
    await expect(initModels(makeLlm({ provider: "unknown", apiKey: "sk-test" }))).rejects.toThrow("Unsupported LLM provider type: unknown");
  });

  /** F20260808ctxw：自定义模型（不在 provider 字典）注入时携带 config 的 contextWindow，否则 SDK 视为 0 → shouldCompact 恒真 */
  it("injects config contextWindow into SDK model when model not in provider dict", async () => {
    await initModels(makeLlm({ alias: "mimo", provider: "anthropic", model: "mimo-v2.5-pro", apiKey: "sk-x", contextWindow: 1048576 }));

    const models = mockCreateProvider.mock.calls[0][0].models as Array<Record<string, unknown>>;
    const injected = models.find((m) => m.id === "mimo-v2.5-pro");
    expect(injected?.contextWindow).toBe(1048576);
  });

  it("omits contextWindow key when not configured", async () => {
    await initModels(makeLlm({ alias: "mimo", provider: "anthropic", model: "mimo-v2.5-pro", apiKey: "sk-x" }));

    const models = mockCreateProvider.mock.calls[0][0].models as Array<Record<string, unknown>>;
    const injected = models.find((m) => m.id === "mimo-v2.5-pro");
    expect(injected).toBeDefined();
    expect(injected).not.toHaveProperty("contextWindow");
  });

  /** F20260808ctxw：maxTokens 为 SDK Model 必填，config 优先、缺省回退模板值（否则请求负载 max_tokens=null） */
  it("injects config maxTokens when provided", async () => {
    await initModels(makeLlm({ alias: "mimo", provider: "anthropic", model: "mimo-v2.5-pro", apiKey: "sk-x", maxTokens: 131072 }));

    const models = mockCreateProvider.mock.calls[0][0].models as Array<Record<string, unknown>>;
    const injected = models.find((m) => m.id === "mimo-v2.5-pro");
    expect(injected?.maxTokens).toBe(131072);
  });
});

describe("initModels — createCustomApiKeyAuth", () => {
  /** Helper: extract the auth resolver from the createProvider call */
  function getAuthResolver() {
    return mockCreateProvider.mock.calls[0][0].auth.apiKey;
  }

  it("resolves apiKey from config when provided", async () => {
    await initModels(makeLlm({ apiKey: "sk-from-config" }));
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async () => undefined },
      credential: undefined,
    });

    expect(result).toEqual({ auth: { apiKey: "sk-from-config" }, source: "config.yaml" });
  });

  it("resolves apiKey from env when config key is absent", async () => {
    await initModels(makeLlm({ apiBaseUrl: "https://proxy.example.com" })); // apiBaseUrl triggers custom provider
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async (name: string) => (name === "OPENAI_API_KEY" ? "sk-from-env" : undefined) },
      credential: undefined,
    });

    expect(result).toEqual({ auth: { apiKey: "sk-from-env" }, source: "OPENAI_API_KEY" });
  });

  it("resolves apiKey from credential when config and env are absent", async () => {
    await initModels(makeLlm({ apiBaseUrl: "https://proxy.example.com" }));
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async () => undefined },
      credential: { key: "sk-from-cred" },
    });

    expect(result).toEqual({ auth: { apiKey: "sk-from-cred" }, source: "stored credential" });
  });

  it("returns undefined when all sources are missing", async () => {
    await initModels(makeLlm({ apiBaseUrl: "https://proxy.example.com" }));
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async () => undefined },
      credential: undefined,
    });

    expect(result).toBeUndefined();
  });

  it("uses ANTHROPIC_API_KEY env var for anthropic provider", async () => {
    mockCreateProvider.mockReturnValue(CUSTOM_ANTHROPIC_PROVIDER);
    mockGetModel.mockReturnValue({ id: "claude-sonnet-4-20250514" });

    await initModels(makeLlm({ alias: "ant", provider: "anthropic", model: "claude-sonnet-4-20250514", apiBaseUrl: "https://proxy.example.com" }));
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async (name: string) => (name === "ANTHROPIC_API_KEY" ? "sk-ant-env" : undefined) },
      credential: undefined,
    });

    expect(result).toEqual({ auth: { apiKey: "sk-ant-env" }, source: "ANTHROPIC_API_KEY" });
  });

  it("config apiKey takes priority over env and credential", async () => {
    await initModels(makeLlm({ apiKey: "sk-config-wins" }));
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async () => "sk-from-env" },
      credential: { key: "sk-from-cred" },
    });

    expect(result).toEqual({ auth: { apiKey: "sk-config-wins" }, source: "config.yaml" });
  });
});

describe("initModels — model pool", () => {
  it("returns ModelPool covering all models[] entries", async () => {
    const llm: AppConfig["llm"] = {
      default: "fast",
      models: [
        { alias: "fast", provider: "openai", model: "gpt-4o-mini", apiKey: "sk-fast" },
        { alias: "powerful", provider: "openai", model: "gpt-4o", apiKey: "sk-powerful" },
      ],
    };

    // Mock getModel to return different models based on call
    let getModelCallCount = 0;
    mockGetModel.mockImplementation(() => {
      getModelCallCount++;
      return getModelCallCount === 1
        ? { id: "gpt-4o-mini" }
        : { id: "gpt-4o" };
    });

    const result = await initModels(llm);

    expect(result.modelPool).toBeDefined();
    expect(result.modelPool.getDefaultAlias()).toBe("fast");
    expect(result.modelPool.hasModel("fast")).toBe(true);
    expect(result.modelPool.hasModel("powerful")).toBe(true);
  });

  it("single-entry models[] returns ModelPool with one entry", async () => {
    const result = await initModels(makeLlm());

    expect(result.modelPool).toBeDefined();
    expect(result.modelPool.getDefaultAlias()).toBe("main");
    expect(result.modelPool.hasModel("main")).toBe(true);
  });

  it("registers each model with alias as provider ID", async () => {
    const llm: AppConfig["llm"] = {
      default: "fast",
      models: [
        { alias: "fast", provider: "openai", model: "gpt-4o-mini", apiKey: "sk-fast" },
        { alias: "powerful", provider: "openai", model: "gpt-4o", apiKey: "sk-powerful" },
      ],
    };

    mockGetModel.mockReturnValue({ id: "model" });
    mockCreateProvider.mockReturnValue({ id: "custom" });

    await initModels(llm);

    // Each model should call createProvider with alias as ID
    const createProviderCalls = mockCreateProvider.mock.calls;
    expect(createProviderCalls.length).toBe(2);
    expect(createProviderCalls[0][0].id).toBe("fast");
    expect(createProviderCalls[1][0].id).toBe("powerful");
  });
});
