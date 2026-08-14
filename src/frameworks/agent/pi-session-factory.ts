/* eslint-disable max-lines */ // 多模型路由改造导致文件增长，后续可拆分
/**
 * PiSessionFactory：基于 pi-coding-agent SDK（createAgentSession）的 AgentGateway 实现。
 *
 * 设计要点：
 * - Session 复用机制：首次 invoke 创建 session 并持久化，后续 invoke 恢复已有 session
 * - 只有在 reset/create 时才创建新 session，构建 session 链
 * - tools 配置控制编码工具启用，customTools 注入 Otter 工具
 * - 系统提示通过 extension before_agent_start 事件注入 system role（R20260810piab S1）
 * - 熔断器通过 session.subscribe 拦截 tool_execution_start 事件
 * - 并发安全：外部方法获取锁，内部方法不获取锁，避免死锁
 *
 * F20260722ta2k: Session 复用机制修复
 */

import fs from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from "better-sqlite3";
import type {
  AgentConfig,
  AgentContext,
  AgentGateway,
} from "@usecases/otter/agent-gateway";
import type { OtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client";
import type { AgentTool, ToolContext } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { truncateToolResult } from "@interface-adapters/agent-runtime/tools/tool-helpers";
import type { ToolResponse } from "@interface-adapters/agent-runtime/tools/tool-helpers";
import type { ResourceLoader, SessionEntry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getContextWindowTokens } from "./context-tokens";
import { createAgentSessionStore } from "./agent-session-store";
import type { AgentSessionStore } from "./agent-session-store";
import type { DynamicContext, AgentStreamEvent } from "@interface-adapters/agent-runtime/agent-invoke-port";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./tool-call-circuit-breaker";
import type { CircuitBreakerConfig, ToolCallCircuitBreaker } from "./tool-call-circuit-breaker";
import { getConfig } from "@frameworks/config";
import type { ModelConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import type { OtterPromptConfig } from "@contract/api/otter";
import { loadPromptFile } from "./prompt-loader";
import type { OtterConfigProvider, OtterType } from "@usecases/ports/otter-config-provider";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import { getCodingToolsForOtterType, getOtterToolNamesForType, SimpleLockManager, getSessionManagerClass, buildOtterPrompt, buildMessageWithContext } from "./session-helpers";
import { attachCircuitBreaker, checkTokenWarning, buildResult } from "./circuit-breaker-helpers";
import { attachOutputGuard } from "./output-guard";
import type { OutputGuardConfig } from "./output-guard";
import { SessionRestore } from "./session-restore";
import type { ModelPool } from "@frameworks/llm/model-pool";

/** Agent 事件（流式推送，对齐 SDK AgentSessionEvent + 索引签名兼容弱类型访问） */
export type AgentEvent = AgentStreamEvent;

/** Agent 执行结果 */
export interface AgentRunResult {
  text: string;
  /** session 累计 token 消耗（成本口径，仅日志用；不代表上下文窗口占用） */
  tokenUsage?: { input: number; output: number };
  /** 上下文窗口占用：末次 LLM 调用的 input+output+cacheRead+cacheWrite（F20260808ctxw） */
  ctxTokens?: number;
  ctxMax?: number;
  circuitBreakerMetadata?: { totalCalls: number; circuitReason?: string };
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number };
  /** 本次 invoke 实际使用的模型别名（F20260814mtrc：metrics model label 数据源） */
  modelAlias?: string;
  /** 本次 invoke 重建了全新 session（文件丢失/损坏/重启；F20260814mtrc） */
  sessionRebuilt?: boolean;
}

/** _buildInvokeResult 所需的 session 结构子集（统计 + 分支条目读取） */
type SessionStatsSource = {
  getSessionStats: () => { tokens: { input: number; output: number } };
  sessionManager: { getBranch: () => SessionEntry[] };
};

/** invoke() 选项 */
export interface InvokeOptions {
  dynamicContext?: DynamicContext;
  onEvent?: (event: AgentEvent) => void;
  conversationId: string;
  /** 当前 streaming 消息 ID（speak 工具需要） */
  messageId?: string;
  /** 首次 invoke 标志（内部使用，注入身份信息） */
  isFirstInvoke?: boolean;
}

/** initAgentSessionFactory 配置 */
export interface AgentSessionFactoryConfig {
  db: Database.Database;
  sessionDir?: string;
  otterToolClient: OtterToolClient | null;
  /** pi-ai Model 对象（由 models-factory 创建，为 modelPool 的默认模型） */
  model: Model<Api>;
  /** ModelPool（多模型路由，可选） */
  modelPool?: ModelPool;
  /** Otter 身份文案目录（含 BIG_OTTER.md / SMALL_OTTER.md，首次 invoke 时按类型注入） */
  identityPromptDir?: string;
  /** 工具工厂函数（由 Composition Root 注入，解耦 interface-adapters） */
  createTools: (ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger) => AgentTool[];
  /** Healing event 仓库（可选，由 Composition Root 注入） */
  healingRepo?: HealingEventRepository;
  /** Otter 配置持久化（由 Composition Root 注入） */
  otterConfigProvider: OtterConfigProvider;
  /** Otter Repository（由 Composition Root 注入，替代直接 DB 查询） */
  otterRepo: OtterRepository;
  /** Settings 仓库（读取用户显示名，可选） */
  settingsRepo?: SettingsRepository;
}

/** pi-coding-agent 模块类型（动态加载） */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

/** SessionManager 类型（从 pi-coding-agent 导入） */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

let piCodingAgentCache: PiCodingAgentModule | null = null;

async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  if (!piCodingAgentCache) {
    piCodingAgentCache = await import("@earendil-works/pi-coding-agent");
  }
  return piCodingAgentCache;
}

/** F20260804hcob: 从 message_end 事件提取 assistant 文本块（与 agent-invoker 的提取逻辑同构；user/toolResult 不计） */
export function extractAssistantTextFromMessageEnd(e: AgentEvent): string {
  const inner = (e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
  const msg = inner ?? (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const role = msg?.role as string | undefined;
  const content = msg?.content as Array<Record<string, unknown>> | undefined;
  if (!content || role === "user" || role === "toolResult") return "";
  return content
    .filter(c => c.type === "text")
    .map(c => String(c.text ?? ""))
    .join("\n");
}

/**
 * F20260804hcob: 维护本轮 assistant 文本缓冲（speak 检测"卡片写在 speak 外"用）。
 * 缓冲按 assistant 消息隔离：message_start（role=assistant）清零，message_end 追加——
 * 检测范围收窄到"本条消息"，避免上一轮文本里的 stray 围栏误拒后续无卡 speak（甚至 livelock）。
 */
export function updateTurnText(turnText: { text: string }, e: AgentEvent): void {
  if (e.type === "message_start") {
    const msg = (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (msg?.role === "assistant") turnText.text = "";
    return;
  }
  if (e.type === "message_end") {
    const text = extractAssistantTextFromMessageEnd(e);
    if (text) turnText.text += (turnText.text ? "\n" : "") + text;
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
 * S1（R20260810piab）：per-invoke 上下文，通过 AsyncLocalStorage 传递给 extension handler。
 *
 * extension factory 在 reload 时注册 handler（闭包固定），handler 在 prompt() 时执行。
 * 把 createAgentSession + prompt 全程包在 otterInvokeStorage.run() 内，handler 即可从
 * store 读到当前 otter 的 prompt config + 身份前缀，注入到 system role。
 * AsyncLocalStorage 按 async 调用链隔离，多 otter 并发 invoke 无竞态。
 */
export interface OtterInvokeContext {
  /** otterConfig.systemPrompt（string 或 OtterPromptConfig 含 reminders） */
  otterPromptConfig: string | OtterPromptConfig | undefined;
  /** 首次 invoke 的身份前缀（名称/ID/类型/身份文案/模型指南/搭档名）；非首次为空串 */
  identityPrefix: string;
}
export const otterInvokeStorage = new AsyncLocalStorage<OtterInvokeContext>();

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

export class PiSessionFactory implements AgentGateway {
  private readonly sessionStore: AgentSessionStore;
  private readonly activeSessions = new Map<string, { abort: () => Promise<void>; toolCallCount: number; guardAbortReason?: string }>();
  private readonly circuitBreakerConfig: CircuitBreakerConfig;
  private readonly lockManager: SimpleLockManager;
  private readonly sessionRestore: SessionRestore;
  /** 大獭/小獭身份文案（首次 invoke 时注入，从 identityPromptDir 加载） */
  private bigOtterIdentity = "";
  private smallOtterIdentity = "";
  private piCodingAgent: PiCodingAgentModule | null = null;
  private resourceLoader: ResourceLoader | null = null;
  /** SDK SettingsManager（M2: retry maxRetries=4 取代 otter 层 API error 重试） */
  private settingsManager: SettingsManager | null = null;
  /** 待注入身份的 otter（create/reset 后标记，注入成功才消费；进程重启丢失由 createdNew 兜底。已知边界：首次注入被 abort 时重试会重复注入一次，罕见无害，有意不处理） */
  private readonly pendingIdentity = new Set<string>();
  /** pi-coding-agent ModelRuntime（S3: 用 SDK 完整类型替代最小接口） */
  private modelRuntime: ModelRuntime | null = null;
  private otterToolClient: OtterToolClient | null;

  constructor(
    private readonly cfg: {
      db: Database.Database;
      sessionDir: string;
      otterToolClient: OtterToolClient | null;
      model: Model<Api>;
      modelPool?: ModelPool;
      identityPromptDir?: string;
      createTools: (ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger) => AgentTool[];
      healingRepo?: HealingEventRepository;
      resourceLoader?: ResourceLoader;
      otterConfigProvider: OtterConfigProvider;
      otterRepo: OtterRepository;
      settingsRepo?: SettingsRepository;
    },
    private readonly logger: Logger,
  ) {
    this.otterToolClient = cfg.otterToolClient;
    this.sessionStore = createAgentSessionStore(cfg.db);
    this.sessionRestore = new SessionRestore(this.sessionStore, cfg.otterConfigProvider, logger, cfg.db);
    if (cfg.identityPromptDir) {
      this.bigOtterIdentity = loadPromptFile(`${cfg.identityPromptDir}/BIG_OTTER.md`) ?? "";
      this.smallOtterIdentity = loadPromptFile(`${cfg.identityPromptDir}/SMALL_OTTER.md`) ?? "";
      if (!this.bigOtterIdentity || !this.smallOtterIdentity) {
        this.logger.warn('Otter 身份文案缺失，身份注入降级为仅名称/类型', {
          dir: cfg.identityPromptDir,
          bigOtterLoaded: Boolean(this.bigOtterIdentity),
          smallOtterLoaded: Boolean(this.smallOtterIdentity),
        });
      }
    } else {
      this.logger.warn('未配置 identityPromptDir，身份注入降级为仅名称/类型');
    }
    this.circuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...getConfig().circuitBreaker,
    };
    this.lockManager = new SimpleLockManager();
  }

  /** 注入 OtterToolClient（解决 Composition Root 循环依赖） */
  setOtterToolClient(client: OtterToolClient): void {
    this.otterToolClient = client;
  }

  /** 预加载 pi-coding-agent SDK + ResourceLoader + ModelRuntime，避免首次对话冷启动阻塞 */
  async warmup(): Promise<void> {
    await this.ensurePiCodingAgent();
    this.logger.info("PiSessionFactory warmup completed");
  }

  /** 懒加载 pi-coding-agent（ESM-only）+ ResourceLoader（skill 发现）+ ModelRuntime（API key） */
  private async ensurePiCodingAgent(): Promise<PiCodingAgentModule> {
    if (!this.piCodingAgent) {
      /** 先走完全部初始化再缓存：中途抛错（如 registerProvider 失败）不得留下
       *  半初始化的缓存态，否则后续调用直接命中缓存、provider 注册永久缺失直到重启 */
      const piCodingAgent = await loadPiCodingAgent();

      /** 创建 ResourceLoader：通过 SDK 原生协议注入 skills（替代手动拼接） */
      if (!this.resourceLoader) {
        const { DefaultResourceLoader, getAgentDir } = piCodingAgent;
        this.resourceLoader = this.cfg.resourceLoader ?? new DefaultResourceLoader({
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
            },
          }],
        });
        await this.resourceLoader.reload();
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
      if (this.cfg.modelPool) {
        for (const entry of this.cfg.modelPool.getAllEntries()) {
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

  /** create() 外部版本（带锁） */
  async create(otterId: string, config: AgentConfig): Promise<void> {
    const release = await this.lockManager.acquire(`session:${otterId}`);
    try {
      await this._createSessionAndPersist(otterId, config, false);
      /** 新獭的 session 上下文中没有身份内容，标记首次 invoke 注入 */
      this.pendingIdentity.add(otterId);
    } finally {
      release();
    }
  }

  /**
   * 创建 session 并持久化（内部方法，不带锁）。
   * @param allowOverwrite 是否允许覆盖已有记录（用于迁移场景）
   */
  private _createSessionAndPersist(otterId: string, config: AgentConfig, allowOverwrite: boolean): void {
    if (!this.piCodingAgent) {
      throw new Error("piCodingAgent not loaded. Call ensurePiCodingAgent() first.");
    }
    /** 首次 invoke 时注入身份到 user message，后续 invoke 从 session 历史恢复 */
    this.sessionRestore.createSessionAndPersist(otterId, {
      systemPrompt: config.systemPrompt,
      otterType: (config.context?.otterType as OtterType) ?? 'big',
      modelAlias: config.modelAlias,
    }, this.piCodingAgent, this.cfg.sessionDir, allowOverwrite);
  }

  async destroy(otterId: string): Promise<void> {
    const release = await this.lockManager.acquire(`session:${otterId}`);
    try {
      await this._destroyInternal(otterId);
    } finally {
      release();
    }
  }

  private async _destroyInternal(otterId: string): Promise<void> {
    // 中止所有相关的活跃 session（先复制 key 列表，避免迭代时修改 Map）
    const prefix = `${otterId}:`;
    for (const key of [...this.activeSessions.keys()].filter(k => k === otterId || k.startsWith(prefix))) {
      const entry = this.activeSessions.get(key);
      if (entry) { try { await entry.abort(); } catch { /* abort 失败不阻塞销毁 */ } this.activeSessions.delete(key); }
    }
    // 删除持久化数据（不删除 session 文件，保留用于审计）
    this.cfg.db.transaction(() => { this.sessionStore.delete(otterId); this.cfg.otterConfigProvider.deleteConfig(otterId); })();
    this.pendingIdentity.delete(otterId);
  }

  async reset(otterId: string, context?: AgentContext): Promise<void> {
    const release = await this.lockManager.acquire(`session:${otterId}`);
    try {
      await this._resetInternal(otterId, context);
    } finally {
      release();
    }
  }

  private async _resetInternal(otterId: string, context?: AgentContext): Promise<void> {
    const stored = this.sessionStore.getWithFile(otterId);
    const oldSessionFile = stored?.sessionFile;

    // 1. 确保 piCodingAgent 已加载
    await this.ensurePiCodingAgent();

    // 2. 创建新 SessionManager（chain，引用旧 session 作为 parent）
    // parentSession 仅是血缘元数据（SDK 只写 header，不拷贝父消息进上下文），故新 session 上下文为空，需步骤 7 标记重注入
    const SessionManagerClass = getSessionManagerClass(this.piCodingAgent!);
    const sessionManager = SessionManagerClass.create(process.cwd(), this.cfg.sessionDir, {
      ...(stored?.piSessionId && { parentSession: stored.piSessionId }),
    });

    // 3. 获取 sessionId 和 sessionFile
    const sessionId = sessionManager.getSessionId();
    const sessionFile = sessionManager.getSessionFile();

    // 4. 验证
    if (!sessionId || !sessionFile) {
      throw new Error('Failed to create session: missing sessionId or sessionFile');
    }

    // 5. 使用事务更新持久化数据
    // 注意：SessionManager.create() 使用延迟写入，文件在第一条 assistant 消息后才落盘
    try {
      this.cfg.db.transaction(() => {
        // 使用 setWithFile，SQLite 的 ON CONFLICT 会自动处理 upsert
        this.sessionStore.setWithFile(otterId, sessionId, sessionFile);

        // 可选更新配置
        if (context?.systemPrompt) {
          const existingConfig = this.cfg.otterConfigProvider.getConfig(otterId);
          this.cfg.otterConfigProvider.setConfig(otterId, {
            systemPrompt: context.systemPrompt,
            otterType: existingConfig?.otterType ?? 'big',
            modelAlias: existingConfig?.modelAlias, // 保留 modelAlias
          });
        }
      })();
    } catch (err) {
      // 事务失败时清理已创建的 session 文件
      try {
        fs.unlinkSync(sessionFile);
      } catch {
        // 清理失败不阻塞错误抛出
      }
      throw err;
    }

    // 6. 保留旧 session 文件（F20260805rsto：与 destroy() 的审计策略统一）。
    // domain 账本行说「封存」，证据文件就不能删——且新 session header 的 parentSession
    // 血缘指针指向旧文件，删了就是悬空指针。旧文件不再被引用，仅作审计留档。
    if (oldSessionFile && oldSessionFile !== sessionFile) {
      this.logger.debug(`Previous session file retained for audit: ${oldSessionFile}`);
    }

    // 7. 标记下次 invoke 重新注入身份（新 session 上下文中没有身份内容）
    this.pendingIdentity.add(otterId);
  }

  /** invoke() 外部版本（带锁） */
  async invoke(
    otterId: string,
    message: string,
    options?: InvokeOptions,
  ): Promise<AgentRunResult> {
    const release = await this.lockManager.acquire(`session:${otterId}`);
    try {
      return await this._invokeInternal(otterId, message, options);
    } finally {
      release();
    }
  }

  /** invoke() 内部版本（不带锁） */
  private async _invokeInternal(
    otterId: string,
    message: string,
    options: InvokeOptions | undefined,
  ): Promise<AgentRunResult> {
    // 前置校验
    if (this.otterToolClient == null) {
      throw new Error("OtterToolClient not injected. Call setOtterToolClient() before invoke().");
    }

    // 1. 恢复或创建 session（文件丢失/损坏时会重建全新 session，见 createdNew）
    this.logger.debug('[invoke] Restoring session', { otterId });
    const { sessionManager, createdNew } = await this._restoreOrCreateSession(otterId);
    this.logger.debug('[invoke] Session restored', { otterId, createdNew });

    // 2. 从数据库加载配置
    const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
    if (!otterConfig) {
      throw new Error(`Otter config not found: ${otterId}. Call create() first.`);
    }

    // 3. 判定身份注入：新建/重建/重置后的 session 上下文中没有身份内容
    const needsIdentity = createdNew || this.pendingIdentity.has(otterId);

    // 4. 创建 AgentSession 并执行（不修改原始 options 对象；options 缺省时也要保证身份注入标志传递）
    this.logger.debug('[invoke] Executing with session', { otterId, needsIdentity });
    const invokeOptions = { ...options, isFirstInvoke: needsIdentity } as InvokeOptions;
    const result = await this._executeWithSession(otterId, message, invokeOptions, sessionManager, otterConfig);
    this.logger.debug('[invoke] Execution complete', { otterId });

    // 5. 注入成功后才消费标记（invoke 失败时保留，下次重试仍会注入）
    this.pendingIdentity.delete(otterId);
    /** F20260814mtrc：session 重建事实随结果透传（metrics 用） */
    if (createdNew) result.sessionRebuilt = true;
    return result;
  }

  /** 恢复或创建 session；createdNew 表示本次重建了全新 session（需要重新注入身份） */
  private async _restoreOrCreateSession(
    otterId: string,
  ): Promise<{ sessionManager: SessionManager; createdNew: boolean }> {
    await this.ensurePiCodingAgent();
    const result = await this.sessionRestore.restoreOrCreate(otterId, this.piCodingAgent!, this.cfg.sessionDir);
    if (!result.sessionManager) {
      throw new Error(`Failed to restore or create session for otter: ${otterId}`);
    }
    return { sessionManager: result.sessionManager, createdNew: result.createdNew };
  }

  /** S1（R20260810piab）：构建首次 invoke 的身份前缀：名称/ID/类型 + 按类型加载的身份文案。类型以 otterConfig 为准（与工具门控同一事实源） */
  private async buildIdentityPrefix(otterId: string, otterType: string, conversationId: string): Promise<string> {
    const otter = await this.cfg.otterRepo.getById(otterId);
    if (!otter) {
      this.logger.warn('身份注入跳过：otters 表中不存在该记录', { otterId });
      return "";
    }
    /** 未知类型按小獭处理（文案侧的保守默认；schema 约束下不可达，工具门控独立判定） */
    const isBig = otterType === 'big';
    const identityBody = isBig ? this.bigOtterIdentity : this.smallOtterIdentity;

    // 大獭且多模型时注入模型选择指南
    const modelGuidance = isBig ? this.buildModelSelectionGuidance() : '';

    // 用户身份段：告诉海獭搭档叫什么名字
    const rawName = this.cfg.settingsRepo ? ((await this.cfg.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || undefined) : undefined;
    const userName = rawName?.replace(/[\r\n]/g, '');
    const userIdentity = userName ? `## 你的搭档\n- 名字：${userName}\n- 称呼：搭档（你可以用名字称呼 ta）` : '';

    // F20260810rout: 小獭注入召唤者身份（修复行动权路由 bug——子獭需知道召唤者是谁，结论才能交回）
    const summonerIdentity = isBig ? '' : await this.buildSummonerIdentity(otter);

    return [
      `## 你的身份\n- 名称：${otter.name}\n- 名号：${otter.name}\n- ID：${otterId}\n- 类型：${isBig ? '大獭' : '小獭'}${conversationId ? `\n- 当前对话 ID：${conversationId}（创建特性文档时写入 frontmatter 的 created_in_conversation 字段）` : ''}`,
      userIdentity,
      summonerIdentity,
      identityBody,
      modelGuidance,
    ].filter(Boolean).join("\n\n");
  }

  /** F20260810rout: 构建召唤者身份段（小獭专用）——子獭需知道召唤者是谁，行动权才能交回 */
  private async buildSummonerIdentity(otter: { parentOtterId: string | null }): Promise<string> {
    if (!otter.parentOtterId) return '';
    const parentOtter = await this.cfg.otterRepo.getById(otter.parentOtterId);
    if (!parentOtter) return '';
    return [
      '## 你的召唤者',
      `- 召唤你的海獭：${parentOtter.name}（本次任务的主导者）`,
      `- **子任务完成后，行动权默认交回 ${parentOtter.name} 处置，不要传 'user'**`,
      `- 只有整个协作任务真正完成、需要搭档（用户）拍板时，才传 'user'`,
    ].join('\n');
  }

  /** 构建模型选择指南（注入大獭 prompt） */
  private buildModelSelectionGuidance(): string {
    if (!this.cfg.modelPool) return "";
    const models = this.cfg.modelPool.describeModels();
    if (models.length <= 1) return "";

    const lines = models.map(m => {
      const strengths = m.strengths?.length ? `优势: ${m.strengths.join("、")}` : "";
      const weaknesses = m.weaknesses?.length ? `劣势: ${m.weaknesses.join("、")}` : "";
      const details = [strengths, weaknesses].filter(Boolean).join("；");
      return `- **${m.alias}**：${m.description ?? "无描述"}${details ? `\n  ${details}` : ""}`;
    });

    return [
      "",
      "## 可用模型",
      "",
      ...lines,
      "",
      "创建小獭时可通过 `modelAlias` 参数选择模型。不指定则使用默认模型。",
      "只在任务有明确的模型适配需求时才选择，大多数情况下默认模型即可。",
    ].join("\n");
  }

  /** 获取 otter 的模型别名（用于日志） */
  private getModelAliasForLog(otterId: string): string {
    if (!this.cfg.modelPool) return 'default';
    const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
    return otterConfig?.modelAlias ?? this.cfg.modelPool.getDefaultAlias();
  }

  /** 使用 session 执行 invoke */
  private async _executeWithSession(
    otterId: string,
    message: string,
    options: InvokeOptions | undefined,
    sessionManager: SessionManager,
    otterConfig: { systemPrompt?: string | OtterPromptConfig; otterType: string },
  ): Promise<AgentRunResult> {
    const otterType = otterConfig.otterType; const otterPromptConfig = otterConfig.systemPrompt;

    // S1（R20260810piab）：身份前缀在 ALS scope 外构建（含 DB 查询）。
    // 对抗检视修正：system prompt 不被 session history 持久化，每次 invoke 重建 session 时
    // system role 是空的。身份信息必须每次都注入，否则 invoke 2+ 起的 LLM 不知道自己的身份。
    // （旧代码拼在 user message 里被持久化，但 system role 方案不持久化——改为每次都构建）
    const conversationId = options?.conversationId ?? "";
    const identityPrefix = await this.buildIdentityPrefix(otterId, otterType, conversationId);

    // S1：整个 createAgentSession + prompt 包在 ALS scope 内，
    // extension 的 before_agent_start handler 从 store 读 otterPromptConfig + identityPrefix。
    return await otterInvokeStorage.run(
      { otterPromptConfig, identityPrefix },
      // eslint-disable-next-line max-statements -- F20260815rstrt pendingRestart 检查增加语句数
      async () => {
        // 1. 构建工具配置并创建 AgentSession
        this.logger.debug('[execute] Creating session with tools', { otterId });
        /** F20260804hcob: 当前 assistant 消息的文本缓冲（按消息清零/累积），speak 检测"卡片写在 speak 外"用 */
        const turnText = { text: "" };
        const { session, sessionKey, toolContext } = await this._createSessionWithTools(otterId, otterType, options, sessionManager, turnText);
        this.logger.debug('[execute] Session created', { otterId, sessionKey });

        // 2. 熔断器 + 输出退化检测
        const { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard, armFirstByte } = this._attachGuards(session, sessionKey, otterId);

        // 3. 构建用户消息（dynamicContext 仍拼在 user message；system prompt 由 extension handler 注入 system role）
        const fullMessage = buildMessageWithContext("", message, options?.dynamicContext);
        this.logger.info('LLM request', { otterId, conversationId: options?.conversationId, modelAlias: this.getModelAliasForLog(otterId), messageLength: fullMessage.length, messagePreview: fullMessage.substring(0, 300) });

        const unsubscribe = session.subscribe(this.createEventHandler(activeEntry, options?.onEvent, turnText));
        try {
          /** F20260804dglp：prompt 前 arm 首字节超时（覆盖排队+prefill 静默，此前区间无任何兜底） */
          armFirstByte();
          await session.prompt(fullMessage);
          this._checkSessionError(session, otterId);
          const result = this._buildPromptResult(otterId, session, circuitBreaker, outputGuard, activeEntry);

          // F20260815rstrt: session.prompt() 完成后检查自重启。
          // Why 在 try 内、return 前：finally 的 dispose 清理当前 session，restart 创建新 session。
          // Why await：fire-and-forget 会导致 restart 失败时 summary 丢失，语义不完整。
          if (toolContext.pendingRestart) {
            try {
              const newSession = await this.otterToolClient!.otter.restart(otterId, toolContext.pendingRestart.summary);
              this.logger.info('Self-restart completed after invoke', { otterId, newSessionId: newSession.id });
            } catch (restartErr) {
              this.logger.error('Self-restart failed after invoke', restartErr as Error, { otterId });
            }
          }
          return result;
        } catch (err) {
          const e = err as Error & { _toolCallCount?: number; _guardAbortReason?: string; _outputGuardMetadata?: unknown };
          e._toolCallCount = this.activeSessions.get(sessionKey)?.toolCallCount ?? 0;
          e._guardAbortReason = activeEntry?.guardAbortReason;
          /** F20260814mtrc：guard abort 路径的首字节样本不随 abort 丢弃（超时样本恰是最关心的） */
          e._outputGuardMetadata = outputGuard.getMetadata();
          throw err;
        } finally {
          unregisterToolCall?.(); cleanupOutputGuard(); unsubscribe();
          this.activeSessions.delete(sessionKey);
          session.dispose();
        }
      },
    );
  }

  /** 检查 session 是否记录了 LLM API 错误（SDK 自动重试后可能返回空响应而不抛异常） */
  private _checkSessionError(session: { state: { errorMessage?: string } }, otterId: string): void {
    const errorMessage = session.state.errorMessage;
    if (errorMessage) {
      this.logger.error('LLM API error detected after prompt', undefined, { otterId, errorMessage });
      throw new Error(`LLM API error: ${errorMessage}`);
    }
  }

  /** prompt 成功后的结果组装 + 首字节延迟埋点日志（F20260804dglp） */
  private _buildPromptResult(
    otterId: string,
    session: SessionStatsSource,
    circuitBreaker: ToolCallCircuitBreaker,
    outputGuard: { getMetadata: () => { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number } },
    activeEntry: { guardAbortReason?: string } | undefined,
  ): AgentRunResult {
    const result = this._buildInvokeResult(otterId, session, circuitBreaker);
    const guardMeta = outputGuard.getMetadata();
    result.outputGuardMetadata = guardMeta;
    if (guardMeta.firstByteLatencyMs !== undefined) {
      this.logger.info('LLM first-byte latency', { otterId, firstByteLatencyMs: guardMeta.firstByteLatencyMs });
    }
    if (activeEntry?.guardAbortReason) (result as unknown as Record<string, unknown>)._guardAbortReason = activeEntry.guardAbortReason;
    return result;
  }

  /** 创建带工具配置的 AgentSession */
  private async _createSessionWithTools(otterId: string, otterType: string, options: InvokeOptions | undefined, sessionManager: SessionManager, turnText?: { text: string }) {
    const conversationId = options?.conversationId ?? "";
    const messageId = options?.messageId;
    const otterToolNames = getOtterToolNamesForType(otterType);
    const { tools: customTools, toolContext } = this.buildCustomTools(otterId, conversationId, otterToolNames, messageId, turnText);
    const codingTools = getCodingToolsForOtterType(otterType);

    // 解析模型：多模型模式下按 otterConfig.modelAlias 获取，否则用默认模型
    let resolvedModel = this.cfg.model;
    let resolvedAlias = 'default';
    if (this.cfg.modelPool) {
      const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
      const modelAlias = otterConfig?.modelAlias;
      resolvedModel = this.cfg.modelPool.getModel(modelAlias);
      resolvedAlias = modelAlias ?? this.cfg.modelPool.getDefaultAlias();
    }

    this.logger.info('Tools registered for agent session', {
      otterId, otterType, modelAlias: resolvedAlias,
      codingTools,
      customToolNames: customTools.map(t => t.name),
      whitelist: [...codingTools, ...customTools.map(t => t.name)],
    });

    const piCodingAgent = this.piCodingAgent!;
    this.logger.debug('[createSession] Calling createAgentSession', { otterId, modelAlias: resolvedAlias });
    const { session } = await piCodingAgent.createAgentSession({
      model: resolvedModel,
      sessionManager,
      tools: [...codingTools, ...customTools.map(t => t.name)],
      customTools,
      resourceLoader: this.resourceLoader ?? undefined,
      modelRuntime: this.modelRuntime ?? undefined,
      settingsManager: this.settingsManager ?? undefined,
    });
    this.logger.debug('[createSession] createAgentSession returned', { otterId });

    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    this.activeSessions.set(sessionKey, { abort: () => session.abort(), toolCallCount: 0 });

    return { session, sessionKey, toolContext };
  }

  /** 构建 invoke 结果 */
  private _buildInvokeResult(
    otterId: string,
    session: SessionStatsSource,
    circuitBreaker: ToolCallCircuitBreaker,
  ): AgentRunResult {
    const stats = session.getSessionStats();
    const tokenUsage = { input: stats.tokens.input, output: stats.tokens.output };

    /** F20260808ctxw：上下文窗口占用 = 末次有效 assistant 消息的 usage（input+output+cacheRead+cacheWrite），
     * 与 SDK compaction 判定同公式、同 compaction 边界语义；session 重建/compaction 后自然回落，不会虚增 */
    const ctxTokens = getContextWindowTokens(session.sessionManager.getBranch());
    checkTokenWarning(otterId, ctxTokens, this.logger);

    // per-otter contextWindow
    let ctxMax: number | undefined;
    if (this.cfg.modelPool) {
      const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
      ctxMax = this.cfg.modelPool.getContextWindow(otterConfig?.modelAlias);
    } else {
      ctxMax = this.cfg.model.contextWindow;
    }
    const result: AgentRunResult = buildResult("", tokenUsage, circuitBreaker, ctxMax, ctxTokens);
    /** F20260814mtrc：模型别名随结果透传（metrics model label 数据源） */
    result.modelAlias = this.getModelAliasForLog(otterId);
    return result;
  }
  private _attachGuards(session: { subscribe: (fn: (event: unknown) => void) => () => void; abort: () => Promise<void> }, sessionKey: string, otterId: string) {
    const activeEntry = this.activeSessions.get(sessionKey);
    const timerRef: { clear: (toolCallId?: string) => void } = { clear: () => {} };
    const wrappedAbort = (reason?: string) => { timerRef.clear(); if (activeEntry && !activeEntry.guardAbortReason) activeEntry.guardAbortReason = reason ?? "internal_abort"; return session.abort(); };
    const { circuitBreaker, unregisterToolCall, clearEventTimer } = attachCircuitBreaker(session, otterId, this.circuitBreakerConfig, this.logger, wrappedAbort);
    timerRef.clear = clearEventTimer;
    /** F20260804dglp：outputGuard 配置含 detector 参数与首字节超时；显式过滤 undefined 防覆盖默认值 */
    const cb = getConfig().circuitBreaker;
    const cfg: Partial<OutputGuardConfig> = {
      ...cb?.outputGuard,
      ...(cb?.streamingTimeoutMs !== undefined && { streamingTimeoutMs: cb.streamingTimeoutMs }),
      ...(cb?.firstByteTimeoutMs !== undefined && { firstByteTimeoutMs: cb.firstByteTimeoutMs }),
    };
    /** abort 返回 Promise：fire 路径无人 await，catch 防 unhandledRejection */
    const guardAbort = () => {
      void wrappedAbort(outputGuard.getMetadata().reason).catch((err: unknown) => {
        this.logger.warn(`[output-guard] abort 调用失败 otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    const { guard: outputGuard, cleanup: cleanupOutputGuard } = attachOutputGuard(session, otterId, cfg, this.logger, guardAbort);
    const armFirstByte = () => outputGuard.armFirstByteTimer(guardAbort);
    return { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard, armFirstByte };
  }
  /** 中断指定 Otter 的 Agent 生成 */
  abort(otterId: string, messageId?: string): void {
    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    const entry = this.activeSessions.get(sessionKey) ?? this.activeSessions.get(otterId);
    if (entry) {
      entry.abort();
    }
  }

  /** 获取指定 Otter 当前 session 的工具调用次数（abort body 构造用） */
  getToolCallCount(otterId: string, messageId?: string): number {
    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    return (this.activeSessions.get(sessionKey) ?? this.activeSessions.get(otterId))?.toolCallCount ?? 0;
  }

  getInternalAbortReason(messageId: string): string | undefined { const s = `:${messageId}`; for (const [k, e] of this.activeSessions) { if (e.guardAbortReason && k.endsWith(s) && k.length > s.length) { const r = e.guardAbortReason; e.guardAbortReason = undefined; return r; } } return undefined; }

  /** 创建 session 事件处理器：跟踪工具调用 + 累积本轮 assistant 文本 + 转发事件到 onEvent 回调 */
  private createEventHandler(
    activeEntry: { abort: () => void; toolCallCount: number } | undefined,
    onEvent?: (event: AgentEvent) => void,
    turnText?: { text: string },
  ): (event: unknown) => void {
    return (event: unknown) => {
      const e = event as AgentEvent;
      if (e.type === "tool_execution_start" && activeEntry) {
        activeEntry.toolCallCount++;
      }
      /** F20260804hcob: message_start/end 维护本轮文本缓冲（message_end 先于本消息的工具执行触发） */
      if (turnText) updateTurnText(turnText, e);
      if (e.type !== "message_update") {
        onEvent?.(e);
      }
    };
  }

  /**
   * 将 Otter 工具适配为 pi-coding-agent ToolDefinition 格式。
   * 适配点：label 字段 + execute 透传 signal（M1: 用户中断时工具可检查 signal.aborted 提前返回）。
   * onUpdate/ctx SDK 特有，Otter 工具不需要，忽略。
   */
  private buildCustomTools(
    otterId: string,
    conversationId: string,
    allowedNames: string[],
    messageId?: string,
    turnText?: { text: string },
  ): {
    tools: Array<{
      name: string;
      label: string;
      description: string;
      parameters: Record<string, unknown>;
      execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResponse>;
    }>;
    toolContext: ToolContext;
  } {
    // F20260815rstrt: 返回 toolContext 引用，供 PiSessionFactory 检查 pendingRestart
    const toolContext: ToolContext = {
      client: this.otterToolClient!,
      otterId,
      conversationId,
      currentMessageId: messageId ?? "",
      modelPool: this.cfg.modelPool,
      getTurnAssistantText: turnText ? () => turnText.text : undefined,
      /** F20260813actk C9：每次 invoke 新建待派工票据 Map（agent turn 级生命周期） */
      pendingDispatches: new Map<string, string>(),
      dispatchWarningShown: false,
    };
    const otterTools = this.cfg.createTools(toolContext, this.cfg.healingRepo, this.logger);

    const tools = otterTools
      .filter(t => allowedNames.includes(t.name))
      .map(t => ({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: t.parameters,
        execute: async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
          const result = await t.execute(toolCallId, params, signal);
          const truncated = truncateToolResult(result);
          /**
           * F20260811sktp: otter ToolResponse.isError → SDK details.__isError 透传。
           * SDK 的 AgentToolResult 不消费顶层 isError 字段；otter-hooks 的 tool_result handler
           * 读 details.__isError 返回 { isError: true } 覆盖 SDK 标志，透传到 Anthropic API。
           */
          if (result.isError) {
            truncated.details = { ...truncated.details, __isError: true };
          }
          return truncated;
        },
      }));

    return { tools, toolContext };
  }


}

/**
 * 初始化 Agent Session 工厂。
 * 异步工厂：pi-coding-agent 是 ESM-only，需通过动态 import() 加载。
 */
export async function initAgentSessionFactory(config: AgentSessionFactoryConfig, logger: Logger): Promise<PiSessionFactory> {
  return new PiSessionFactory({
    db: config.db,
    sessionDir: config.sessionDir ?? "./data/sessions",
    otterToolClient: config.otterToolClient,
    model: config.model,
    modelPool: config.modelPool,
    identityPromptDir: config.identityPromptDir,
    createTools: config.createTools,
    healingRepo: config.healingRepo,
    otterConfigProvider: config.otterConfigProvider,
    otterRepo: config.otterRepo,
    settingsRepo: config.settingsRepo,
  }, logger);
}
