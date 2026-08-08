/**
 * pi-ai Models 对象工厂（Provider 路由 + Model 获取）。
 * 本模块只提供 Models 工厂，LLM 交互由 AgentHarness 内部处理。
 *
 * 模型唯一真相源是 config.yaml 的 llm.models[]（单模型即一条 models[] 条目）。
 * 条目配置 apiBaseUrl 或 apiKey 时，使用 createProvider() 构造自定义 provider，
 * 替代默认的 openaiProvider() / anthropicProvider() / kimiCodingProvider()。
 */

import type { AppConfig, ModelConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPool } from "./model-pool";
import { buildModelPool } from "./model-pool";
export type { ModelPool } from "./model-pool";

/** 自定义 provider 连接选项（apiBaseUrl 或 apiKey 任一配置即触发自定义构造） */
interface CustomProviderOptions {
  apiBaseUrl?: string;
  apiKey?: string;
  /** 模型上下文窗口（自定义模型注入时带入，SDK compaction/溢出检测依赖它，F20260808ctxw） */
  contextWindow?: number;
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

/**
 * 判断是否需要自定义 provider。
 * apiBaseUrl 或 apiKey 任一配置即触发自定义 provider 构造。
 */
function needsCustomProvider(options: CustomProviderOptions): boolean {
  return !!(options.apiBaseUrl || options.apiKey);
}

/**
 * 构造自定义 API Key Auth。
 * 解析优先级：configApiKey → credential.key → 标准环境变量。
 */
function createCustomApiKeyAuth(configApiKey?: string, provider?: string) {
  // 根据 provider 类型选择环境变量
  let envVarName: string;
  switch (provider) {
    case "anthropic":
      envVarName = "ANTHROPIC_API_KEY";
      break;
    case "kimi-coding":
      envVarName = "KIMI_API_KEY";
      break;
    default:
      envVarName = "OPENAI_API_KEY";
      break;
  }
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
  options: CustomProviderOptions,
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
  } else if (providerType === "kimi-coding") {
    const modelsMod = await import("@earendil-works/pi-ai/providers/kimi-coding.models");
    modelsDict = modelsMod.KIMI_CODING_MODELS;
    const apiMod = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");
    api = apiMod.anthropicMessagesApi();
  } else {
    throw new Error(`Unsupported LLM provider type: ${providerType}`);
  }

  // 转为数组并注入自定义模型（连接属性继承模板；contextWindow 从 config 带入，缺省不带）
  const modelsArray = Object.values(modelsDict) as Record<string, unknown>[];
  const hasModel = modelsArray.some(m => (m as Record<string, unknown>).id === modelId);
  if (!hasModel) {
    const template = modelsArray[0] as Record<string, unknown> | undefined;
    if (template) {
      // eslint-disable-next-line no-console
      console.warn(`[models-factory] Model "${modelId}" not found in ${providerType} models dict, using template from "${template.id}" but with empty compat/thinkingLevelMap. Available models: ${modelsArray.map(m => (m as Record<string, unknown>).id).join(', ')}`);
      modelsArray.push({
        id: modelId,
        name: modelId,
        api: template.api,
        provider: alias, // 用 alias 作为 provider 字段，确保 SDK auth 解析正确
        baseUrl: options.apiBaseUrl ?? template.baseUrl,
        reasoning: template.reasoning,
        // 不继承 compat 和 thinkingLevelMap，避免意外行为
        compat: {},
        thinkingLevelMap: {},
        input: template.input,
        cost: (template as Record<string, unknown>).cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        /** F20260808ctxw：contextWindow 缺省时 SDK 视为 0，shouldCompact 恒真（每轮白跑摘要调用） */
        ...(options.contextWindow !== undefined && { contextWindow: options.contextWindow }),
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
 * @param providerType provider 类型（openai/anthropic/kimi-coding），用于模块加载
 * @param modelId 模型 ID
 * @param alias provider ID，用于注册
 * @param options 可选的连接配置（apiKey/apiBaseUrl）
 */
async function loadProvider(providerType: string, modelId: string, alias: string, options?: CustomProviderOptions): Promise<unknown> {
  const piAi = await loadPiAi();

  if (options && needsCustomProvider(options)) {
    return loadCustomProvider(piAi, providerType, modelId, alias, options);
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
    case "kimi-coding": {
      const mod = await import("@earendil-works/pi-ai/providers/kimi-coding");
      return mod.kimiCodingProvider();
    }
    default:
      throw new Error(`Unsupported LLM provider type: ${providerType}`);
  }
}

/** pi-ai Models 类型 */
export type Models = Awaited<ReturnType<PiAiModule["createModels"]>>;

/**
 * 初始化模型池：遍历 models[]，为每个模型创建独立的 provider 实例。
 */
async function initModelPool(
  piAi: PiAiModule,
  models: Models,
  modelConfig: AppConfig["llm"],
  logger?: Logger,
): Promise<{ model: unknown; modelPool: ModelPool }> {
  const startTime = Date.now();
  const modelEntries: Array<{ config: ModelConfig; model: unknown }> = [];

  for (const mc of modelConfig.models) {
    const providerModule = await loadProvider(mc.provider, mc.model, mc.alias, {
      apiKey: mc.apiKey,
      apiBaseUrl: mc.apiBaseUrl,
      contextWindow: mc.contextWindow,
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

  const modelPool = buildModelPool(modelConfig.default, modelEntries);
  const duration = Date.now() - startTime;
  if (logger) {
    logger.info('LLM models initialized', { modelCount: modelEntries.length, defaultAlias: modelConfig.default, duration, action: 'model_init_complete' });
  }

  return { model: modelPool.getDefaultModel(), modelPool };
}

/**
 * 初始化 Models 对象。
 * 异步工厂：pi-ai 是 ESM-only，需通过动态 import() 加载。
 */
export async function initModels(
  modelConfig: AppConfig["llm"],
  logger?: Logger,
): Promise<{ models: Models; model: unknown; modelPool: ModelPool }> {
  if (logger) {
    logger.info('LLM model initialization started', { defaultAlias: modelConfig.default, modelCount: modelConfig.models.length, action: 'model_init_start' });
  }

  const piAi = await loadPiAi();
  const models = piAi.createModels();

  const result = await initModelPool(piAi, models, modelConfig, logger);

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
