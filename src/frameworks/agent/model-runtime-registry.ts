/**
 * ModelRuntimeRegistry：负责 pi-coding-agent ModelRuntime 的初始化和模型注册。
 *
 * 从 PiSessionFactory 拆出（D2 瘦身），职责：
 * - 加载 pi-coding-agent SDK（ESM-only）
 * - 创建 ModelRuntime 并注入 config.yaml 的 apiKey
 * - 创建 SettingsManager（retry maxRetries=4）
 * - 注册自定义 provider（alias !== config.provider 时）
 * - 设置 API key 到 alias 和 provider 两个名称上
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "@usecases/ports/logger";
import type { ModelConfig } from "@frameworks/config";
import type { ModelPool } from "@frameworks/llm/model-pool";
import type { OtterPromptConfig } from "@contract/api/otter";
import { buildOtterPrompt } from "./session-helpers";
import { handleSessionBeforeCompact, type CompactionHookDeps, type CompactionPreparationLike } from "./compaction-hook";
import { haltRegistry, type HaltDirective } from "@usecases/signal/halt-registry";
import { buildHaltBlockReason } from "@usecases/signal/halt-block-reason";

/** pi-coding-agent 模块类型（动态加载） */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

let piCodingAgentCache: PiCodingAgentModule | null = null;

async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  if (!piCodingAgentCache) {
    piCodingAgentCache = await import("@earendil-works/pi-coding-agent");
  }
  return piCodingAgentCache;
}

export class ModelRuntimeRegistry {
  /** pi-coding-agent ModelRuntime（S3: 用 SDK 完整类型替代最小接口） */
  private modelRuntime: ModelRuntime | null = null;
  /** SDK SettingsManager（M2: retry maxRetries=4 取代 otter 层 API error 重试） */
  private settingsManager: SettingsManager | null = null;
  /** pi-coding-agent 模块缓存 */
  private piCodingAgent: PiCodingAgentModule | null = null;
  /** ResourceLoader（skill 发现） */
  private resourceLoader: ResourceLoader | null = null;

  constructor(
    private readonly modelPool: ModelPool | undefined,
    private readonly logger: Logger,
    private readonly resourceLoaderOverride?: ResourceLoader,
    /** F20260826mwrd C1：halt 首次注入回调（signal_events 落账更新 + 外部监听） */
    private readonly onHaltFirstBlock?: (directive: HaltDirective) => void,
  ) {}

  /** 获取 ModelRuntime */
  getModelRuntime(): ModelRuntime | null {
    return this.modelRuntime;
  }

  /** 获取 SettingsManager */
  getSettingsManager(): SettingsManager | null {
    return this.settingsManager;
  }

  /** 获取 pi-coding-agent 模块 */
  getPiCodingAgent(): PiCodingAgentModule | null {
    return this.piCodingAgent;
  }

  /** 获取 ResourceLoader */
  getResourceLoader(): ResourceLoader | null {
    return this.resourceLoader;
  }

  /** 预加载 pi-coding-agent SDK + ResourceLoader + ModelRuntime，避免首次对话冷启动阻塞 */
  async warmup(): Promise<void> {
    await this.ensurePiCodingAgent();
    this.logger.info("ModelRuntimeRegistry warmup completed");
  }

  /** 懒加载 pi-coding-agent（ESM-only）+ ResourceLoader（skill 发现）+ ModelRuntime（API key） */
  async ensurePiCodingAgent(): Promise<PiCodingAgentModule> {
    if (!this.piCodingAgent) {
      /** 先走完全部初始化再缓存：中途抛错（如 registerProvider 失败）不得留下
       *  半初始化的缓存态，否则后续调用直接命中缓存、provider 注册永久缺失直到重启 */
      const piCodingAgent = await loadPiCodingAgent();

      /** 创建 ResourceLoader：通过 SDK 原生协议注入 skills（替代手动拼接） */
      if (!this.resourceLoader) {
        const { DefaultResourceLoader, getAgentDir } = piCodingAgent;
        this.resourceLoader = this.resourceLoaderOverride ?? new DefaultResourceLoader({
          cwd: process.cwd(),
          agentDir: getAgentDir(),
          extensionFactories: [{
            name: "otter-hooks",
            hidden: true,
            // ExtensionAPI.on 的 overload 不包含 "context"/"before_agent_start"，需要 any 绕过
            factory: (pi: any) => {
              // strip 历史 assistant 消息的 thinking 块（保留最新一条）
              pi.on("context", (event: { messages: any[] }) => {
                return { messages: stripHistoricalThinking(event.messages) };
              });
              // F20260826mwrd C1：halt 边界注入。tool_call 扩展事件在每次工具执行前触发，
              // 返回 { block, reason } → SDK agent-loop 对该次调用生成 isError tool result
              // （reason 正文）返回 LLM。读 ALS store 拿当前 invoke 的 otterId（fail-open：
              // 读不到 store 时放行，见 haltToolCallGuard 注释）。
              pi.on("tool_call", (event: { toolName?: string }) => {
                return haltToolCallGuard(otterInvokeStorage.getStore(), haltRegistry, event.toolName);
              });
              // S1（R20260810piab）：otter system prompt 注入 system role。
              // handler 在 prompt() 调用栈内执行，此时 AsyncLocalStorage scope 有效，
              // 可读到 per-invoke 的 otterPromptConfig + identityPrefix。
              // 返回的 systemPrompt 会替换 SDK base（runner.js 链式覆盖语义），
              // 因此在 event.systemPrompt（SDK base 含工具描述）基础上追加 otter 专属内容。
              pi.on("before_agent_start", (event: { systemPrompt: string }) => {
                return buildBeforeAgentStartResult(event, otterInvokeStorage.getStore());
              });
              /**
               * F20260811sktp: isError 透传。
               * SDK 的 AgentToolResult 不消费工具返回值顶层 isError 字段（成功路径硬编码 isError=false）。
               * buildCustomTools mapping 时把 otter ToolResponse.isError 复制到 details.__isError，
               * 此 handler 读 details.__isError 返回 { isError: true } 覆盖 SDK 标志，
               * 透传到 Anthropic API 的 tool_result.is_error，让 LLM 结构化识别错误。
               */
              pi.on("tool_result", (event: { details?: unknown }) => {
                const details = event.details as { __isError?: boolean } | undefined;
                if (details?.__isError === true) {
                  return { isError: true };
                }
                return undefined;
              });
              // F20260903cmpk：压缩算法替换——threshold 触发时用七段合成替代 Pi 默认摘要
              //（overflow/manual 放行）。deps 由 PiSessionFactory 在创建 session 时注入
              //（setCompactionHookDeps），此处读全局槽（factory 与 registry 同模块层级，
              // 避免 registry 构造参数反向穿透）。无 deps 时 undefined = Pi 默认兜底。
              pi.on("session_before_compact", async (event: { reason: "manual" | "threshold" | "overflow"; preparation: CompactionPreparationLike }) => {
                const store = otterInvokeStorage.getStore();
                const otterName = store?.otterPromptConfig ? otterIdFromStore(store) : "海獭";
                return await handleSessionBeforeCompact(event, compactionHookDeps, otterName);
              });
            },
          }],
        });
        await this.resourceLoader.reload();
        // F20260826mwrd C1：halt 首次注入回调——落账更新（指令已到达）+ 日志。
        // 注册在 resourceLoader 就绪后（首次 halt 必然晚于 session 创建，而 session 依赖 resourceLoader）。
        haltRegistry.onFirstBlock(directive => {
          this.logger.info('Halt directive first block injected', { targetOtterId: directive.targetOtterId, signalId: directive.id, fromOtterId: directive.fromOtterId });
          try { this.onHaltFirstBlock?.(directive); } catch { /* 回调失败不影响 block */ }
        });
        const { skills } = this.resourceLoader.getSkills();
        if (skills.length === 0) {
          this.logger.warn(`ResourceLoader discovered 0 skills from .pi/skills — check if directory exists and contains SKILL.md files`);
        } else {
          this.logger.info(`ResourceLoader discovered ${skills.length} skill(s) from .pi/skills`);
        }
      }

      /** 创建 ModelRuntime 并注入 config.yaml 的 apiKey（SDK 不读 config.yaml） */
      this.modelRuntime = await piCodingAgent.ModelRuntime.create();

      // M2（R20260810piab）：创建 SettingsManager，retry maxRetries=4 取代 otter 层 API error 重试。
      // SDK 默认 maxRetries=3；调到 4 后移除了 otter AgentInvoker 的 API error 重试（原最坏 4 次 = SDK 3 + otter 1）。
      this.settingsManager = piCodingAgent.SettingsManager.create(process.cwd());
      this.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 4 } });

      // initModels 恒产出 ModelPool（models-factory.ts），bootstrap 必装配下传
      if (this.modelPool) {
        for (const entry of this.modelPool.getAllEntries()) {
          await this._registerRuntimeModel(entry.alias, entry.config, entry.model);
        }
      }

      this.piCodingAgent = piCodingAgent;
    }
    return this.piCodingAgent;
  }

  /**
   * 把一个模型条目注册进 ModelRuntime。
   * 自定义 alias 必须注册进 ModelRuntime 的 provider 注册表：
   * AgentSession 鉴权走 modelRuntime.getAuth()，对未知 provider 直接返回 undefined
   * （报 "No API key found for <alias>"），即使已 setRuntimeApiKey 也查不到。
   * alias 与内置 provider 同名时跳过注册（内置 provider 天然在注册表中）。
   */
  private async _registerRuntimeModel(alias: string, config: ModelConfig, model: Model<Api>): Promise<void> {
    if (!this.modelRuntime) return;
    if (alias !== config.provider) {
      this._registerCustomProvider(alias, config, model);
    }
    if (config.apiKey) {
      await this._setRuntimeApiKeys(alias, config);
    }
  }

  /** 注册自定义 provider（alias !== config.provider 时） */
  private _registerCustomProvider(alias: string, config: ModelConfig, model: Model<Api>): void {
    // S3（R20260810piab）：model 现在是 Model<Api>，字段类型由 SDK 精确声明，无需 inline cast 弱化。
    // contextWindow/maxTokens 在 Model 上可能 undefined，但 ProviderConfigInput 期望 number——
    // 回退到 config 的值（config 是 otter 自己的 ModelConfig，这些字段是 number | undefined），
    // 双重 undefined 时回退 0（SDK 视 0 contextWindow 为"总是需要 compaction"，但此处只在 alias !== provider 时触发）。
    this.modelRuntime!.registerProvider(alias, {
      // config 只配 apiKey 不配 apiBaseUrl 时回退到 pool model 的 baseUrl（template 兜底，总有值），
      // 否则 SDK 对"注册了 models 但无 baseUrl"的 provider 同步抛错
      baseUrl: config.apiBaseUrl ?? model.baseUrl,
      apiKey: config.apiKey,
      api: config.provider === "openai" ? "openai-responses" : "anthropic-messages",
      models: [{
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.reasoning ?? false,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input ?? ["text" as const],
        cost: model.cost,
        contextWindow: model.contextWindow ?? config.contextWindow ?? 0,
        maxTokens: model.maxTokens ?? config.maxTokens ?? 0,
        compat: model.compat,
      }],
    });
    this.logger.info(`Registered runtime provider for alias=${alias}`);
  }

  /** 设置 API key 到 alias 和 provider 两个名称上（SDK 可能用任一名称查找） */
  private async _setRuntimeApiKeys(alias: string, config: ModelConfig): Promise<void> {
    await this.modelRuntime!.setRuntimeApiKey(alias, config.apiKey!);
    if (alias !== config.provider) {
      await this.modelRuntime!.setRuntimeApiKey(config.provider, config.apiKey!);
    }
    this.logger.info(`Set runtime API key for alias=${alias} (also for provider=${config.provider})`);
  }
}

/**
 * Strip 历史 assistant 消息的 thinking 块，保留最新 assistant 消息的 thinking 不动。
 *
 * - 当前轮 thinking 保留：多步工具调用场景下模型依赖自己的推理过程
 * - abort 保护：只有 thinking 无 text/toolCall 的 assistant 消息保留原样，防止 API 400
 * - JSONL 不受影响：此函数只影响发给 LLM 的 context，原始数据完整保留
 *
 * @param messages AgentMessage[] — 包含 user/assistant/toolResult 等消息
 * @returns 新数组，历史 assistant 的 thinking 被 strip
 */
export function stripHistoricalThinking(messages: any[]) {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  return messages.map((msg, idx) => {
    if (msg.role !== "assistant") return msg;
    if (idx === lastAssistantIdx) return msg;
    const hasThinking = msg.content.some((c: any) => c.type === "thinking");
    if (!hasThinking) return msg;
    const nonThinking = msg.content.filter((c: any) => c.type !== "thinking");
    if (nonThinking.length === 0) return msg;
    return { ...msg, content: nonThinking };
  });
}

/**
 * S1（R20260810piab）：before_agent_start handler 的纯函数实现。
 * 提取为独立导出函数以便测试——不需要走完整 SDK 调用链即可验证 system prompt 注入逻辑。
 *
 * 在 SDK base systemPrompt 基础上追加 otterPrompt + identityPrefix，返回新 systemPrompt。
 * SDK runner.js 的链式覆盖语义：返回的 systemPrompt 替换当前值。
 */
export function buildBeforeAgentStartResult(
  event: { systemPrompt: string },
  ctx: OtterInvokeContext | undefined,
): { systemPrompt: string } | undefined {
  if (!ctx) return undefined;
  const parts: string[] = [];
  if (event.systemPrompt) parts.push(event.systemPrompt);
  const otterPrompt = buildOtterPrompt(ctx.otterPromptConfig);
  if (otterPrompt) parts.push(otterPrompt);
  if (ctx.identityPrefix) parts.push(ctx.identityPrefix);
  if (parts.length <= 1) return undefined; // 只有 base，无需覆盖
  return { systemPrompt: parts.join("\n\n") };
}

/** S1（R20260810piab）：per-invoke 上下文，通过 AsyncLocalStorage 传递给 extension handler。 */
export interface OtterInvokeContext {
  /** otterConfig.systemPrompt（string 或 OtterPromptConfig 含 reminders） */
  otterPromptConfig: string | OtterPromptConfig | undefined;
  /** 首次 invoke 的身份前缀（名称/ID/类型/身份文案/模型指南/搭档名）；非首次为空串 */
  identityPrefix: string;
  /** F20260826mwrd C1：当前 invoke 的 otterId——tool_call handler 查 halt 标用 */
  otterId: string;
}

export const otterInvokeStorage = new AsyncLocalStorage<OtterInvokeContext>();


/** F20260903cmpk：压缩钩子依赖槽。PiSessionFactory 创建 session 时注入（setCompactionHookDeps）。
 *  模块级单例与 otter-hooks 单例 factory 对应；null = 钩子放行 Pi 默认。 */
let compactionHookDeps: CompactionHookDeps | null = null;

export function setCompactionHookDeps(deps: CompactionHookDeps | null): void {
  compactionHookDeps = deps;
}

function otterIdFromStore(store: OtterInvokeContext): string {
  return store.otterId || "海獭";
}

/**
 * F20260826mwrd C1：halt tool_call handler 的 block 判定（纯函数，测试可独立覆盖）。
 *
 * SDK 语义链：tool_call 扩展事件 → ToolCallEventResult{ block, reason } →
 * agent-loop 对 block 生成 isError tool result（reason 正文）返回 LLM。
 *
 * 为什么不是拦截器内闭包直接取 store：ALS store 读不到（如 handler 在异步边界后执行）时
 * 无法区分「无 halt」与「读不到」——独立成纯函数后，读不到返回 undefined（放行），
 * 语义与「无 halt」一致（fail-open），不会误伤正常工具流。
 */
export function haltToolCallGuard(
  store: OtterInvokeContext | undefined,
  haltRegistryLike: { takeForBlock(otterId: string): HaltDirective[]; isHalted(otterId: string): boolean },
  toolName?: string,
): { block: true; reason: string } | undefined {
  const otterId = store?.otterId;
  if (!otterId) return undefined;
  // speak 豁免（检视发现 1 处置）：被 halt 的獭需要 speak 报告进度快照（注入文本义务 2）。
  // 豁免期间不消费 pending（takeForBlock 不触发）——注入到下一个非 speak 调用边界才发生，
  // 落账闭环不受影响（首次 block 时 resolve）。speak 无副作用，halt 的目的是停副作用。
  if (toolName === 'speak') return undefined;
  const directives = haltRegistryLike.takeForBlock(otterId);
  if (directives.length === 0) return undefined;
  const reason = buildHaltBlockReason(directives);
  return reason ? { block: true, reason } : undefined;
}
