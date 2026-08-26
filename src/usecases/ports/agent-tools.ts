/**
 * Agent 工具领域接口（R20260817arnt PR-A / D2 拍板）。
 *
 * 工具是"给 LLM 的手脚"，其契约（AgentTool/ToolContext/ToolResponse）是应用层概念——
 * interface-adapters（工具实现与文案）与 frameworks（pi-session-factory 装载）双方
 * 都可依赖本 port（外层依内层）。此前这组类型定义在 interface-adapters，导致
 * pi-session-factory 反向 import interface-adapters（分层倒穿）；truncateToolResult
 * 及其返回类型 ToolResponse 从 tools/tool-helpers.ts 随迁至此。
 *
 * ToolContext 的 pendingRestart / getTurnAssistantText 字段携带 SDK 会话生命周期协议
 * 语义（由 session 工厂消费/维护）——换 SDK 时需修订本 port，字段注释有警示。
 */
import type { OtterToolClient } from "./otter-tool-client";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import type { ModelPoolLike } from "./model-pool-like";
import type { OtterConfigProvider } from "./otter-config-provider";

/**
 * 工具层的模型池窄接口（R20260817arnt PR-A）：工具只做 modelAlias 校验与列举，
 * 不需要默认模型切换/全量信息。具体 ModelPool 结构化兼容，无需 adapter。
 * 取代 tool-factory 内的重复 ModelPoolLike 定义（双定义消除）。
 */
export type ToolModelPool = Pick<ModelPoolLike, "hasModel" | "describeModels">;

/** Tool 执行结果（Pi AgentTool 格式） */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  /**
   * F20260811sktp: 错误标志。
   * SDK 的 AgentToolResult 不直接消费此字段——otter-hooks 的 tool_result extension handler
   * 把它复制到 details.__isError，再由 handler 返回 { isError: true } 覆盖 SDK 的 isError 标志，
   * 从而透传到 Anthropic API 的 tool_result.is_error。
   */
  isError?: boolean;
  /** 置 true 时 agent loop 在本批次工具执行后终止，不再发起下一轮 LLM 调用（Pi 原生能力） */
  terminate?: boolean;
}

export function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * F20260811sktp: 错误返回工厂。
 * 文案保留 `[错误]` 前缀（人类可读），同时设 isError=true（机器可识别）。
 * 经 otter-hooks tool_result handler 透传到 Anthropic API 的 is_error 字段。
 */
export function errorResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}

/** 单个 tool result 最大字符数（~4K tokens，防止巨量结果污染上下文导致模型退化） */
export const MAX_TOOL_RESULT_CHARS = 15_000;

/**
 * 截断过大的 tool result，防止上下文膨胀导致模型退化。
 * 策略：超过阈值时智能截断（JSON 模式保留完整条目），附加截断提示。
 */
export function truncateToolResult(result: ToolResponse): ToolResponse {
  return {
    ...result,
    content: result.content.map(c => {
      if (c.type !== "text" || c.text.length <= MAX_TOOL_RESULT_CHARS) return c;
      const truncated = smartTruncate(c.text, MAX_TOOL_RESULT_CHARS);
      return {
        type: "text" as const,
        text: `${truncated}\n\n[结果已截断，请缩小查询范围或使用分段参数获取完整内容。]`,
      };
    }),
  };
}

/**
 * 智能截断：JSON 数组在条目边界截断，其他文本在字符边界截断。
 * 支持顶级数组 `[...]` 和嵌套结构 `{"data": [...]}`
 */
function smartTruncate(text: string, maxChars: number): string {
  const trimmed = text.slice(0, maxChars);
  // 找到 JSON 数组起始位置（顶级或嵌套）
  const arrStart = trimmed.indexOf("[");
  if (arrStart >= 0 && arrStart < 100) {
    const lastEntryEnd = trimmed.lastIndexOf("},");
    if (lastEntryEnd > arrStart) {
      return trimmed.slice(0, lastEntryEnd + 1) + "\n]";
    }
    const lastClose = trimmed.lastIndexOf("}");
    if (lastClose > arrStart) {
      return trimmed.slice(0, lastClose + 1) + "\n]";
    }
  }
  return trimmed;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 执行工具。
   * M1（R20260810piab）：signal 透传 SDK 的 AbortSignal——用户中断时工具可检查 signal.aborted 提前返回。
   * 大多数工具不需要中断（执行快），signal 参数可选；长耗时工具（如 workspace_* 操作大文件）应定期检查。
   */
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResponse>;
  [key: string]: unknown;
}

/**
 * 工具上下文：invoke 时由系统注入，闭包捕获。
 * otterId、conversationId、currentMessageId 由系统注入，LLM 不传。
 */
export interface ToolContext {
  client: OtterToolClient;
  otterId: string;
  conversationId: string;
  currentMessageId: string;
  /** 模型池（多模型路由，可选，用于校验 modelAlias） */
  modelPool?: ToolModelPool;
  /** F20260824aibd: Otter 配置提供者（用于查询其他獭的 modelAlias） */
  otterConfigProvider?: OtterConfigProvider;
  /**
   * 当前 assistant 消息的文本（speak 之外的输出）。
   * 由 session 工厂按消息维护（message_start 清零、message_end 累积）；speak 用它检测"卡片写在 speak 外"的错误用法。
   */
  getTurnAssistantText?: () => string;
  /**
   * F20260815rstrt: 自重启时由 restart_otter 工具设置。
   * PiSessionFactory 在 session.prompt() 返回后检查并执行重启。
   * Why: session.prompt() 是原子的，中途无法替换 session；
   * 延迟到 prompt 完成后执行，消息生命周期不受影响。
   */
  pendingRestart?: { summary?: string };
  /**
   * F20260813actk C9：本轮待派工票据（otterId → otterName）。
   * create_otter 创建后注册；speak 派工后清除已覆盖的；未清空时 speak 给一次软提醒（非阻断）。
   * agent invoke 级生命周期（每次 invoke 新建）。可选——未注入时 C9 no-op。
   */
  pendingDispatches?: Map<string, string>;
  /** F20260813actk C9：本轮是否已展示过派工提醒。避免软守卫死循环——首次提醒后二次 speak 放行。 */
  dispatchWarningShown?: boolean;
  /** F20260821i336：本轮是否已展示过编排守卫提醒。二次放行——首次提醒后再次调用 write/edit/bash 放行。 */
  orchestrationWarningShown?: boolean;
  /** F20260826mwrd C1：signal_events 仓库（halt_otter/query_signals 注册条件；invoke 级注入） */
  signalRepo?: SignalEventRepository;

}
