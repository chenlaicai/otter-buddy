/**
 * pi-ai Models 对象工厂（Provider 路由 + Model 获取）。
 * LLM 交互（chat/streamChat）由 AgentHarness 内部处理，本模块只提供 Models 工厂。
 */

import { config } from "@frameworks/config";

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

  const providerModule = await loadProvider(provider);
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
