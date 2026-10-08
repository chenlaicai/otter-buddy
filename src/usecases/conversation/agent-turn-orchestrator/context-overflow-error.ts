/**
 * #1247：模型上下文窗口超限（400）识别与告警文案。
 *
 * 现状（问题）：注入体积超过模型上下文窗口时，API 直接 400 拒答（非 429 配额），
 * 小獭首条请求即死（kimi-256k 实证），错误只走 generic failTerminal——无 healing
 * 落账类型、无告警，体检不可见（issue #1247 改进点 1）。
 *
 * 本模块与 rate-limit-error.ts 同骨架（#543 先例）：把「模型客户端上抛的错误消息」
 * 翻译成编排层可落账的结构化事实。识别策略同为正则匹配错误消息文本——数据源是
 * formatProviderError 终端形态字符串，跨 provider 统一。
 *
 * 与限流的分界：限流词族（quota/usage/429/rate limit）由 matchRateLimitError 先判；
 * 本模块只接「体积超窗」形态（token limit/context/window/maximum context length）。
 * 两个 matcher 在 orchestrator 按先限流后超窗串行调用，互斥面由词族区分。
 *
 * 边界：错误正文携带的「请求 N > 窗口 M」数字尽力提取（kimi 实证形态
 * "exceeded k3-256k model token limit: 273412 > 262144"），提取不到不阻塞落账。
 */

/** 窗口超限形态（词族与限流互斥：不含 quota/usage/429/rate limit） */
const CTX_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /exceeded k3-256k model token limit/i, // kimi-256k 实证（issue #1247 原文，2026-09-29 现场）
  /maximum context length/i, // OpenAI「This model's maximum context length is 262144 tokens. However, you requested...」
  /prompt is too long/i, // Anthropic/OpenAI 变体「prompt is too long: X tokens > Y maximum」
  /context[ _-]?overflow/i, // SDK 侧「Context overflow recovery failed」
  /(exceed|exceeds|exceeded)[^\n]{0,30}token limit/i, // 通用「exceeded ... token limit」
  /(context|window|length)[^\n]{0,16}(exceed|too[ _-]?long|too[ _-]?large|overflow)/i, // 通用超窗词族
  /上下文[^\n]{0,8}(超限|溢出|超长|超出)/, // 中文文案
  /输入[^\n]{0,10}(超长|超出|超过)/, // 中文「输入超长/超出上限」
];

/** 「请求 N > 窗口 M」数字提取（kimi 实证形态；尽力提取非硬保证）。
 *  \d[\d,]* 贪婪匹配完整数字（含千分位逗号），两捕获组各需 ≥4 位数字——
 *  防止把年份/状态码等短数字段当 token 数提取 */
const REQ_GT_WINDOW = /(\d[\d,]{3,})\s*>\s*(\d[\d,]{3,})/;

/** OpenAI 经典形态：「maximum context length is M tokens. However, you requested N tokens.」
 *  （M 在前 N 在后，与 kimi N > M 倒序——两个捕获组按语义命名位） */
const MAXCTX_REQUESTED = /maximum context length is (\d[\d,]{3,}) tokens[^\n]{0,80}?you requested (\d[\d,]{3,})/i;

/** Anthropic「prompt is too long: N tokens ... maximum is M」形态 */
const PROMPT_TOO_LONG = /prompt is too long:?\s*(\d[\d,]{3,}) tokens[^\n]{0,60}?maximum is:? (\d[\d,]{3,})/i;

/** 兜底：仅请求侧数字（无窗口数可提时不阻塞） */
const REQUESTED_ONLY = /you requested (\d[\d,]{3,}) tokens/i;

/** 窗口超限识别结果 */
export interface ContextOverflowMatch {
  /** 请求 token 数（错误正文携带时；undefined=未携带） */
  requestedTokens?: number;
  /** 模型窗口 token 数（错误正文携带时；undefined=未携带） */
  windowTokens?: number;
}

/** 识别错误消息是否为上下文窗口超限类；非超限返回 null。
 *  数字提取三段式：kimi N>M 形态 → OpenAI 倒序形态 → Anthropic prompt-too-long 形态 →
 *  均不中则返回空对象（词族已命中，数字尽力提取非硬保证） */
export function matchContextOverflowError(errorMessage: string): ContextOverflowMatch | null {
  if (!CTX_OVERFLOW_PATTERNS.some(p => p.test(errorMessage))) return null;
  const gt = errorMessage.match(REQ_GT_WINDOW);
  if (gt) {
    return {
      requestedTokens: Number(gt[1].replace(/,/g, '')),
      windowTokens: Number(gt[2].replace(/,/g, '')),
    };
  }
  const om = errorMessage.match(MAXCTX_REQUESTED);
  if (om) {
    return {
      windowTokens: Number(om[1].replace(/,/g, '')),
      requestedTokens: Number(om[2].replace(/,/g, '')),
    };
  }
  const pm = errorMessage.match(PROMPT_TOO_LONG);
  if (pm) {
    return {
      requestedTokens: Number(pm[1].replace(/,/g, '')),
      windowTokens: Number(pm[2].replace(/,/g, '')),
    };
  }
  const ro = errorMessage.match(REQUESTED_ONLY);
  if (ro) return { requestedTokens: Number(ro[1].replace(/,/g, '')) };
  return {};
}

/** 数字提示段（有实测数字时呈现，无则省略——文案不依赖提取成功） */
function tokenHint(p: ContextOverflowMatch): string {
  if (p.requestedTokens === undefined || p.windowTokens === undefined) return '';
  return `（请求 ${p.requestedTokens.toLocaleString()} > 窗口 ${p.windowTokens.toLocaleString()} tokens）`;
}

/** 告警系统消息文案（会话内可见：搭档 + 在场獭） */
export function buildContextOverflowSystemMsg(p: {
  otterName: string;
  modelAlias: string;
  match: ContextOverflowMatch;
}): string {
  return `[系统告警] ${p.otterName} 的模型 ${p.modelAlias} 请求超过上下文窗口上限（400），本轮发言已终止${tokenHint(p.match)}。` +
    `该模型窗口装不下当前注入面——请缩减注入体积（缩短任务简报/systemPrompt），或改派更大窗口的模型（如 kimi/glm 的 1M 档）。重试同一注入无意义。`;
}

/** healing 事件 description 文案（台账可 grep） */
export function buildContextOverflowDescription(p: {
  modelAlias: string;
  match: ContextOverflowMatch;
}): string {
  return `模型 ${p.modelAlias} 上下文窗口超限（400）：注入体积超过模型窗口${tokenHint(p.match)}——终态错误，需缩注入或换大窗口模型`;
}
