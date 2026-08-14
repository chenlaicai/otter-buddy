/**
 * PinoLogger 实现在 frameworks 层（低层模块）。
 * 符合依赖反转原则（DIP）：高层模块定义接口，低层模块实现。
 */
import pino from 'pino';
import type { Logger, LogContext } from '@usecases/ports/logger';
import { traceLogFields } from '@usecases/ports/trace-context';

export class PinoLogger implements Logger {
  private pino: pino.Logger;

  constructor(optionsOrLogger?: pino.LoggerOptions | pino.Logger) {
    if (optionsOrLogger && 'child' in optionsOrLogger) {
      // 传入的是 pino.Logger 实例
      this.pino = optionsOrLogger;
    } else {
      // 传入的是配置选项
      this.pino = pino(optionsOrLogger as pino.LoggerOptions);
    }
  }

  /** F20260814mtrc：合并 trace 字段（traceId/messageId）；显式 context 优先 */
  private withTrace(context?: LogContext): LogContext | undefined {
    const trace = traceLogFields();
    if (!trace.traceId && !trace.messageId) return context;
    return { ...trace, ...context };
  }

  info(message: string, context?: LogContext): void {
    this.pino.info(this.withTrace(context), message);
  }

  warn(message: string, context?: LogContext): void {
    this.pino.warn(this.withTrace(context), message);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.pino.error({ ...this.withTrace(context), err: error }, message);
  }

  debug(message: string, context?: LogContext): void {
    this.pino.debug(this.withTrace(context), message);
  }

  child(context: LogContext): Logger {
    return new PinoLogger(this.pino.child(context));
  }

  /**
   * 刷新日志缓冲区，确保所有日志都被写入。
   * 在进程退出时调用，防止日志丢失。
   */
  flush(): void {
    this.pino.flush();
  }
}
