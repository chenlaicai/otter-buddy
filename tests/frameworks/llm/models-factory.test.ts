import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config module — must be declared before dynamic import
const mockConfig = {
  llm: {
    provider: "openai",
    model: "gpt-4o",
    apiKey: undefined as string | undefined,
    apiBaseUrl: undefined as string | undefined,
  },
};

vi.mock("../../../src/frameworks/config", () => ({
  config: mockConfig,
}));

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

beforeEach(async () => {
  vi.clearAllMocks();
  mockConfig.llm = { provider: "openai", model: "gpt-4o", apiKey: undefined, apiBaseUrl: undefined };
  mockGetModel.mockReturnValue({ id: "gpt-4o" });
  mockCreateProvider.mockReturnValue(CUSTOM_PROVIDER);

  const mod = await import("../../../src/frameworks/llm/models-factory");
  initModels = mod.initModels;
});

describe("initModels — custom provider routing", () => {
  it("uses default provider when no apiBaseUrl or apiKey is set", async () => {
    const result = await initModels();
    // Default provider sentinel is passed to setProvider
    expect(mockSetProvider.mock.calls[0][0]).toBe(DEFAULT_PROVIDER);
    expect(result.model).toEqual({ id: "gpt-4o" });
  });

  it("uses custom provider when apiKey is set", async () => {
    mockConfig.llm.apiKey = "sk-custom";

    const result = await initModels();

    // Custom provider sentinel is passed to setProvider (not default)
    expect(mockSetProvider.mock.calls[0][0]).toBe(CUSTOM_PROVIDER);
    expect(result.model).toEqual({ id: "gpt-4o" });
  });

  it("uses custom provider when apiBaseUrl is set", async () => {
    mockConfig.llm.apiBaseUrl = "https://proxy.example.com";

    await initModels();

    expect(mockSetProvider.mock.calls[0][0]).toBe(CUSTOM_PROVIDER);
  });

  it("uses custom provider when both apiBaseUrl and apiKey are set", async () => {
    mockConfig.llm.apiKey = "sk-test";
    mockConfig.llm.apiBaseUrl = "https://proxy.example.com";

    await initModels();

    expect(mockSetProvider.mock.calls[0][0]).toBe(CUSTOM_PROVIDER);
  });

  it("loads anthropic custom provider for anthropic config", async () => {
    mockConfig.llm.provider = "anthropic";
    mockConfig.llm.model = "claude-sonnet-4-20250514";
    mockConfig.llm.apiKey = "sk-ant";
    mockCreateProvider.mockReturnValue(CUSTOM_ANTHROPIC_PROVIDER);
    mockGetModel.mockReturnValue({ id: "claude-sonnet-4-20250514" });

    await initModels();

    expect(mockSetProvider.mock.calls[0][0]).toBe(CUSTOM_ANTHROPIC_PROVIDER);
  });

  it("throws for unsupported provider in custom path", async () => {
    mockConfig.llm.provider = "unknown";
    mockConfig.llm.apiKey = "sk-test";

    await expect(initModels()).rejects.toThrow("Unsupported LLM provider: unknown");
  });
});

describe("initModels — createCustomApiKeyAuth", () => {
  /** Helper: extract the auth resolver from the createProvider call */
  function getAuthResolver() {
    return mockCreateProvider.mock.calls[0][0].auth.apiKey;
  }

  it("resolves apiKey from config when provided", async () => {
    mockConfig.llm.apiKey = "sk-from-config";

    await initModels();
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async () => undefined },
      credential: undefined,
    });

    expect(result).toEqual({ auth: { apiKey: "sk-from-config" }, source: "config.yaml" });
  });

  it("resolves apiKey from env when config key is absent", async () => {
    mockConfig.llm.apiBaseUrl = "https://proxy.example.com"; // trigger custom provider

    await initModels();
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async (name: string) => (name === "OPENAI_API_KEY" ? "sk-from-env" : undefined) },
      credential: undefined,
    });

    expect(result).toEqual({ auth: { apiKey: "sk-from-env" }, source: "OPENAI_API_KEY" });
  });

  it("resolves apiKey from credential when config and env are absent", async () => {
    mockConfig.llm.apiBaseUrl = "https://proxy.example.com";

    await initModels();
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async () => undefined },
      credential: { key: "sk-from-cred" },
    });

    expect(result).toEqual({ auth: { apiKey: "sk-from-cred" }, source: "stored credential" });
  });

  it("returns undefined when all sources are missing", async () => {
    mockConfig.llm.apiBaseUrl = "https://proxy.example.com";

    await initModels();
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async () => undefined },
      credential: undefined,
    });

    expect(result).toBeUndefined();
  });

  it("uses ANTHROPIC_API_KEY env var for anthropic provider", async () => {
    mockConfig.llm.provider = "anthropic";
    mockConfig.llm.model = "claude-sonnet-4-20250514";
    mockConfig.llm.apiBaseUrl = "https://proxy.example.com";
    mockCreateProvider.mockReturnValue(CUSTOM_ANTHROPIC_PROVIDER);
    mockGetModel.mockReturnValue({ id: "claude-sonnet-4-20250514" });

    await initModels();
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async (name: string) => (name === "ANTHROPIC_API_KEY" ? "sk-ant-env" : undefined) },
      credential: undefined,
    });

    expect(result).toEqual({ auth: { apiKey: "sk-ant-env" }, source: "ANTHROPIC_API_KEY" });
  });

  it("config apiKey takes priority over env and credential", async () => {
    mockConfig.llm.apiKey = "sk-config-wins";

    await initModels();
    const resolver = getAuthResolver();
    const result = await resolver.resolve({
      ctx: { env: async () => "sk-from-env" },
      credential: { key: "sk-from-cred" },
    });

    expect(result).toEqual({ auth: { apiKey: "sk-config-wins" }, source: "config.yaml" });
  });
});
