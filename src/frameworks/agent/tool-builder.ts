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

/**
 * Invoke 级寄存器（F20260911pspl session 池化）。
 * 池化后工具闭包跨 invoke 复用，「每 invoke 必变」的字段集中在此，
 * invoke 入口统一重置；工具经 getter 引用读取（读取时机 = 工具执行时）。
 */
export interface InvokeRegister {
  currentMessageId: string;
  /** speak 检测「卡片写在 speak 外」用的本轮 assistant 文本缓冲 */
  turnText: { text: string };
  pendingDispatches: Map<string, string>;
  dispatchWarningShown: boolean;
  orchestrationWarningShown: boolean;
  pendingRestart?: { summary?: string; modelAlias?: string };
  /** F20260913ctlv：当前 invoke ID（invoke 级上下文——池命中不刷新则第二次 invoke 复用旧 ID，
   *  speak/yield entry 会挂错 invoke；随寄存器 invoke 入口重置） */
  currentInvokeId?: string;
  /** F20260913ctlv：SSE 发射通道（工具层发 entry.yield 等事件用；invoke 级注入） */
  emitEvent?: (event: { event: string; data: Record<string, unknown> }) => void;
  /** F20260913ctlv：当前打开的 speak entry ID（speak/yield 检测「本轮已发言」用；
   *  新 invoke 重置为 undefined） */
  lastSpeakEntryId?: string;
}

export function createInvokeRegister(): InvokeRegister {
  return {
    currentMessageId: "",
    turnText: { text: "" },
    pendingDispatches: new Map<string, string>(),
    dispatchWarningShown: false,
    orchestrationWarningShown: false,
    pendingRestart: undefined,
    currentInvokeId: undefined,
    emitEvent: undefined,
    lastSpeakEntryId: undefined,
  };
}

/** invoke 入口重置（新 invoke 开始 = 寄存器回初值；pendingRestart 由消费点清除）。
 *  F20260913ctlv 扩展：currentInvokeId/emitEvent 每次刷新（池命中不刷新则第二次
 *  invoke 复用旧 invoke ID，speak/yield entry 挂错 invoke）；lastSpeakEntryId
 *  重置 undefined（新 invoke 从零开始计发言）。 */
export function resetInvokeRegister(reg: InvokeRegister, messageId?: string, invokeDeps?: { currentInvokeId?: string; emitEvent?: (event: { event: string; data: Record<string, unknown> }) => void }): void {
  reg.currentMessageId = messageId ?? "";
  reg.turnText.text = "";
  reg.pendingDispatches.clear();
  reg.dispatchWarningShown = false;
  reg.orchestrationWarningShown = false;
  reg.pendingRestart = undefined;
  reg.currentInvokeId = invokeDeps?.currentInvokeId;
  reg.emitEvent = invokeDeps?.emitEvent;
  reg.lastSpeakEntryId = undefined;
}

/** buildCustomTools 所需的参数类型 */
export interface BuildCustomToolsParams {
  otterId: string;
  conversationId: string;
  allowedNames: string[];
  /** F20260911pspl：invoke 级寄存器（getter 绑定的读取目标） */
  register: InvokeRegister;
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
  const { otterId, conversationId, allowedNames, register, otterToolClient, modelPool, otterConfigProvider, createTools, healingRepo, signalRepo, logger } = params;
  // F20260826mwrd C1：signalRepo 挂 ToolContext（tool-factory 从 ctx 读，避免 createTools 参数膨胀）

  // F20260815rstrt: 返回 toolContext 引用，供 PiSessionFactory 检查 pendingRestart
  // F20260911pspl：invoke 级字段 getter 化——闭包捕获 ctx 对象，字段读取时
  // 穿透到寄存器当前值（池化后闭包跨 invoke 复用，寄存器在 invoke 入口重置）。
  const toolContext: ToolContext = {
    client: otterToolClient,
    otterId,
    conversationId,
    modelPool,
    otterConfigProvider,
    signalRepo,
    get currentMessageId() { return register.currentMessageId; },
    getTurnAssistantText: () => register.turnText.text,
    get pendingDispatches() { return register.pendingDispatches; },
    get dispatchWarningShown() { return register.dispatchWarningShown; },
    set dispatchWarningShown(v: boolean) { register.dispatchWarningShown = v; },
    get orchestrationWarningShown() { return register.orchestrationWarningShown; },
    set orchestrationWarningShown(v: boolean) { register.orchestrationWarningShown = v; },
    get pendingRestart() { return register.pendingRestart; },
    set pendingRestart(v: { summary?: string; modelAlias?: string } | undefined) { register.pendingRestart = v; },
    // F20260913ctlv：invoke 级字段 getter 化（与 #894 模式合流——池命中经 resetInvokeRegister 刷新）
    get currentInvokeId() { return register.currentInvokeId; },
    set currentInvokeId(v: string | undefined) { register.currentInvokeId = v; },
    get emitEvent() { return register.emitEvent; },
    get lastSpeakMessageId() { return register.lastSpeakEntryId; },
    set lastSpeakMessageId(v: string | undefined) { register.lastSpeakEntryId = v; },
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
