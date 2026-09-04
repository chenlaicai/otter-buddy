import type { HealingErrorType, HealingSeverity } from '@entities/healing/healing-event';

const VALID_TYPES: ReadonlySet<string> = new Set([
  'tool_failure', 'missing_context', 'wrong_tool',
  'format_violation', 'knowledge_gap', 'performance', 'other',
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

export interface HealingIssue {
  type: HealingErrorType;
  severity: HealingSeverity;
  description: string;
  suggestion: string;
}

export interface ParsedHealingReport {
  hasIssues: boolean;
  issues: HealingIssue[];
}

const MAX_ISSUES_PER_REPORT = 10;
const MAX_FIELD_LENGTH = 500;
const MAX_HEALING_BLOCK_LENGTH = 5000;

function extractField(entry: string, key: string): string {
  return entry.match(new RegExp(`${key}:\\s*(\\S+)`, 'i'))?.[1]?.toLowerCase() ?? '';
}

function extractMultilineField(entry: string, key: string, nextKey: string): string {
  return entry.match(new RegExp(`${key}:\\s*([\\s\\S]*?)(?=\\s*${nextKey}:|$)`, 'i'))?.[1]?.trim() ?? '';
}

function parseSingleIssue(entry: string): HealingIssue | null {
  const description = extractMultilineField(entry, 'description', 'suggestion');
  if (!description) return null;
  const type = extractField(entry, 'type');
  const severity = extractField(entry, 'severity');
  return {
    type: VALID_TYPES.has(type) ? type as HealingErrorType : 'other',
    severity: VALID_SEVERITIES.has(severity) ? severity as HealingSeverity : 'low',
    description: description.slice(0, MAX_FIELD_LENGTH),
    suggestion: extractMultilineField(entry, 'suggestion', '').slice(0, MAX_FIELD_LENGTH) || '',
  };
}

/**
 * 从 speak body 中解析 healing report。
 * 鲁棒性处理：normalize、白名单校验、多行支持、误解析防护。
 *
 * 误解析防护（F20260904hstr）：只认「协议块」——<healing> 开头紧跟
 * [issues] / [no_issue] 标记。正文里引用标签字样（裸写或反引号包裹）不触发。
 */
export function parseHealingReport(body: string): ParsedHealingReport {
  const normalized = body.replace(/\\<|\\>/g, m => m.slice(1));

  // 协议块开头必然紧跟 [issues] 或 [no_issue]/[no issue] 变体标记，
  // 以此锚定，避免正文提及标签字样被误当报告块开头。
  // 注意：不做反引号还原——`` `<healing>` `` 是正文引用，不是报告（F20260904hstr）。
  const match = normalized.match(/<healing>\s*\[(issues|no.?issues?)\]([\s\S]*?)<\/healing>/i);
  if (!match) return { hasIssues: false, issues: [] };

  const [, marker, content] = match;
  if (!/^issues$/i.test(marker)) return { hasIssues: false, issues: [] };

  // [issues] 必须与 [/issues] 成对，缺闭合视为残缺块，不解析
  const entriesRaw = content.match(/([\s\S]*?)\[\/issues\]/i)?.[1] ?? null;
  if (entriesRaw === null) return { hasIssues: false, issues: [] };

  const entries = entriesRaw.split(/(?=- type:)/gi).filter(Boolean);
  const issues = entries.map(parseSingleIssue).filter((i): i is HealingIssue => i !== null);

  if (issues.length > 0 && match[0].length > MAX_HEALING_BLOCK_LENGTH) {
    return { hasIssues: false, issues: [] };
  }

  const capped = issues.slice(0, MAX_ISSUES_PER_REPORT);
  return { hasIssues: capped.length > 0, issues: capped };
}

/**
 * 从 speak body 中剥离 healing report。
 *
 * 误剥防护（F20260904hstr）：只剥离协议块（开头紧跟 [issues]/[no_issue] 标记）。
 * 旧正则从正文首次出现的 <healing> 字样起非贪婪吞到文末闭合，
 * 正文引用标签名的消息被整段剥离（2026-09-04 现场：正文+卡片全部丢失）。
 */
export function stripHealingReport(body: string): string {
  return body
    .replace(/<healing>\s*\[(issues|no.?issues?)\][\s\S]*?<\/healing>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
