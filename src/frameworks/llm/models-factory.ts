/**
 * pi-ai Models 对象工厂（Provider 路由 + Model 获取）。
 * 本模块只提供 Models 工厂，LLM 交互由 AgentHarness 内部处理。
 *
 * 支持自定义 provider：当 config.yaml 中配置了 llm.apiBaseUrl 或 llm.apiKey 时，
 * 使用 createProvider() 构造自定义 provider，替代默认的 openaiProvider() / anthropicProvider()。
 */

import { config } from "@frameworks/config";
import type { AppConfig } from "@frameworks/config";

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

/**
 * 判断是否需要自定义 provider。
 * apiBaseUrl 或 apiKey 任一配置即触发自定义 provider 构造。
 */
function needsCustomProvider(llmConfig: AppConfig["llm"]): boolean {
  return !!(llmConfig.apiBaseUrl || llmConfig.apiKey);
}

/**
 * 构造自定义 API Key Auth。
 * 解析优先级：configApiKey → credential.key → 标准环境变量。
 */
function createCustomApiKeyAuth(configApiKey?: string, provider?: string) {
  const envVarName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  return {
    name: `${provider} API key`,
    resolve: async ({ ctx, credential }: { ctx: { env: (name: string) => Promise<string | undefined> }; credential?: { key?: string } }) => {
      if (configApiKey) {
        return { auth: { apiKey: configApiKey }, source: "config.yaml" };
      }
      if (credential?.key) {
        return { auth: { apiKey: credential.key }, source: "stored credential" };
      }
      const envKey = await ctx.env(envVarName);
      if (envKey) {
        return { auth: { apiKey: envKey }, source: envVarName };
      }
      return undefined;
    },
  };
}

/**
 * 构造自定义 provider（使用 createProvider）。
 * 动态导入 provider 对应的模型列表和 API handler。
 */
async function loadCustomProvider(
  piAi: PiAiModule,
  provider: string,
  modelId: string,
  apiBaseUrl?: string,
  apiKey?: string,
): Promise<unknown> {
  let modelsDict: Record<string, unknown>;
  let api: unknown;

  if (provider === "openai") {
    const modelsMod = await import("@earendil-works/pi-ai/providers/openai.models");
    modelsDict = modelsMod.OPENAI_MODELS;
    const apiMod = await import("@earendil-works/pi-ai/api/openai-responses.lazy");
    api = apiMod.openAIResponsesApi();
  } else if (provider === "anthropic") {
    const modelsMod = await import("@earendil-works/pi-ai/providers/anthropic.models");
    modelsDict = modelsMod.ANTHROPIC_MODELS;
    const apiMod = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");
    api = apiMod.anthropicMessagesApi();
  } else {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  // 转为数组并注入自定义模型（只继承连接属性，不继承 contextWindow/maxTokens/cost 等模型属性）
  const modelsArray = Object.values(modelsDict) as Record<string, unknown>[];
  const hasModel = modelsArray.some(m => (m as Record<string, unknown>).id === modelId);
  if (!hasModel) {
    const template = modelsArray[0] as Record<string, unknown> | undefined;
    if (template) {
      modelsArray.push({
        id: modelId,
        name: modelId,
        api: template.api,
        provider: template.provider,
        baseUrl: apiBaseUrl ?? template.baseUrl,
        reasoning: template.reasoning,
        compat: template.compat,
        thinkingLevelMap: template.thinkingLevelMap,
        input: template.input,
        cost: (template as Record<string, unknown>).cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
  }

  return piAi.createProvider({
    id: provider,
    baseUrl: apiBaseUrl,
    auth: { apiKey: createCustomApiKeyAuth(apiKey, provider) },
    models: modelsArray as unknown as Parameters<typeof piAi.createProvider>[0]["models"],
    api: api as Parameters<typeof piAi.createProvider>[0]["api"],
  });
}

/** 根据提供商名称加载 pi-ai provider（默认或自定义） */
async function loadProvider(provider: string, modelId: string): Promise<unknown> {
  const piAi = await loadPiAi();
  const llmConfig = config.llm;

  if (needsCustomProvider(llmConfig)) {
    return loadCustomProvider(piAi, provider, modelId, llmConfig.apiBaseUrl, llmConfig.apiKey);
  }

  // 默认 provider 工厂（行为不变）
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

/** pi-ai Models 类型 */
export type Models = Awaited<ReturnType<PiAiModule["createModels"]>>;

/**
 * 初始化 Models 对象。
 * 异步工厂：pi-ai 是 ESM-only，需通过动态 import() 加载。
 */
export async function initModels(modelConfig?: {
  provider?: string;
  model?: string;
}): Promise<{ models: Models; model: unknown }> {
  const provider = modelConfig?.provider ?? config.llm.provider;
  const modelId = modelConfig?.model ?? config.llm.model;

  const piAi = await loadPiAi();
  const models = piAi.createModels();

  const providerModule = await loadProvider(provider, modelId);
  models.setProvider(providerModule as never);

  const model = models.getModel(provider, modelId);
  if (!model) {
    throw new Error(`LLM model not found: provider=${provider}, model=${modelId}`);
  }

  return { models, model };
}

/** 测试用 Faux Provider 工厂 */
export async function initFauxModels(
  responses: unknown[],
): Promise<{ models: Models; model: unknown; faux: unknown }> {
  const piAi = await loadPiAi();
  const faux = piAi.fauxProvider({});
  const models = piAi.createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  if (responses.length > 0) {
    faux.setResponses(responses as never);
  }

  return { models, model, faux };
}
