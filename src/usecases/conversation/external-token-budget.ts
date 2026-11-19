import { DomainError } from "@entities/errors";

/** 外部对话额度错误的稳定机器码；CoLink 适配器只认此前缀，不向用户展示内部错误细节。 */
export const EXTERNAL_TOKEN_BUDGET_ERROR_CODE = "EXTERNAL_TOKEN_BUDGET_EXCEEDED";
export const EXTERNAL_TOKEN_BUDGET_ERROR_PREFIX = `${EXTERNAL_TOKEN_BUDGET_ERROR_CODE}:`;

export function externalTokenBudgetExceeded(message: string): DomainError {
  return new DomainError(`${EXTERNAL_TOKEN_BUDGET_ERROR_PREFIX}${message}`, "validation");
}

/** Asia/Shanghai 当前没有夏令时；用固定 +08:00 偏移计算本地日界，避免宿主机 TZ 影响。 */
export function shanghaiDayRange(now: Date): { start: string; end: string } {
  const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = shanghaiNow.toISOString().slice(0, 10);
  const startMs = Date.parse(`${day}T00:00:00+08:00`);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}
