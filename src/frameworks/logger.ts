/** 统一日志接口，封装 console 以满足 ESLint no-console 规则。
 *  Cross-cutting concern（D39）：usecases 层可直接 import。 */
const _console = console;

export const logger = {
  info(message: string, ...args: unknown[]): void {
    _console.info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    _console.warn(message, ...args);
  },
  error(message: string, ...args: unknown[]): void {
    _console.error(message, ...args);
  },
  debug(message: string, ...args: unknown[]): void {
    _console.debug(message, ...args);
  },
};
