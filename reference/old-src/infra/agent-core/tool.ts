/**
 * AgentTool 类型定义 + 注册辅助。
 *
 * AgentToolDef 是 infra 层的工具抽象，屏蔽 pi-agent-core 的 TypeBox 依赖。
 * agent-core 内部将 AgentToolDef 转换为 pi-agent-core 的 AgentTool。
 */

export interface AgentToolDef {
  /** 工具唯一 ID（用于注销） */
  id: string;
  /** 工具名称（LLM 可见） */
  name: string;
  /** 工具描述（LLM 可见） */
  description: string;
  /** 参数 JSON Schema（TypeBox 格式） */
  schema: Record<string, unknown>;
  /** 执行函数 */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
