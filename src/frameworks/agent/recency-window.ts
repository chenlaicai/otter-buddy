/**
 * 近期原文切取器（F20260825hndf 件③）
 *
 * 从 session entries 末尾往前切取指定 token 预算的近期原文。
 * 按 turn 边界对齐（不切半轮），搭档消息和 speak 文本全文保留，
 * 工具结果截断 500 字符。
 *
 * 借用式生命周期：每代重新切取，旧原文不跨代累积。
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/** 切取到的 turn 片段 */
export interface TurnFragment {
  role: 'user' | 'assistant';
  content: string;
  toolSummary?: string;   // 工具调用一行摘要
  timestamp?: string;
}

/** 近期原文窗口 */
export interface RecencyWindow {
  turns: TurnFragment[];
  tokenEstimate: number;
  turnCount: number;
  timeRange: { from?: string; to?: string };
}

/** 工具结果截断长度 */
const TOOL_RESULT_MAX_CHARS = 500;

/** chars/4 启发式估算 token（与 SDK estimateTokens 一致） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 判断 entry 是否是 turn 起始（user 消息或自定义消息） */
function isTurnStartEntry(entry: SessionEntry): boolean {
  if (entry.type !== 'message') return false;
  const msg = (entry as { message: unknown }).message as Record<string, unknown>;
  return msg.role === 'user';
}

/**
 * 从 session entry 提取可读文本片段。
 */
function extractEntryContent(entry: SessionEntry): TurnFragment | null {
  if (entry.type !== 'message') return null;
  const msg = (entry as { message: unknown }).message as Record<string, unknown>;
  const timestamp = (entry as { timestamp?: string }).timestamp;

  if (msg.role === 'user') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content.trim()) return null;
    return { role: 'user', content, timestamp };
  }

  if (msg.role === 'assistant') {
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
        const path = args && typeof args.path === 'string' ? `(${args.path})` : '';
        toolNames.push(`${b.name}${path}`);
      }
    }

    // assistant 消息只保留 speak 输出的文本（非空），不含内部推理
    if (!textContent.trim() && toolNames.length === 0) return null;

    const fragment: TurnFragment = { role: 'assistant', content: textContent.trim(), timestamp };
    if (toolNames.length > 0) {
      fragment.toolSummary = `> 工具: ${toolNames.join(', ')}`;
    }
    return fragment;
  }

  return null;
}

/**
 * 从 session entries 切取近期原文窗口。
 * @param entries session entries（时间正序）
 * @param tokenBudget token 预算
 */
export function extractRecencyWindow(
  entries: SessionEntry[],
  tokenBudget: number,
): RecencyWindow {
  const turns: TurnFragment[] = [];
  let totalTokens = 0;
  let timeFrom: string | undefined;
  let timeTo: string | undefined;

  // 从末尾往前遍历
  const collected: TurnFragment[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const fragment = extractEntryContent(entries[i]);
    if (!fragment) continue;

    const fragTokens = estimateTokens(fragment.content) +
      (fragment.toolSummary ? estimateTokens(fragment.toolSummary) : 0);

    // 检查预算
    if (totalTokens + fragTokens > tokenBudget && collected.length > 0) {
      break;
    }

    collected.push(fragment);
    totalTokens += fragTokens;

    if (fragment.timestamp) {
      if (!timeTo) timeTo = fragment.timestamp;
      timeFrom = fragment.timestamp;
    }
  }

  // 反转为时间正序
  collected.reverse();

  // 按 turn 边界对齐：确保每个 turn 的 user + assistant 配对完整
  const aligned: TurnFragment[] = [];
  let i = 0;
  while (i < collected.length) {
    // 如果第一个不是 user 消息，跳过直到找到 user
    if (collected[i].role !== 'user' && aligned.length === 0) {
      i++;
      continue;
    }
    aligned.push(collected[i]);
    i++;
  }

  return {
    turns: aligned,
    tokenEstimate: totalTokens,
    turnCount: aligned.filter(f => f.role === 'user').length,
    timeRange: { from: timeFrom, to: timeTo },
  };
}

/**
 * 渲染近期原文为 markdown 文本。
 */
export function renderRecencyWindow(window: RecencyWindow): string {
  if (window.turns.length === 0) return '';

  const timeFrom = window.timeRange.from
    ? new Date(window.timeRange.from).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
    : '?';
  const timeTo = window.timeRange.to
    ? new Date(window.timeRange.to).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
    : '?';

  const parts: string[] = [
    `## 近期对话原文（旧 session 最后 ${window.turnCount} 轮，${timeFrom}–${timeTo}，仅供接续参考）`,
  ];

  for (const frag of window.turns) {
    const time = frag.timestamp
      ? new Date(frag.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
      : '';
    const header = frag.role === 'user' ? '搭档' : '海獭';

    if (frag.content) {
      parts.push(`### [${time}] ${header}`);
      parts.push(frag.content);
    }
    if (frag.toolSummary) {
      parts.push(frag.toolSummary);
    }
  }

  return parts.join('\n');
}
