import { describe, it, expect, vi } from "vitest";
import type { AgentInternals } from "@infra/agent-core/agent";
import { createAgentHandle } from "@infra/agent-core/agent";
import type { AgentToolDef } from "@infra/agent-core/tool";

/** 创建 mock AgentInternals */
function createMockInternals(): AgentInternals & {
  prompts: string[];
  tools: unknown[];
  resetCount: number;
  systemPrompt: string;
} {
  const systemPrompt = "";
  return {
    prompts: [] as string[],
    tools: [] as unknown[],
    resetCount: 0,
    systemPrompt,
    prompt(message: string) {
      this.prompts.push(message);
      return Promise.resolve();
    },
    subscribe(callback: (event: any) => void) {
      // 模拟立即结束的 agent 事件流
      callback({ type: "agent_end" });
      return () => {};
    },
    reset() {
      this.resetCount++;
    },
    setSystemPrompt(prompt: string) {
      this.systemPrompt = prompt;
    },
    setTools(tools: unknown[]) {
      this.tools = tools;
    },
    toAgentTool(tool: AgentToolDef) {
      return { name: tool.name, execute: tool.handler };
    },
  };
}

describe("agent-core", () => {
  describe("AgentHandle", () => {
    it("registerTool 注册工具后 setTools 被调用", () => {
      const internals = createMockInternals();
      const handle = createAgentHandle(internals, { systemPrompt: "test" });

      const tool: AgentToolDef = {
        id: "t1",
        name: "search",
        description: "Search tool",
        schema: { type: "object" },
        handler: async () => "result",
      };

      handle.registerTool(tool);
      expect(internals.tools.length).toBe(1);
    });

    it("unregisterTool 注销工具后 tools 列表更新", () => {
      const internals = createMockInternals();
      const handle = createAgentHandle(internals, { systemPrompt: "test" });

      handle.registerTool({
        id: "t1",
        name: "search",
        description: "Search",
        schema: {},
        handler: async () => "ok",
      });
      handle.registerTool({
        id: "t2",
        name: "write",
        description: "Write",
        schema: {},
        handler: async () => "ok",
      });
      expect(internals.tools.length).toBe(2);

      handle.unregisterTool("t1");
      expect(internals.tools.length).toBe(1);
    });

    it("run 返回 Agent 响应文本", async () => {
      const internals = createMockInternals();
      internals.subscribe = (callback) => {
        // 模拟文本增量事件
        callback({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Hello" },
        });
        callback({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: " world" },
        });
        return () => {};
      };

      const handle = createAgentHandle(internals, {});
      const result = await handle.run("Hi");
      expect(result).toBe("Hello world");
    });

    it("reset 清空上下文", () => {
      const internals = createMockInternals();
      const handle = createAgentHandle(internals, { systemPrompt: "original" });

      handle.reset();
      expect(internals.resetCount).toBe(1);
    });

    it("reset with context 更新 systemPrompt", () => {
      const internals = createMockInternals();
      const handle = createAgentHandle(internals, { systemPrompt: "original" });

      handle.reset("new context");
      expect(internals.resetCount).toBe(1);
      expect(internals.systemPrompt).toBe("original\n\nnew context");
    });

    it("reset without systemPrompt uses context directly", () => {
      const internals = createMockInternals();
      const handle = createAgentHandle(internals, {});

      handle.reset("just context");
      expect(internals.systemPrompt).toBe("just context");
    });
  });

  describe("AgentRegistry (via initAgentCore)", () => {
    it("create + get 全流程", async () => {
      const { initFauxLLMGateway } = await import("@infra/llm-gateway");
      const { initAgentCore } = await import("@infra/agent-core/registry");
      const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");

      const { gateway } = await initFauxLLMGateway([
        fauxAssistantMessage([fauxText("Agent response")]),
      ]);

      const { agentRegistry } = await initAgentCore({ llmGateway: gateway });

      const handle = agentRegistry.create("otter-1", { systemPrompt: "You are a test agent" });
      expect(handle).toBeDefined();

      const retrieved = agentRegistry.get("otter-1");
      expect(retrieved).not.toBeNull();
    });

    it("destroy 后 get 返回 null", async () => {
      const { initFauxLLMGateway } = await import("@infra/llm-gateway");
      const { initAgentCore } = await import("@infra/agent-core/registry");
      const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");

      const { gateway } = await initFauxLLMGateway([
        fauxAssistantMessage([fauxText("OK")]),
      ]);

      const { agentRegistry } = await initAgentCore({ llmGateway: gateway });
      agentRegistry.create("otter-1", {});

      agentRegistry.destroy("otter-1");
      expect(agentRegistry.get("otter-1")).toBeNull();
    });

    it("create 重复 ID 抛出异常", async () => {
      const { initFauxLLMGateway } = await import("@infra/llm-gateway");
      const { initAgentCore } = await import("@infra/agent-core/registry");
      const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");

      const { gateway } = await initFauxLLMGateway([
        fauxAssistantMessage([fauxText("OK")]),
      ]);

      const { agentRegistry } = await initAgentCore({ llmGateway: gateway });
      agentRegistry.create("otter-1", {});

      expect(() => agentRegistry.create("otter-1", {})).toThrow(/already exists/);
    });

    it("get 不存在返回 null", async () => {
      const { initFauxLLMGateway } = await import("@infra/llm-gateway");
      const { initAgentCore } = await import("@infra/agent-core/registry");
      const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");

      const { gateway } = await initFauxLLMGateway([
        fauxAssistantMessage([fauxText("OK")]),
      ]);

      const { agentRegistry } = await initAgentCore({ llmGateway: gateway });
      expect(agentRegistry.get("nonexistent")).toBeNull();
    });

    it("AgentHandle.run 返回 LLM 响应", async () => {
      const { initFauxLLMGateway } = await import("@infra/llm-gateway");
      const { initAgentCore } = await import("@infra/agent-core/registry");
      const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");

      const { gateway } = await initFauxLLMGateway([
        fauxAssistantMessage([fauxText("Hello from agent")]),
      ]);

      const { agentRegistry } = await initAgentCore({ llmGateway: gateway });
      const handle = agentRegistry.create("otter-1", { systemPrompt: "test" });
      const result = await handle.run("Hi");
      expect(typeof result).toBe("string");
    });
  });
});

// avoid unused import warning
void vi;
