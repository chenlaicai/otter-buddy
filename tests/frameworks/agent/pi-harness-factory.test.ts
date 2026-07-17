import { describe, it, expect, vi, beforeEach } from "vitest";

let lastSessionId = 0;
const mockCreate = vi.fn(() => ({ id: `session-${++lastSessionId}` }));
const mockOpen = vi.fn();
const mockDelete = vi.fn();

class MockSessionRepo {
  create = mockCreate;
  open = mockOpen;
  delete = mockDelete;
}

const mockHarnessPrompt = vi.fn();
const harnessInstances: Array<{ opts: Record<string, unknown> }> = [];
class MockHarness {
  prompt = mockHarnessPrompt;
  subscribe = vi.fn(() => vi.fn());
  constructor(opts: Record<string, unknown>) {
    harnessInstances.push({ opts });
  }
}
class MockNodeEnv {}

vi.mock("@earendil-works/pi-agent-core", () => ({
  JsonlSessionRepo: MockSessionRepo,
  AgentHarness: MockHarness,
  NodeExecutionEnv: MockNodeEnv,
}));

import { PiHarnessFactory } from "@frameworks/agent/pi-harness-factory";

function createMockDb() {
  const store = new Map<string, string>();
  return {
    prepare: vi.fn((sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes("INSERT")) {
          store.set(args[0] as string, args[1] as string);
        } else if (sql.includes("UPDATE")) {
          const key = args[1] as string;
          if (store.has(key)) store.set(key, args[0] as string);
        } else if (sql.includes("DELETE")) {
          store.delete(args[0] as string);
        }
      },
      get: (...args: unknown[]) => {
        const val = store.get(args[0] as string);
        return val ? { pi_session_id: val } : undefined;
      },
    })),
  };
}

function createFactory(overrides?: { settingsRepo?: unknown }) {
  const mockClient = {} as never;
  const mockDb = createMockDb() as never;
  return new PiHarnessFactory(
    {
      models: {} as never,
      model: {} as never,
      db: mockDb,
      sessionDir: "/tmp/test-sessions",
      otterToolClient: mockClient,
      settingsRepo: overrides?.settingsRepo as never,
    },
    mockClient,
  );
}

describe("PiHarnessFactory - reset() B-4 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSessionId = 0;
    harnessInstances.length = 0;
  });

  it("reset 更新 Otter prompt 配置后 invoke 使用新 prompt", async () => {
    const factory = createFactory();
    await factory.create("otter-1", { systemPrompt: "原始 prompt" });
    await factory.reset("otter-1", { systemPrompt: "新的 prompt" });

    await factory.invoke("otter-1", "hello");

    expect(mockHarnessPrompt).toHaveBeenCalled();
    const lastHarness = harnessInstances[harnessInstances.length - 1];
    const systemPromptFn = lastHarness.opts.systemPrompt as (ctx: unknown) => string;
    expect(systemPromptFn({})).toContain("新的 prompt");
    expect(systemPromptFn({})).not.toContain("原始 prompt");
  });

  it("reset 从有 prompt 更新为空 prompt 清除配置", async () => {
    const factory = createFactory();
    await factory.create("otter-1", { systemPrompt: "有 prompt" });
    await factory.reset("otter-1", { systemPrompt: "" });

    await factory.invoke("otter-1", "hello");

    const lastHarness = harnessInstances[harnessInstances.length - 1];
    const systemPromptFn = lastHarness.opts.systemPrompt as (ctx: unknown) => string;
    expect(systemPromptFn({})).not.toContain("有 prompt");
  });

  it("reset 不传 systemPrompt 时保留原有配置", async () => {
    const factory = createFactory();
    await factory.create("otter-1", { systemPrompt: "保留的 prompt" });
    await factory.reset("otter-1");

    await factory.invoke("otter-1", "hello");

    const lastHarness = harnessInstances[harnessInstances.length - 1];
    const systemPromptFn = lastHarness.opts.systemPrompt as (ctx: unknown) => string;
    expect(systemPromptFn({})).toContain("保留的 prompt");
  });

  it("reset 传入 OtterPromptConfig 对象更新配置", async () => {
    const factory = createFactory();
    await factory.create("otter-1", { systemPrompt: "原始" });
    await factory.reset("otter-1", {
      systemPrompt: { systemPrompt: "对象形式", reminders: [{ content: "提醒内容" }] },
    });

    await factory.invoke("otter-1", "hello");

    const lastHarness = harnessInstances[harnessInstances.length - 1];
    const systemPromptFn = lastHarness.opts.systemPrompt as (ctx: unknown) => string;
    const result = systemPromptFn({});
    expect(result).toContain("对象形式");
    expect(result).toContain("提醒内容");
    expect(result).not.toContain("原始");
  });
});
