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

export function logModelResolution(logger: Logger, model: { provider: string; id: string }): void {
  logger.debug("durable model resolved", { provider: model.provider, model: model.id });
}
