/**
 * LLM 网关：封装 pi-ai，提供统一的多提供商 LLM 调用接口。
 *
 * pi-ai 是 ESM-only 包，本项目使用 CommonJS，因此通过动态 import() 加载。
 * 工厂函数 initLLMGateway 为异步，这是 ESM 兼容的必要偏差（D-Dev-1）。
 */

import { config } from "@infra/config";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LLMChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMStreamChunk {
  delta: string;
  done: boolean;
}

export interface LLMGatewayConfig {
  provider?: string;
  model?: string;
}

export interface LLMGateway {
  /** 同步聊天（等待完整响应） */
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse>;
  /** 流式聊天（返回异步迭代器） */
  streamChat(messages: LLMMessage[], options?: LLMChatOptions): AsyncIterable<LLMStreamChunk>;
  /** 获取底层 Model 对象（供 agent-core 内部使用） */
  getModel(): unknown;
}

/** pi-ai 动态加载后的模块句柄（单例，避免重复 import） */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PiAiModule = typeof import("@earendil-works/pi-ai");

let piAiCache: PiAiModule | null = null;

async function loadPiAi(): Promise<PiAiModule> {
  if (!piAiCache) {
    piAiCache = await import("@earendil-works/pi-ai");
  }
  return piAiCache;
}

/** 将 LLMMessage[] 转换为 pi-ai Context 格式 */
function toContext(messages: LLMMessage[]): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const systemPrompt =
    systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join("\n")
      : undefined;

  const piMessages = nonSystemMessages.map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: Date.now(),
  }));

  return { systemPrompt, messages: piMessages };
}

/** 从 pi-ai AssistantMessage 中提取文本内容 */
function extractText(content: unknown[]): string {
  return content
    .filter(
      (block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type: string }).type === "text",
    )
    .map((block: unknown) => (block as { text: string }).text)
    .join("");
}

/** 构建 stream options */
function buildStreamOpts(options?: LLMChatOptions): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (options?.temperature !== undefined) opts.temperature = options.temperature;
  if (options?.maxTokens !== undefined) opts.maxTokens = options.maxTokens;
  return opts;
}

/**
 * 初始化 LLM 网关。
 *
 * 异步工厂：pi-ai 是 ESM-only，需通过动态 import() 加载。
 * 根据配置选择提供商，支持 openai / anthropic。
 */
export async function initLLMGateway(
  gatewayConfig?: LLMGatewayConfig,
): Promise<LLMGateway> {
  const provider = gatewayConfig?.provider ?? config.llm.provider;
  const modelId = gatewayConfig?.model ?? config.llm.model;

  const piAi = await loadPiAi();
  const models = piAi.createModels();

  const providerModule = await loadProvider(provider);
  models.setProvider(providerModule as never);

  const model = models.getModel(provider, modelId);
  if (!model) {
    throw new Error(`LLM model not found: provider=${provider}, model=${modelId}`);
  }

  return {
    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
      const context = toContext(messages);
      const streamOpts = buildStreamOpts(options);
      const response = await models.complete(model, context as never, streamOpts as never);
      const text = extractText(response.content as unknown[]);

      return {
        content: text,
        usage: response.usage
          ? { promptTokens: response.usage.input, completionTokens: response.usage.output }
          : undefined,
      };
    },

    async *streamChat(messages: LLMMessage[], options?: LLMChatOptions): AsyncIterable<LLMStreamChunk> {
      const context = toContext(messages);
      const streamOpts = buildStreamOpts(options);
      const stream = models.stream(model, context as never, streamOpts as never);

      for await (const event of stream) {
        if (event.type === "text_delta") {
          yield { delta: event.delta, done: false };
        } else if (event.type === "done") {
          yield { delta: "", done: true };
        } else if (event.type === "error") {
          const errorMsg = (event as { error?: { errorMessage?: string } }).error;
          throw new Error(errorMsg?.errorMessage ?? "LLM stream error");
        }
      }
    },

    getModel(): unknown {
      return model;
    },
  };
}

/** 根据提供商名称动态加载 pi-ai provider 模块 */
async function loadProvider(provider: string): Promise<unknown> {
  switch (provider) {
    case "openai": {
      const mod = await import("@earendil-works/pi-ai/providers/openai");
      return mod.openaiProvider();
    }
    case "anthropic": {
      const mod = await import("@earendil-works/pi-ai/providers/anthropic");
      return mod.anthropicProvider();
    }
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

// ── 测试辅助：Faux Provider 工厂 ──

/**
 * 创建使用 Faux Provider 的 LLM 网关（仅用于测试）。
 * 提供可控的 LLM 响应，不依赖真实 API。
 */
export async function initFauxLLMGateway(
  responses: unknown[],
): Promise<{ gateway: LLMGateway; faux: unknown }> {
  const piAi = await loadPiAi();
  const faux = piAi.fauxProvider({});
  const models = piAi.createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  if (responses.length > 0) {
    faux.setResponses(responses as never);
  }

  return {
    faux,
    gateway: {
      async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        const context = toContext(messages);
        const streamOpts = buildStreamOpts(options);
        const response = await models.complete(model, context as never, streamOpts as never);
        return {
          content: extractText(response.content as unknown[]),
          usage: response.usage
            ? { promptTokens: response.usage.input, completionTokens: response.usage.output }
            : undefined,
        };
      },

      async *streamChat(messages: LLMMessage[], options?: LLMChatOptions): AsyncIterable<LLMStreamChunk> {
        const context = toContext(messages);
        const streamOpts = buildStreamOpts(options);
        const stream = models.stream(model, context as never, streamOpts as never);
        for await (const event of stream) {
          if (event.type === "text_delta") {
            yield { delta: event.delta, done: false };
          } else if (event.type === "done") {
            yield { delta: "", done: true };
          }
        }
      },

      getModel(): unknown {
        return model;
      },
    },
  };
}
