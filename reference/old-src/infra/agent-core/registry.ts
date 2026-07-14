/**
 * AgentRegistry：otterId -> AgentHandle 映射，多模块共享 Agent 实例。
 *
 * 消费方：
 * - domain/otter：create, destroy, reset（Agent 生命周期管理）
 * - app/agent-runtime：get, registerTool, run, stream（Agent 执行）
 *
 * initAgentCore 为异步工厂（D-Dev-1：pi-agent-core 是 ESM-only）。
 */

import type { LLMGateway } from "@infra/llm-gateway";
import type { AgentToolDef } from "./tool";
import type { AgentConfig, AgentHandle, AgentInternals } from "./agent";
import { createAgentHandle } from "./agent";

export interface AgentRegistry {
  create(otterId: string, agentConfig: AgentConfig): AgentHandle;
  destroy(otterId: string): void;
  reset(otterId: string, context?: string): void;
  get(otterId: string): AgentHandle | null;
}

/** pi-agent-core Agent 实例的最小类型断言 */
interface PiAgentInstance {
  prompt(message: string): Promise<void>;
  subscribe(callback: (event: unknown) => void | Promise<void>): () => void;
  reset(): void;
  state: { systemPrompt: string; tools: unknown[]; messages: unknown[] };
}

/** 将 AgentToolDef 转换为 pi-agent-core AgentTool 格式 */
function toAgentTool(tool: AgentToolDef): unknown {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.schema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await tool.handler(params);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}

/** 创建 pi-agent-core Agent 的 AgentInternals 适配器 */
function createInternals(agentInstance: unknown): AgentInternals {
  const a = agentInstance as PiAgentInstance;
  return {
    prompt: (message: string) => a.prompt(message),
    subscribe: (callback) => a.subscribe((event: unknown) => callback(event as never)),
    reset: () => a.reset(),
    setSystemPrompt: (prompt: string) => { a.state.systemPrompt = prompt; },
    setTools: (tools: unknown[]) => { a.state.tools = tools; },
    toAgentTool,
  };
}

/** 创建 AgentHandle 的工厂函数 */
function makeCreateHandle(
  AgentClass: { new (opts: unknown): unknown },
  model: unknown,
): (config: AgentConfig) => AgentHandle {
  return (config: AgentConfig) => {
    const agent = new AgentClass({
      initialState: {
        systemPrompt: config.systemPrompt ?? "",
        model: model as never,
        messages: config.context
          ? [{ role: "user", content: config.context, timestamp: Date.now() }]
          : [],
        tools: [],
      },
    });
    return createAgentHandle(createInternals(agent), config);
  };
}

/** 创建 AgentRegistry 实例 */
function buildRegistry(createHandle: (config: AgentConfig) => AgentHandle): AgentRegistry {
  const registry = new Map<string, AgentHandle>();
  return {
    create(otterId, agentConfig) {
      if (registry.has(otterId)) throw new Error(`Agent already exists for otter: ${otterId}`);
      const handle = createHandle(agentConfig);
      registry.set(otterId, handle);
      return handle;
    },
    destroy(otterId) {
      registry.delete(otterId);
    },
    reset(otterId, context) {
      registry.get(otterId)?.reset(context);
    },
    get(otterId) {
      return registry.get(otterId) ?? null;
    },
  };
}

/**
 * 初始化 Agent 核心：加载 pi-agent-core，创建 AgentRegistry。
 *
 * @param llmGateway - LLM 网关（提供 Model 对象）
 */
export async function initAgentCore({
  llmGateway,
}: {
  llmGateway: LLMGateway;
}): Promise<{ agentRegistry: AgentRegistry }> {
  const piAgentCore = await import("@earendil-works/pi-agent-core");
  const model = llmGateway.getModel();
  const createHandle = makeCreateHandle(piAgentCore.Agent as { new (opts: unknown): unknown }, model);
  return { agentRegistry: buildRegistry(createHandle) };
}

export type { AgentConfig, AgentHandle } from "./agent";
export type { AgentToolDef } from "./tool";
