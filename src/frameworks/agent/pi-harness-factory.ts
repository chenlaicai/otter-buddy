/**
 * PiHarnessFactory：实现 AgentGateway 接口 + 冷启动 invoke() 方法。
 *
 * 基于 docs/research/pi-capability-analysis.md：
 * - 使用 AgentHarness（非 Agent），支持 Session/Skill/Compaction/动态 Prompt
 * - 冷启动模型（R17）：每次发言创建 harness，完成后释放
 * - Pi 自管理 Session（R12）：使用 JsonlSessionRepo，Otter 只存 pi_session_id
 * - Pi 内置 NodeExecutionEnv（R13）：不需要自定义 ExecutionEnv
 */

import type Database from "better-sqlite3";
import type {
  AgentConfig,
  AgentContext,
  AgentGateway,
} from "@usecases/otter/agent-gateway";
import type { Models } from "@frameworks/llm/models-factory";
import type { TTool, ToolRegistry } from "./tool-registry";
import { DEFAULT_OTTER_TOOL_CONFIGS } from "./tool-registry";
import { createAgentSessionStore } from "./agent-session-store";
import type { AgentSessionStore } from "./agent-session-store";
import { buildSystemPrompt, type DynamicContext } from "./system-prompt-builder";
import { logger } from "@frameworks/logger";

/** Agent 事件（流式推送） */
export interface AgentEvent {
  type: string;
  delta?: string;
  [key: string]: unknown;
}

/** Agent 执行结果 */
export interface AgentRunResult {
  text: string;
  tokenUsage?: { input: number; output: number };
}

/** invoke() 选项 */
export interface InvokeOptions {
  dynamicContext?: DynamicContext;
  onEvent?: (event: AgentEvent) => void;
}

/** initAgentCore 配置 */
export interface AgentCoreConfig {
  models: Models;
  model: unknown;
  db: Database.Database;
  sessionDir?: string;
  toolRegistry?: ToolRegistry;
}

/** pi-agent-core 模块类型（动态加载） */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PiAgentCoreModule = typeof import("@earendil-works/pi-agent-core");

let piAgentCoreCache: PiAgentCoreModule | null = null;

async function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  if (!piAgentCoreCache) {
    piAgentCoreCache = await import("@earendil-works/pi-agent-core");
  }
  return piAgentCoreCache;
}

/** Token 阈值（超过则触发 compaction，R1） */
const COMPACT_TOKEN_THRESHOLD = 100_000;

export class PiHarnessFactory implements AgentGateway {
  private readonly sessionStore: AgentSessionStore;
  private readonly staticPrompts = new Map<string, string>();
  private readonly otterTypes = new Map<string, string>();
  private piAgentCore: PiAgentCoreModule | null = null;

  constructor(
    private readonly models: Models,
    private readonly model: unknown,
    private readonly db: Database.Database,
    private readonly sessionDir: string,
    private readonly toolRegistry?: ToolRegistry,
  ) {
    this.sessionStore = createAgentSessionStore(db);

    /** 注册默认 Otter 工具配置 */
    if (this.toolRegistry) {
      for (const config of DEFAULT_OTTER_TOOL_CONFIGS) {
        this.toolRegistry.configureOtterTools(config);
      }
    }
  }

  /** 懒加载 pi-agent-core（ESM-only） */
  private async ensurePiAgentCore(): Promise<PiAgentCoreModule> {
    if (!this.piAgentCore) {
      this.piAgentCore = await loadPiAgentCore();
    }
    return this.piAgentCore;
  }

  async create(otterId: string, config: AgentConfig): Promise<void> {
    if (this.sessionStore.get(otterId)) {
      throw new Error(`Agent already exists for otter: ${otterId}`);
    }

    const piAgentCore = await this.ensurePiAgentCore();

    /** 创建 Pi session（JsonlSessionRepo） */
    const sessionRepo = this.createSessionRepo(piAgentCore);
    const session = sessionRepo.create();
    const piSessionId = session.id ?? crypto.randomUUID();

    /** 存储映射 + 静态 prompt */
    this.sessionStore.set(otterId, piSessionId);
    this.staticPrompts.set(otterId, config.systemPrompt);

    if (config.context?.otterType) {
      this.otterTypes.set(otterId, config.context.otterType as string);
    }
  }

  async destroy(otterId: string): Promise<void> {
    const piSessionId = this.sessionStore.get(otterId);
    if (piSessionId) {
      const piAgentCore = await this.ensurePiAgentCore();
      try {
        const sessionRepo = this.createSessionRepo(piAgentCore);
        sessionRepo.delete?.(piSessionId);
      } catch {
        logger.warn(`Failed to delete Pi session for otter ${otterId}`);
      }
    }

    this.sessionStore.delete(otterId);
    this.staticPrompts.delete(otterId);
    this.otterTypes.delete(otterId);
  }

  async reset(otterId: string, context?: AgentContext): Promise<void> {
    const piAgentCore = await this.ensurePiAgentCore();

    /** 创建新 Pi session（chain，R9 Otter chain） */
    const sessionRepo = this.createSessionRepo(piAgentCore);
    const session = sessionRepo.create();
    const newPiSessionId = session.id ?? crypto.randomUUID();

    /** 更新映射 */
    this.sessionStore.update(otterId, newPiSessionId);

    /** 可选更新静态 prompt */
    if (context?.systemPrompt) {
      this.staticPrompts.set(otterId, context.systemPrompt);
    }
  }

  /**
   * 冷启动调用（R17）：打开 session -> 创建 AgentHarness -> prompt -> 释放。
   * Session 通过 JSONL 持久化，harness 释放后不丢数据。
   */
  async invoke(
    otterId: string,
    message: string,
    options?: InvokeOptions,
  ): Promise<AgentRunResult> {
    const piSessionId = this.sessionStore.get(otterId);
    if (!piSessionId) {
      throw new Error(`No agent session found for otter: ${otterId}`);
    }

    const piAgentCore = await this.ensurePiAgentCore();
    const staticPrompt = this.staticPrompts.get(otterId) ?? "";
    const otterType = this.otterTypes.get(otterId);
    const systemPromptFn = buildSystemPrompt(staticPrompt, options?.dynamicContext);

    const sessionRepo = this.createSessionRepo(piAgentCore);
    const session = sessionRepo.open(piSessionId);
    const { tools, activeToolNames } = this.getToolsForOtter(otterType);

    const harness = this.createHarness(piAgentCore, {
      session, systemPrompt: systemPromptFn, tools, activeToolNames,
    });

    let resultText = "";
    const unsubscribe = harness.subscribe((event: unknown) => {
      const e = event as AgentEvent;
      if (e.type === "message_update" && e.delta) {
        resultText += e.delta;
      }
      options?.onEvent?.(e);
    });

    try {
      await harness.prompt(message);
      await this.checkAndCompact(harness);

      const tokenUsage = harness.getTokenUsage?.();
      return {
        text: resultText,
        tokenUsage: tokenUsage
          ? { input: tokenUsage.input, output: tokenUsage.output }
          : undefined,
      };
    } finally {
      unsubscribe();
    }
  }

  /** 获取 Otter 类型的工具配置 */
  private getToolsForOtter(otterType: string | undefined): {
    tools: TTool[];
    activeToolNames?: string[];
  } {
    if (!this.toolRegistry || !otterType) {
      return { tools: this.toolRegistry?.getAllTools() ?? [] };
    }
    const activeTools = this.toolRegistry.getActiveTools(otterType);
    return {
      tools: activeTools,
      activeToolNames: activeTools.map((t: TTool) => t.name ?? t.id),
    };
  }

  /** 检查 token 用量，超阈值则 compact（R1 手动 compaction） */
  private async checkAndCompact(harness: {
    compact?(): Promise<void>;
    getTokenUsage?(): { input: number; output: number } | undefined;
  }): Promise<void> {
    const tokenUsage = harness.getTokenUsage?.();
    if (!tokenUsage) return;
    const total = tokenUsage.input + tokenUsage.output;
    if (total > COMPACT_TOKEN_THRESHOLD) {
      logger.info(`Token usage ${total} exceeds threshold, compacting...`);
      await harness.compact?.();
    }
  }

  /** 创建 JsonlSessionRepo */
  private createSessionRepo(piAgentCore: PiAgentCoreModule): {
    create(): { id: string };
    open(sessionId: string): unknown;
    delete?(sessionId: string): void;
  } {
    const RepoClass = (piAgentCore as unknown as {
      JsonlSessionRepo: new (opts: unknown) => unknown;
    }).JsonlSessionRepo;

    const repo = new RepoClass({ dir: this.sessionDir });
    return repo as {
      create(): { id: string };
      open(sessionId: string): unknown;
      delete?(sessionId: string): void;
    };
  }

  /** 创建 AgentHarness */
  private createHarness(
    piAgentCore: PiAgentCoreModule,
    opts: {
      session: unknown;
      systemPrompt: (ctx: unknown) => string;
      tools: TTool[];
      activeToolNames?: string[];
    },
  ): {
    prompt(message: string): Promise<void>;
    subscribe(callback: (event: unknown) => void): () => void;
    compact?(): Promise<void>;
    getTokenUsage?(): { input: number; output: number } | undefined;
  } {
    const HarnessClass = (piAgentCore as unknown as {
      AgentHarness: new (opts: unknown) => unknown;
    }).AgentHarness;

    const env = (piAgentCore as unknown as {
      NodeExecutionEnv: new () => unknown;
    }).NodeExecutionEnv;

    const harness = new HarnessClass({
      env: new env(),
      session: opts.session,
      models: this.models,
      model: this.model,
      tools: opts.tools,
      activeToolNames: opts.activeToolNames,
      systemPrompt: opts.systemPrompt,
    });

    return harness as {
      prompt(message: string): Promise<void>;
      subscribe(callback: (event: unknown) => void): () => void;
      compact?(): Promise<void>;
      getTokenUsage?(): { input: number; output: number } | undefined;
    };
  }
}

/**
 * 初始化 Agent 核心。
 * 异步工厂：pi-agent-core 是 ESM-only，需通过动态 import() 加载。
 */
export async function initAgentCore(config: AgentCoreConfig): Promise<PiHarnessFactory> {
  return new PiHarnessFactory(
    config.models,
    config.model,
    config.db,
    config.sessionDir ?? "./data/sessions",
    config.toolRegistry,
  );
}
