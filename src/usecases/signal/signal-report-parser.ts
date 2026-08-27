/**
 * Signal report 解析器（F20260826mwrd C2）。
 *
 * 小獭在 speak body 中嵌入 <signal type="objection|blocked" severity="...">正文</signal>，
 * 本模块抽取进 signal_events 台账（仿 healing-report-parser 先例）。
 *
 * 与 healing 块的分界：healing = 系统自愈（工具故障/格式异常），signal = 协作协调
 * （异议/卡住升级）。语义池独立、传输管道模式共享（方案 Part 2「为什么不复用
 * healing_events 表」）。
 *
 * 鲁棒性（对齐 healing parser 踩坑防御 + 审视发现 6 增补）：
 * - normalize：转义写法（\< \>）、反引号包裹、属性引号全角/单引号
 * - 白名单校验 type（objection/blocked——halt 只能经 halt_otter 工具，不走 speak）
 * - 截断防滥用：正文 ≤1000 字符；每条消息信号数上限 5
 * - 畸形类型显式枚举（C2 单测验收）：无 type / type 白名单外 / 空 payload /
 *   超长 / 属性引号异常 / 正文未闭合——非法块静默剥离不落账（fail-open，
 *   不阻断正常发言）
 *
 * F20260827c2sg 审视处置（发现 4 重写）：正则三件套无法表达「标签平衡配对」语义
 * （初版非贪婪跨块吞噬；二版负向前瞻把 payload 含 `<signal` 字样的合法块整块丢掉、
 * 反引号示例经 normalize 后内层冒名落账且 parse/strip 不同步）。改为 tokenizer +
 * 栈式配对：开/闭标签按位置切 token，栈式配对成块，顶层块（不被其他成对块包含）
 * 为落账候选，嵌套块是外层 payload 的一部分（不冒名落账）；未闭合开标签与孤儿
 * 闭标签剥离。parse 与 strip 共享同一 tokenize/配对结果，结构上不再不同步。
 */

export type ParsedSignalType = 'objection' | 'blocked';

export interface ParsedSignal {
  type: ParsedSignalType;
  severity: 'low' | 'medium' | 'high';
  payload: string;
}

export interface ParsedSignalReport {
  signals: ParsedSignal[];
  /** 被剥离的原始块（含畸形块）——调用方日志用 */
  strippedBlocks: string[];
}

export const MAX_SIGNALS_PER_MESSAGE = 5;
export const MAX_PAYLOAD_CHARS = 1000;

// 全角引号 → 半角（在 signal 标签头部区域；" " ' '）
function normalizeTagQuotes(body: string): string {
  // 逐次扫描：<signal 后到首个 > 之间的引号替换（避免误伤正文内容——正文中全角引号合法）
  return body.replace(/<signal\b[^>]*>/gi, tag => tag.replace(/[“”‘’]/g, '"'));
}

/** normalize：LLM 常见变体 → 标准形态 */
function normalizeSignalSyntax(body: string): string {
  return normalizeTagQuotes(
    body
      // 转义写法 \<signal / \< / \>
      .replace(/\\</g, '<')
      .replace(/\\>/g, '>')
      // 反引号包裹的标签（讨论协议本身时避免误解析）
      .replace(/`(<signal)/gi, '$1')
      .replace(/(<\/signal>)`/gi, '$1'),
  );
}

/**
 * token：一个 signal 开标签或闭标签。
 * attrs 为开标签 <signal ...> 的属性段（不含首尾尖括号与标签名）。
 */
interface SignalToken {
  kind: 'open' | 'close';
  start: number;
  end: number;
  attrs: string;
}

/** 开/闭标签统一切 token（normalize 后无全角引号）。开标签属性段不含 <（避免 payload 中的裸 <signal 字样把闭合标签吞进开标签 token） */
const SIGNAL_TOKEN_RE = /<signal\b[^<>]*>|<\/signal>/gi;

function tokenizeSignals(text: string): SignalToken[] {
  const tokens: SignalToken[] = [];
  for (const m of text.matchAll(SIGNAL_TOKEN_RE)) {
    const raw = m[0];
    if (raw[1] === '/') {
      tokens.push({ kind: 'close', start: m.index, end: m.index + raw.length, attrs: '' });
    } else {
      tokens.push({ kind: 'open', start: m.index, end: m.index + raw.length, attrs: raw.slice(7, -1) });
    }
  }
  return tokens;
}

/** 成对块（开标签起、闭标签止） */
interface PairedBlock {
  start: number;
  end: number;
  attrs: string;
  payloadStart: number;
  payloadEnd: number;
}

/** 栈式配对：每个闭标签与其后最近的未配对开标签成块 */
function pairSignalBlocks(tokens: SignalToken[]): { paired: PairedBlock[]; leftovers: SignalToken[] } {
  const stack: SignalToken[] = [];
  const paired: PairedBlock[] = [];
  const orphans: SignalToken[] = []; // 孤儿闭标签（无对应开标签）
  for (const t of tokens) {
    if (t.kind === 'open') {
      stack.push(t);
    } else {
      const open = stack.pop();
      if (!open) {
        orphans.push(t);
        continue;
      }
      paired.push({ start: open.start, end: t.end, attrs: open.attrs, payloadStart: open.end, payloadEnd: t.start });
    }
  }
  return { paired, leftovers: [...stack, ...orphans] };
}

/** 顶层块：不被其他成对块包含。嵌套块视为外层 payload 的一部分，不单独落账（防内层示例冒名） */
function topLevelBlocks(paired: PairedBlock[]): PairedBlock[] {
  return paired.filter(b => !paired.some(o => o !== b && o.start <= b.start && b.end <= o.end));
}

/** type 属性：白名单不含 halt（小獭不可伪造 halt 入台账） */
const TYPE_ATTR_RE = /\btype\s*=\s*(["']?)(objection|blocked)\1/i;
/** severity 属性 */
const SEVERITY_ATTR_RE = /\bseverity\s*=\s*(["']?)(low|medium|high)\1/i;

function validatePayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_PAYLOAD_CHARS);
}

/**
 * 解析 speak body 中的信号块。
 * 顶层成对块做属性校验（type/severity 逐项匹配，顺序无关）；校验失败/空 payload
 * 不计入 signals（静默剥离），合法块超上限的部分丢弃。嵌套块不单独落账。
 */
export function parseSignalReport(body: string): ParsedSignalReport {
  const normalized = normalizeSignalSyntax(body);
  const tokens = tokenizeSignals(normalized);
  const { paired, leftovers } = pairSignalBlocks(tokens);
  const tops = topLevelBlocks(paired);

  const signals: ParsedSignal[] = [];
  for (const block of tops) {
    const typeMatch = TYPE_ATTR_RE.exec(block.attrs);
    const severityMatch = SEVERITY_ATTR_RE.exec(block.attrs);
    if (!typeMatch || !severityMatch) continue; // 属性缺失/非法 = 畸形，静默剥离不落账
    const payload = validatePayload(normalized.slice(block.payloadStart, block.payloadEnd));
    if (!payload) continue; // 空 payload = 畸形，不落账
    signals.push({
      type: typeMatch[2].toLowerCase() as ParsedSignalType,
      severity: severityMatch[2].toLowerCase() as ParsedSignal['severity'],
      payload,
    });
    if (signals.length >= MAX_SIGNALS_PER_MESSAGE) break;
  }

  // 剥离文本 = 顶层块全文 + 未闭合开标签/孤儿闭标签（供日志）
  const strippedBlocks = [
    ...tops.map(b => normalized.slice(b.start, b.end)),
    ...leftovers.map(t => normalized.slice(t.start, t.end)),
  ];

  return { signals, strippedBlocks };
}

/**
 * 从 speak body 剥离全部 signal 语法（顶层块、未闭合开标签、孤儿闭标签），返回 cleanBody。
 * 与 parseSignalReport 共享 tokenize/配对结果——结构上保证 parse 与 strip 不再不同步。
 */
export function stripSignalReport(body: string): string {
  const normalized = normalizeSignalSyntax(body);
  const tokens = tokenizeSignals(normalized);
  const { paired, leftovers } = pairSignalBlocks(tokens);
  const ranges: Array<{ start: number; end: number }> = [
    ...topLevelBlocks(paired).map(b => ({ start: b.start, end: b.end })),
    ...leftovers.map(t => ({ start: t.start, end: t.end })),
  ];
  ranges.sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue; // 被前一个区间覆盖（嵌套块随顶层一起剥）
    parts.push(normalized.slice(cursor, r.start));
    cursor = r.end;
  }
  parts.push(normalized.slice(cursor));

  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
