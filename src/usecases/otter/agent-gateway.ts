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

/** F20260923hspx：Agent reset 渠道路由——normal=常规 invoke 池复用锁路径；
 *  handoff=交接冻结锁已由调用方持有，走 resetForHandoff 锁旁路变体。 */
export type AgentResetChannel = 'normal' | 'handoff';

/** Agent 生命周期网关接口（由 frameworks/agent/ 实现） */
export interface AgentGateway {
  create(otterId: string, config: AgentConfig): Promise<void>;
  destroy(otterId: string): Promise<void>;
  reset(otterId: string, context?: AgentContext, channel?: AgentResetChannel): Promise<void>;
  /** F20260923hspx：交接换世隔离通道——reset 的锁旁路变体。Precondition：调用方已持交接冻结锁
   *  （acquireSessionLock）。Why：交接换世复用 invoke 池复用锁路径 = 一把锁双目的 + 不可重入
   *  = 自死锁（9/23 实证 4 獭连续「Lock acquire timeout」，holderHeldForMs 恂 ≈120s、
   *  queueLength=0——等的是自己）。本通道让 per-otter 锁退回单目的（invoke 池复用短临界区）。
   *  可选——未实现时 reset(channel='handoff') 降级走正常 reset（旧行为，保持兼容）。 */
  resetForHandoff?(otterId: string, context?: AgentContext): Promise<void>;
  /** P3a ① URGENT steer 注入：向活跃 session 注入打断询问文案。
   *  返回 true=注入成功（session 活跃），false=不可达（降级 busyQueue）。
   *  可选方法——未实现时路由器跳过 steer 路径（行为等同 false）。 */
  steerSession?(otterId: string, text: string): boolean;
}
