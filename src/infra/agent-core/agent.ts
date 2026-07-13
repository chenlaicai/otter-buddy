/**
 * Agent 包装类：封装 pi-agent-core 的 Agent，提供 AgentHandle 接口。
 *
 * pi-agent-core 是 ESM-only 包，Agent 实例在 initAgentCore 中通过动态 import 创建。
 * AgentHandle 屏蔽 pi-agent-core 的内部 API，只暴露 run/stream/reset/tool 管理方法。
 */

import type { AgentToolDef } from "./tool";

export interface AgentConfig {
  systemPrompt?: string;
  context?: string;
}

export interface AgentHandle {
  /** 注册 AgentTool */
  registerTool(tool: AgentToolDef): void;
  /** 注销 AgentTool */
  unregisterTool(toolId: string): void;
  /** 执行消息（同步，等待完整响应） */
  run(message: string): Promise<string>;
  /** 执行消息（流式） */
  stream(message: string): AsyncIterable<string>;
  /** 重置上下文（重启獭生） */
  reset(context?: string): void;
}

/** pi-agent-core Agent 的事件类型（简化） */
interface AgentEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
}

/** pi-agent-core Agent 的内部操作接口 */
export interface AgentInternals {
  prompt(message: string): Promise<void>;
  subscribe(callback: (event: AgentEvent) => void): () => void;
  reset(): void;
  setSystemPrompt(prompt: string): void;
  setTools(tools: unknown[]): void;
  toAgentTool(tool: AgentToolDef): unknown;
}

/** 同步工具列表到 Agent */
function syncTools(agent: AgentInternals, tools: Map<string, AgentToolDef>): void {
  agent.setTools(Array.from(tools.values()).map((t) => agent.toAgentTool(t)));
}

/** 运行 Agent 并收集完整响应文本 */
async function runAgent(agent: AgentInternals, message: string): Promise<string> {
  let resultText = "";
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      resultText += event.assistantMessageEvent.delta ?? "";
    }
  });
  try {
    await agent.prompt(message);
    return resultText;
  } finally {
    unsubscribe();
  }
}

/** 流式运行 Agent，yield 文本增量 */
async function*streamAgent(agent: AgentInternals, message: string): AsyncIterable<string> {
  const queue: string[] = [];
  let done = false;
  let promptError: Error | null = null;
  let resolveWait: (() => void) | null = null;

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      queue.push(event.assistantMessageEvent.delta ?? "");
      resolveWait?.();
    } else if (event.type === "agent_end") {
      done = true;
      resolveWait?.();
    }
  });

  try {
    agent.prompt(message).catch((err: unknown) => {
      promptError = err instanceof Error ? err : new Error(String(err));
      resolveWait?.();
    });
    while (!done && !promptError) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => { resolveWait = resolve; });
        resolveWait = null;
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }
    if (promptError) throw promptError;
  } finally {
    unsubscribe();
  }
}

/** 创建 AgentHandle，包装 pi-agent-core 的 Agent 实例 */
export function createAgentHandle(agent: AgentInternals, initialConfig: AgentConfig): AgentHandle {
  const tools = new Map<string, AgentToolDef>();

  return {
    registerTool(tool: AgentToolDef): void {
      tools.set(tool.id, tool);
      syncTools(agent, tools);
    },
    unregisterTool(toolId: string): void {
      tools.delete(toolId);
      syncTools(agent, tools);
    },
    run(message: string): Promise<string> {
      return runAgent(agent, message);
    },
    stream(message: string): AsyncIterable<string> {
      return streamAgent(agent, message);
    },
    reset(context?: string): void {
      agent.reset();
      const basePrompt = initialConfig.systemPrompt ?? "";
      if (context !== undefined) {
        agent.setSystemPrompt(basePrompt ? `${basePrompt}\n\n${context}` : context);
      } else {
        agent.setSystemPrompt(basePrompt);
      }
      syncTools(agent, tools);
    },
  };
}
