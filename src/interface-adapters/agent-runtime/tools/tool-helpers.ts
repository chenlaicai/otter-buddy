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
