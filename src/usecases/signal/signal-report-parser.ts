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

// 全角引号 → 半角（在 signal 标签头部区域；“ ” ‘ ’）
function normalizeTagQuotes(body: string): string {
  // 逐次扫描：<signal 后到首个 > 之间的引号替换（避免误伤正文书容——正文中全角引号合法）
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
 * 抽取信号块（合法与畸形都匹配，属性在 parseSignalReport 里逐项校验）。
 * F20260827c2sg 审视处置：
 * - 属性顺序不再硬编码（type 在前/severity 在前均容忍）——LLM 高频合法变体，整块静默剥离会无声断问责链
 * - payload 带 <signal 起始守卫（(?!<signal\b)）：未闭合块不会跨块吞噬后续合法块（此前外层未闭合块会吃到内层块的闭合标签，合法信号以错误类型落账）
 * 属性引号容忍双引号/单引号/无引号（normalize 后无全角）。
 */
const SIGNAL_BLOCK_RE = /<signal\b([^>]*)>((?:(?!<signal\b)[\s\S])*?)<\/signal>/gi;
/** type 属性：白名单不含 halt（小獭不可伪造 halt 入台账） */
const TYPE_ATTR_RE = /\btype\s*=\s*(["']?)(objection|blocked)\1/i;
/** severity 属性 */
const SEVERITY_ATTR_RE = /\bseverity\s*=\s*(["']?)(low|medium|high)\1/i;

/** 全部 signal 块（含畸形）：剥离用。type 白名单外的块也剥离——不让控制语法泄漏进 UI 正文 */
const ANY_SIGNAL_BLOCK_RE = /<signal\b[^>]*>[\s\S]*?<\/signal>/gi;
/** 未闭合块（有开无合）——尾部残留也剥离 */
const UNCLOSED_SIGNAL_RE = /<signal\b[^>]*>(?![\s\S]*<\/signal>)/gi;

function validatePayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_PAYLOAD_CHARS);
}

/**
 * 解析 speak body 中的信号块。
 * 非法/畸形块不计入 signals（静默剥离），合法块超上限的部分丢弃。
 */
export function parseSignalReport(body: string): ParsedSignalReport {
  const normalized = normalizeSignalSyntax(body);
  const strippedBlocks: string[] = [];

  for (const m of normalized.matchAll(ANY_SIGNAL_BLOCK_RE)) {
    strippedBlocks.push(m[0]);
  }
  for (const m of normalized.matchAll(UNCLOSED_SIGNAL_RE)) {
    strippedBlocks.push(m[0]);
  }

  const signals: ParsedSignal[] = [];
  for (const m of normalized.matchAll(SIGNAL_BLOCK_RE)) {
    // 属性逐项校验：type/severity 缺失或值非法 = 畸形块，静默剥离不落账
    const attrs = m[1] ?? "";
    const typeMatch = TYPE_ATTR_RE.exec(attrs);
    const severityMatch = SEVERITY_ATTR_RE.exec(attrs);
    if (!typeMatch || !severityMatch) continue;
    const payload = validatePayload(m[2]);
    if (!payload) continue; // 空 payload = 畸形，不落账
    signals.push({
      type: typeMatch[2].toLowerCase() as ParsedSignalType,
      severity: severityMatch[2].toLowerCase() as ParsedSignal['severity'],
      payload,
    });
    if (signals.length >= MAX_SIGNALS_PER_MESSAGE) break;
  }

  return { signals, strippedBlocks };
}

/** 从 speak body 剥离全部信号块（合法 + 畸形），返回 cleanBody */
export function stripSignalReport(body: string): string {
  const normalized = normalizeSignalSyntax(body);
  return normalized
    .replace(ANY_SIGNAL_BLOCK_RE, '')
    .replace(UNCLOSED_SIGNAL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
