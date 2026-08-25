/**
 * 四件套编排器（F20260825hndf）
 *
 * 编排交接上下文包的组装：摘要 + 文件轨迹 + 近期原文 + 活状态盘点。
 * Phase 1：摘要使用机械转储（不走 LLM）；Phase 2 将升级为 LLM 合成。
 *
 * 件②③④ 纯机械，零 LLM 成本。
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { extractFileTrail, renderFileTrail } from './file-trail-extractor';
import { extractRecencyWindow, renderRecencyWindow } from './recency-window';
import { collectStateInventory, renderStateInventory } from './state-inventory';
import type { StateInventoryDeps } from './state-inventory';
import type { Logger } from '@usecases/ports/logger';

/** 四件套完整包 */
export interface HandoffPackage {
  /** 件① 结构化摘要 */
  summary: string;
  /** 件② 文件轨迹（渲染后 markdown） */
  fileTrail: string;
  /** 件③ 近期原文（渲染后 markdown） */
  recencyWindow: string;
  /** 件④ 活状态盘点（渲染后 markdown） */
  stateInventory: string;
  /** 总 token 估算 */
  totalTokenEstimate: number;
}

/** 编排选项 */
export interface HandoffPackageOptions {
  /** 件① 摘要最大 token（Phase 1 不使用，预留） */
  summaryMaxTokens?: number;
  /** 件② 最大文件条目数 */
  fileTrailMaxEntries?: number;
  /** 件③ 原文 token 预算 */
  recencyTokens?: number;
  /** 件②③④ 的状态盘点依赖 */
  stateInventoryDeps: StateInventoryDeps;
  logger?: Logger;
}

/**
 * 构建四件套上下文包。
 *
 * @param entries 当前 session 的 entries（sessionManager.getBranch()）
 * @param conversationId 对话 ID
 * @param otterId 海獭 ID
 * @param options 编排选项
 */
export async function buildHandoffPackage(
  entries: SessionEntry[],
  conversationId: string,
  otterId: string,
  options: HandoffPackageOptions,
): Promise<HandoffPackage> {
  const {
    fileTrailMaxEntries = 30,
    recencyTokens = 8000,
    stateInventoryDeps,
    logger,
  } = options;

  // 并行执行三件机械提取（件②③④）
  const [fileTrailResult, recencyResult, inventoryResult] = await Promise.all([
    // 件②：文件轨迹
    Promise.resolve().then(() => {
      const trail = extractFileTrail(entries, fileTrailMaxEntries);
      if (stateInventoryDeps.workspacePath) {
        const { scanWorkspaceFiles } = require('./file-trail-extractor');
        trail.workspaceFiles = scanWorkspaceFiles(stateInventoryDeps.workspacePath);
      }
      return renderFileTrail(trail);
    }),
    // 件③：近期原文
    Promise.resolve().then(() => {
      const window = extractRecencyWindow(entries, recencyTokens);
      return renderRecencyWindow(window);
    }),
    // 件④：活状态盘点
    collectStateInventory(conversationId, otterId, stateInventoryDeps)
      .then(inv => renderStateInventory(inv))
      .catch(err => {
        logger?.warn('[handoff-package] State inventory failed', { error: String(err) });
        return '## 活状态盘点（生成失败，降级为空）';
      }),
  ]);

  // 件①：Phase 1 使用机械转储
  const summary = buildMechanicalDump(entries, conversationId, otterId);

  // token 估算
  const estimate = (text: string) => Math.ceil(text.length / 4);
  const totalTokenEstimate = estimate(summary) + estimate(fileTrailResult) +
    estimate(recencyResult) + estimate(inventoryResult);

  logger?.info('[handoff-package] Built', {
    summaryTokens: estimate(summary),
    fileTrailTokens: estimate(fileTrailResult),
    recencyTokens: estimate(recencyResult),
    inventoryTokens: estimate(inventoryResult),
    total: totalTokenEstimate,
  });

  return {
    summary,
    fileTrail: fileTrailResult,
    recencyWindow: recencyResult,
    stateInventory: inventoryResult,
    totalTokenEstimate,
  };
}

/**
 * Phase 1 机械转储摘要。
 * 直接从 session entries 和 otter_context 机械提取关键信息，
 * 不走 LLM——这是三道防线的第二道。
 *
 * Phase 2 将替换为 LLM 合成的结构化摘要。
 */
function buildMechanicalDump(
  entries: SessionEntry[],
  conversationId: string,
  otterId: string,
): string {
  const parts: string[] = [
    `## 交接摘要（机械转储，Phase 1 降级）`,
    `meta: ${otterId} | ${new Date().toISOString()} | 触发: 70% 阈值`,
  ];

  // 从最近几条消息提取上下文
  const recentMessages = entries
    .filter(e => e.type === 'message')
    .slice(-5);

  if (recentMessages.length > 0) {
    parts.push('');
    parts.push('### 最近活动');
    for (const entry of recentMessages) {
      const msg = (entry as { message: unknown }).message as Record<string, unknown>;
      const ts = (entry as { timestamp?: string }).timestamp;
      const time = ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }) : '';
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const preview = msg.content.slice(0, 200);
        parts.push(`- [${time}] 搭档: ${preview}${msg.content.length > 200 ? '...' : ''}`);
      } else if (msg.role === 'assistant') {
        // 提取 speak 文本
        const content = msg.content;
        if (Array.isArray(content)) {
          const textBlocks = content.filter(b => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text');
          for (const b of textBlocks) {
            const text = (b as { text?: string }).text ?? '';
            const preview = text.slice(0, 200);
            parts.push(`- [${time}] 海獭: ${preview}${text.length > 200 ? '...' : ''}`);
          }
        }
      }
    }
  }

  parts.push('');
  parts.push('### 说明');
  parts.push('- 这是 Phase 1 机械转储，Phase 2 将替换为 LLM 合成的结构化摘要');
  parts.push('- 完整上下文请查阅：记忆检索（search_messages）、产物（list_artifacts）、上下文（get_context）');

  return parts.join('\n');
}
