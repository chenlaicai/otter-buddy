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
/* eslint-disable max-lines -- #530 护栏 +11 行（steerSession 方法 + activeSessions steer 字段）；拆工厂会切断 session 生命周期与 steer/abort 的闭包内聚 */

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
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { getCodingToolsForOtterType, getOtterToolNamesForType, SimpleLockManager, getSessionManagerClass, buildMessageWithContext } from "./session-helpers";
import { attachGuards, checkSessionError, buildPromptResult } from "./circuit-breaker-helpers";
import { checkOrchestrationGuard } from "@usecases/conversation/dispatch-guard";
import { haltRegistry, type HaltDirective } from "@usecases/signal/halt-registry";
import { SessionRestore } from "./session-restore";
import type { ModelPool } from "@frameworks/llm/model-pool";
import { IdentityBuilder } from "./identity-builder";
import { buildCustomTools, createInvokeRegister, resetInvokeRegister, type InvokeRegister } from "./tool-builder";
// F20260904cg77（#776）：编码工具描述覆写（「如何正确使用工具」归位工具自身描述）
import { buildToolDescriptionOverrides, buildPiBuiltinToolDefinitions } from "./tool-description-overrides";
// F20260901mbfx（审计 F5）：readOnly 合成的自定义工具白名单（只读查询类）
import { SYNTHESIS_READ_ONLY_TOOL_WHITELIST } from "./synthesis-prompt-builder";
import { ModelRuntimeRegistry, otterInvokeStorage } from "./model-runtime-registry";
import type { PiCodingAgentModule } from "./model-runtime-registry";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createEventHandler } from "./agent-event-utils";
import { setCompactionHookDeps } from "./model-runtime-registry";
import type { AgentEvent } from "./agent-event-utils";

/**
 * F20260831tumv：仅用于计算注册工具全集的占位 ToolContext（模块级基础字段）。
 * Why：createTools 声明上依赖 ToolContext，但实际工厂实现（bootstrap/platforms.ts 注入的
 * tool-factory 路径）只消费 signalRepo / otterId / conversationId 等少数字段，不读实体工具
 * （Ledger 等）。传占位上下文可零副作用获取全部注册工具名，供 manifest "*" 展开使用。
 * signalRepo 等影响条件注册的字段由 buildOtterToolWhitelist 运行时补充（检视发现 1）。
 * 注：若未来工具工厂改为惰性注册（按 ctx 字段过滤注册集），需改回从 buildCustomTools
 * 内部拿真实全集，见特性文档 F20260831tumv 的遗留观察。
 */
const EMPTY_TOOL_CONTEXT_BASE: ToolContext = {
  client: undefined as unknown as ToolContext["client"],
  otterId: "",
  conversationId: "",
  currentMessageId: "",
};

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
  _selfRestart?: { otterId: string; summary?: string; modelAlias?: string };
  /** 末条 assistant 消息的 stopReason（F20260903lngth：length=生成被 token 上限截断） */
  lastStopReason?: string;
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
  /** 多模态 Phase 1：当前任务消息携带的图片，透传给 session.prompt(text, { images })。
   *  模型不支持 vision 时 SDK downgradeUnsupportedImages 自动降级（otter 层不自判）。 */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** F20260825hndf Phase 2：只读模式——跳过消息持久化和 SSE 广播，用于交接摘要合成。 */
  readOnly?: boolean;
}

/** 多模态 Phase 1：把 InvokeOptions 折叠成 SDK PromptOptions（images 缺省返回 undefined，保持纯文本路径行为等价） */
function buildPromptOptions(options: InvokeOptions | undefined): { images?: Array<{ type: "image"; data: string; mimeType: string }> } | undefined {
  if (options?.images && options.images.length > 0) return { images: options.images };
  return undefined;
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
  /** F20260826mwrd C1：signal_events 仓库（halt 落账） */
  signalRepo?: SignalEventRepository;
  /** F20260826mwrd C1：halt 首次注入回调（进程级 ModelRuntimeRegistry 单次注册） */
  onHaltFirstBlock?: (directive: HaltDirective) => void;
  /** Otter 配置持久化（由 Composition Root 注入） */
  otterConfigProvider: OtterConfigProvider;
  /** Otter Repository（由 Composition Root 注入，替代直接 DB 查询） */
  otterRepo: OtterRepository;
  /** Settings 仓库（读取用户显示名，可选） */
  settingsRepo?: SettingsRepository;
}

/** SessionManager 类型（从 pi-coding-agent 导入） */
import type { SessionManager, AgentSession } from "@earendil-works/pi-coding-agent";
import { PiSessionPool } from "@frameworks/pi/pi-session-pool";

export class PiSessionFactory implements AgentGateway {
  private readonly sessionStore: AgentSessionStore;
  private readonly activeSessions = new Map<string, { abort: () => Promise<void>; steer?: (text: string) => Promise<void>; toolCallCount: number; guardAbortReason?: string }>();
  private readonly circuitBreakerConfig: CircuitBreakerConfig;
  private readonly lockManager: SimpleLockManager;
  private readonly sessionRestore: SessionRestore;
  private readonly identityBuilder: IdentityBuilder;
  private readonly modelRuntimeRegistry: ModelRuntimeRegistry;
  /** 待注入身份的 otter（create/reset 后标记，注入成功才消费；进程重启丢失由 createdNew 兜底。已知边界：首次注入被 abort 时重试会重复注入一次，罕见无害，有意不处理） */
  private readonly pendingIdentity = new Set<string>();
  private otterToolClient: OtterToolClient | null;

  /** F20260911pspl：池化后的 session 持有（session + invoke 级寄存器 + 工具上下文）。 */
  private readonly pool: PiSessionPool;
  private readonly poolMeta = new Map<string, { session: AgentSession; toolContext: ToolContext; register: InvokeRegister; otterType: string }>();

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
      signalRepo?: SignalEventRepository;
      onHaltFirstBlock?: (directive: HaltDirective) => void;
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
    this.modelRuntimeRegistry = new ModelRuntimeRegistry(cfg.modelPool, logger, cfg.resourceLoader, cfg.onHaltFirstBlock);
    this.circuitBreakerConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...getConfig().circuitBreaker,
    };
    // Why(#423 方案1): 注入 logger，锁获取超时时落结构化诊断日志（持有者、持有时长、队列深度）
    this.lockManager = new SimpleLockManager(undefined, logger);
    // F20260911pspl：session 池（running 豁免用 SDK isStreaming；TTL 默认 10min）。
    // acquire 不走池 factory（重建需 otterConfig 装配，在 _acquirePooled 内联）；
    // 池本体负责持有/驱逐，驱逐后 poolMeta 同步清理由 onEvict 闭环。
    this.pool = new PiSessionPool(async () => { throw new Error("pool factory must not be called directly"); });
    this.pool.onEvict = (key) => { this.poolMeta.delete(key); };
    this.pool.start();
  }

  /** 注入 OtterToolClient（解决 Composition Root 循环依赖） */
  setOtterToolClient(client: OtterToolClient): void {
    this.otterToolClient = client;
  }

  /** F20260903cmpk：压缩钩子合成函数（延迟注入，同 setOtterToolClient 模式——
   *  合成依赖 agentInvoke，而 agentInvoke 依赖本工厂，只能后置）。
   *  注入后 session_before_compact 钩子在 threshold 触发时用七段合成替换 Pi 默认摘要。
   *  F20260909csfx：签名 (otterId, prompt)——otterId 由钩子在触发时从 invoke store 取真实值。 */
  setCompactionSynthesis(synthesize: ((otterId: string, prompt: string) => Promise<string>) | null): void {
    setCompactionHookDeps(synthesize ? { synthesize, logger: this.logger } : null);
  }

  /** 预加载 pi-coding-agent SDK + ResourceLoader + ModelRuntime，避免首次对话冷启动阻塞 */
  async warmup(): Promise<void> {
    await this.modelRuntimeRegistry.warmup();
    this.logger.info("PiSessionFactory warmup completed");
  }

  /** 获取 ResourceLoader（profile 端点用；需 warmup 完成后调用） */
  getResourceLoader() {
    return this.modelRuntimeRegistry.getResourceLoader();
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
    // F20260911pspl：先驱逐池内 session（池外无引用则 dispose），再处理其余。
    this.pool.evict(otterId);
    this.poolMeta.delete(otterId);
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
    // F20260911pspl：reset = 重启獭生——先驱逐池内旧 session（若在池），再建新链。
    this.pool.evict(otterId);
    this.poolMeta.delete(otterId);

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
    // #896：ALS 嵌套检测锁旁路。session_before_compact 钩子在 session.prompt() 的 agent loop
    // 内部触发（SDK agent-session.js _checkCompaction 每轮 LLM 响应后跑），此时外层 invoke
    // 持有 per-otter 锁；钩子里的合成走完整 invoke 链路，若再取同一把锁 → 30s 超时降级。
    // 判定：同 otterId 的 store 存在 = 同一 async context 内的嵌套 invoke（压缩合成正是这种），
    // 外层已持锁，直接执行。真并发来自不同 async context（store 为 undefined），照常取锁。
    // 嵌套串行安全由 ALS 链保证（外层 await 内层，不存在并行执行）。
    const nestedStore = otterInvokeStorage.getStore();
    if (nestedStore && nestedStore.otterId === otterId) {
      this.logger.debug('[invoke] nested invoke within ALS context, bypassing lock', { otterId, readOnly: options?.readOnly ?? false });
      return await this._invokeInternal(otterId, message, options);
    }
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

    // 1. 池化获取 session（F20260911pspl：命中 = 重置 invoke 级寄存器后直接复用；未命中 = 冷启动重建入池）
    //    身份注入判定：池命中 = session 已有身份上下文（上轮注入过），不再重复注入；
    //    冷启动 createdNew / pendingIdentity 场景与现状一致。
    const { session, sessionKey, toolContext, turnText, isPooled, createdNew } = await this._acquirePooled(otterId, options);

    // 2. 判定身份注入：池命中跳过（身份已在 session 上下文里）；冷启动走原判定
    const needsIdentity = !isPooled && this.pendingIdentity.has(otterId);

    // 3. 执行（不修改原始 options 对象；options 缺省时也要保证身份注入标志传递）
    this.logger.debug('[invoke] Executing with session', { otterId, needsIdentity, isPooled });
    const invokeOptions = { ...options, isFirstInvoke: needsIdentity } as InvokeOptions;
    const result = await this._executeWithSession(otterId, message, invokeOptions, session, sessionKey, toolContext, turnText);
    this.logger.debug('[invoke] Execution complete', { otterId });

    // 4. 注入成功后才消费标记（invoke 失败时保留，下次重试仍会注入）
    this.pendingIdentity.delete(otterId);
    /** F20260814mtrc：session 重建事实随结果透传（metrics 用，orchestrator recordSessionRebuild） */
    if (createdNew) result.sessionRebuilt = true;
    return result;
  }

  /** 池化 session 获取：命中 → 重置 invoke 级寄存器；未命中 → 冷启动重建入池。 */
  private async _acquirePooled(
    otterId: string,
    options: InvokeOptions | undefined,
  ): Promise<{ session: AgentSession; sessionKey: string; toolContext: ToolContext; turnText: { text: string }; isPooled: boolean; createdNew: boolean }> {
    const existing = this.poolMeta.get(otterId);
    if (existing) {
      // 并发防御（检视发现 3）：stale steal（#599，300s 超时）后旧 invoke 仍挂 streaming，
      // 直接复用会让新 invoke 被 SDK 拒绝且寄存器已 reset 致旧 invoke speak 落错消息。
      // ⚠️ 不能立即 dispose：旧 invoke 正在执行中，dispose → agent.abort() 会撕裂旧 invoke。
      // 策略：标记 stale 出池（不再被命中），不 dispose——旧 invoke 终有终点（完成/abort/超时），
      // 其 finally 的 activeSessions.delete 后 session 无引用，GC 兜底；jsonl 早已持久。
      if (existing.session.isStreaming) {
        this.logger.warn('[acquire] pooled session still streaming (stale steal), marking stale and cold-starting', { otterId });
        // 出池（不 dispose）：从池和 meta 摘除，旧 session 成为孤儿由旧 invoke 生命周期托管
        this.pool.markStale(otterId);
        this.poolMeta.delete(otterId);
      } else {
        resetInvokeRegister(existing.register, options?.messageId);
        const turnText = existing.register.turnText;
        const sessionKey = options?.messageId ? `${otterId}:${options.messageId}` : otterId;
        this.activeSessions.set(sessionKey, { abort: () => existing.session.abort(), steer: (text: string) => existing.session.steer?.(text) ?? Promise.resolve(), toolCallCount: 0 });
        return { session: existing.session, sessionKey, toolContext: existing.toolContext, turnText, isPooled: true, createdNew: false };
      }
    }

    // 冷启动：恢复 SessionManager → 全量创建 → 入池
    const { sessionManager, createdNew } = await this._restoreOrCreateSession(otterId);
    const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
    if (!otterConfig) {
      throw new Error(`Otter config not found: ${otterId}. Call create() first.`);
    }
    if (createdNew) this.pendingIdentity.add(otterId);
    const register = createInvokeRegister();
    resetInvokeRegister(register, options?.messageId);
    const { session, sessionKey, toolContext } = await this._createSessionWithTools(
      otterId, otterConfig.otterType, options, sessionManager, register, options?.readOnly,
    );
    this.poolMeta.set(otterId, { session, toolContext, register, otterType: otterConfig.otterType });
    // 入池：adopt（宿主自建的 session 由池接管驱逐生命周期）
    this.pool.adopt(otterId, session);
    return { session, sessionKey, toolContext, turnText: register.turnText, isPooled: false, createdNew };
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

  /**
   * F20260831aksp T3：bash 守卫拦截落 healing_events（框架层 medium 样本）。
   * fire-and-forget：失败仅记日志，不阻断拦截本身；healingRepo 缺失时返回 undefined。
   */
  private buildGuardInterceptHook(
    otterId: string,
    ids: { messageId?: string; conversationId?: string },
  ): ((input: { command: string; reason: string }) => void) | undefined {
    const healingRepo = this.cfg.healingRepo;
    if (!healingRepo) return undefined;
    return ({ command, reason }) => {
      healingRepo.create({
        id: crypto.randomUUID(),
        messageId: ids.messageId ?? "",
        conversationId: ids.conversationId ?? "",
        otterId,
        errorType: "guard_intercept",
        severity: "medium",
        description: `bash 守卫拦截：${reason.substring(0, 200)}（命令前缀：${command.substring(0, 120)}）`,
        suggestion: "LLM 已收到引导提示；若同一 otter 短时间内多次被拦，先排查是否误拦——误拦率上升会侵蚀 LLM 对引导的信任",
        context: { layer: "framework" },
        status: "open",
        resolution: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      }).catch(err => this.logger.error("guard_intercept healing event write failed (non-fatal)", err instanceof Error ? err : new Error(String(err)), { otterId }));
    };
  }

  /** 使用 session 执行 invoke（F20260911pspl：session 由 _acquirePooled 获取，本方法不再创建） */
  // eslint-disable-next-line max-params -- F20260911pspl：池化后 session/sessionKey/toolContext/turnText 由 acquire 产出透传（拆对象会切断参数与 acquire 返回值的对应关系）
  private async _executeWithSession(
    otterId: string,
    message: string,
    options: InvokeOptions | undefined,
    session: AgentSession,
    sessionKey: string,
    toolContext: ToolContext,
    turnText: { text: string },
  ): Promise<AgentRunResult> {
    const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId)!;
    const otterType = otterConfig.otterType; const otterPromptConfig = otterConfig.systemPrompt;

    // S1（R20260810piab）：身份前缀在 ALS scope 外构建（含 DB 查询）。
    // 对抗检视修正：system prompt 不被 session history 持久化，每次 invoke 重建 session 时
    // system role 是空的。身份信息必须每次都注入，否则 invoke 2+ 起的 LLM 不知道自己的身份。
    // （旧代码拼在 user message 里被持久化，但 system role 方案不持久化——改为每次都构建）
    const conversationId = options?.conversationId ?? "";
    // F20260824aibd: 传递 raw config 的 modelAlias（可能 undefined）给身份构建，
    // 让 buildModelIdentity 正确判定 isDefault（未显式指定 = 默认）。
    // getModelAliasForLog 返回解析后的非空值，此处用 config 裸值。
    const rawConfig = this.cfg.otterConfigProvider?.getConfig(otterId);
    const rawModelAlias = rawConfig?.modelAlias;
    const identityPrefix = await this.identityBuilder.buildIdentityPrefix(otterId, otterType, conversationId, rawModelAlias);
    // F20260903cmpk（#770 检视发现 2）：压缩钩子合成 prompt 的 meta 行要显示名而非 UUID。
    // 查询失败不影响链路（catch 降级 undefined，钩子用"海獭"兜底）。
    const displayName = await this.identityBuilder.getOtterName(otterId).catch(() => undefined);

    // S1：整个 createAgentSession + prompt 包在 ALS scope 内，
    // extension 的 before_agent_start handler 从 store 读 otterPromptConfig + identityPrefix。
    return await otterInvokeStorage.run(
      // F20260826mwrd C1：otterId 进 store——tool_call handler 查 halt 标用
      { otterPromptConfig, identityPrefix, otterId, displayName },
      // eslint-disable-next-line max-statements, complexity -- F20260815rstrt pendingRestart 检查增加语句数；F20260831aksp 守卫拦截 hook 增加分支
      async () => {
        // 1. session 已由 _acquirePooled 提供（池化：命中复用 / 未命中冷启动入池）
        this.logger.debug('[execute] Using pooled session', { otterId, sessionKey });

        // 2. 熔断器 + 输出退化检测 + 编排守卫（F20260821i336）+ 守卫拦截 healing（F20260831aksp T3）
        const { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard, armFirstByte } = attachGuards({ session, sessionKey, otterId, activeSessions: this.activeSessions, circuitBreakerConfig: this.circuitBreakerConfig, logger: this.logger, orchestrationCheck: (toolName: string, _args?: unknown) => checkOrchestrationGuard(toolContext, toolName), projectRoot: process.cwd(), onGuardIntercept: this.buildGuardInterceptHook(otterId, { messageId: options?.messageId, conversationId: options?.conversationId }) });

        // 3. 构建用户消息（dynamicContext 仍拼在 user message；system prompt 由 extension handler 注入 system role）
        const fullMessage = buildMessageWithContext("", message, options?.dynamicContext);
        this.logger.info('LLM request', { otterId, conversationId: options?.conversationId, modelAlias: this.getModelAliasForLog(otterId), messageLength: fullMessage.length, messagePreview: fullMessage.substring(0, 300) });

        const unsubscribe = session.subscribe(createEventHandler(activeEntry, options?.onEvent, turnText));
        try {
          /** F20260804dglp：prompt 前 arm 首字节超时（覆盖排队+prefill 静默，此前区间无任何兜底） */
          armFirstByte();
          /** 多模态 Phase 1：images 透传（机制层不做策略；SDK 按模型 input 自动降级）。
   *  空对象省略：undefined 与 {images:[]} 等价走纯文本路径 */
          await session.prompt(fullMessage, buildPromptOptions(options));
          checkSessionError(session, otterId, this.logger);
          const result = buildPromptResult({ otterId, session, circuitBreaker, outputGuard, activeEntry, modelPool: this.cfg.modelPool, otterConfigProvider: this.cfg.otterConfigProvider, model: this.cfg.model, logger: this.logger, getModelAliasForLog: this.getModelAliasForLog.bind(this) });

          // F20260821spcm: 携带 LLM 直出文本（旁白流失检测用）
          if (turnText.text.trim()) {
            result.directText = turnText.text;
          }

          // F20260819rscn: session.prompt() 完成后检查自重启。
          // Why 不在此处执行 restart：自重启后需要自动 re-invoke（獭继续工作），
          // 这需要 agent-invoker 层递归调用 invokeConversationInner。
          // Why 在 try 内、return 前：finally 的 dispose 清理当前 session，
          // 信号必须在 session 生命周期内捕获。
          if (toolContext.pendingRestart) {
            result._selfRestart = { otterId, summary: toolContext.pendingRestart.summary, modelAlias: toolContext.pendingRestart.modelAlias };
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
          // F20260826mwrd C1：invoke 生命周期结束，清理 halt 持续 block 状态——
          // 改派后新 invoke 不受旧 halt 影响（halt 指令已随本 invoke 的 block 注入达成使命）
          haltRegistry.endInvoke(otterId);
          // F20260911pspl：不再 dispose——session 归还池，等待驱逐或下次 invoke。
          // pendingRestart 的消费（result._selfRestart 已设置）与 restart 后的重建由
          // agent-invoker 层递归 invoke 完成：那时池里还是旧 session——restart 语义
          // 要求「下轮新 session」，故在消费点同步 evict。
          if (toolContext.pendingRestart) {
            this.pool.evict(otterId);
            this.poolMeta.delete(otterId);
          }
        }
      },
    );
  }



  /** F20260831tumv：计算某 otter 类型的自定义工具白名单（manifest 展开以注册全集为 universe） */
  private buildOtterToolWhitelist(otterType: string): string[] {
    // 注册工具全集先于白名单计算——manifest "*" 展开以此为全集，
    // 保证 tool-factory 新注册的工具（如 PR4/PR5 的 stock_data/paper_trade）自动进入 big 型白名单。
    // 旧序（先白名单后注册）在 "*" 展开时退化为 getOtterToolNamesForType 的 stale 硬编码 fallback，
    // 曾致 stock_data/paper_trade 对 big 型不可见（0831 操盘日报现场）。
    //
    // 占位 ctx 必须携带影响 tool-factory 条件注册的字段（检视发现 1）：
    // signalRepo 缺失时 halt_otter/query_signals/resolve_signal 不注册 → 不进白名单 →
    // 真实注册时反被 allowedNames 滤除。client/otterId 等运行时字段工厂不读，可占位。
    const ctx: ToolContext = {
      ...EMPTY_TOOL_CONTEXT_BASE,
      signalRepo: this.cfg.signalRepo,
    };
    const registeredTools = this.cfg.createTools(ctx, this.cfg.healingRepo, this.logger);
    return getOtterToolNamesForType(otterType, registeredTools.map(t => t.name), process.cwd(), this.logger);
  }

  /** 创建带工具配置的 AgentSession（F20260911pspl：invoke 级字段走寄存器，不再按 invoke 新建） */
  // eslint-disable-next-line max-params, complexity, max-statements -- Phase 2: readOnly 参数增加工具过滤；F20260904cg77 描述覆写接线 +1 语句（覆写本体在 tool-description-overrides.ts，此处仅组装）
  private async _createSessionWithTools(otterId: string, otterType: string, options: InvokeOptions | undefined, sessionManager: SessionManager, register: InvokeRegister, readOnly?: boolean) {
    const conversationId = options?.conversationId ?? "";
    const otterToolNames = this.buildOtterToolWhitelist(otterType);
    const { tools: customTools, toolContext } = buildCustomTools({ otterId, conversationId, allowedNames: otterToolNames, register, otterToolClient: this.otterToolClient!, modelPool: this.cfg.modelPool, otterConfigProvider: this.cfg.otterConfigProvider, createTools: this.cfg.createTools, healingRepo: this.cfg.healingRepo, signalRepo: this.cfg.signalRepo, logger: this.logger });
    const codingTools = getCodingToolsForOtterType(otterType);
    // F20260825hndf Phase 2：readOnly 模式只保留 read 工具，排除 write/edit/bash
    const filteredCodingTools = readOnly ? codingTools.filter(t => t === 'read') : codingTools;
    // F20260901mbfx（审计 F5）：readOnly 模式的自定义工具同样走白名单过滤。
    // 此前只滤 coding 工具，speak/yield/写库类自定义工具原样进 session——合成獭
    // 理论上可在摘要生成路径越权发言/交棒/写产物。白名单与 otterType manifest 的
    // allowedNames 双重求交（本过滤发生在 allowedNames 之后），新注册工具默认不进。
    const filteredCustomTools = readOnly
      ? customTools.filter(t => SYNTHESIS_READ_ONLY_TOOL_WHITELIST.has(t.name))
      : customTools;

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
      codingTools: filteredCodingTools,
      readOnly: readOnly ?? false,
      customToolNames: filteredCustomTools.map(t => t.name),
      whitelist: [...filteredCodingTools, ...filteredCustomTools.map(t => t.name)],
    });

    const piCodingAgent = this.modelRuntimeRegistry.getPiCodingAgent()!;
    const resourceLoader = this.modelRuntimeRegistry.getResourceLoader();
    const modelRuntime = this.modelRuntimeRegistry.getModelRuntime();
    const settingsManager = this.modelRuntimeRegistry.getSettingsManager();

    // F20260904cg77（#776）：编码工具描述覆写（引导归位工具描述，readOnly 不覆写——
    // 合成路径工具已过滤，保持 prompt 最小）。机制见 tool-description-overrides.ts。
    const descriptionOverrides = readOnly ? [] : buildToolDescriptionOverrides(
      buildPiBuiltinToolDefinitions(piCodingAgent as unknown as Record<string, unknown>, process.cwd()),
      filteredCodingTools,
    );

    this.logger.debug('[createSession] Calling createAgentSession', { otterId, modelAlias: resolvedAlias });
    const { session } = await piCodingAgent.createAgentSession({
      model: resolvedModel,
      sessionManager,
      tools: [...filteredCodingTools, ...filteredCustomTools.map(t => t.name)],
      customTools: [...descriptionOverrides, ...filteredCustomTools],
      resourceLoader: resourceLoader ?? undefined,
      modelRuntime: modelRuntime ?? undefined,
      settingsManager: settingsManager ?? undefined,
    });
    this.logger.debug('[createSession] createAgentSession returned', { otterId });

    // F20260909mthl：按模型配置设置思考深度（session 每次 invoke 重建，故每次创建后都设）。
    // SDK 默认链：createAgentSession 未显式传 thinkingLevel 时落到 DEFAULT_THINKING_LEVEL="medium"（sdk.js:115-138），
    // 再经 clampThinkingLevel 按模型 thinkingLevelMap 映射（如 k3 medium=null → clamp 向上到 high）。
    // 本处覆写 SDK 默认链：配置了就用配置值；未配置跳过（保持 SDK 解析链结果）。
    // 非 reasoning 模型 available=["off"]，任何档位被安全钳为 off。clamp 发生时打 info 日志（配置与模型能力不一致的信号）。
    if (this.cfg.modelPool) {
      const configuredLevel = this.cfg.modelPool.getThinkingLevel(resolvedAlias);
      if (configuredLevel) {
        session.setThinkingLevel(configuredLevel);
        const applied = session.thinkingLevel;
        if (applied !== configuredLevel) {
          this.logger.info('Thinking level clamped to model-supported level', { otterId, modelAlias: resolvedAlias, configured: configuredLevel, applied });
        } else {
          this.logger.debug('Thinking level applied', { otterId, modelAlias: resolvedAlias, thinkingLevel: applied });
        }
      }
    }

    const sessionKey = options?.messageId ? `${otterId}:${options.messageId}` : otterId;
    this.activeSessions.set(sessionKey, { abort: () => session.abort(), steer: (text: string) => session.steer?.(text) ?? Promise.resolve(), toolCallCount: 0 });

    return { session, sessionKey, toolContext };
  }

  /** 构建 invoke 结果 */


  /** 中断指定 Otter 的 Agent 生成。
   *  F20260911pspl：池化后 session 常驻——activeSessions 在 invoke 期间有值，
   *  invoke 结束后 session 在池里仍可直接 abort（idle session 的 abort 是 no-op）。 */
  abort(otterId: string, messageId?: string): void {
    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    const entry = this.activeSessions.get(sessionKey) ?? this.activeSessions.get(otterId);
    if (entry) {
      void entry.abort().catch((err: unknown) => {
        this.logger.warn(`[abort] abort 调用失败 otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }
    // F20260911pspl：invoke 间隙的 abort——池内 session 仍持有，直接调。
    const pooled = this.poolMeta.get(otterId);
    if (pooled) {
      this.logger.info(`[abort] session idle in pool, abort via pooled session otter=${otterId}`);
      void pooled.session.abort().catch((err: unknown) => {
        this.logger.warn(`[abort] pooled abort 调用失败 otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /** 获取指定 Otter 当前 session 的工具调用次数（abort body 构造用） */
  getToolCallCount(otterId: string, messageId?: string): number {
    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    return (this.activeSessions.get(sessionKey) ?? this.activeSessions.get(otterId))?.toolCallCount ?? 0;
  }

  getInternalAbortReason(messageId: string): string | undefined { const s = `:${messageId}`; for (const [k, e] of this.activeSessions) { if (e.guardAbortReason && k.endsWith(s) && k.length > s.length) { const r = e.guardAbortReason; e.guardAbortReason = undefined; return r; } } return undefined; }

  /** #530 梯度护栏：向活跃 session 注入 steer 文案（链引擎调用）。
   *  复用 circuit-breaker-helpers 的 session.steer 通道。
   *  键格式：生产链路 sessionKey 恒为 ${otterId}:${messageId}，需前缀扫描匹配。
   *  返回 true=找到活跃 session 并发出注入请求，false=session 不活跃或无 steer 能力。
   *  ⚠️ 竞态窗口（F20260907usti 严重 1）：fire-and-forget 语义下 true ≠ 送达确认——
   *  session 收尾 finally 块 delete 前的窗口内，steer 可能抛错（session dispose 中）。
   *  此时返回 true + 路由器写 completed/steered 销账行 → URGENT 零投递且台账说已消费。
   *  最小修复：catch 内落 healing event（可观测），重启补扫不补（设计显式声明此窗口）。 */
  steerSession(otterId: string, text: string): boolean {
    // 遍历 activeSessions 查找 otterId 前缀匹配（键格式 ${otterId}:${messageId}）
    for (const [key, entry] of this.activeSessions) {
      if ((key === otterId || key.startsWith(`${otterId}:`)) && entry.steer) {
        void entry.steer(text).catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[steer] steer 调用失败 otter=${otterId}: ${errMsg}`);
          // F20260907usti 严重 1 修复：steer 失败时落 healing event（可观测）
          if (this.cfg.healingRepo) {
            this.cfg.healingRepo.create({
              id: crypto.randomUUID(),
              messageId: "",
              conversationId: "",
              otterId,
              errorType: "other",
              severity: "medium",
              description: `URGENT steer 注入失败（session 收尾竞态窗口）：${errMsg}`,
              suggestion: "注入未送达且已销账=零投递，需补救时人工重投；链引擎护栏调用则仅警示缺失",
              context: { layer: "framework", method: "steerSession" },
              status: "open",
              resolution: null,
              createdAt: new Date().toISOString(),
              resolvedAt: null,
            }).catch(() => {/* healing 落账失败不阻断 */});
          }
        });
        return true;
      }
    }
    this.logger.warn(`[steer] session 不活跃或无 steer 能力 otter=${otterId}`);
    return false;
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
    signalRepo: config.signalRepo,
    onHaltFirstBlock: config.onHaltFirstBlock,
    otterConfigProvider: config.otterConfigProvider,
    otterRepo: config.otterRepo,
    settingsRepo: config.settingsRepo,
  }, logger);
}
