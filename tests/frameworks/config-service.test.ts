import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// Provide a default config so loadConfig tests work
mockExistsSync.mockReturnValue(true);
mockReadFileSync.mockReturnValue("llm:\n  provider: openai\n  model: gpt-4o\n");

let validate: typeof import("../../src/frameworks/config-service").validate;
let loadConfig: typeof import("../../src/frameworks/config-service").loadConfig;

beforeAll(async () => {
  const mod = await import("../../src/frameworks/config-service");
  validate = mod.validate;
  loadConfig = mod.loadConfig;
});

beforeEach(() => {
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
});

describe("validate", () => {
  it("throws when llm.provider is missing", () => {
    expect(() => validate({ llm: { model: "gpt-4o" } })).toThrow("llm.provider");
  });

  it("throws when llm.model is missing", () => {
    expect(() => validate({ llm: { provider: "openai" } })).toThrow("llm.model");
  });

  it("throws when llm.provider is invalid", () => {
    expect(() => validate({ llm: { provider: "unknown", model: "x" } })).toThrow("openai / anthropic");
  });

  it("throws when server.port is not a number", () => {
    expect(() =>
      validate({ llm: { provider: "openai", model: "gpt-4o" }, server: { port: "abc" as unknown as number } }),
    ).toThrow("server.port");
  });

  it("passes with valid minimal config", () => {
    expect(() => validate({ llm: { provider: "openai", model: "gpt-4o" } })).not.toThrow();
  });

  it("passes with anthropic provider", () => {
    expect(() => validate({ llm: { provider: "anthropic", model: "claude-sonnet-4-20250514" } })).not.toThrow();
  });
});

describe("loadConfig", () => {
  it("throws when config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => loadConfig()).toThrow("配置文件不存在");
  });

  it("loads valid config with defaults", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("llm:\n  provider: openai\n  model: gpt-4o\n");

    const cfg = loadConfig();
    expect(cfg.llm.provider).toBe("openai");
    expect(cfg.llm.model).toBe("gpt-4o");
    expect(cfg.server.port).toBe(3000);
    expect(cfg.db.path).toBe("./otter-buddy.db");
    expect(cfg.memory.rrfK).toBe(60);
    expect(cfg.embedding.dimensions).toBe(1024);
    expect(cfg.embedding.modelPath).toBe("Xenova/bge-m3");
    expect(cfg.embedding.localModelPath).toBeUndefined();
    expect(cfg.circuitBreaker.maxToolCalls).toBe(40);
    expect(cfg.circuitBreaker.maxChainDepth).toBe(100);
  });

  it("overrides maxChainDepth from yaml", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "llm:\n  provider: openai\n  model: gpt-4o\ncircuitBreaker:\n  maxChainDepth: 3\n",
    );

    const cfg = loadConfig();
    expect(cfg.circuitBreaker.maxChainDepth).toBe(3);
  });

  it("loads config with custom values", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514\n  apiKey: sk-test\n  apiBaseUrl: https://proxy.example.com\nserver:\n  port: 8080\n",
    );

    const cfg = loadConfig();
    expect(cfg.llm.provider).toBe("anthropic");
    expect(cfg.llm.model).toBe("claude-sonnet-4-20250514");
    expect(cfg.llm.apiKey).toBe("sk-test");
    expect(cfg.llm.apiBaseUrl).toBe("https://proxy.example.com");
    expect(cfg.server.port).toBe(8080);
  });

  it("converts YAML null values for optional llm fields to undefined", () => {
    mockExistsSync.mockReturnValue(true);
    // js-yaml parses `apiKey:` (no value) as null
    mockReadFileSync.mockReturnValue(
      "llm:\n  provider: openai\n  model: gpt-4o\n  apiKey:\n  apiBaseUrl:\n",
    );

    const cfg = loadConfig();
    expect(cfg.llm.apiKey).toBeUndefined();
    expect(cfg.llm.apiBaseUrl).toBeUndefined();
  });

  it("preserves all config sections", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "llm:\n  provider: openai\n  model: gpt-4o\ndatabase:\n  path: /tmp/test.db\nmemory:\n  rrfK: 100\nembedding:\n  dimensions: 512\ncircuitBreaker:\n  maxToolCalls: 10\n",
    );

    const cfg = loadConfig();
    expect(cfg.db.path).toBe("/tmp/test.db");
    expect(cfg.memory.rrfK).toBe(100);
    expect(cfg.embedding.dimensions).toBe(512);
    expect(cfg.circuitBreaker.maxToolCalls).toBe(10);
  });

  it("parses embedding.localModelPath when set", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "llm:\n  provider: openai\n  model: gpt-4o\nembedding:\n  dimensions: 1024\n  modelPath: bge-m3\n  localModelPath: ./models\n",
    );

    const cfg = loadConfig();
    expect(cfg.embedding.modelPath).toBe("bge-m3");
    expect(cfg.embedding.localModelPath).toBe("./models");
  });
});

describe("validate — multi-model", () => {
  it("passes with valid multi-model config", () => {
    const raw = {
      llm: {
        default: "fast",
        models: [
          { alias: "fast", provider: "openai", model: "gpt-4o-mini" },
          { alias: "powerful", provider: "anthropic", model: "claude-sonnet-4-20250514" },
        ],
      },
    };
    expect(() => validate(raw)).not.toThrow();
    expect(raw.llm.default).toBe("fast");
    expect(raw.llm.models).toBeDefined();
  });

  it("sets default to first model when not specified", () => {
    const raw = {
      llm: {
        models: [
          { alias: "fast", provider: "openai", model: "gpt-4o-mini" },
          { alias: "powerful", provider: "anthropic", model: "claude-sonnet-4-20250514" },
        ],
      },
    };
    validate(raw);
    expect(raw.llm.default).toBe("fast");
  });

  it("throws when model alias is missing", () => {
    expect(() => validate({
      llm: {
        models: [
          { provider: "openai", model: "gpt-4o" },
        ],
      },
    })).toThrow("缺少 alias");
  });

  it("throws when model provider is missing", () => {
    expect(() => validate({
      llm: {
        models: [
          { alias: "test", model: "gpt-4o" },
        ],
      },
    })).toThrow("provider 为必填字段");
  });

  it("throws when model provider is invalid", () => {
    expect(() => validate({
      llm: {
        models: [
          { alias: "test", provider: "google", model: "gemini-pro" },
        ],
      },
    })).toThrow("openai / anthropic");
  });

  it("throws when aliases are duplicated", () => {
    expect(() => validate({
      llm: {
        models: [
          { alias: "same", provider: "openai", model: "gpt-4o" },
          { alias: "same", provider: "anthropic", model: "claude-sonnet-4-20250514" },
        ],
      },
    })).toThrow("重复的 alias");
  });

  it("throws when default alias not in models", () => {
    expect(() => validate({
      llm: {
        default: "nonexistent",
        models: [
          { alias: "fast", provider: "openai", model: "gpt-4o" },
        ],
      },
    })).toThrow("不在 models[] 中");
  });
});

