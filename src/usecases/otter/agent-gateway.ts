import type { OtterPromptConfig } from "@contract/api/otter";

/** Agent 配置（create 时传入） */
export interface AgentConfig {
  /** Otter 级系统提示词（可选，与平台 prompt 叠加） */
  systemPrompt?: string | OtterPromptConfig;
  context?: Record<string, unknown>;
  /** 模型别名（多模型路由，可选） */
  modelAlias?: string;
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
  /** P3a ① URGENT steer 注入：向活跃 session 注入打断询问文案。
   *  返回 true=注入成功（session 活跃），false=不可达（降级 busyQueue）。
   *  可选方法——未实现时路由器跳过 steer 路径（行为等同 false）。 */
  steerSession?(otterId: string, text: string): boolean;
}
