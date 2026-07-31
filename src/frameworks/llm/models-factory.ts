/**
 * pi-ai Models 对象工厂（Provider 路由 + Model 获取）。
 * 本模块只提供 Models 工厂，LLM 交互由 AgentHarness 内部处理。
 *
 * 支持自定义 provider：当 config.yaml 中配置了 llm.apiBaseUrl 或 llm.apiKey 时，
 * 使用 createProvider() 构造自定义 provider，替代默认的 openaiProvider() / anthropicProvider()。
 *
 * 支持多模型：当 config.yaml 中配置了 llm.models[] 时，
 * 为每个模型创建独立的 provider 实例，返回 ModelPool。
 */

import type { AppConfig, ModelConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPool } from "./model-pool";
import { buildModelPool } from "./model-pool";
export type { ModelPool } from "./model-pool";

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
 * @param providerType provider 类型（openai/anthropic），用于模块加载
 * @param alias provider ID，用于注册（避免同 provider 多实例冲突）
 */
async function loadCustomProvider(
  piAi: PiAiModule,
  providerType: string,
  modelId: string,
  alias: string,
  options: { apiBaseUrl?: string; apiKey?: string },
): Promise<unknown> {
  let modelsDict: Record<string, unknown>;
  let api: unknown;

  if (providerType === "openai") {
    const modelsMod = await import("@earendil-works/pi-ai/providers/openai.models");
    modelsDict = modelsMod.OPENAI_MODELS;
    const apiMod = await import("@earendil-works/pi-ai/api/openai-responses.lazy");
    api = apiMod.openAIResponsesApi();
  } else if (providerType === "anthropic") {
    const modelsMod = await import("@earendil-works/pi-ai/providers/anthropic.models");
    modelsDict = modelsMod.ANTHROPIC_MODELS;
    const apiMod = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");
    api = apiMod.anthropicMessagesApi();
  } else {
    throw new Error(`Unsupported LLM provider type: ${providerType}`);
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
        provider: alias, // 用 alias 作为 provider 字段，确保 SDK auth 解析正确
        baseUrl: options.apiBaseUrl ?? template.baseUrl,
        reasoning: template.reasoning,
        compat: template.compat,
        thinkingLevelMap: template.thinkingLevelMap,
        input: template.input,
        cost: (template as Record<string, unknown>).cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
  }

  return piAi.createProvider({
    id: alias, // 用 alias 作为 provider ID
    baseUrl: options.apiBaseUrl,
    auth: { apiKey: createCustomApiKeyAuth(options.apiKey, providerType) },
    models: modelsArray as unknown as Parameters<typeof piAi.createProvider>[0]["models"],
    api: api as Parameters<typeof piAi.createProvider>[0]["api"],
  });
}

/**
 * 根据提供商类型加载 pi-ai provider（默认或自定义）。
 * @param providerType provider 类型（openai/anthropic），用于模块加载
 * @param modelId 模型 ID
 * @param alias provider ID，用于注册
 * @param llmConfig 可选的 llm 配置（含 apiKey/apiBaseUrl）
 */
async function loadProvider(providerType: string, modelId: string, alias: string, llmConfig?: AppConfig["llm"]): Promise<unknown> {
  const piAi = await loadPiAi();

  if (llmConfig && needsCustomProvider(llmConfig)) {
    return loadCustomProvider(piAi, providerType, modelId, alias, { apiBaseUrl: llmConfig.apiBaseUrl, apiKey: llmConfig.apiKey });
  }

  // 默认 provider 工厂（行为不变）
  switch (providerType) {
    case "openai": {
      const mod = await import("@earendil-works/pi-ai/providers/openai");
      return mod.openaiProvider();
    }
    case "anthropic": {
      const mod = await import("@earendil-works/pi-ai/providers/anthropic");
      return mod.anthropicProvider();
    }
    default:
      throw new Error(`Unsupported LLM provider type: ${providerType}`);
  }
}

/** pi-ai Models 类型 */
export type Models = Awaited<ReturnType<PiAiModule["createModels"]>>;

/**
 * 初始化多模型模式。
 * 遍历 models[]，为每个模型创建独立的 provider 实例。
 */
async function initMultiModel(
  piAi: PiAiModule,
  models: Models,
  modelConfig: AppConfig["llm"],
  logger?: Logger,
): Promise<{ model: unknown; modelPool: ModelPool }> {
  const startTime = Date.now();
  const modelEntries: Array<{ config: ModelConfig; model: unknown }> = [];

  for (const mc of modelConfig.models!) {
    const providerModule = await loadProvider(mc.provider, mc.model, mc.alias, {
      provider: mc.provider,
      model: mc.model,
      apiKey: mc.apiKey,
      apiBaseUrl: mc.apiBaseUrl,
    });
    models.setProvider(providerModule as never);

    const resolvedModel = models.getModel(mc.alias, mc.model);
    if (!resolvedModel) {
      const error = new Error(`LLM model not found: alias=${mc.alias}, provider=${mc.provider}, model=${mc.model}`);
      if (logger) {
        logger.error('LLM model initialization failed', error, { alias: mc.alias, action: 'model_init_failed' });
      }
      throw error;
    }
    modelEntries.push({ config: mc, model: resolvedModel });
  }

  const modelPool = buildModelPool(modelConfig.default!, modelEntries);
  const duration = Date.now() - startTime;
  if (logger) {
    logger.info('LLM models initialized (multi-model)', { modelCount: modelEntries.length, defaultAlias: modelConfig.default, duration, action: 'model_init_complete' });
  }

  return { model: modelPool.getDefaultModel(), modelPool };
}

/**
 * 初始化单模型模式（兼容旧配置）。
 */
async function initSingleModel(
  piAi: PiAiModule,
  models: Models,
  modelConfig: AppConfig["llm"],
  logger?: Logger,
): Promise<{ model: unknown; modelPool: ModelPool }> {
  const startTime = Date.now();
  const { provider, model: modelId } = modelConfig;

  const providerModule = await loadProvider(provider, modelId, provider, modelConfig);
  models.setProvider(providerModule as never);

  const model = models.getModel(provider, modelId);
  if (!model) {
    const error = new Error(`LLM model not found: provider=${provider}, model=${modelId}`);
    if (logger) {
      logger.error('LLM model initialization failed', error, { provider, model: modelId, action: 'model_init_failed' });
    }
    throw error;
  }

  const modelPool = buildModelPool(provider, [{
    config: { alias: provider, provider, model: modelId, apiKey: modelConfig.apiKey, apiBaseUrl: modelConfig.apiBaseUrl },
    model,
  }]);

  const duration = Date.now() - startTime;
  if (logger) {
    logger.info('LLM model initialized (single-model)', { provider, model: modelId, duration, action: 'model_init_complete' });
  }

  return { model, modelPool };
}

/**
 * 初始化 Models 对象。
 * 异步工厂：pi-ai 是 ESM-only，需通过动态 import() 加载。
 *
 * 支持多模型：当 modelConfig.models 存在时，为每个模型创建独立的 provider 实例，返回 ModelPool。
 */
export async function initModels(
  modelConfig: AppConfig["llm"],
  logger?: Logger,
): Promise<{ models: Models; model: unknown; modelPool: ModelPool }> {
  const { provider, model: modelId } = modelConfig;

  if (logger) {
    logger.info('LLM model initialization started', { provider, model: modelId, multiModel: !!modelConfig.models?.length, action: 'model_init_start' });
  }

  const piAi = await loadPiAi();
  const models = piAi.createModels();

  const isMultiModel = modelConfig.models && modelConfig.models.length > 0 && modelConfig.default;
  const result = isMultiModel
    ? await initMultiModel(piAi, models, modelConfig, logger)
    : await initSingleModel(piAi, models, modelConfig, logger);

  return { models, ...result };
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
