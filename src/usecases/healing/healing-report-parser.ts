import type { HealingErrorType, HealingSeverity } from '@entities/healing/healing-event';

const VALID_TYPES: ReadonlySet<string> = new Set([
  'tool_failure', 'missing_context', 'wrong_tool',
  'format_violation', 'knowledge_gap', 'performance', 'other',
  // F20260904tflp：工具使用感受反馈（难用/多余/过度设计/参数反直觉），description 以 [tool:工具名] 前缀标识工具
  'tool_use_feedback',
  // F20261111hrepl（#1842）：运行时状态投影与真实运行态不一致（模型自报类型）
  'runtime_status_mismatch',
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

export interface HealingIssue {
  type: HealingErrorType;
  severity: HealingSeverity;
  description: string;
  suggestion: string;
}

/** 非法协议块（非 no_issue 但无法解析为合法上报）——调用方据此响亮反馈 */
export interface HealingBlockError {
  /** 非法块的截断预览（供模型定位哪一块写错了） */
  preview: string;
  /** 可操作的错误原因 */
  reason: string;
}

export interface ParsedHealingReport {
  hasIssues: boolean;
  issues: HealingIssue[];
  /** 非法协议块（本期起非空即应反馈给模型而非静默） */
  invalidBlocks: HealingBlockError[];
}

const MAX_ISSUES_PER_REPORT = 10;
const MAX_FIELD_LENGTH = 500;
const MAX_HEALING_BLOCK_LENGTH = 5000;
const INVALID_PREVIEW_LENGTH = 160;

function extractField(entry: string, key: string): string {
  return entry.match(new RegExp(`${key}:\\s*(\\S+)`, 'i'))?.[1]?.toLowerCase() ?? '';
}

function extractMultilineField(entry: string, key: string, nextKey: string): string {
  return entry.match(new RegExp(`${key}:\\s*([\\s\\S]*?)(?=\\s*${nextKey}:|$)`, 'i'))?.[1]?.trim() ?? '';
}

function parseSingleIssue(entry: string): HealingIssue | null {
  const type = extractField(entry, 'type');
  const description = extractMultilineField(entry, 'description', 'suggestion');
  if (!type || !description) return null;
  const severity = extractField(entry, 'severity');
  return {
    type: VALID_TYPES.has(type) ? type as HealingErrorType : 'other',
    severity: VALID_SEVERITIES.has(severity) ? severity as HealingSeverity : 'low',
    description: description.slice(0, MAX_FIELD_LENGTH),
    suggestion: extractMultilineField(entry, 'suggestion', '').slice(0, MAX_FIELD_LENGTH) || '',
  };
}

/**
 * Markdown 代码围栏分段（F20261111hrepl，#1842）。
 * 围栏内是「展示/讲解」保护域：讲解示例既不该被解析落账，也不该被剥离（否则正文损坏，
 * 如 seq 5946 把第一个 ```text 讲解示例剥空）。围栏外是「上报」域。
 * 围栏 no_issue 无载荷控制块的剥离是唯一例外（F20261110hjfnx），在 strip 侧单独处理。
 */
interface Segment { text: string; fenced: boolean; }

function splitFences(body: string): Segment[] {
  const lines = body.split('\n');
  const segments: Segment[] = [];
  let current: string[] = [];
  let fenceChar = '';
  let fenceLength = 0;

  for (const line of lines) {
    if (!fenceChar) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!opening) {
        current.push(line);
        continue;
      }
      if (current.length) segments.push({ text: current.join('\n'), fenced: false });
      current = [line];
      fenceChar = opening[1][0];
      fenceLength = opening[1].length;
      continue;
    }

    current.push(line);
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
    if (closing && closing[1][0] === fenceChar && closing[1].length >= fenceLength) {
      segments.push({ text: current.join('\n'), fenced: true });
      current = [];
      fenceChar = '';
      fenceLength = 0;
    }
  }
  if (current.length) segments.push({ text: current.join('\n'), fenced: Boolean(fenceChar) });
  return segments;
}

function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && text[end] === '`') end += 1;
  return end;
}

function inlineCodeCloseEnd(text: string, start: number, runLength: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    const runEnd = backtickRunEnd(text, i);
    if (runEnd - i === runLength) return runEnd;
    i = runEnd;
  }
  return -1;
}

/** 将成对行内代码 span 等长遮罩，检测协议时跳过；保留换行与索引供 strip 原样切片。 */
function maskInlineCode(text: string): string {
  const chars = text.split('');
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    const openEnd = backtickRunEnd(text, i);
    const closeEnd = inlineCodeCloseEnd(text, openEnd, openEnd - i);
    if (closeEnd < 0) {
      i = openEnd;
      continue;
    }
    for (let k = i; k < closeEnd; k += 1) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
    i = closeEnd;
  }
  return chars.join('');
}

/** 裸写协议块（围栏/行内代码外）：<healing> 后紧跟 [ 或 { 才进入协议判定。 */
interface RawBlock { text: string; content: string; start: number; end: number; closed: boolean; }

function extractBlocks(plainText: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  const masked = maskInlineCode(plainText);
  // 同时捕获缺 </healing> 的块：parse 侧必须响亮报错；strip 侧仍保留原文，避免误吞正文。
  const re = /<healing>\s*([[{][\s\S]*?)(<\/healing>|$)/gi;
  for (const m of masked.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    const contentStart = start + m[0].indexOf(m[1]);
    blocks.push({
      text: plainText.slice(start, end),
      content: plainText.slice(contentStart, contentStart + m[1].length),
      start,
      end,
      closed: Boolean(m[2]),
    });
  }
  return blocks;
}

type Classified =
  | { kind: 'no_issue' }
  | { kind: 'issues'; issues: HealingIssue[] }
  | { kind: 'invalid'; reason: string }
  /** 非协议的 JSON 示例（无 description 且非 no_issue）——正文保留，不落账不报错 */
  | { kind: 'example-json' };

/** JSON.parse 结果统一 unknown 后收窄的对象视图 */
function toPlainObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** JSON.parse 后收窄为对象视图；数组/非对象/解析失败返回可操作原因 */
function parseJsonObject(content: string): { obj: Record<string, unknown> } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content.trim());
  } catch {
    return { error: 'JSON 解析失败：healing 块内的 JSON 无法 parse' };
  }
  if (Array.isArray(raw)) {
    return { error: '不支持 JSON 数组形态，请拆成单个 JSON 对象（本期只承诺单对象）' };
  }
  const obj = toPlainObject(raw);
  if (!obj) return { error: 'JSON 必须是对象（如 {"type":"...","description":"..."}）' };
  return { obj };
}

/** 从 JSON 对象构造合法上报 issue（type 未知兜底 other，severity 未知兜底 low） */
function jsonObjectToIssue(obj: Record<string, unknown>, type: string, description: string): HealingIssue {
  const severityRaw = typeof obj.severity === 'string' ? obj.severity.trim().toLowerCase() : '';
  const severity = VALID_SEVERITIES.has(severityRaw) ? severityRaw as HealingSeverity : 'low';
  const suggestion = typeof obj.suggestion === 'string' ? obj.suggestion.trim().slice(0, MAX_FIELD_LENGTH) : '';
  return {
    type: VALID_TYPES.has(type) ? type as HealingErrorType : 'other',
    severity,
    description: description.slice(0, MAX_FIELD_LENGTH),
    suggestion,
  };
}

/** 受控 JSON 单对象块（F20261111hrepl，#1842：兼容真实 JSON 单对象现场）。
 *  规则：type/description 必填（缺则非法块）；severity 默认 low；suggestion 可选；
 *  只承诺单对象，不接数组。合法协议 type + 缺 description 是非法上报，不能静默当示例；
 *  只有非协议 type 且无 description 的既有 JSON 示例才保留（兼容正文防误吞）。
 */
function classifyJson(content: string): Classified {
  const parsed = parseJsonObject(content);
  if ('error' in parsed) return { kind: 'invalid', reason: parsed.error };
  const obj = parsed.obj;

  const type = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : '';
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';

  // 无载荷 no_issue 控制块（剥离，不落账）
  if (type === 'no_issue' || obj.no_issue === true) return { kind: 'no_issue' };

  if (!description) {
    if (VALID_TYPES.has(type)) return { kind: 'invalid', reason: 'JSON 缺 description 字段（必填）' };
    return { kind: 'example-json' };
  }

  // 有 description = 上报意图，type 为必填
  if (!type) return { kind: 'invalid', reason: 'JSON 缺 type 字段（必填）' };

  return { kind: 'issues', issues: [jsonObjectToIssue(obj, type, description)] };
}

/** XML/YAML-like [issues]/[no_issue] 块 */
function classifyXmlMarker(content: string): Classified {
  const markerMatch = content.trim().match(/^\[(issues|no.?issues?)\]/i);
  if (!markerMatch) {
    return { kind: 'invalid', reason: '无法识别的 healing 标记（应为 [issues] / [no_issue] 或 JSON 对象）' };
  }
  const marker = markerMatch[1];
  if (!/^issues$/i.test(marker)) return { kind: 'no_issue' };

  const closed = content.match(/([\s\S]*?)\[\/issues\]/i)?.[1] ?? null;
  if (closed === null) return { kind: 'invalid', reason: '[issues] 缺 [/issues] 闭合标记' };

  const entriesRaw = closed.replace(/^\s*\[issues\]/i, '');
  const entries = entriesRaw.split(/(?=^\s*-\s+)/m).filter(entry => entry.trim());
  if (entries.length === 0) {
    return { kind: 'invalid', reason: '[issues] 未解析出 issue（每条需 - type: 与 description 字段）' };
  }
  const issues = entries.map(parseSingleIssue);
  const invalidIndex = issues.findIndex(issue => issue === null);
  if (invalidIndex >= 0) {
    const missing = extractField(entries[invalidIndex], 'type') ? 'description' : 'type';
    return {
      kind: 'invalid',
      reason: `[issues] 第 ${invalidIndex + 1} 条缺 ${missing} 字段（必填，整个块未落账）`,
    };
  }
  return { kind: 'issues', issues: issues as HealingIssue[] };
}

function classifyBlock(content: string): Classified {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) return classifyJson(content);
  // 非 [issues]/[no_issue] 的方括号块按 JSON 数组处理，以返回明确的“不支持数组”错误。
  if (trimmed.startsWith('[') && !/^\[(issues|no.?issues?)\]/i.test(trimmed)) return classifyJson(content);
  return classifyXmlMarker(content);
}

function preview(text: string): string {
  return text.length > INVALID_PREVIEW_LENGTH ? `${text.slice(0, INVALID_PREVIEW_LENGTH)}…` : text;
}

/**
 * 从 speak body 中解析 healing 报告。
 *
 * 协议契约（F20261111hrepl，#1842）：
 * - 裸写 = 上报：[issues] YAML 列表 + 受控 JSON 单对象两种形态都受理。
 * - 代码围栏内 = 讲解/展示：不解析、不剥离（防讲解示例误落账 / 正文损坏）。
 * - 上下文提及标签字样（<healing> 后非 [/{）不触发（F20260904hstr 保留）。
 * - 非法块（非 no_issue 但无法解析）进 invalidBlocks，由拦截器响亮反馈，不再静默。
 */
export function parseHealingReport(body: string): ParsedHealingReport {
  const normalized = body.replace(/\\<|\\>/g, m => m.slice(1));
  const segments = splitFences(normalized);
  const allIssues: HealingIssue[] = [];
  const invalidBlocks: HealingBlockError[] = [];

  for (const seg of segments) {
    if (seg.fenced) continue; // 围栏内不解析（讲解示例防误落账）
    for (const block of extractBlocks(seg.text)) {
      if (block.text.length > MAX_HEALING_BLOCK_LENGTH) {
        invalidBlocks.push({
          preview: preview(block.text),
          reason: `healing 块过长（${block.text.length} > ${MAX_HEALING_BLOCK_LENGTH} 字符），请精简`,
        });
        continue;
      }
      const classified = classifyBlock(block.content);
      if (!block.closed && classified.kind !== 'no_issue' && classified.kind !== 'example-json') {
        invalidBlocks.push({ preview: preview(block.text), reason: 'healing 块缺 </healing> 闭合标签' });
      } else if (classified.kind === 'issues') {
        allIssues.push(...classified.issues);
      } else if (classified.kind === 'invalid') {
        invalidBlocks.push({ preview: preview(block.text), reason: classified.reason });
      }
      // no_issue / example-json 不落账、不报错
    }
  }

  const capped = allIssues.slice(0, MAX_ISSUES_PER_REPORT);
  return { hasIssues: capped.length > 0, issues: capped, invalidBlocks };
}

/** 围栏 no_issue 控制块（F20261110hjfnx 例外）：精确剥离，非 no_issue 围栏原样保留 */
function stripFenceNoIssueControl(fenceText: string): string {
  const trimmed = fenceText.trim();
  if (/^```healing\s*(?:\{\s*"type"\s*:\s*"no_issue"\s*\}|\{\s*"no_issue"\s*:\s*true\s*\})\s*```$/i.test(trimmed)) return '';
  if (/^```no_issue\s*```$/i.test(trimmed)) return '';
  return fenceText;
}

/** 剥围栏外「剥除类」块（no_issue / issues / invalid）；non-protocol JSON 示例保留 */
function stripPlainBlocks(text: string): string {
  const blocks = extractBlocks(text);
  if (blocks.length === 0) return text;
  const stripRanges = blocks
    .filter(b => b.closed && classifyBlock(b.content).kind !== 'example-json')
    .map(b => ({ start: b.start, end: b.end }))
    .sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  let cursor = 0;
  for (const r of stripRanges) {
    if (r.start < cursor) continue;
    parts.push(text.slice(cursor, r.start));
    cursor = r.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * 从 speak body 中剥离 healing 报告。
 *
 * 误剥防护（F20260904hstr）：只剥「协议块」（<healing> 后紧跟 [/{）；正文引用标签字样不剥。
 * 围栏保护（F20261111hrepl，#1842）：围栏内讲解示例不剥离（不再像 seq 5946 把正文剥空）；
 * 围栏 no_issue 无载荷控制块是唯一例外（F20261110hjfnx 保留）。
 */
export function stripHealingReport(body: string): string {
  const segments = splitFences(body);
  const parts = segments.map(seg => seg.fenced ? stripFenceNoIssueControl(seg.text) : stripPlainBlocks(seg.text));
  return parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
