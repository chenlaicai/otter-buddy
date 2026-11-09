import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelConfig } from "../../../src/frameworks/config";
import type { Logger } from "../../../src/usecases/ports/logger";
import { ModelRuntimeRegistry } from "../../../src/frameworks/agent/model-runtime-registry";

type RegistryTestAccess = {
  modelRuntime: { registerProvider(alias: string, input: { api: Api }): void } | null;
  _registerCustomProvider(alias: string, config: ModelConfig, model: Model<Api>): void;
};

function makeLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeModel(api: Api): Model<Api> {
  return {
    id: "kimi-k3",
    name: "kimi-k3",
    api,
    provider: "apig-kimi-k3",
    baseUrl: "https://proxy.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384,
  } as Model<Api>;
}

describe("ModelRuntimeRegistry custom provider api", () => {
  it("preserves the protocol selected by models-factory instead of forcing OpenAI aliases back to Responses", () => {
    const registry = new ModelRuntimeRegistry(undefined, makeLogger()) as unknown as RegistryTestAccess;
    const registrations = new Map<string, { api: Api }>();
    registry.modelRuntime = {
      registerProvider: (alias, input) => { registrations.set(alias, input); },
    };
    const config: ModelConfig = {
      alias: "apig-kimi-k3",
      provider: "openai",
      model: "kimi-k3",
      apiFormat: "chat",
      handoffThresholdTokens: 100000,
    };

    registry._registerCustomProvider(config.alias, config, makeModel("openai-completions"));

    expect(registrations.get("apig-kimi-k3")?.api).toBe("openai-completions");
  });
});
