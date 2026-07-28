/**
 * PiSessionFactory：基于 pi-coding-agent SDK（createAgentSession）的 AgentGateway 实现。
 *
 * 设计要点：
 * - Session 复用机制：首次 invoke 创建 session 并持久化，后续 invoke 恢复已有 session
 * - 只有在 reset/create 时才创建新 session，构建 session 链
 * - tools 配置控制编码工具启用，customTools 注入 Otter 工具
 * - 系统提示作为消息前缀注入（SDK 的 _systemPromptOverride 为 private，无公开 setter）
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
import type { OtterToolClient } from "@interface-adapters/agent-runtime/otter-tool-client";
import type { AgentTool, ToolContext } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAgentSessionStore } from "./agent-session-store";
import type { AgentSessionStore } from "./agent-session-store";
import type { DynamicContext } from "@interface-adapters/agent-runtime/agent-invoke-port";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./tool-call-circuit-breaker";
import type { CircuitBreakerConfig, ToolCallCircuitBreaker } from "./tool-call-circuit-breaker";
import { config as appConfig } from "@frameworks/config";
import type { Logger } from "@usecases/ports/logger";
import type { OtterPromptConfig } from "@contract/api/otter";
import { loadPromptFile } from "./prompt-loader";
import type { OtterConfigProvider, OtterType } from "@usecases/ports/otter-config-provider";
import { getCodingToolsForOtterType, getOtterToolNamesForType, SimpleLockManager, getSessionManagerClass, buildOtterPrompt, buildMessageWithContext } from "./session-helpers";
import { attachCircuitBreaker, checkTokenWarning, buildResult } from "./circuit-breaker-helpers";
import { attachOutputGuard } from "./output-guard";
import { SessionRestore } from "./session-restore";

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
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string };
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
  otterToolClient: OtterToolClient;
  /** pi-ai Model 对象（由 models-factory 创建） */
  model: unknown;
  /** Otter 身份文案目录（含 BIG_OTTER.md / SMALL_OTTER.md，首次 invoke 时按类型注入） */
  identityPromptDir?: string;
  /** 工具工厂函数（由 Composition Root 注入，解耦 interface-adapters） */
  createTools: (ctx: ToolContext) => AgentTool[];
  /** Otter 配置持久化（由 Composition Root 注入） */
  otterConfigProvider: OtterConfigProvider;
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
  /** 待注入身份的 otter（create/reset 后标记，注入成功才消费；进程重启丢失由 createdNew 兜底。已知边界：首次注入被 abort 时重试会重复注入一次，罕见无害，有意不处理） */
  private readonly pendingIdentity = new Set<string>();
  /** pi-coding-agent ModelRuntime 最小接口（SDK ESM-only，无法直接导入类型） */
  private modelRuntime: { setRuntimeApiKey(provider: string, key: string): Promise<void> } | null = null;
  private otterToolClient: OtterToolClient;

  constructor(
    private readonly cfg: {
      db: Database.Database;
      sessionDir: string;
      otterToolClient: OtterToolClient;
      model: unknown;
      identityPromptDir?: string;
      createTools: (ctx: ToolContext) => AgentTool[];
      resourceLoader?: ResourceLoader;
      otterConfigProvider: OtterConfigProvider;
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
      ...appConfig.circuitBreaker,
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
    // 1. 中止所有相关的活跃 session（先复制 key 列表，避免迭代时修改 Map）
    const keysToDelete: string[] = [];
    for (const [key] of this.activeSessions.entries()) {
      if (key === otterId || key.startsWith(`${otterId}:`)) {
        keysToDelete.push(key);
      }
    }

    // 2. 逐个中止并删除
    for (const key of keysToDelete) {
      const entry = this.activeSessions.get(key);
      if (entry) {
        try {
          await entry.abort();
        } catch {
          // abort 失败不阻塞销毁流程
        }
        this.activeSessions.delete(key);
      }
    }

    // 3. 删除持久化数据（不删除 session 文件，保留用于审计）
    this.cfg.db.transaction(() => {
      this.sessionStore.delete(otterId);
      this.cfg.otterConfigProvider.deleteConfig(otterId);
    })();
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

    // 6. 清理旧 session 文件（安全检查：避免删除刚创建的文件）
    if (oldSessionFile && oldSessionFile !== sessionFile) {
      try {
        fs.unlinkSync(oldSessionFile);
        this.logger.debug(`Deleted old session file: ${oldSessionFile}`);
      } catch (err) {
        this.logger.warn(`Failed to delete old session file: ${oldSessionFile}`, { error: err });
      }
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
    if (!this.otterToolClient) {
      throw new Error("OtterToolClient not injected. Call setOtterToolClient() before invoke().");
    }

    // 1. 恢复或创建 session（文件丢失/损坏时会重建全新 session，见 createdNew）
    const { sessionManager, createdNew } = await this._restoreOrCreateSession(otterId);

    // 2. 从数据库加载配置
    const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
    if (!otterConfig) {
      throw new Error(`Otter config not found: ${otterId}. Call create() first.`);
    }

    // 3. 判定身份注入：新建/重建/重置后的 session 上下文中没有身份内容
    const needsIdentity = createdNew || this.pendingIdentity.has(otterId);

    // 4. 创建 AgentSession 并执行（不修改原始 options 对象；options 缺省时也要保证身份注入标志传递）
    const invokeOptions = { ...options, isFirstInvoke: needsIdentity } as InvokeOptions;
    const result = await this._executeWithSession(otterId, message, invokeOptions, sessionManager, otterConfig);

    // 5. 注入成功后才消费标记（invoke 失败时保留，下次重试仍会注入）
    this.pendingIdentity.delete(otterId);
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

  /** 组装用户消息前缀：首次 invoke 时身份叠加在 otter 专属 prompt 之前（后续 invoke 从 session 历史恢复，不重复注入） */
  private buildUserMessagePrefix(
    otterId: string,
    otterType: string,
    otterPromptConfig: string | OtterPromptConfig | undefined,
    isFirstInvoke: boolean | undefined,
  ): string {
    const otterPrompt = buildOtterPrompt(otterPromptConfig);
    if (!isFirstInvoke) return otterPrompt;
    const identityPrefix = this.buildIdentityPrefix(otterId, otterType);
    if (!identityPrefix) return otterPrompt;
    return [identityPrefix, otterPrompt].filter(Boolean).join("\n\n");
  }

  /** 构建首次 invoke 的身份前缀：名称/ID/类型 + 按类型加载的身份文案。类型以 otterConfig 为准（与工具门控同一事实源） */
  private buildIdentityPrefix(otterId: string, otterType: string): string {
    const otterRow = this.cfg.db.prepare("SELECT name FROM otters WHERE id = ?").get(otterId) as { name: string } | undefined;
    if (!otterRow) {
      this.logger.warn('身份注入跳过：otters 表中不存在该记录', { otterId });
      return "";
    }
    /** 未知类型按小獭处理（文案侧的保守默认；schema 约束下不可达，工具门控独立判定） */
    const isBig = otterType === 'big';
    const identityBody = isBig ? this.bigOtterIdentity : this.smallOtterIdentity;
    return [
      `## 你的身份\n- 名称：${otterRow.name}\n- ID：${otterId}\n- 类型：${isBig ? '大獭' : '小獭'}`,
      identityBody,
    ].filter(Boolean).join("\n\n");
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

    // 1. 构建工具配置并创建 AgentSession
    const { session, sessionKey } = await this._createSessionWithTools(
      otterId, otterType, options, sessionManager,
    );

    // 2. 熔断器 + 输出退化检测
    const { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard } = this._attachGuards(session, sessionKey, otterId);

    // 3. 构建完整消息
    const fullMessage = buildMessageWithContext(this.buildUserMessagePrefix(otterId, otterType, otterPromptConfig, options?.isFirstInvoke), message, options?.dynamicContext);
    this.logger.info('LLM request', { otterId, conversationId: options?.conversationId, messageLength: fullMessage.length, messagePreview: fullMessage.substring(0, 300) });
    const unsubscribe = session.subscribe(this.createEventHandler(activeEntry, options?.onEvent));

    try {
      await session.prompt(fullMessage);
      const result = this._buildInvokeResult(otterId, session, circuitBreaker);
      result.outputGuardMetadata = outputGuard.getMetadata(); if (activeEntry?.guardAbortReason) (result as unknown as Record<string, unknown>)._guardAbortReason = activeEntry.guardAbortReason;
      return result;
    } catch (err) {
      const e = err as Error & { _toolCallCount?: number; _guardAbortReason?: string };
      e._toolCallCount = this.activeSessions.get(sessionKey)?.toolCallCount ?? 0; e._guardAbortReason = activeEntry?.guardAbortReason;
      throw err;
    } finally {
      unregisterToolCall?.(); cleanupOutputGuard(); unsubscribe();
      this.activeSessions.delete(sessionKey);
      session.dispose();
    }
  }

  /** 创建带工具配置的 AgentSession */
  private async _createSessionWithTools(otterId: string, otterType: string, options: InvokeOptions | undefined, sessionManager: SessionManager) {
    const conversationId = options?.conversationId ?? "";
    const messageId = options?.messageId;
    const otterToolNames = getOtterToolNamesForType(otterType);
    const customTools = this.buildCustomTools(otterId, conversationId, otterToolNames, messageId);
    const codingTools = getCodingToolsForOtterType(otterType);

    this.logger.info('Tools registered for agent session', {
      otterId, otterType,
      codingTools,
      customToolNames: customTools.map(t => t.name),
      whitelist: [...codingTools, ...customTools.map(t => t.name)],
    });

    const piCodingAgent = this.piCodingAgent!;
    const { session } = await piCodingAgent.createAgentSession({
      model: this.cfg.model as never,
      sessionManager,
      tools: [...codingTools, ...customTools.map(t => t.name)],
      customTools: customTools as never,
      resourceLoader: this.resourceLoader ?? undefined,
      modelRuntime: this.modelRuntime as any,
    });

    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    this.activeSessions.set(sessionKey, { abort: () => session.abort(), toolCallCount: 0 });

    return { session, sessionKey };
  }

  /** 构建 invoke 结果 */
  private _buildInvokeResult(
    otterId: string,
    session: { getSessionStats: () => { tokens: { input: number; output: number } } },
    circuitBreaker: ToolCallCircuitBreaker,
  ): AgentRunResult {
    const stats = session.getSessionStats();
    const tokenUsage = { input: stats.tokens.input, output: stats.tokens.output };
    checkTokenWarning(otterId, stats.tokens, this.logger);

    const ctxMax = (this.cfg.model as Record<string, unknown>)?.contextWindow as number | undefined;
    return buildResult("", tokenUsage, circuitBreaker, ctxMax);
  }
  private _attachGuards(session: { subscribe: (fn: (event: unknown) => void) => () => void; abort: () => Promise<void> }, sessionKey: string, otterId: string) {
    const activeEntry = this.activeSessions.get(sessionKey); const wrappedAbort = (reason?: string) => { if (activeEntry && !activeEntry.guardAbortReason) activeEntry.guardAbortReason = reason ?? "internal_abort"; return session.abort(); };
    const { circuitBreaker, unregisterToolCall } = attachCircuitBreaker(session, otterId, this.circuitBreakerConfig, this.logger, wrappedAbort);
    const cfg = { ...appConfig.circuitBreaker?.outputGuard, streamingTimeoutMs: appConfig.circuitBreaker?.streamingTimeoutMs }; const { guard: outputGuard, cleanup: cleanupOutputGuard } = attachOutputGuard(session, otterId, cfg, this.logger, () => wrappedAbort(outputGuard.getMetadata().reason));
    return { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard };
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
    identityPromptDir: config.identityPromptDir,
    createTools: config.createTools,
    otterConfigProvider: config.otterConfigProvider,
  }, logger);
}
