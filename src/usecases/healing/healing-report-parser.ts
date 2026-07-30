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
 */
export function parseHealingReport(body: string): ParsedHealingReport {
  const normalized = body
    .replace(/\\<|\\>/g, m => m.slice(1))
    .replace(/`<healing>`/gi, '<healing>')
    .replace(/<\/healing>/gi, '</healing>');

  const match = normalized.match(/<healing>([\s\S]*?)<\/healing>/i);
  if (!match) return { hasIssues: false, issues: [] };

  const content = match[1].trim();
  if (/\[no.?issue\]/i.test(content)) return { hasIssues: false, issues: [] };

  const issueBlock = content.match(/\[issues\]([\s\S]*?)\[\/issues\]/i);
  if (!issueBlock) return { hasIssues: false, issues: [] };

  const entries = issueBlock[1].split(/(?=- type:)/gi).filter(Boolean);
  const issues = entries.map(parseSingleIssue).filter((i): i is HealingIssue => i !== null);

  if (issues.length > 0 && match[0].length > MAX_HEALING_BLOCK_LENGTH) {
    return { hasIssues: false, issues: [] };
  }

  const capped = issues.slice(0, MAX_ISSUES_PER_REPORT);
  return { hasIssues: capped.length > 0, issues: capped };
}

/**
 * 从 speak body 中剥离 healing report。
 */
export function stripHealingReport(body: string): string {
  return body
    .replace(/<healing>[\s\S]*?<\/healing>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
