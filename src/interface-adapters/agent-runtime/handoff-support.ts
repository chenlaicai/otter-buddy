/**
 * F20260825hndf：优雅上下文交接支持模块
 *
 * 从 agent-invoker.ts 抽取交接触发逻辑，降低主文件复杂度。
 * 职责：pre-invoke 阈值检查、handleHandoff 编排、context 恢复/清理。
 */

import type { DynamicContext } from "@usecases/ports/sdk-invoke-port";
import type { ManageContext } from "@usecases/otter/manage-context";
import type { Logger } from "@usecases/ports/logger";

/** handoff 阈值常量 */
export const DEFAULT_CTX_MAX = 128_000;

/** handoff 状态管理 */
export class HandoffState {
  private readonly lastCtxTokens = new Map<string, number>();
  private readonly inProgress = new Map<string, boolean>();
  /** F20260923hsyn：连续交接失败计数（死循环熔断——9/23 压缩死亡链：失败后 continuing with
   *  current session → ctx 继续涨 → 再触发再失败。连续 2 次失败则强制跳过合成直接机械档案，
   *  断「再试一次同样超窗」的循环；成功后清零） */
  private readonly consecutiveFailCount = new Map<string, number>();

  getLastCtxTokens(otterId: string): number | undefined {
    return this.lastCtxTokens.get(otterId);
  }

  setLastCtxTokens(otterId: string, tokens: number): void {
    this.lastCtxTokens.set(otterId, tokens);
  }

  clearLastCtxTokens(otterId: string): void {
    this.lastCtxTokens.delete(otterId);
  }

  isInProgress(otterId: string): boolean {
    return this.inProgress.get(otterId) ?? false;
  }

  setInProgress(otterId: string, value: boolean): void {
    this.inProgress.set(otterId, value);
  }

  /** F20260923hsyn：记录一次交接失败（合成失败/锁超时等），返回累计失败次数 */
  recordHandoffFailure(otterId: string): number {
    const n = (this.consecutiveFailCount.get(otterId) ?? 0) + 1;
    this.consecutiveFailCount.set(otterId, n);
    return n;
  }

  /** F20260923hsyn：交接成功后清零失败计数 */
  clearHandoffFailures(otterId: string): void {
    this.consecutiveFailCount.delete(otterId);
  }

  /** F20260923hsyn：当前连续失败次数 */
  getConsecutiveFailures(otterId: string): number {
    return this.consecutiveFailCount.get(otterId) ?? 0;
  }
}

/**
 * Pre-invoke 检查：上轮 ctxTokens 超阈值时返回 true。
 */
/**
 * 从 otter_context 恢复交接上下文（借用式，消费即删）。
 */
export async function restoreHandoffContext(
  otterId: string,
  ctx: DynamicContext,
  manageContext: ManageContext | undefined,
  _logger?: Logger,
): Promise<void> {
  if (!manageContext) return;
  const keys = ['handoff_file_trail', 'handoff_recency_window', 'handoff_state_inventory'] as const;
  const targets = ['fileTrail', 'recencyWindow', 'stateInventory'] as const;

  for (let i = 0; i < keys.length; i++) {
    try {
      const result = await manageContext.get(otterId, keys[i]);
      const value = result[keys[i]];
      if (value) {
        (ctx as Record<string, unknown>)[targets[i]] = value;
        await manageContext.delete(otterId, keys[i]);
        _logger?.debug('[handoff] Restored and consumed context key', { otterId, key: keys[i] });
      }
    } catch {
      // 非致命
    }
  }
}
