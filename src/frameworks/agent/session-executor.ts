/**
 * Session 执行器：负责使用 session 执行 invoke
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OtterPromptConfig } from "@contract/api/otter";
import type { Logger } from "@usecases/ports/logger";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { AgentEvent, AgentRunResult, InvokeOptions } from "./pi-session-factory";
import { getCodingToolsForOtterType, getOtterToolNamesForType, buildOtterPrompt, buildMessageWithContext } from "./session-helpers";
import { attachCircuitBreaker, checkTokenWarning, buildResult } from "./circuit-breaker-helpers";
import type { CircuitBreakerConfig } from "./tool-call-circuit-breaker";

/** Session 执行器配置 */
export interface SessionExecutorConfig {
  model: unknown;
  platformPrompt: string;
  resourceLoader: unknown;
  modelRuntime: unknown;
  circuitBreakerConfig: CircuitBreakerConfig;
  createTools: (ctx: unknown) => Array<{
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
  }>;
}

/** Session 执行参数 */
export interface SessionExecuteParams {
  otterId: string;
  message: string;
  options: InvokeOptions | undefined;
  sessionManager: SessionManager;
  otterConfig: { systemPrompt?: string | OtterPromptConfig; otterType: string };
  piCodingAgent: unknown;
}

/** Session 执行器 */
export class SessionExecutor {
  constructor(
    private readonly config: SessionExecutorConfig,
    private readonly otterToolClient: unknown,
    private readonly otterConfigProvider: OtterConfigProvider,
    private readonly activeSessions: Map<string, { abort: () => Promise<void>; toolCallCount: number }>,
    private readonly logger: Logger,
  ) {}

  /** 使用 session 执行 invoke */
  async executeWithSession(params: SessionExecuteParams): Promise<AgentRunResult> {
    const { otterId, message, options, sessionManager, otterConfig, piCodingAgent } = params;
    const otterType = otterConfig.otterType;
    const otterPromptConfig = otterConfig.systemPrompt;

    // 1. 构建工具配置并创建 AgentSession
    const { session, sessionKey } = await this.createSessionWithTools({
      otterId, otterType, options, sessionManager, piCodingAgent,
    });

    // 2. 熔断器
    const { circuitBreaker, unregisterToolCall } = attachCircuitBreaker(
      session, otterId, this.config.circuitBreakerConfig, this.logger,
    );

    // 3. 构建完整消息
    const otterPrompt = buildOtterPrompt(otterPromptConfig);
    const staticPrompt = [this.config.platformPrompt, otterPrompt].filter(Boolean).join("\n\n");
    const fullMessage = buildMessageWithContext(staticPrompt, message, options?.dynamicContext);

    const activeEntry = this.activeSessions.get(sessionKey);
    const unsubscribe = session.subscribe(this.createEventHandler(activeEntry, options?.onEvent));

    try {
      await session.prompt(fullMessage);
      return this.buildInvokeResult(otterId, session, circuitBreaker);
    } catch (err) {
      /** 将 toolCallCount 附着到异常，供 handleInvokeError 在 finally 清理后仍可读取 */
      (err as Error & { _toolCallCount?: number })._toolCallCount =
        this.activeSessions.get(sessionKey)?.toolCallCount ?? 0;
      throw err;
    } finally {
      circuitBreaker.clearSteerDeadline();
      unregisterToolCall?.();
      unsubscribe();
      this.activeSessions.delete(sessionKey);
      session.dispose();
    }
  }

  /** 创建带工具配置的 AgentSession */
  private async createSessionWithTools(params: {
    otterId: string;
    otterType: string;
    options: InvokeOptions | undefined;
    sessionManager: SessionManager;
    piCodingAgent: unknown;
  }) {
    const { otterId, otterType, options, sessionManager, piCodingAgent } = params;
    const conversationId = options?.conversationId ?? "";
    const messageId = options?.messageId;
    const otterToolNames = getOtterToolNamesForType(otterType);
    const customTools = this.config.createTools({
      client: this.otterToolClient,
      otterId,
      conversationId,
      currentMessageId: messageId ?? "",
    }).filter(t => otterToolNames.includes(t.name));
    const codingTools = getCodingToolsForOtterType(otterType);

    this.logger.info('Tools registered for agent session', {
      otterId, otterType,
      codingTools,
      customToolNames: customTools.map(t => t.name),
      whitelist: [...codingTools, ...customTools.map(t => t.name)],
    });

    const { createAgentSession } = piCodingAgent as { createAgentSession: (options: unknown) => Promise<{ session: unknown }> };
    const { session } = await createAgentSession({
      model: this.config.model,
      sessionManager,
      tools: [...codingTools, ...customTools.map(t => t.name)],
      customTools: customTools,
      resourceLoader: this.config.resourceLoader,
      modelRuntime: this.config.modelRuntime,
    });

    const sessionKey = messageId ? `${otterId}:${messageId}` : otterId;
    this.activeSessions.set(sessionKey, { abort: () => (session as { abort: () => Promise<void> }).abort(), toolCallCount: 0 });

    return { session, sessionKey };
  }

  /** 构建 invoke 结果 */
  private buildInvokeResult(
    otterId: string,
    session: { getSessionStats: () => { tokens: { input: number; output: number } } },
    circuitBreaker: unknown,
  ): AgentRunResult {
    const stats = session.getSessionStats();
    const tokenUsage = { input: stats.tokens.input, output: stats.tokens.output };
    checkTokenWarning(otterId, stats.tokens, this.logger);

    const ctxMax = (this.config.model as Record<string, unknown>)?.contextWindow as number | undefined;
    return buildResult("", tokenUsage, circuitBreaker as any, ctxMax);
  }

  /** 创建 session 事件处理器 */
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
}
