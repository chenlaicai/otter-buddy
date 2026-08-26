/**
 * 近期原文切取器（F20260825hndf 件③）
 *
 * 从 session entries 末尾往前切取指定 token 预算的近期原文。
 * 按 turn 边界对齐（不切半轮），搭档消息和 speak 文本全文保留，
 * 工具结果截断。
 *
 * 借用式生命周期：每代重新切取，旧原文不跨代累积。
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/** 切取到的 turn 片段 */
export interface TurnFragment {
  role: 'user' | 'assistant';
  content: string;
  toolSummary?: string;
  timestamp?: string;
}

/** 近期原文窗口 */
export interface RecencyWindow {
  turns: TurnFragment[];
  tokenEstimate: number;
  turnCount: number;
  timeRange: { from?: string; to?: string };
}

/** chars/4 启发式估算 token */
export function estimateRecencyTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 内部别名 */
const estimateTokens = estimateRecencyTokens;

/**
 * 从 session entry 提取可读文本片段。
 */
// eslint-disable-next-line complexity -- 多类型消息处理逻辑
function extractEntryContent(entry: SessionEntry): TurnFragment | null {
  if (entry.type !== 'message') return null;
  const msg = (entry as { message: unknown }).message as Record<string, unknown>;
  const timestamp = (entry as { timestamp?: string }).timestamp;

  if (msg.role === 'user') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    return content.trim() ? { role: 'user', content, timestamp } : null;
  }

  if (msg.role !== 'assistant') return null;
  const content = msg.content;
  if (!Array.isArray(content)) return null;

  let textContent = '';
  const toolNames: string[] = [];

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      textContent += b.text;
    } else if (b.type === 'toolCall' && typeof b.name === 'string') {
      const args = b.arguments as Record<string, unknown> | undefined;
      const p = args && typeof args.path === 'string' ? `(${args.path})` : '';
      toolNames.push(`${b.name}${p}`);
    }
  }

  if (!textContent.trim() && toolNames.length === 0) return null;

  const fragment: TurnFragment = { role: 'assistant', content: textContent.trim(), timestamp };
  if (toolNames.length > 0) {
    fragment.toolSummary = `> 工具: ${toolNames.join(', ')}`;
  }
  return fragment;
}

/**
 * 从 session entries 切取近期原文窗口。
 */
// extractRecencyWindow
export function extractRecencyWindow(
  entries: SessionEntry[],
  tokenBudget: number,
): RecencyWindow {
  const collected: TurnFragment[] = [];
  let totalTokens = 0;
  let timeFrom: string | undefined;
  let timeTo: string | undefined;

  for (let i = entries.length - 1; i >= 0; i--) {
    const fragment = extractEntryContent(entries[i]);
    if (!fragment) continue;

    const fragTokens = estimateTokens(fragment.content) +
      (fragment.toolSummary ? estimateTokens(fragment.toolSummary) : 0);

    if (totalTokens + fragTokens > tokenBudget && collected.length > 0) break;

    collected.push(fragment);
    totalTokens += fragTokens;

    if (fragment.timestamp) {
      if (!timeTo) timeTo = fragment.timestamp;
      timeFrom = fragment.timestamp;
    }
  }

  // 反转为时间正序，跳过开头的非 user 消息
  collected.reverse();
  const aligned = collected.filter((f, i) => i > 0 || f.role === 'user');
  // 如果第一个不是 user，跳过直到找到 user
  const startIdx = aligned.findIndex(f => f.role === 'user');
  const finalTurns = startIdx >= 0 ? aligned.slice(startIdx) : [];

  return {
    turns: finalTurns,
    tokenEstimate: totalTokens,
    turnCount: finalTurns.filter(f => f.role === 'user').length,
    timeRange: { from: timeFrom, to: timeTo },
  };
}

/**
 * 渲染近期原文为 markdown 文本。
 */
export function renderRecencyWindow(window: RecencyWindow): string {
  if (window.turns.length === 0) return '';

  const fmt = (ts?: string) => ts
    ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
    : '?';

  const parts: string[] = [
    `## 近期对话原文（旧 session 最后 ${window.turnCount} 轮，${fmt(window.timeRange.from)}–${fmt(window.timeRange.to)}，仅供接续参考）`,
  ];

  for (const frag of window.turns) {
    const time = fmt(frag.timestamp);
    const header = frag.role === 'user' ? '搭档' : '海獭';
    if (frag.content) {
      parts.push(`### [${time}] ${header}`);
      parts.push(frag.content);
    }
    if (frag.toolSummary) parts.push(frag.toolSummary);
  }

  return parts.join('\n');
}
