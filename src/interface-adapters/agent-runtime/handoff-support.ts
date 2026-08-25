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
export const HANDOFF_THRESHOLD = 0.7;
export const DEFAULT_CTX_MAX = 128_000;

/** handoff 状态管理 */
export class HandoffState {
  private readonly lastCtxTokens = new Map<string, number>();
  private readonly inProgress = new Map<string, boolean>();

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
}

/**
 * Pre-invoke 检查：上轮 ctxTokens 超阈值时返回 true。
 */
export function shouldTriggerHandoff(
  otterId: string,
  state: HandoffState,
  ctxMax: number,
): boolean {
  const prevTokens = state.getLastCtxTokens(otterId);
  return prevTokens !== undefined && prevTokens > 0 && prevTokens >= ctxMax * HANDOFF_THRESHOLD;
}

/**
 * Post-turn 记录：保存本轮 ctxTokens。
 */
export async function recordPostTurnTokens(
  otterId: string,
  messageId: string,
  queryMessage: { getMessageById: (id: string) => Promise<{ contextTokens?: number | null } | null> },
  state: HandoffState,
  _logger?: Logger,
): Promise<void> {
  try {
    const msg = await queryMessage.getMessageById(messageId);
    if (msg?.contextTokens && msg.contextTokens > 0) {
      state.setLastCtxTokens(otterId, msg.contextTokens);
    }
  } catch {
    // 非致命
  }
}

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
