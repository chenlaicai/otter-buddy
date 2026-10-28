/** F20261028egitx：真实沙箱工具必须进入 AgentSession 的 baseToolsOverride。 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

type CreateAgentSessionOptions = PiCodingAgent.CreateAgentSessionOptions;
type CreateAgentSessionResult = PiCodingAgent.CreateAgentSessionResult;

type PiCodingAgentSdk = typeof PiCodingAgent;

export type SandboxedAgentSessionOptions = CreateAgentSessionOptions & {
  baseToolsOverride: Record<string, AgentTool>;
};

/**
 * SDK 1.1.0–1.4.0 的 createAgentSession 不转发 baseToolsOverride；tools=[] + customTools
 * 同名注入亦被 allowlist 过滤。这里只替代最后的公开 Agent/AgentSession 构造，
 * 复用调用方已解析的模型、resourceLoader 与 settings；不得回退到裸默认工具。
 */
export async function createSandboxedAgentSession(
  sdk: PiCodingAgentSdk,
  options: SandboxedAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  const services = options.resourceLoader && options.modelRuntime && options.settingsManager
    ? undefined
    : await sdk.createAgentSessionServices({ cwd, settingsManager: options.settingsManager, modelRuntime: options.modelRuntime });
  const sessionManager = options.sessionManager ?? sdk.SessionManager.create(cwd);
  const settingsManager = options.settingsManager ?? services!.settingsManager;
  const modelRuntime = options.modelRuntime ?? services!.modelRuntime;
  const resourceLoader = options.resourceLoader ?? services!.resourceLoader;
  const agent = new Agent({
    initialState: {
      systemPrompt: resourceLoader.getSystemPrompt() ?? "",
      model: options.model,
      tools: [],
    },
    streamFn: (model, context, streamOptions) => modelRuntime.streamSimple(model, context, {
      ...streamOptions,
      reasoning: streamOptions?.reasoning ?? options.thinkingLevel,
      sessionId: sessionManager.getSessionId(),
    } as ModelsSimpleStreamOptions),
    getApiKey: async (provider) => (await modelRuntime.getAuth(provider))?.auth.apiKey,
  });
  const session = new sdk.AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    resourceLoader,
    customTools: options.customTools,
    modelRuntime,
    initialActiveToolNames: options.tools as string[],
    baseToolsOverride: options.baseToolsOverride,
    sessionStartEvent: options.sessionStartEvent,
  });
  return { session, extensionsResult: resourceLoader.getExtensions() };
}
