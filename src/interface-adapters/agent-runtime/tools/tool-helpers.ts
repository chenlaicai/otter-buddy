/** Tool 执行结果（Pi AgentTool 格式） */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {} };
}
