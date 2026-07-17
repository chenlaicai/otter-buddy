import type { OtterPromptConfig } from "@contract/api/otter";

/** Agent 配置（create 时传入） */
export interface AgentConfig {
  /** Otter 级系统提示词（可选，与平台 prompt 叠加） */
  systemPrompt?: string | OtterPromptConfig;
  context?: Record<string, unknown>;
}

/** Agent 重置上下文 */
export interface AgentContext {
  systemPrompt?: string | OtterPromptConfig;
  context?: Record<string, unknown>;
}

/** Agent 生命周期网关接口（由 frameworks/agent/ 实现） */
export interface AgentGateway {
  create(otterId: string, config: AgentConfig): Promise<void>;
  destroy(otterId: string): Promise<void>;
  reset(otterId: string, context?: AgentContext): Promise<void>;
}
