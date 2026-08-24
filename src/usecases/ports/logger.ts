/**
 * Logger 接口定义在 usecases 层（高层模块）。
 * 符合依赖反转原则（DIP）：高层模块定义接口，低层模块实现。
 */
export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface LogContext {
  [key: string]: unknown;
  /** HTTP 请求 ID */
  requestId?: string;
  /** Otter ID */
  otterId?: string;
  /** 对话 ID */
  conversationId?: string;
  /** Session ID */
  sessionId?: string;
  /** 用户 ID */
  userId?: string;
  /** 模块名 */
  module?: string;
  /** 耗时（ms） */
  duration?: number;
  /** HTTP 状态码 */
  statusCode?: number;
  /** PR ID（PR 评估体系） */
  prId?: string;
}
