/**
 * PiSessionFactory：基于 pi-coding-agent SDK（createAgentSession）的 AgentGateway 实现。
 *
 * 设计要点：
 * - 冷启动模型（R17）：每次发言创建 session，完成后释放
 * - tools 配置控制编码工具启用，customTools 注入 Otter 工具
 * - 系统提示作为消息前缀注入（SDK 的 _systemPromptOverride 为 private，无公开 setter）
 * - 熔断器通过 session.subscribe 拦截 tool_execution_start 事件
 *
 * F20260716sq6e §13 T2: 薄封装 createAgentSession()
 */

import type Database from "better-sqlite3";
import type {
  AgentConfig,
  AgentContext,
  AgentGateway,
} from "@usecases/otter/agent-gateway";
import type { OtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client";
import type { AgentTool, ToolContext } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAgentSessionStore } from "./agent-session-store";
import type { AgentSessionStore } from "./agent-session-store";
import type { DynamicContext } from "@interface-adapters/agent-runtime/agent-invoke-port";
import { ToolCallCircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "./tool-call-circuit-breaker";
import { config as appConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import type { OtterPromptConfig } from "@contract/api/otter";
import { loadPlatformPromptFile } from "./platform-prompt-loader";

/** Agent 事件（流式推送，与 AgentStreamEvent 兼容） */
export interface AgentEvent {
  type: string;
  delta?: string;
  [key: string]: unknown;
}

/** Agent 执行结果 */
export interface AgentRunResult {
  text: string;
  tokenUsage?: { input: number; output: number };
  ctxMax?: number;
  circuitBreakerMetadata?: { totalCalls: number; circuitReason?: string };
}

/** invoke() 选项 */
export interface InvokeOptions {
  dynamicContext?: DynamicContext;
  onEvent?: (event: AgentEvent) => void;
  conversationId: string;
  /** 当前 streaming 消息 ID（speak 工具需要） */
  messageId?: string;
}

/** initAgentSessionFactory 配置 */
export interface AgentSessionFactoryConfig {
  db: Database.Database;
  sessionDir?: string;
  otterToolClient: OtterToolClient;
  /** pi-ai Model 对象（由 models-factory 创建） */
  model: unknown;
  /** 平台级 system prompt 文件路径 */
  platformPromptFile?: string;
  /** 工具工厂函数（由 Composition Root 注入，解耦 interface-adapters） */
  createTools: (ctx: ToolContext) => AgentTool[];
}

/** pi-coding-agent 模块类型（动态加载） */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

/** SessionManager 类型（从 pi-coding-agent 导入） */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Token 阈值（超过则记录警告，与旧实现一致） */
const TOKEN_WARNING_THRESHOLD = 100_000;

let piCodingAgentCache: PiCodingAgentModule | null = null;

async function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  if (!piCodingAgentCache) {
    piCodingAgentCache = await import("@earendil-works/pi-coding-agent");
  }
  return piCodingAgentCache;
}

/**
 * 按 otterType 获取编码工具列表。
 * big otter 启用全部编码工具，small otter 不启用编码工具。
 */
function getCodingToolsForOtterType(otterType: string | undefined): string[] {
  if (!otterType || otterType === "big") {
    return ["read", "write", "edit", "bash"];
  }
  /** small otter 不需要编码工具 */
  return [];
}

/**
 * 按 otterType 获取 Otter 自定义工具名称白名单。
 * big otter 拥有全部工具，small otter 只有消息和记忆相关工具。
 */
function getOtterToolNamesForType(otterType: string | undefined): string[] {
  const allToolNames = [
    "speak", "pass_talking_stone", "search_memory",
    "create_otter", "dissolve_otter", "create_linked_resource", "get_memory_detail",
    "get_message", "list_messages", "search_messages", "get_turn_history",
    "get_context", "set_context", "delete_context",
    "search_terminology", "add_terminology",
    "list_artifacts", "update_artifact_status",
    "get_active_participants",
  ];

  if (!otterType || otterType === "big") {
    return allToolNames;
  }

  /** small otter：消息检索 + 记忆 + 上下文 + 术语库 + 产物管理 + 参与者查询，不含管理类工具 */
  return [
    "speak", "search_memory", "create_linked_resource", "get_memory_detail",
    "get_message", "list_messages", "search_messages", "get_turn_history",
    "get_context", "set_context", "delete_context",
    "search_terminology", "add_terminology",
    "list_artifacts", "update_artifact_status",
    "get_active_participants",
  ];
}

export class PiSessionFactory implements AgentGateway {
  private readonly sessionStore: AgentSessionStore;
  private readonly staticPrompts = new Map<string, string | OtterPromptConfig>();
  private readonly otterTypes = new Map<string, string>();
  private readonly activeSessions = new Map<string, { abort: () => Promise<void>; toolCallCount: number }>();
  private readonly circuitBreakerConfig: CircuitBreakerConfig;
  private platformPrompt = "";
  private piCodingAgent: PiCodingAgentModule | null = null;
  private resourceLoader: ResourceLoader | null = null;
  /** pi-coding-agent ModelRuntime 最小接口（SDK ESM-only，无法直接导入类型） */
  private modelRuntime: { setRuntimeApiKey(provider: string, key: string): Promise<void> } | null = null;
  private otterToolClient: OtterToolClient;

  constructor(
    private readonly cfg: {
      db: Database.Database;
      sessionDir: string;
      otterToolClient: OtterToolClient;
      model: unknown;
      platformPromptFile?: string;
      createTools: (ctx: ToolContext) => AgentTool[];
      resourceLoader?: ResourceLoader;
    },
    private readonly logger: Logger,
  ) {
    this.otterToolClient = cfg.otterToolClient;
    this.sessionStore = createAgentSessionStore(cfg.db);
    if (cfg.platformPromptFile) {
      const loaded = loadPlatformPromptFile(cfg.platformPromptFile);
      if (loaded) this.platformPrompt = loaded;
    }
    this.circuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...appConfig.circuitBreaker,
    };
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
      this.piCodingAgent = await loadPiCodingAgent();

      /** 创建 ResourceLoader：通过 SDK 原生协议注入 skills（替代手动拼接） */
      if (!this.resourceLoader) {
        const { DefaultResourceLoader, getAgentDir } = this.piCodingAgent as unknown as {
          DefaultResourceLoader: new (options: unknown) => ResourceLoader;
          getAgentDir: () => string;
        };
        this.resourceLoader = this.cfg.resourceLoader ?? new DefaultResourceLoader({
          cwd: process.cwd(),
          agentDir: getAgentDir(),
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
      const ModelRuntimeClass = (this.piCodingAgent as unknown as { ModelRuntime: { create: (options?: unknown) => Promise<unknown> } }).ModelRuntime;
      this.modelRuntime = await ModelRuntimeClass.create() as { setRuntimeApiKey(provider: string, key: string): Promise<void> };

      const llmConfig = appConfig.llm;
      if (llmConfig.apiKey && this.modelRuntime) {
        await this.modelRuntime.setRuntimeApiKey(llmConfig.provider, llmConfig.apiKey);
        this.logger.info(`Set runtime API key for ${llmConfig.provider}`);
      }
    }
    return this.piCodingAgent;
  }

  async create(otterId: string, config: AgentConfig): Promise<void> {
    if (this.sessionStore.get(otterId)) {
      throw new Error(`Agent already exists for otter: ${otterId}`);
    }

    const piCodingAgent = await this.ensurePiCodingAgent();

    /** 创建 session 并获取 sessionId */
    const sessionManager = this.createSessionManager(piCodingAgent);
    const { session } = await piCodingAgent.createAgentSession({
      model: this.cfg.model as never,
      sessionManager,
      tools: [],
      customTools: [],
      resourceLoader: this.resourceLoader ?? undefined,
      modelRuntime: this.modelRuntime as any,
    });

    const sessionId = session.sessionId;
    session.dispose();

    /** 存储映射 + 静态 prompt + otterType */
    this.sessionStore.set(otterId, sessionId);
    if (config.systemPrompt) {
      this.staticPrompts.set(otterId, config.systemPrompt);
    }

    if (config.context?.otterType) {
      this.otterTypes.set(otterId, config.context.otterType as string);
    }
  }

  async destroy(otterId: string): Promise<void> {
    /** 中止正在运行的 session */
    const activeEntry = this.activeSessions.get(otterId);
    if (activeEntry) {
      try {
        await activeEntry.abort();
      } catch {
        /** abort 失败不阻塞销毁流程 */
      }
      this.activeSessions.delete(otterId);
    }

    /** SessionManager 是 append-only 设计，无 delete API，session 文件保留但不再引用 */
    this.sessionStore.delete(otterId);
    this.staticPrompts.delete(otterId);
    this.otterTypes.delete(otterId);
  }

  async reset(otterId: string, context?: AgentContext): Promise<void> {
    const piCodingAgent = await this.ensurePiCodingAgent();
    const oldSessionId = this.sessionStore.get(otterId);

    /** 创建新 session（chain，引用旧 session 作为 parent） */
    const sessionManager = this.createSessionManager(piCodingAgent, oldSessionId ?? undefined);
    const { session } = await piCodingAgent.createAgentSession({
      model: this.cfg.model as never,
      sessionManager,
      tools: [],
      customTools: [],
      resourceLoader: this.resourceLoader ?? undefined,
      modelRuntime: this.modelRuntime as any,
    });

    /** 更新映射 */
    this.sessionStore.update(otterId, session.sessionId);
    session.dispose();

    /** 可选更新静态 prompt */
    if (context?.systemPrompt) {
      this.staticPrompts.set(otterId, context.systemPrompt);
    }
  }

  /**
   * 冷启动调用（R17）：创建 AgentSession → prompt → 释放。
   * 系统提示作为消息前缀注入（SDK 的 _systemPromptOverride 为 private，无公开 setter）。
   */
  // eslint-disable-next-line max-statements, complexity -- invoke 是冷启动调用的核心方法，步骤间有顺序依赖
  async invoke(
    otterId: string,
    message: string,
    options?: InvokeOptions,
  ): Promise<AgentRunResult> {
    if (!this.otterToolClient) {
      throw new Error("OtterToolClient not injected. Call setOtterToolClient() before invoke().");
    }

    const piSessionId = this.sessionStore.get(otterId);
    if (!piSessionId) {
      throw new Error(`No agent session found for otter: ${otterId}`);
    }

    const conversationId = options?.conversationId ?? "";
    const messageId = options?.messageId;
    const dynamicContext = options?.dynamicContext;

    const piCodingAgent = await this.ensurePiCodingAgent();
    const otterType = this.otterTypes.get(otterId);
    const otterPromptConfig = this.staticPrompts.get(otterId);

    /** 构建 Otter 提示（支持字符串或 OtterPromptConfig） */
    const otterPrompt = this.buildOtterPrompt(otterPromptConfig);

    /** 组装消息前缀：平台 prompt + Otter prompt（Skills 由 SDK ResourceLoader 原生注入） */
    const staticPrompt = [this.platformPrompt, otterPrompt].filter(Boolean).join("\n\n");

    /** 构建 customTools（Otter 自定义工具，适配 ToolDefinition 格式） */
    const otterToolNames = getOtterToolNamesForType(otterType);
    const customTools = this.buildCustomTools(otterId, conversationId, otterToolNames, messageId);

    /** 编码工具列表 */
    const codingTools = getCodingToolsForOtterType(otterType);

    /** 创建 session（冷启动，恢复已有 session 数据） */
    const sessionManager = this.createSessionManager(piCodingAgent, piSessionId);
    const { session } = await piCodingAgent.createAgentSession({
      model: this.cfg.model as never,
      sessionManager,
      /** tools 是 SDK 的工具白名单，必须包含 codingTools + 所有 customTools 名称，
       *  否则 SDK 的 allowedToolNames 过滤器会把 customTools 全部排除。 */
      tools: [...codingTools, ...customTools.map(t => t.name)],
      customTools: customTools as never,
      resourceLoader: this.resourceLoader ?? undefined,
      modelRuntime: this.modelRuntime as any,
    });

    /** 注册活跃 session 引用，支持外部 abort + 工具调用计数 */
    this.activeSessions.set(otterId, { abort: () => session.abort(), toolCallCount: 0 });

    /** 熔断器 */
    const { circuitBreaker, unregisterToolCall } = this.attachCircuitBreaker(session, otterId);

    /** 构建完整消息：系统提示 + 动态上下文 + 用户消息 */
    const fullMessage = this.buildMessageWithContext(staticPrompt, message, dynamicContext);

    const activeEntry = this.activeSessions.get(otterId);
    const unsubscribe = session.subscribe(this.createEventHandler(activeEntry, options?.onEvent));





    try {
      await session.prompt(fullMessage);

      /** speak 工具已直接 complete 消息，invoke() 只返回 tokenUsage 等元数据 */

      /** 从 session stats 恢复 token usage */
      const stats = session.getSessionStats();
      const tokenUsage = { input: stats.tokens.input, output: stats.tokens.output };
      this.checkTokenWarning(otterId, stats.tokens);

      /** token 超阈值警告 */
      const total = stats.tokens.input + stats.tokens.output;
      if (total > TOKEN_WARNING_THRESHOLD) {
        this.logger.warn(`[token-warning] otter=${otterId} total=${total} threshold=${TOKEN_WARNING_THRESHOLD}`);
      }

      const ctxMax = (this.cfg.model as Record<string, unknown>)?.contextWindow as number | undefined;
      return this.buildResult("", tokenUsage, circuitBreaker, ctxMax);
    } catch (err) {
      /** 将 toolCallCount 附着到异常，供 handleInvokeError 在 finally 清理后仍可读取 */
      (err as Error & { _toolCallCount?: number })._toolCallCount =
        this.activeSessions.get(otterId)?.toolCallCount ?? 0;
      throw err;
    } finally {
      circuitBreaker.clearSteerDeadline();
      unregisterToolCall?.();
      unsubscribe();
      this.activeSessions.delete(otterId);
      session.dispose();
    }
  }

  /** 中断指定 Otter 的 Agent 生成 */
  abort(otterId: string): void {
    const entry = this.activeSessions.get(otterId);
    if (entry) {
      entry.abort();
    }
  }

  /** 获取指定 Otter 当前 session 的工具调用次数（abort body 构造用） */
  getToolCallCount(otterId: string): number {
    return this.activeSessions.get(otterId)?.toolCallCount ?? 0;
  }

  /** 创建 session 事件处理器：跟踪工具调用 + 转发事件到 onEvent 回调 */
  private createEventHandler(
    activeEntry: { abort: () => void; toolCallCount: number } | undefined,
    onEvent?: (event: AgentEvent) => void,
  ): (event: unknown) => void {
    return (event: unknown) => {
      const e = event as AgentEvent;
      if (e.type === "tool_execution_start" && activeEntry) {
        activeEntry.toolCallCount++;
      }
      if (e.type !== "message_update") {
        onEvent?.(e);
      }
    };
  }

  /**
   * 将 Otter 工具适配为 pi-coding-agent ToolDefinition 格式。
   * 适配点：label 字段 + execute 签名扩展（signal/onUpdate/ctx）。
   */
  private buildCustomTools(
    otterId: string,
    conversationId: string,
    allowedNames: string[],
    messageId?: string,
  ): Array<{
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    const otterTools = this.cfg.createTools({
      client: this.otterToolClient,
      otterId,
      conversationId,
      currentMessageId: messageId ?? "",
    });

    return otterTools
      .filter(t => allowedNames.includes(t.name))
      .map(t => ({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: t.parameters,
        /** ToolDefinition.execute 有额外参数（signal/onUpdate/ctx），Otter 工具不需要，忽略 */
        execute: async (toolCallId: string, params: Record<string, unknown>) => {
          return t.execute(toolCallId, params);
        },
      }));
  }

  /**
   * 构建 Otter 提示（支持字符串或 OtterPromptConfig）。
   * OtterPromptConfig 包含 systemPrompt 和 reminders，需按优先级排序后拼接。
   */
  private buildOtterPrompt(config: string | OtterPromptConfig | undefined): string {
    if (!config) return "";
    if (typeof config === "string") return config;

    const parts: string[] = [];
    if (config.systemPrompt) {
      parts.push(config.systemPrompt);
    }

    /** System reminders（按优先级排序） */
    if (config.reminders && config.reminders.length > 0) {
      const sorted = [...config.reminders]
        .sort((a, b) => {
          const weightA = a.priority === "high" ? 0 : a.priority === "medium" ? 1 : 2;
          const weightB = b.priority === "high" ? 0 : b.priority === "medium" ? 1 : 2;
          return weightA - weightB;
        });
      for (const reminder of sorted) {
        parts.push(`<system-reminder>\n${reminder.content}\n</system-reminder>`);
      }
    }

    return parts.join("\n\n");
  }

  /**
   * 构建包含系统提示和动态上下文的消息。
   * 系统提示作为用户消息前缀注入（SDK 的 systemPrompt 由 ResourceLoader 内部管理，
   * 无公开 API 覆盖；冷启动模型下 session 无持久 system prompt）。
   */
  private buildMessageWithContext(
    staticPrompt: string,
    message: string,
    dynamicContext?: DynamicContext,
  ): string {
    const parts: string[] = [];

    if (staticPrompt) {
      parts.push(staticPrompt);
    }

    if (dynamicContext?.sessionSummary) {
      parts.push(`## 会话摘要\n${dynamicContext.sessionSummary}`);
    }

    parts.push(message);

    return parts.join("\n\n");
  }

  /** 熔断器 tool_execution_start 钩子 */
  private attachCircuitBreaker(
    session: { subscribe: (fn: (event: unknown) => void) => () => void; steer?: (text: string) => Promise<void>; abort: () => Promise<void> },
    otterId: string,
  ): { circuitBreaker: ToolCallCircuitBreaker; unregisterToolCall: (() => void) | undefined } {
    const circuitBreaker = new ToolCallCircuitBreaker(this.circuitBreakerConfig, otterId, this.logger);

    /** 通过 subscribe 拦截 tool_execution_start 事件实现熔断 */
    const unregisterToolCall = session.subscribe((event: unknown) => {
      const e = event as { type?: string; name?: string };
      if (e.type === "tool_execution_start") {
        const result = circuitBreaker.check(e.name ?? "unknown");
        if (result.action === "terminate") {
          session.abort();
          return;
        }
        if (result.action === "steer") {
          session.steer?.(result.reason ?? "Stop calling tools. Call speak now.");
          circuitBreaker.setSteerDeadline(() => { session.abort(); });
          return;
        }
      }
    });

    return { circuitBreaker, unregisterToolCall };
  }

  /** token 超阈值警告 */
  private checkTokenWarning(otterId: string, tokens: { input: number; output: number }): void {
    const total = tokens.input + tokens.output;
    if (total > TOKEN_WARNING_THRESHOLD) {
      this.logger.warn(`[token-warning] otter=${otterId} total=${total} threshold=${TOKEN_WARNING_THRESHOLD}`);
    }
  }

  /** 构建执行结果（含熔断器元数据） */
  private buildResult(
    text: string,
    tokenUsage?: { input: number; output: number },
    circuitBreaker?: ToolCallCircuitBreaker,
    ctxMax?: number,
  ): AgentRunResult {
    return {
      text,
      tokenUsage: tokenUsage
        ? { input: tokenUsage.input, output: tokenUsage.output }
        : undefined,
      ctxMax,
      circuitBreakerMetadata: circuitBreaker?.getMetadata(),
    };
  }

  /**
   * 创建 SessionManager。
   * 当 existingSessionId 存在时，通过 NewSessionOptions.parentSession 建立 session chain。
   */
  private createSessionManager(
    piCodingAgent: PiCodingAgentModule,
    existingSessionId?: string,
  ): SessionManager {
    const SessionManagerClass = (piCodingAgent as unknown as {
      SessionManager: {
        create: (cwd: string, sessionDir?: string, options?: { parentSession?: string }) => SessionManager;
        inMemory: () => SessionManager;
      };
    }).SessionManager;

    /** 使用文件系统 SessionManager 以支持 session 持久化 */
    return SessionManagerClass.create(process.cwd(), this.cfg.sessionDir, {
      ...(existingSessionId && { parentSession: existingSessionId }),
    });
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
    platformPromptFile: config.platformPromptFile,
    createTools: config.createTools,
  }, logger);
}
