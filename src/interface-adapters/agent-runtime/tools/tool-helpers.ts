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

/** F20260804hcob: html-card 围栏匹配（``` 与 ~~~ 两种合法围栏，与渲染侧对齐），排除 html-card-reply（回执围栏，不算卡片） */
const HTML_CARD_FENCE = /(?:```|~~~)html-card(?!-reply)/;

/**
 * speak body 校验：返回错误文案（null 表示通过）。
 * F20260804hcob: 除空 body 外，还检测"卡片写在 speak 外"——assistant 文本不持久化，
 * 写在里面的 html-card 搭档根本看不到，必须拒绝并指导模型把围栏移入 body 重试。
 */
export function validateSpeakBody(turnAssistantText: string | undefined, cleanBody: string): string | null {
  if (!cleanBody || cleanBody.trim().length === 0) return "[错误] body 不能为空。请提供你的最终答复内容，然后重新调用 speak。";
  if (turnAssistantText !== undefined && HTML_CARD_FENCE.test(turnAssistantText) && !HTML_CARD_FENCE.test(cleanBody)) {
    return "[错误] 检测到你把 ```html-card 卡片写在了 speak 之外的文本里——那段文本不会进入消息，搭档根本看不到卡片。请把完整的 ```html-card 围栏（含全部 HTML）原样移入本次 speak 的 body 参数，重新调用 speak。";
  }
  return null;
}
