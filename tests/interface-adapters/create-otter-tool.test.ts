/**
 * create_otter 工具测试：modelAlias 校验 + type 参数移除（大獭只能创建小獭）
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { ToolModelPool } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";

function makeModelPool(aliases: string[]): ToolModelPool {
  return {
    hasModel: (alias: string) => aliases.includes(alias),
    describeModels: () => aliases.map(alias => ({ alias, description: `Model ${alias}` })),
  };
}

function makeCreateOtterTool(options: {
  modelPool?: ToolModelPool;
  existingParticipants?: Array<{ otterId: string; otterName: string }>;
  createError?: Error;
  otterConfigProvider?: OtterConfigProvider;
} = {}) {
  const createCalls: Array<{ name: string; type: string; modelAlias?: string }> = [];
  const joinCalls: Array<{ conversationId: string; otterId: string }> = [];

  const client = {
    conversation: {
      participant: {
        getActive: async () => options.existingParticipants ?? [],
        join: async (conversationId: string, otterId: string) => {
          joinCalls.push({ conversationId, otterId });
        },
      },
    },
    otter: {
      create: async (params: { name: string; type: string; systemPrompt: string; parentOtterId: string; modelAlias?: string }) => {
        if (options.createError) throw options.createError;
        createCalls.push({ name: params.name, type: params.type, modelAlias: params.modelAlias });
        // 模拟真实行为：Otter 实体不包含 modelAlias
        return { id: "new-otter-id", name: params.name };
      },
    },
    // F20260821i336：派工台账 mock
    dispatch: {
      createRecord: async () => ({ id: "dispatch-1" }),
      updateRecord: async () => {},
      queryRecords: async () => [],
    },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = {
    client,
    otterId: "parent-otter",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
    modelPool: options.modelPool,
    otterConfigProvider: options.otterConfigProvider,
  };

  const tools = createTools(ctx);
  const createOtter = tools.find(t => t.name === "create_otter")!;
  return { createOtter, createCalls, joinCalls };
}

describe("create_otter 工具", () => {
  describe("type 参数移除：大獭只能创建小獭", () => {
    it("无论传入什么 type 值，创建的 Otter 类型始终为 small", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool();

      // 即使 LLM 幻觉传入 type: "big"，工具层也会忽略，硬编码为 small
      const result = await createOtter.execute("c1", {
        name: "测试獭",
        type: "big" as any,
        systemPrompt: "你是测试獭",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].type).toBe("small");
    });

    it("不传 type 参数时，创建的 Otter 类型仍为 small", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool();

      const result = await createOtter.execute("c1", {
        name: "测试獭",
        systemPrompt: "你是测试獭",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].type).toBe("small");
    });
  });

  describe("modelAlias 校验", () => {
    it("不传 modelAlias 时正常创建，modelAlias 为 undefined", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool({
        modelPool: makeModelPool(["default", "fast"]),
      });

      const result = await createOtter.execute("c1", {
        name: "小獭",
        systemPrompt: "你是小獭",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].modelAlias).toBeUndefined();
    });

    it("传入有效 modelAlias 时正常创建", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool({
        modelPool: makeModelPool(["default", "fast"]),
      });

      const result = await createOtter.execute("c1", {
        name: "快速小獭",
        systemPrompt: "你是小獭",
        modelAlias: "fast",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].modelAlias).toBe("fast");
    });

    it("传入无效 modelAlias 时返回错误", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool({
        modelPool: makeModelPool(["default", "fast"]),
      });

      const result = await createOtter.execute("c1", {
        name: "小獭",
        systemPrompt: "你是小獭",
        modelAlias: "nonexistent",
      });

      expect(result.content[0].text).toContain("[错误]");
      expect(result.content[0].text).toContain("nonexistent");
      expect(result.content[0].text).toContain("default");
      expect(result.content[0].text).toContain("fast");
      expect(createCalls).toHaveLength(0);
    });

    it("传入空字符串 modelAlias 时正常创建（走默认）", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool({
        modelPool: makeModelPool(["default", "fast"]),
      });

      const result = await createOtter.execute("c1", {
        name: "小獭",
        systemPrompt: "你是小獭",
        modelAlias: "",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].modelAlias).toBeUndefined();
    });

    it("传入空白字符串 modelAlias 时正常创建（走默认）", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool({
        modelPool: makeModelPool(["default", "fast"]),
      });

      const result = await createOtter.execute("c1", {
        name: "小獭",
        systemPrompt: "你是小獭",
        modelAlias: "   ",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].modelAlias).toBeUndefined();
    });

    it("无 modelPool 时跳过校验，正常创建", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool({
        // modelPool 未配置
      });

      const result = await createOtter.execute("c1", {
        name: "小獭",
        systemPrompt: "你是小獭",
        modelAlias: "anything",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].modelAlias).toBe("anything");
    });

    it("同名参与者已存在时返回错误", async () => {
      const { createOtter, createCalls } = makeCreateOtterTool({
        modelPool: makeModelPool(["default"]),
        existingParticipants: [{ otterId: "existing-id", otterName: "小獭" }],
      });

      const result = await createOtter.execute("c1", {
        name: "小獭",
        systemPrompt: "你是小獭",
      });

      expect(result.content[0].text).toContain("[错误]");
      expect(result.content[0].text).toContain("同名参与者");
      expect(createCalls).toHaveLength(0);
    });
  });

  describe("modelLabel 回包测试（F20260824aibd）", () => {
    it("传入 modelAlias 时回包包含模型标签", async () => {
      const otterConfigProvider: OtterConfigProvider = {
        getConfig: (otterId: string) => {
          if (otterId === "new-otter-id") return { otterType: "small", modelAlias: "fast" };
          return null;
        },
        getConfigs: () => new Map(),
        setConfig: () => {},
        deleteConfig: () => {},
        hasConfig: () => true,
      };

      const { createOtter } = makeCreateOtterTool({
        modelPool: makeModelPool(["default", "fast"]),
        otterConfigProvider,
      });

      const result = await createOtter.execute("c1", {
        name: "快速小獭",
        systemPrompt: "你是小獭",
        modelAlias: "fast",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(result.content[0].text).toContain("模型：fast");
    });

    it("不传 modelAlias 时回包不包含模型标签", async () => {
      const otterConfigProvider: OtterConfigProvider = {
        getConfig: (otterId: string) => {
          if (otterId === "new-otter-id") return { otterType: "small" };
          return null;
        },
        getConfigs: () => new Map(),
        setConfig: () => {},
        deleteConfig: () => {},
        hasConfig: () => true,
      };

      const { createOtter } = makeCreateOtterTool({
        modelPool: makeModelPool(["default", "fast"]),
        otterConfigProvider,
      });

      const result = await createOtter.execute("c1", {
        name: "小獭",
        systemPrompt: "你是小獭",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(result.content[0].text).not.toContain("模型：");
    });

    it("传入空白 modelAlias 时回包不包含模型标签（trim 后为空）", async () => {
      const otterConfigProvider: OtterConfigProvider = {
        getConfig: (otterId: string) => {
          if (otterId === "new-otter-id") return { otterType: "small" };
          return null;
        },
        getConfigs: () => new Map(),
        setConfig: () => {},
        deleteConfig: () => {},
        hasConfig: () => true,
      };

      const { createOtter } = makeCreateOtterTool({
        modelPool: makeModelPool(["default", "fast"]),
        otterConfigProvider,
      });

      const result = await createOtter.execute("c1", {
        name: "小獭",
        systemPrompt: "你是小獭",
        modelAlias: "   ",
      });

      expect(result.content[0].text).toContain("Otter created");
      expect(result.content[0].text).not.toContain("模型：");
    });
  });
});
