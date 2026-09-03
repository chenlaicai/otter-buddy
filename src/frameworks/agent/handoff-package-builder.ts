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

export type { StateInventoryDeps };
import { buildSynthesisPrompt, buildMechanicalDump } from './synthesis-prompt-builder';
import type { SynthesisPrefetch } from './synthesis-prompt-builder';
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
  /** F20260901mbfx：§④/⑥ 机械预取数据（枚举型事实机械供料，不再依赖 LLM 自行调工具） */
  prefetch?: SynthesisPrefetch;
  /** F20260903lngth：合成降级结果回调（timeout/error 在此捕获；success/empty/truncated 在合成闭包内） */
  onSynthesisOutcome?: (outcome: "error" | "timeout") => void;
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
    prefetch,
    trigger = '70%阈值',
    onSynthesisOutcome,
  } = options;

  // 审视 P2：件④只收集一次，渲染文本与合成 prompt 共用同一对象——
  // 避免双重 6 次 DB 查询，也消除竞态窗口内两次结果不一致的问题（收敛文档设计：一次聚合两用）
  const inventoryPromise = collectStateInventory(conversationId, otterId, stateInventoryDeps)
    .then(inv => ({ text: renderStateInventory(inv), inv }) as const)
    .catch(err => {
      logger?.warn('[handoff-package] State inventory failed', { error: String(err) });
      return { text: '## 活状态盘点（生成失败，降级为空）', inv: null } as const;
    });

  // 并行执行件②③④（机械提取，零 LLM 成本）
  const [fileTrailResult, recencyResult, inventoryPair] = await Promise.all([
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
    // 件④：活状态盘点（一次收集，文本与对象两用）
    inventoryPromise,
  ]);
  const inventoryResult = inventoryPair.text;
  const inventoryObj = inventoryPair.inv;

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
    prefetch,
    logger,
    onSynthesisOutcome,
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
/**
 * F20260903lngth：带超时的合成调用（超时/异常统一走 SynthesisFailureError，
 * 调用方凭 outcome 字段回传 metrics，不再内联分支判定）。
 */
class SynthesisFailureError extends Error {
  constructor(
    readonly outcome: "timeout" | "error",
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

async function synthesizeWithTimeout(synthesize: SynthesisFunction, prompt: string, timeoutMs: number): Promise<string> {
  try {
    return await Promise.race([
      synthesize(prompt),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Synthesis timeout')), timeoutMs)
      ),
    ]);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'Synthesis timeout';
    throw new SynthesisFailureError(isTimeout ? 'timeout' : 'error', err);
  }
}

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
  prefetch: SynthesisPrefetch | undefined,
  logger?: Logger,
  onSynthesisOutcome?: (outcome: "error" | "timeout") => void,
): Promise<string> {
  // 防线①：LLM 叙事合成
  if (synthesize) {
    try {
      const prompt = buildSynthesisPrompt({
        otterName,
        // F20260901mbfx（审计 F2）：oldSessionId 由调用方（handleHandoff）机械查询注入，
        // 堆叠 fallback 仅限极端未注入场景（手动路径未传时）——旧 session 是可查的枚举事实，
        // 不该退化为 otterId（曾致谱系行永远显示 otter UUID，跨代不可区分）。
        oldSessionId: oldSessionId ?? otterId,
        lineage,
        stateInventory: inventoryObj ?? undefined,
        stateInventoryText: inventoryText,
        trigger: trigger as '70%阈值' | '手动' | '熔断',
        prefetch,
      });

      logger?.info('[handoff-package] Starting LLM synthesis', { otterId });

      const result = await synthesizeWithTimeout(synthesize, prompt, 60_000)
        .catch((err: SynthesisFailureError) => {
          // F20260903lngth：timeout/error 降级结果回传 metrics
          onSynthesisOutcome?.(err.outcome);
          throw err;
        });
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
