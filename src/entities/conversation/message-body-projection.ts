/**
 * 消息体投影：HTML 卡片围栏剥离（F20260728htar）。
 *
 * 消息体是唯一事实源（body 原文不动）；检索（FTS/记忆索引）与上下文注入出口
 * 给剥离投影：html-card 围栏整体替换为 `[html-card: {title}]`，
 * html-card-reply 围栏整体替换为 `[html-card-reply: {cardId}]`。
 *
 * 剥离粒度按围栏类型分叉：
 * - html-card（卡片源码，体积大）：全路径剥离（索引 + 注入）
 * - html-card-reply（回执 JSON，≤2KB，本就是交互载荷）：仅索引剥离；
 *   上下文注入出口用 stripHtmlCardsOnly（不剥回执，水獭直接看到 JSON）
 *
 * 解析规则是 CommonMark 围栏代码块的子集：
 * - 反引号围栏（``` 或更长；卡片内含三反引号时用四反引号外层围栏）
 * - 开围栏缩进 ≤3 空格；支持嵌套在 blockquote（> 前缀）/ list（缩进前缀）内
 * - 闭围栏反引号数 ≥ 开围栏；未闭合围栏吃到文件尾
 * - 容器中断（后续行不再携带容器前缀）时围栏在容器出口处结束
 * - 普通代码围栏（含 ~~~）作为不透明块跳过：其内部的 html-card 字样不剥离
 */

/** 剥离选项：stripReplies=false 时只剥 html-card，保留 html-card-reply 原文（注入出口） */
export interface StripHtmlCardOptions {
  stripReplies?: boolean;
}

/** 开围栏匹配：捕获容器前缀（≤3 空格缩进，可选 blockquote 标记组）+ 围栏字符串 + info string */
const OPENING_FENCE_RE = /^( {0,3}(?:(?:> ?)+ {0,3})?)(`{3,}|~{3,})[^\S\n]*([^\n]*)$/;

/** 闭围栏匹配（剥离容器前缀后的剩余部分）：≥3 个同种围栏字符 + 至多尾随空白 */
const CLOSING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[^\S\n]*$/;

/** meta 属性提取（title / card）：双引号值，遇到首个引号截断 */
function extractMetaAttr(meta: string, attr: string): string {
  const re = new RegExp(`(?:^|\\s)${attr}="([^"]*)"`);
  const m = meta.match(re);
  return m ? m[1] : "";
}

interface FenceOpening {
  /** 容器前缀（如 "> "、"  "），围栏内容的每行都带此前缀 */
  prefix: string;
  /** 围栏字符（` 或 ~），闭围栏必须同种 */
  fenceChar: string;
  /** 开围栏字符数（闭围栏必须 ≥） */
  fenceLength: number;
  /** info string 首个词（语言标识）；反引号围栏的 info 不含 `（CommonMark） */
  lang: string;
  /** info string 去掉首个词后的 meta 部分 */
  meta: string;
}

/** 解析一行是否为开围栏；非围栏返回 null */
function parseOpeningFence(line: string): FenceOpening | null {
  const m = line.match(OPENING_FENCE_RE);
  if (!m) return null;
  /** CommonMark：反引号围栏的 info string 不能含反引号（含则整行不是开围栏） */
  if (m[2][0] === "`" && m[3].includes("`")) return null;
  const info = m[3].trim();
  const firstSpace = info.search(/\s/);
  const lang = firstSpace === -1 ? info : info.slice(0, firstSpace);
  const meta = firstSpace === -1 ? "" : info.slice(firstSpace + 1);
  return { prefix: m[1], fenceChar: m[2][0], fenceLength: m[2].length, lang, meta };
}

/** 判断剥离容器前缀后的剩余部分是否为该围栏的闭围栏 */
function isClosingFence(rest: string, opening: FenceOpening): boolean {
  const m = rest.match(CLOSING_FENCE_RE);
  return m !== null && m[1][0] === opening.fenceChar && m[1].length >= opening.fenceLength;
}

/**
 * 剥离消息体中的 HTML 卡片围栏，返回投影文本。
 *
 * @param body 消息原文
 * @param options.stripReplies 是否剥离 html-card-reply 回执围栏（默认 true）。
 *   索引出口（FTS/记忆）用默认值；上下文注入出口传 false（回执 JSON 给水獭直接看）。
 */
export function stripHtmlCardFences(body: string, options?: StripHtmlCardOptions): string {
  const stripReplies = options?.stripReplies ?? true;
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    i = processFenceOrLine(lines, i, out, stripReplies);
  }
  return out.join("\n");
}

/** 处理一行：普通行原样输出；围栏按类型决定剥离或透明跳过。返回下一未处理行号。 */
function processFenceOrLine(lines: string[], i: number, out: string[], stripReplies: boolean): number {
  const opening = parseOpeningFence(lines[i]);
  if (!opening) {
    out.push(lines[i]);
    return i + 1;
  }
  const isCard = opening.lang === "html-card";
  const isReply = opening.lang === "html-card-reply";
  /** 只替换目标围栏；普通围栏整体跳过（内部可能出现的 html-card 字样只是代码示例） */
  const shouldStrip = isCard || (isReply && stripReplies);
  out.push(shouldStrip ? placeholder(opening, isCard) : lines[i]);
  return consumeFenceBody(lines, i + 1, opening, out, !shouldStrip);
}

/** 生成占位符（保留容器前缀）：[html-card: {title}] / [html-card-reply: {cardId}] */
function placeholder(opening: FenceOpening, isCard: boolean): string {
  return isCard
    ? `${opening.prefix}[html-card: ${extractMetaAttr(opening.meta, "title")}]`
    : `${opening.prefix}[html-card-reply: ${extractMetaAttr(opening.meta, "card")}]`;
}

/** 消费围栏内容直到闭围栏 / 容器中断 / 文件尾（未闭合吃到 EOF）。emit=false 时内容不输出。 */
function consumeFenceBody(lines: string[], i: number, opening: FenceOpening, out: string[], emit: boolean): number {
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith(opening.prefix)) break; // 容器结束，围栏随之结束
    const rest = line.slice(opening.prefix.length);
    const closed = isClosingFence(rest, opening);
    if (emit) out.push(line);
    i++;
    if (closed) break;
  }
  return i;
}

/**
 * 只剥 html-card、保留 html-card-reply 的投影（上下文注入出口用）。
 * 注入出口：buildMessageWithContext 未读注入、list_messages、get_turn_history。
 */
export function stripHtmlCardsOnly(body: string): string {
  return stripHtmlCardFences(body, { stripReplies: false });
}
