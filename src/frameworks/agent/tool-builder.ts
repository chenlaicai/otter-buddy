/**
 * 工具构建器。
 *
 * 从 PiSessionFactory 拆出（D2 瘦身），职责：
 * - 将 Otter 工具适配为 pi-coding-agent ToolDefinition 格式
 * - 构建 toolContext
 */

import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { truncateToolResult, type ToolResponse } from "@usecases/ports/agent-tools";
import type { Logger } from "@usecases/ports/logger";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import type { ModelPool } from "@frameworks/llm/model-pool";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";

/** buildCustomTools 所需的参数类型 */
export interface BuildCustomToolsParams {
  otterId: string;
  conversationId: string;
  allowedNames: string[];
  messageId?: string;
  turnText?: { text: string };
  otterToolClient: OtterToolClient;
  modelPool?: ModelPool;
  otterConfigProvider?: OtterConfigProvider;
  createTools: (ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger) => AgentTool[];
  healingRepo?: HealingEventRepository;
  /** F20260826mwrd C1：signal 工具（halt_otter/query_signals）的仓库 */
  signalRepo?: SignalEventRepository;
  logger: Logger;
}

/** buildCustomTools 返回类型 */
export interface BuildCustomToolsResult {
  tools: Array<{
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResponse>;
  }>;
  toolContext: ToolContext;
}

/**
 * 将 Otter 工具适配为 pi-coding-agent ToolDefinition 格式。
 * 适配点：label 字段 + execute 透传 signal（M1: 用户中断时工具可检查 signal.aborted 提前返回）。
 * onUpdate/ctx SDK 特有，Otter 工具不需要，忽略。
 */
export function buildCustomTools(params: BuildCustomToolsParams): BuildCustomToolsResult {
  const { otterId, conversationId, allowedNames, messageId, turnText, otterToolClient, modelPool, otterConfigProvider, createTools, healingRepo, signalRepo, logger } = params;
  // F20260826mwrd C1：signalRepo 挂 ToolContext（tool-factory 从 ctx 读，避免 createTools 参数膨胀）

  // F20260815rstrt: 返回 toolContext 引用，供 PiSessionFactory 检查 pendingRestart
  const toolContext: ToolContext = {
    client: otterToolClient,
    otterId,
    conversationId,
    currentMessageId: messageId ?? "",
    modelPool,
    otterConfigProvider,
    getTurnAssistantText: turnText ? () => turnText.text : undefined,
    /** F20260813actk C9：每次 invoke 新建待派工票据 Map（agent turn 级生命周期） */
    pendingDispatches: new Map<string, string>(),
    dispatchWarningShown: false,
    /** F20260821i336：编排守卫提醒标志（agent turn 级生命周期） */
    orchestrationWarningShown: false,
    /** F20260826mwrd C1：signal 仓库（halt_otter/query_signals 注册条件） */
    signalRepo,
  };
  const otterTools = createTools(toolContext, healingRepo, logger);

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
          // F20260904tflp：摩擦精确时刻触发提示——错误结果尾部引导 tool_use_feedback 反馈。
          // 仅 isError 时出现（无噪音）；speak 自身报错不提示（反馈动作发生在 speak，避免循环暗示）。
          if (t.name !== "speak") {
            truncated.content = truncated.content.map(c =>
              c.type === "text" && c.text.length > 0
                ? { ...c, text: `${c.text}\n[提示] 此工具报错了？若属难用/参数设计问题，可在下次 speak 末尾用 healing 块反馈（type: tool_use_feedback，description 以 [tool:${t.name}] 开头）` }
                : c
            );
          }
        }
        return truncated;
      },
    }));

  return { tools, toolContext };
}
