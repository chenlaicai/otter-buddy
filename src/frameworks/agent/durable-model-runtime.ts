import { createModels, type Models } from "@earendil-works/pi-ai";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPool } from "@frameworks/llm/model-pool";

/**
 * The models factory already installs every configured provider in its private
 * catalog. Keep that catalog as the single source of truth instead of maintaining
 * a second provider/key registry for the durable Harness.
 */
export type ModelsSource = Models & { setProvider(provider: unknown): void };

const sources = new WeakMap<ModelPool, ModelsSource>();

export function registerModelSource(modelPool: ModelPool, models: ModelsSource): void {
  sources.set(modelPool, models);
}

export function getModelSource(modelPool?: ModelPool): ModelsSource {
  if (modelPool) {
    const source = sources.get(modelPool);
    if (source) return source;
  }
  // Custom-only deployments do not need the built-in provider catalog. Their
  // providers are registered by initModels before any session is opened.
  return createModels() as ModelsSource;
}

export function modelRef(model: { provider: string; id: string }): { provider: string; modelId: string } {
  return { provider: model.provider, modelId: model.id };
}

/** F20261111mwire（#1854）：按 (provider, id) 覆盖的 models 源包装。
 *  Why：durable Harness 对 models 源的使用面 = getModel/streamSimple/completeSimple/
 *  fetchDeferred/cancelDeferred（pi-durable harness 全量 grep 实证）——模型解析经
 *  getModel(provider, id) 重取（generation.js:138），副本覆盖（maxTokens/thinkingLevelMap）
 *  若不进 models 源就到不了线缆（#1852 检视 B1：F20260924swin 显式 max_tokens 在
 *  durable 迁移后空转的根因）。
 *  语义：Proxy get 委托底层（函数 bind 到底层对象，auth/凭据/流式链路零改动），
 *  仅 getModel 命中目标 (provider,id) 时返回覆盖副本；不改底层（底层源是 WeakMap
 *  池缓存的共享实例，就地修改会泄漏到全部 session）。
 *  使用面：合成影子通道的一次性 session（每次 attempt 独立包装，随 session 销毁）。 */
export function withModelOverride<T extends object>(base: T, override: { provider: string; id: string }): T {
  return new Proxy(base, {
    get(target: T, prop, _receiver) {
      if (prop === "getModel") {
        const original = (target as unknown as Record<string, unknown>).getModel as (provider: string, id: string) => unknown;
        return (provider: string, id: string) =>
          provider === override.provider && id === override.id
            ? override
            : original.call(target, provider, id);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function logModelResolution(logger: Logger, model: { provider: string; id: string }): void {
  logger.debug("durable model resolved", { provider: model.provider, model: model.id });
}
