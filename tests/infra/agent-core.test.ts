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

    it("reset 恢复 systemPrompt（无 context 时恢复初始值）", () => {
      const internals = createMockInternals();
      const handle = createAgentHandle(internals, { systemPrompt: "original prompt" });

      handle.reset();
      expect(internals.systemPrompt).toBe("original prompt");
    });

    it("reset 后重新同步 tools", () => {
      const internals = createMockInternals();
      const handle = createAgentHandle(internals, { systemPrompt: "test" });

      handle.registerTool({
        id: "t1",
        name: "search",
        description: "Search",
        schema: {},
        handler: async () => "ok",
      });
      expect(internals.tools.length).toBe(1);

      // reset 后 tools 应该被重新同步
      internals.tools = [];
      handle.reset();
      expect(internals.tools.length).toBe(1);
    });

    it("stream 返回文本增量", async () => {
      const internals = createMockInternals();
      internals.subscribe = (callback) => {
        // 模拟异步文本增量事件
        setTimeout(() => {
          callback({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "chunk1" },
          });
          callback({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "chunk2" },
          });
          callback({ type: "agent_end" });
        }, 0);
        return () => {};
      };

      const handle = createAgentHandle(internals, {});
      const chunks: string[] = [];
      for await (const chunk of handle.stream("Hi")) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual(["chunk1", "chunk2"]);
    });

    it("stream prompt() 失败时抛出错误", async () => {
      const internals = createMockInternals();
      internals.prompt = () => Promise.reject(new Error("LLM connection failed"));
      internals.subscribe = () => () => {};

      const handle = createAgentHandle(internals, {});
      await expect(async () => {
        for await (const chunk of handle.stream("Hi")) {
          void chunk;
        }
      }).rejects.toThrow(/LLM connection failed/);
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

    it("reset 后 Agent 实例仍然可用", async () => {
      const { initFauxLLMGateway } = await import("@infra/llm-gateway");
      const { initAgentCore } = await import("@infra/agent-core/registry");
      const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");

      const { gateway } = await initFauxLLMGateway([
        fauxAssistantMessage([fauxText("First response")]),
        fauxAssistantMessage([fauxText("Second response")]),
      ]);

      const { agentRegistry } = await initAgentCore({ llmGateway: gateway });
      const handle = agentRegistry.create("otter-1", { systemPrompt: "test" });
      await handle.run("First");

      agentRegistry.reset("otter-1", "new context");

      const result = await handle.run("Second");
      expect(typeof result).toBe("string");
    });

    it("reset 不存在的 otter 不报错", async () => {
      const { initFauxLLMGateway } = await import("@infra/llm-gateway");
      const { initAgentCore } = await import("@infra/agent-core/registry");
      const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");

      const { gateway } = await initFauxLLMGateway([
        fauxAssistantMessage([fauxText("OK")]),
      ]);

      const { agentRegistry } = await initAgentCore({ llmGateway: gateway });
      expect(() => agentRegistry.reset("nonexistent")).not.toThrow();
    });
  });
});

// avoid unused import warning
void vi;
