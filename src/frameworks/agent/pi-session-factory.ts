/* eslint-disable max-lines */ // 多模型路由改造导致文件增长，后续可拆分
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
import { truncateToolResult } from "@interface-adapters/agent-runtime/tools/tool-helpers";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAgentSessionStore } from "./agent-session-store";
import type { AgentSessionStore } from "./agent-session-store";
import type { DynamicContext } from "@interface-adapters/agent-runtime/agent-invoke-port";
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
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number };
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
  model: unknown;
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
  private modelRuntime: {
    setRuntimeApiKey(provider: string, key: string): Promise<void>;
    registerProvider(providerId: string, config: Record<string, unknown>): void;
  } | null = null;
  private otterToolClient: OtterToolClient | null;

  constructor(
    private readonly cfg: {
      db: Database.Database;
      sessionDir: string;
      otterToolClient: OtterToolClient | null;
      model: unknown;
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
        const { DefaultResourceLoader, getAgentDir } = piCodingAgent as unknown as {
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
      const ModelRuntimeClass = (piCodingAgent as unknown as { ModelRuntime: { create: (options?: unknown) => Promise<unknown> } }).ModelRuntime;
      this.modelRuntime = await ModelRuntimeClass.create() as {
        setRuntimeApiKey(provider: string, key: string): Promise<void>;
        registerProvider(providerId: string, config: Record<string, unknown>): void;
      };

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
  private async _registerRuntimeModel(alias: string, config: ModelConfig, model: unknown): Promise<void> {
    if (!this.modelRuntime) return;
    if (alias !== config.provider) {
      const m = model as {
        id: string; name?: string; reasoning?: boolean; input?: string[]; baseUrl?: string;
        cost?: unknown; contextWindow?: number; maxTokens?: number;
        thinkingLevelMap?: unknown; compat?: unknown;
      };
      this.modelRuntime.registerProvider(alias, {
        // config 只配 apiKey 不配 apiBaseUrl 时回退到 pool model 的 baseUrl（template 兜底，总有值），
        // 否则 SDK 对"注册了 models 但无 baseUrl"的 provider 同步抛错
        baseUrl: config.apiBaseUrl ?? m.baseUrl,
        apiKey: config.apiKey,
        api: config.provider === "openai" ? "openai-responses" : "anthropic-messages",
        models: [{
          id: m.id,
          name: m.name ?? m.id,
          reasoning: m.reasoning ?? false,
          thinkingLevelMap: m.thinkingLevelMap,
          input: m.input ?? ["text"],
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          compat: m.compat,
        }],
      });
      this.logger.info(`Registered runtime provider for alias=${alias}`);
    }
    if (config.apiKey) {
      // 设置 API key 到 alias 和 provider 两个名称上（SDK 可能用任一名称查找）
      await this.modelRuntime.setRuntimeApiKey(alias, config.apiKey);
      if (alias !== config.provider) {
        await this.modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
      }
      this.logger.info(`Set runtime API key for alias=${alias} (also for provider=${config.provider})`);
    }
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
  private async buildUserMessagePrefix(
    otterId: string,
    otterType: string,
    otterPromptConfig: string | OtterPromptConfig | undefined,
    isFirstInvoke: boolean | undefined,
  ): Promise<string> {
    const otterPrompt = buildOtterPrompt(otterPromptConfig);
    if (!isFirstInvoke) return otterPrompt;
    const identityPrefix = await this.buildIdentityPrefix(otterId, otterType);
    if (!identityPrefix) return otterPrompt;
    return [identityPrefix, otterPrompt].filter(Boolean).join("\n\n");
  }

  /** 构建首次 invoke 的身份前缀：名称/ID/类型 + 按类型加载的身份文案。类型以 otterConfig 为准（与工具门控同一事实源） */
  private async buildIdentityPrefix(otterId: string, otterType: string): Promise<string> {
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
    const userName = this.cfg.settingsRepo ? ((await this.cfg.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || undefined) : undefined;
    const userIdentity = userName ? `## 你的搭档\n- 名字：${userName}\n- 称呼：搭档（你可以用名字称呼 ta）` : '';

    return [
      `## 你的身份\n- 名称：${otter.name}\n- 名号：${otter.name}\n- ID：${otterId}\n- 类型：${isBig ? '大獭' : '小獭'}`,
      userIdentity,
      identityBody,
      modelGuidance,
    ].filter(Boolean).join("\n\n");
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

    // 1. 构建工具配置并创建 AgentSession
    this.logger.debug('[execute] Creating session with tools', { otterId });
    /** F20260804hcob: 当前 assistant 消息的文本缓冲（按消息清零/累积），speak 检测"卡片写在 speak 外"用 */
    const turnText = { text: "" };
    const { session, sessionKey } = await this._createSessionWithTools(otterId, otterType, options, sessionManager, turnText);
    this.logger.debug('[execute] Session created', { otterId, sessionKey });

    // 2. 熔断器 + 输出退化检测
    const { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard, armFirstByte } = this._attachGuards(session, sessionKey, otterId);

    // 3. 构建完整消息并记录日志
    const fullMessage = buildMessageWithContext(await this.buildUserMessagePrefix(otterId, otterType, otterPromptConfig, options?.isFirstInvoke), message, options?.dynamicContext);
    this.logger.info('LLM request', { otterId, conversationId: options?.conversationId, modelAlias: this.getModelAliasForLog(otterId), messageLength: fullMessage.length, messagePreview: fullMessage.substring(0, 300) });

    const unsubscribe = session.subscribe(this.createEventHandler(activeEntry, options?.onEvent, turnText));
    try {
      /** F20260804dglp：prompt 前 arm 首字节超时（覆盖排队+prefill 静默，此前区间无任何兜底） */
      armFirstByte();
      await session.prompt(fullMessage);
      this._checkSessionError(session, otterId);
      return this._buildPromptResult(otterId, session, circuitBreaker, outputGuard, activeEntry);
    } catch (err) {
      const e = err as Error & { _toolCallCount?: number; _guardAbortReason?: string };
      e._toolCallCount = this.activeSessions.get(sessionKey)?.toolCallCount ?? 0;
      e._guardAbortReason = activeEntry?.guardAbortReason;
      throw err;
    } finally {
      unregisterToolCall?.(); cleanupOutputGuard(); unsubscribe();
      this.activeSessions.delete(sessionKey);
      session.dispose();
    }
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
    session: { getSessionStats: () => { tokens: { input: number; output: number } } },
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
    const customTools = this.buildCustomTools(otterId, conversationId, otterToolNames, messageId, turnText);
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
      model: resolvedModel as never,
      sessionManager,
      tools: [...codingTools, ...customTools.map(t => t.name)],
      customTools: customTools as never,
      resourceLoader: this.resourceLoader ?? undefined,
      modelRuntime: this.modelRuntime as any,
    });
    this.logger.debug('[createSession] createAgentSession returned', { otterId });

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

    // per-otter contextWindow
    let ctxMax: number | undefined;
    if (this.cfg.modelPool) {
      const otterConfig = this.cfg.otterConfigProvider.getConfig(otterId);
      ctxMax = this.cfg.modelPool.getContextWindow(otterConfig?.modelAlias);
    } else {
      ctxMax = (this.cfg.model as Record<string, unknown>)?.contextWindow as number | undefined;
    }
    return buildResult("", tokenUsage, circuitBreaker, ctxMax);
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
   * 适配点：label 字段 + execute 签名扩展（signal/onUpdate/ctx）。
   */
  private buildCustomTools(
    otterId: string,
    conversationId: string,
    allowedNames: string[],
    messageId?: string,
    turnText?: { text: string },
  ): Array<{
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    const otterTools = this.cfg.createTools({
      client: this.otterToolClient!,
      otterId,
      conversationId,
      currentMessageId: messageId ?? "",
      modelPool: this.cfg.modelPool,
      getTurnAssistantText: turnText ? () => turnText.text : undefined,
    }, this.cfg.healingRepo, this.logger);

    return otterTools
      .filter(t => allowedNames.includes(t.name))
      .map(t => ({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: t.parameters,
        /** ToolDefinition.execute 有额外参数（signal/onUpdate/ctx），Otter 工具不需要，忽略 */
        execute: async (toolCallId: string, params: Record<string, unknown>) => {
          const result = await t.execute(toolCallId, params);
          return truncateToolResult(result);
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
    modelPool: config.modelPool,
    identityPromptDir: config.identityPromptDir,
    createTools: config.createTools,
    healingRepo: config.healingRepo,
    otterConfigProvider: config.otterConfigProvider,
    otterRepo: config.otterRepo,
    settingsRepo: config.settingsRepo,
  }, logger);
}
