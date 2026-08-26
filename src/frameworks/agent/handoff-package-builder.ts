/**
 * 四件套编排器（F20260825hndf）
 *
 * 编排交接上下文包的组装：摘要 + 文件轨迹 + 近期原文 + 活状态盘点。
 * Phase 1：摘要使用机械转储（不走 LLM）；Phase 2 将升级为 LLM 合成。
 *
 * Phase 1 降级声明：
 * - 件②文件轨迹：仅包含工作区存量文件列表（SDK session entries 不可直接访问）
 * - 件③近期原文：通过 queryMessage 拉取应用层消息做近似
 */

import type { QueryMessage } from '@usecases/conversation/query-message';
import type { Message } from '@entities/conversation/message';
import { aggregateBody } from '@entities/conversation/message';
import { scanWorkspaceFiles, renderFileTrail } from './file-trail-extractor';
import type { FileTrail } from './file-trail-extractor';
import { renderRecencyWindow, estimateRecencyTokens } from './recency-window';
import type { RecencyWindow, TurnFragment } from './recency-window';
import { collectStateInventory, renderStateInventory } from './state-inventory';
import type { StateInventoryDeps } from './state-inventory';
import type { Logger } from '@usecases/ports/logger';

/** 四件套完整包 */
export interface HandoffPackage {
  summary: string;
  fileTrail: string;
  recencyWindow: string;
  stateInventory: string;
  totalTokenEstimate: number;
}

/** 编排选项 */
export interface HandoffPackageOptions {
  fileTrailMaxEntries?: number;
  recencyTokens?: number;
  stateInventoryDeps: StateInventoryDeps;
  queryMessage: QueryMessage;
  logger?: Logger;
}

/**
 * 构建四件套上下文包。
 */
export async function buildHandoffPackage(
  conversationId: string,
  otterId: string,
  options: HandoffPackageOptions,
): Promise<HandoffPackage> {
  const {
    recencyTokens = 8000,
    stateInventoryDeps,
    queryMessage,
    logger,
  } = options;

  const [fileTrailResult, recencyResult, inventoryResult] = await Promise.all([
    // 件②：文件轨迹（Phase 1 降级：仅工作区存量）
    Promise.resolve().then(() => {
      const workspaceFiles = stateInventoryDeps.workspacePath
        ? scanWorkspaceFiles(stateInventoryDeps.workspacePath)
        : [];
      const trail: FileTrail = { modified: [], readOnly: [], workspaceFiles };
      return renderFileTrail(trail);
    }),
    // 件③：近期原文
    fetchRecentMessages(queryMessage, conversationId, recencyTokens)
      .then(w => renderRecencyWindow(w))
      .catch(err => {
        logger?.warn('[handoff-package] Recency window failed', { error: String(err) });
        return '';
      }),
    // 件④：活状态盘点
    collectStateInventory(conversationId, otterId, stateInventoryDeps)
      .then(inv => renderStateInventory(inv))
      .catch(err => {
        logger?.warn('[handoff-package] State inventory failed', { error: String(err) });
        return '## 活状态盘点（生成失败，降级为空）';
      }),
  ]);

  const summary = buildMechanicalDump(otterId);

  const estimate = (text: string) => Math.ceil(text.length / 4);
  const totalTokenEstimate = estimate(summary) + estimate(fileTrailResult) +
    estimate(recencyResult) + estimate(inventoryResult);

  logger?.info('[handoff-package] Built', { total: totalTokenEstimate });

  return {
    summary,
    fileTrail: fileTrailResult,
    recencyWindow: recencyResult,
    stateInventory: inventoryResult,
    totalTokenEstimate,
  };
}

/**
 * 通过 queryMessage 获取近期消息并转换为 RecencyWindow。
 */
async function fetchRecentMessages(
  queryMessage: QueryMessage,
  conversationId: string,
  tokenBudget: number,
): Promise<RecencyWindow> {
  const messages = await queryMessage.getMessages(conversationId, { limit: 20 });

  const turns: TurnFragment[] = [];
  let totalTokens = 0;
  let timeFrom: string | undefined;
  let timeTo: string | undefined;

  for (const msg of messages) {
    const fragment = messageToFragment(msg);
    if (!fragment) continue;

    const fragTokens = estimateRecencyTokens(fragment.content) +
      (fragment.toolSummary ? estimateRecencyTokens(fragment.toolSummary) : 0);

    if (totalTokens + fragTokens > tokenBudget && turns.length > 0) break;

    turns.push(fragment);
    totalTokens += fragTokens;

    if (fragment.timestamp) {
      if (!timeTo) timeTo = fragment.timestamp;
      timeFrom = fragment.timestamp;
    }
  }

  turns.reverse();

  return {
    turns,
    tokenEstimate: totalTokens,
    turnCount: turns.filter(f => f.role === 'user').length,
    timeRange: { from: timeFrom, to: timeTo },
  };
}

/** 将 Message 转换为 TurnFragment */
function messageToFragment(msg: Message): TurnFragment | null {
  const content = aggregateBody(msg.segments);
  if (!content.trim()) return null;

  if (msg.senderType === 'user') {
    return { role: 'user', content, timestamp: msg.createdAt };
  }

  if (msg.senderType === 'otter') {
    return { role: 'assistant', content, timestamp: msg.createdAt };
  }

  return null;
}

/** Phase 1 机械转储摘要 */
function buildMechanicalDump(otterId: string): string {
  const parts: string[] = [
    '## 交接摘要（机械转储，Phase 1 降级）',
    `meta: ${otterId} | ${new Date().toISOString()} | 触发: 70% 阈值`,
    '',
    '### 说明',
    '- 这是 Phase 1 机械转储，Phase 2 将替换为 LLM 合成的结构化摘要',
    '- 完整上下文请查阅：记忆检索（search_messages）、产物（list_artifacts）、上下文（get_context）',
  ];
  return parts.join('\n');
}
