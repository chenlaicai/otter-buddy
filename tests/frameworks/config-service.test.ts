import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

const MINIMAL_YAML = "llm:\n  models:\n    - alias: main\n      provider: openai\n      model: gpt-4o\n";

// Provide a default config so loadConfig tests work
mockExistsSync.mockReturnValue(true);
mockReadFileSync.mockReturnValue(MINIMAL_YAML);

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
  it("throws when llm.models is missing", () => {
    expect(() => validate({ llm: {} })).toThrow("llm.models[]");
  });

  it("throws when llm.models is empty", () => {
    expect(() => validate({ llm: { models: [] } })).toThrow("llm.models[]");
  });

  it("throws when llm section is missing entirely", () => {
    expect(() => validate({})).toThrow("llm.models[]");
  });

  it("rejects legacy single-model format (llm.provider + llm.model)", () => {
    // F20260806cnp6 [Incompatible]：旧格式启动即报错并提示迁移
    expect(() =>
      validate({ llm: { provider: "openai", model: "gpt-4o" } as never }),
    ).toThrow("llm.models[] 为必填字段");
  });

  it("throws when server.port is not a number", () => {
    expect(() =>
      validate({
        llm: { models: [{ alias: "main", provider: "openai", model: "gpt-4o" }] },
        server: { port: "abc" as unknown as number },
      }),
    ).toThrow("server.port");
  });

  it("passes with valid single-entry models[]", () => {
    expect(() => validate({ llm: { models: [{ alias: "main", provider: "openai", model: "gpt-4o" }] } })).not.toThrow();
  });

  it("passes with anthropic provider", () => {
    expect(() => validate({ llm: { models: [{ alias: "ant", provider: "anthropic", model: "claude-sonnet-4-20250514" }] } })).not.toThrow();
  });
});

describe("loadConfig", () => {
  it("throws when config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => loadConfig()).toThrow("配置文件不存在");
  });

  it("loads valid config with defaults", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(MINIMAL_YAML);

    const cfg = loadConfig();
    expect(cfg.llm.default).toBe("main");
    expect(cfg.llm.models).toHaveLength(1);
    expect(cfg.llm.models[0].provider).toBe("openai");
    expect(cfg.llm.models[0].model).toBe("gpt-4o");
    expect(cfg.server.port).toBe(3000);
    expect(cfg.db.path).toBe("./otter-buddy.db");
    expect(cfg.memory.rrfK).toBe(60);
    expect(cfg.embedding.dimensions).toBe(1024);
    expect(cfg.embedding.modelPath).toBe("Xenova/bge-m3");
    expect(cfg.embedding.localModelPath).toBeUndefined();
    expect(cfg.circuitBreaker.maxChainDepth).toBe(100);
  });

  it("overrides maxChainDepth from yaml", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(MINIMAL_YAML + "circuitBreaker:\n  maxChainDepth: 3\n");

    const cfg = loadConfig();
    expect(cfg.circuitBreaker.maxChainDepth).toBe(3);
  });

  it("loads config with custom values", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "llm:\n  models:\n    - alias: ant\n      provider: anthropic\n      model: claude-sonnet-4-20250514\n      apiKey: sk-test\n      apiBaseUrl: https://proxy.example.com\nserver:\n  port: 8080\n",
    );

    const cfg = loadConfig();
    expect(cfg.llm.default).toBe("ant");
    expect(cfg.llm.models[0].provider).toBe("anthropic");
    expect(cfg.llm.models[0].model).toBe("claude-sonnet-4-20250514");
    expect(cfg.llm.models[0].apiKey).toBe("sk-test");
    expect(cfg.llm.models[0].apiBaseUrl).toBe("https://proxy.example.com");
    expect(cfg.server.port).toBe(8080);
  });

  it("converts YAML null values for optional model fields to undefined", () => {
    mockExistsSync.mockReturnValue(true);
    // js-yaml parses `apiKey:` (no value) as null
    mockReadFileSync.mockReturnValue(
      "llm:\n  models:\n    - alias: main\n      provider: openai\n      model: gpt-4o\n      apiKey:\n      apiBaseUrl:\n",
    );

    const cfg = loadConfig();
    expect(cfg.llm.models[0].apiKey).toBeUndefined();
    expect(cfg.llm.models[0].apiBaseUrl).toBeUndefined();
  });

  it("preserves all config sections", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      MINIMAL_YAML + "database:\n  path: /tmp/test.db\nmemory:\n  rrfK: 100\nembedding:\n  dimensions: 512\ncircuitBreaker:\n  maxToolCalls: 10\n",
    );

    const cfg = loadConfig();
    expect(cfg.db.path).toBe("/tmp/test.db");
    expect(cfg.memory.rrfK).toBe(100);
    expect(cfg.embedding.dimensions).toBe(512);
    // maxToolCalls 已移除，验证该 YAML 配置项被静默忽略
    expect("maxToolCalls" in cfg.circuitBreaker).toBe(false);
  });

  it("parses embedding.localModelPath when set", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      MINIMAL_YAML + "embedding:\n  dimensions: 1024\n  modelPath: bge-m3\n  localModelPath: ./models\n",
    );

    const cfg = loadConfig();
    expect(cfg.embedding.modelPath).toBe("bge-m3");
    expect(cfg.embedding.localModelPath).toBe("./models");
  });

  it("defaults modelPath to bge-m3 when localModelPath set but modelPath omitted", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      MINIMAL_YAML + "embedding:\n  localModelPath: ./models\n",
    );

    const cfg = loadConfig();
    // 本地模式默认 modelPath 为目录名（models/bge-m3/），而非远程 repo id
    expect(cfg.embedding.modelPath).toBe("bge-m3");
    expect(cfg.embedding.localModelPath).toBe("./models");
  });

  it("web.baseUrl 接受 https://", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(MINIMAL_YAML + 'web:\n  baseUrl: "https://otter.app"\n');
    const cfg = loadConfig();
    expect(cfg.web?.baseUrl).toBe("https://otter.app");
  });

  it("web.baseUrl 拒绝 javascript: 协议(审视 F20260812fmdr R5)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(MINIMAL_YAML + 'web:\n  baseUrl: "javascript:alert(1)"\n');
    expect(() => loadConfig()).toThrow(/web\.baseUrl 必须以 http/);
  });

  it("web.baseUrl 缺省时 cfg.web 为 undefined", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(MINIMAL_YAML);
    const cfg = loadConfig();
    expect(cfg.web).toBeUndefined();
  });
});

describe("validate — models[] 条目校验", () => {
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
