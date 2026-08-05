/** Tool 执行结果（Pi AgentTool 格式） */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  /** 置 true 时 agent loop 在本批次工具执行后终止，不再发起下一轮 LLM 调用（Pi 原生能力） */
  terminate?: boolean;
}

export function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {} };
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
