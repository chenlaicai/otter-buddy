/**
 * 四件套编排器（F20260825hndf）
 *
 * 编排交接上下文包的组装：摘要 + 文件轨迹 + 近期原文 + 活状态盘点。
 * Phase 2：摘要使用 LLM 叙事合成（防线①），降级为机械转储（防线②）。
 *
 * Phase 1 降级声明（仍有效）：
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
import type { StateInventory, StateInventoryDeps } from './state-inventory';
import { buildSynthesisPrompt, buildMechanicalDump } from './synthesis-prompt-builder';
import type { Logger } from '@usecases/ports/logger';

/** 四件套完整包 */
export interface HandoffPackage {
  summary: string;
  fileTrail: string;
  recencyWindow: string;
  stateInventory: string;
  totalTokenEstimate: number;
}

/** LLM 合成函数类型 */
export type SynthesisFunction = (prompt: string) => Promise<string>;

/** 编排选项 */
export interface HandoffPackageOptions {
  fileTrailMaxEntries?: number;
  recencyTokens?: number;
  stateInventoryDeps: StateInventoryDeps;
  queryMessage: QueryMessage;
  logger?: Logger;
  /** Phase 2：LLM 合成函数（readOnly invocation）。未提供时降级为机械转储。 */
  synthesize?: SynthesisFunction;
  /** otter 名称（用于摘要 meta 行） */
  otterName?: string;
  /** 旧 session ID（用于摘要 meta 行和谱系） */
  oldSessionId?: string;
  /** 交接谱系（从旧 summary 继承） */
  lineage?: string;
  /** 触发原因 */
  trigger?: '70%阈值' | '手动' | '熔断';
}

/**
 * 构建四件套上下文包。
 *
 * Phase 2 升级：件①摘要优先使用 LLM 叙事合成（防线①），
 * 失败/超时时降级为机械转储（防线②）。
 */
// eslint-disable-next-line max-lines-per-function -- Phase 2: LLM 合成 + 降级链 + 件②③④并行组装
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
    synthesize,
    otterName = otterId,
    oldSessionId,
    lineage,
    trigger = '70%阈值',
  } = options;

  // 并行执行件②③④（机械提取，零 LLM 成本）
  const [fileTrailResult, recencyResult, inventoryResult, inventoryObj] = await Promise.all([
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
    // 件④：活状态盘点（渲染文本）
    collectStateInventory(conversationId, otterId, stateInventoryDeps)
      .then(inv => {
        const text = renderStateInventory(inv);
        return { text, inv };
      })
      .catch(err => {
        logger?.warn('[handoff-package] State inventory failed', { error: String(err) });
        return { text: '## 活状态盘点（生成失败，降级为空）', inv: null };
      })
      .then(r => r.text),
    // 件④原始对象（用于注入合成 prompt）
    collectStateInventory(conversationId, otterId, stateInventoryDeps)
      .catch(() => null),
  ]);

  // 件①：摘要生成（防线① LLM 合成 → 防线② 机械转储）
  const summary = await generateSummary(
    otterId,
    otterName,
    oldSessionId,
    lineage,
    trigger,
    inventoryObj,
    inventoryResult,
    synthesize,
    logger,
  );

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
 * 生成件①摘要。
 *
 * 防线①：LLM 叙事合成（readOnly invocation）
 * 防线②：机械转储（LLM 失败/超时时降级）
 */
// eslint-disable-next-line max-params -- 防线①/②合成链路需要完整上下文参数
async function generateSummary(
  otterId: string,
  otterName: string,
  oldSessionId: string | undefined,
  lineage: string | undefined,
  trigger: string,
  inventoryObj: StateInventory | null,
  inventoryText: string,
  synthesize: SynthesisFunction | undefined,
  logger?: Logger,
): Promise<string> {
  // 防线①：LLM 叙事合成
  if (synthesize) {
    try {
      const prompt = buildSynthesisPrompt({
        otterName,
        oldSessionId: oldSessionId ?? otterId,
        lineage,
        stateInventory: inventoryObj ?? undefined,
        stateInventoryText: inventoryText,
        trigger: trigger as '70%阈值' | '手动' | '熔断',
      });

      logger?.info('[handoff-package] Starting LLM synthesis', { otterId });

      // 设置超时（60s）
      const timeoutMs = 60_000;
      const result = await Promise.race([
        synthesize(prompt),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Synthesis timeout')), timeoutMs)
        ),
      ]);

      if (result && result.trim().length > 0) {
        logger?.info('[handoff-package] LLM synthesis succeeded', {
          otterId,
          length: result.length,
        });
        return result;
      }
      logger?.warn('[handoff-package] LLM synthesis returned empty, falling back to mechanical dump');
    } catch (err) {
      logger?.warn('[handoff-package] LLM synthesis failed, falling back to mechanical dump', {
        otterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 防线②：机械转储
  return buildMechanicalDump(otterName, trigger, inventoryText);
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
