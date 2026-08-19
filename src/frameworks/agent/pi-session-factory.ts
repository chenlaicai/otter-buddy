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
import type Database from "better-sqlite3";
import type {
  AgentConfig,
  AgentContext,
  AgentGateway,
} from "@usecases/otter/agent-gateway";
// R20260817arnt PR-A：以下四项自 interface-adapters 上移 @usecases/ports——消除 frameworks→interface-adapters 倒穿
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import type { Model, Api } from "@earendil-works/pi-ai";
import { createAgentSessionStore } from "./agent-session-store";
import type { AgentSessionStore } from "./agent-session-store";
import type { DynamicContext } from "@usecases/ports/sdk-invoke-port";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "./tool-call-circuit-breaker";
import { getConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider, OtterType } from "@usecases/ports/otter-config-provider";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { getCodingToolsForOtterType, getOtterToolNamesForType, SimpleLockManager, getSessionManagerClass, buildMessageWithContext } from "./session-helpers";
import { attachGuards, checkSessionError, buildPromptResult } from "./circuit-breaker-helpers";
import { SessionRestore } from "./session-restore";
import type { ModelPool } from "@frameworks/llm/model-pool";
import { IdentityBuilder } from "./identity-builder";
import { buildCustomTools } from "./tool-builder";
import { ModelRuntimeRegistry, otterInvokeStorage } from "./model-runtime-registry";
import type { PiCodingAgentModule } from "./model-runtime-registry";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { OtterPromptConfig } from "@contract/api/otter";
import { createEventHandler } from "./agent-event-utils";
import type { AgentEvent } from "./agent-event-utils";

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
  /** F20260819rscn: LLM 调用 restart_otter(self) 时标记，由 agent-invoker 执行 restart + 全新 invoke */
  _selfRestart?: { otterId: string; summary?: string };
}



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

/** SessionManager 类型（从 pi-coding-agent 导入） */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export class PiSessionFactory implements AgentGateway {
  private readonly sessionStore: AgentSessionStore;
  private readonly activeSessions = new Map<string, { abort: () => Promise<void>; toolCallCount: number; guardAbortReason?: string }>();
  private readonly circuitBreakerConfig: CircuitBreakerConfig;
  private readonly lockManager: SimpleLockManager;
  private readonly sessionRestore: SessionRestore;
  private readonly identityBuilder: IdentityBuilder;
  private readonly modelRuntimeRegistry: ModelRuntimeRegistry;
  /** 待注入身份的 otter（create/reset 后标记，注入成功才消费；进程重启丢失由 createdNew 兜底。已知边界：首次注入被 abort 时重试会重复注入一次，罕见无害，有意不处理） */
  private readonly pendingIdentity = new Set<string>();
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
    this.identityBuilder = new IdentityBuilder(cfg.otterRepo, cfg.settingsRepo, cfg.modelPool, logger, cfg.identityPromptDir);
    this.modelRuntimeRegistry = new ModelRuntimeRegistry(cfg.modelPool, logger, cfg.resourceLoader);
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
    await this.modelRuntimeRegistry.warmup();
    this.logger.info("PiSessionFactory warmup completed");
  }

  /** 懒加载 pi-coding-agent（ESM-only）+ ResourceLoader（skill 发现）+ ModelRuntime（API key） */
  private async ensurePiCodingAgent(): Promise<PiCodingAgentModule> {
    return await this.modelRuntimeRegistry.ensurePiCodingAgent();
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
    const piCodingAgent = this.modelRuntimeRegistry.getPiCodingAgent();
    if (!piCodingAgent) {
      throw new Error("piCodingAgent not loaded. Call ensurePiCodingAgent() first.");
    }
    /** 首次 invoke 时注入身份到 user message，后续 invoke 从 session 历史恢复 */
    this.sessionRestore.createSessionAndPersist(otterId, {
      systemPrompt: config.systemPrompt,
      otterType: (config.context?.otterType as OtterType) ?? 'big',
      modelAlias: config.modelAlias,
    }, piCodingAgent, this.cfg.sessionDir, allowOverwrite);
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
    const SessionManagerClass = getSessionManagerClass(this.modelRuntimeRegistry.getPiCodingAgent()!);
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
    const result = await this.sessionRestore.restoreOrCreate(otterId, this.modelRuntimeRegistry.getPiCodingAgent()!, this.cfg.sessionDir);
    if (!result.sessionManager) {
      throw new Error(`Failed to restore or create session for otter: ${otterId}`);
    }
    return { sessionManager: result.sessionManager, createdNew: result.createdNew };
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
    const identityPrefix = await this.identityBuilder.buildIdentityPrefix(otterId, otterType, conversationId);

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
        const { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard, armFirstByte } = attachGuards({ session, sessionKey, otterId, activeSessions: this.activeSessions, circuitBreakerConfig: this.circuitBreakerConfig, logger: this.logger });

        // 3. 构建用户消息（dynamicContext 仍拼在 user message；system prompt 由 extension handler 注入 system role）
        const fullMessage = buildMessageWithContext("", message, options?.dynamicContext);
        this.logger.info('LLM request', { otterId, conversationId: options?.conversationId, modelAlias: this.getModelAliasForLog(otterId), messageLength: fullMessage.length, messagePreview: fullMessage.substring(0, 300) });

        const unsubscribe = session.subscribe(createEventHandler(activeEntry, options?.onEvent, turnText));
        try {
          /** F20260804dglp：prompt 前 arm 首字节超时（覆盖排队+prefill 静默，此前区间无任何兜底） */
          armFirstByte();
          await session.prompt(fullMessage);
          checkSessionError(session, otterId, this.logger);
          const result = buildPromptResult({ otterId, session, circuitBreaker, outputGuard, activeEntry, modelPool: this.cfg.modelPool, otterConfigProvider: this.cfg.otterConfigProvider, model: this.cfg.model, logger: this.logger, getModelAliasForLog: this.getModelAliasForLog.bind(this) });

          // F20260819rscn: session.prompt() 完成后检查自重启。
          // Why 不在此处执行 restart：自重启后需要自动 re-invoke（獭继续工作），
          // 这需要 agent-invoker 层递归调用 invokeConversationInner。
          // Why 在 try 内、return 前：finally 的 dispose 清理当前 session，
          // 信号必须在 session 生命周期内捕获。
          if (toolContext.pendingRestart) {
            result._selfRestart = { otterId, summary: toolContext.pendingRestart.summary };
            this.logger.info('Self-restart signal set on result', { otterId });
          }
          return result;
        } catch (err) {
          const e = err as Error & { _toolCallCount?: number; _guardAbortReason?: string; _outputGuardMetadata?: unknown; _modelAlias?: string };
          e._toolCallCount = this.activeSessions.get(sessionKey)?.toolCallCount ?? 0;
          e._guardAbortReason = activeEntry?.guardAbortReason;
          /** F20260814mtrc：guard abort 路径的首字节样本不随 abort 丢弃（超时样本恰是最关心的） */
          e._outputGuardMetadata = outputGuard.getMetadata();
          /** F20260814mtrc PR 审视修复：err 路径 result 不可达，model 随 error 透传（防 guard_abort 样本 model=unknown） */
          e._modelAlias = this.getModelAliasForLog(otterId);
          throw err;
        } finally {
          unregisterToolCall?.(); cleanupOutputGuard(); unsubscribe();
          this.activeSessions.delete(sessionKey);
          session.dispose();
        }
      },
    );
  }



  /** 创建带工具配置的 AgentSession */
  private async _createSessionWithTools(otterId: string, otterType: string, options: InvokeOptions | undefined, sessionManager: SessionManager, turnText?: { text: string }) {
    const conversationId = options?.conversationId ?? "";
    const messageId = options?.messageId;
    const otterToolNames = getOtterToolNamesForType(otterType);
    const { tools: customTools, toolContext } = buildCustomTools({ otterId, conversationId, allowedNames: otterToolNames, messageId, turnText, otterToolClient: this.otterToolClient!, modelPool: this.cfg.modelPool, createTools: this.cfg.createTools, healingRepo: this.cfg.healingRepo, logger: this.logger });
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

    const piCodingAgent = this.modelRuntimeRegistry.getPiCodingAgent()!;
    const resourceLoader = this.modelRuntimeRegistry.getResourceLoader();
    const modelRuntime = this.modelRuntimeRegistry.getModelRuntime();
    const settingsManager = this.modelRuntimeRegistry.getSettingsManager();

    this.logger.debug('[createSession] Calling createAgentSession', { otterId, modelAlias: resolvedAlias });
    const { session } = await piCodingAgent.createAgentSession({
      model: resolvedModel,
      sessionManager,
      tools: [...codingTools, ...customTools.map(t => t.name)],
      customTools,
      resourceLoader: resourceLoader ?? undefined,
      modelRuntime: modelRuntime ?? undefined,
      settingsManager: settingsManager ?? undefined,
    });
    this.logger.debug('[createSession] createAgentSession returned', { otterId });

    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    this.activeSessions.set(sessionKey, { abort: () => session.abort(), toolCallCount: 0 });

    return { session, sessionKey, toolContext };
  }

  /** 构建 invoke 结果 */


  /** 中断指定 Otter 的 Agent 生成 */
  abort(otterId: string, messageId?: string): void {
    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    const entry = this.activeSessions.get(sessionKey) ?? this.activeSessions.get(otterId);
    if (entry) {
      /** abort 返回 Promise：fire 路径无人 await，catch 防 unhandledRejection（与 _attachGuards 的 guardAbort 同模式） */
      void entry.abort().catch((err: unknown) => {
        this.logger.warn(`[abort] abort 调用失败 otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /** 获取指定 Otter 当前 session 的工具调用次数（abort body 构造用） */
  getToolCallCount(otterId: string, messageId?: string): number {
    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    return (this.activeSessions.get(sessionKey) ?? this.activeSessions.get(otterId))?.toolCallCount ?? 0;
  }

  getInternalAbortReason(messageId: string): string | undefined { const s = `:${messageId}`; for (const [k, e] of this.activeSessions) { if (e.guardAbortReason && k.endsWith(s) && k.length > s.length) { const r = e.guardAbortReason; e.guardAbortReason = undefined; return r; } } return undefined; }


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
