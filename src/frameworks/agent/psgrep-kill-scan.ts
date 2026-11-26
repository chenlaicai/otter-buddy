/**
 * ps|grep 主服务精确入口签名→kill 数据流（特性文档：psgrep-kill-bypass）。
 * 词法层只消费真实执行 token；确认不了的数据流一律放行（宁漏勿误）。
 */
import { lex, type Token, type Word } from "./command-lexer";
import { findKillSegments } from "./kill-segment-finder";
import type { GuardBlock } from "./bash-safety-guard";
import {
  executableWords,
  PKILL_OTTER_PATTERNS,
  textScansMainSignature,
  tokensScanMainSignature,
  wordExpansionScansMain,
} from "./psgrep-token-scan";

// pkill/pgrep 的特征名表迁至 psgrep-token-scan（pkill 按名杀 + pgrep 按名查询同语义共用），此处 re-export 兼容旧 import。
export { PKILL_OTTER_PATTERNS };

export const PS_GREP_KILL_BLOCK_MSG: GuardBlock = {
  text: "ps|grep 按名匹配会命中主进程（dist/src/main.js 入口签名）再 kill——主服务与 worktree alpha 同签名不可区分，不允许。精确终止请用字面量 PID kill。",
  ruleId: "self_kill_byname",
  layer: "self_kill",
};

const BOUNDARIES = new Set([";", "\n", "&", "&&", "||", "(", ")"]);

function wordValue(token: Token | undefined): string | null {
  return token?.type === "word" ? token.word!.evaluated : null;
}

function isCommandPosition(tokens: Token[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token.type === "comment") continue;
    if (token.type === "op") return BOUNDARIES.has(token.op!) || token.op === "|";
    return ["do", "then", "else"].includes(wordValue(token) ?? "");
  }
  return true;
}

function isControlWord(tokens: Token[], index: number, word: string): boolean {
  return wordValue(tokens[index]) === word && isCommandPosition(tokens, index);
}

function commandBasename(value: string | null): string | null {
  return value ? value.split("/").pop() ?? value : null;
}

function clauseRange(tokens: Token[], index: number): { start: number; end: number } {
  let start = 0;
  let end = tokens.length;
  for (let i = index - 1; i >= 0; i--) {
    if (tokens[i].type === "op" && BOUNDARIES.has(tokens[i].op!)) { start = i + 1; break; }
  }
  for (let i = index; i < tokens.length; i++) {
    if (tokens[i].type === "op" && BOUNDARIES.has(tokens[i].op!)) { end = i; break; }
  }
  return { start, end };
}

function variableNames(word: Word, delayedPayload: boolean): string[] {
  const names: string[] = [];
  for (let i = 0; i < word.parts.length; i++) {
    const part = word.parts[i];
    if (part.type === "var") {
      const match = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(part.text);
      if (match) names.push(match[1]);
      continue;
    }
    // 双引号 bash -c 的原始载荷里 \$p 由外层保留给内层 shell；仅限该上下文识别。
    if (delayedPayload && part.type === "escape" && part.text === "\\$") {
      const match = /^([A-Za-z_]\w*)/.exec(word.parts[i + 1]?.text ?? "");
      if (match) names.push(match[1]);
    }
  }
  return names;
}

function assignmentName(word: Word): string | null {
  const first = word.parts[0];
  if (!first || (first.type !== "lit" && first.type !== "escape")) return null;
  return /^([A-Za-z_]\w*)=/.exec(first.text)?.[1] ?? null;
}

interface LoopBinding {
  kind: "for" | "while";
  header: number;
  doIndex: number;
  doneIndex: number;
  variables: string[];
  listWords: Word[];
}

function doDonePairs(tokens: Token[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isControlWord(tokens, i, "do")) stack.push(i);
    if (isControlWord(tokens, i, "done")) {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  return pairs;
}

/** header 之后位置最小的 do——Map 按闭合序插入，嵌套循环取外层 do 必须按位置而非插入序。 */
function nextDo(pairs: Map<number, number>, header: number): number {
  const candidates = [...pairs.keys()].filter(index => index > header);
  return candidates.length ? Math.min(...candidates) : -1;
}

function forBinding(tokens: Token[], header: number, pairs: Map<number, number>): LoopBinding | null {
  const variable = wordValue(tokens[header + 1]);
  if (!variable || !/^[A-Za-z_]\w*$/.test(variable) || wordValue(tokens[header + 2]) !== "in") return null;
  const doIndex = nextDo(pairs, header);
  if (doIndex < 0) return null;
  const listWords = tokens.slice(header + 3, doIndex).filter(t => t.type === "word").map(t => t.word!);
  return { kind: "for", header, doIndex, doneIndex: pairs.get(doIndex)!, variables: [variable], listWords };
}

function readVariables(tokens: Token[], read: number, doIndex: number): string[] {
  const variables: string[] = [];
  for (const token of tokens.slice(read + 1, doIndex)) {
    const value = wordValue(token);
    if (value && /^[A-Za-z_]\w*$/.test(value)) variables.push(value);
  }
  return variables;
}

function whileBinding(tokens: Token[], header: number, pairs: Map<number, number>): LoopBinding | null {
  const doIndex = nextDo(pairs, header);
  if (doIndex < 0) return null;
  let read = -1;
  for (let i = header + 1; i < doIndex; i++) {
    if (wordValue(tokens[i]) === "read") { read = i; break; }
  }
  if (read < 0) return null;
  return {
    kind: "while", header, doIndex, doneIndex: pairs.get(doIndex)!,
    variables: readVariables(tokens, read, doIndex), listWords: [],
  };
}

function loopBindings(tokens: Token[]): LoopBinding[] {
  const pairs = doDonePairs(tokens);
  const loops: LoopBinding[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isCommandPosition(tokens, i)) continue;
    const value = wordValue(tokens[i]);
    const loop = value === "for" ? forBinding(tokens, i, pairs)
      : value === "while" ? whileBinding(tokens, i, pairs) : null;
    if (loop) loops.push(loop);
  }
  return loops;
}

function lastAssignmentBefore(tokens: Token[], loop: LoopBinding, kill: number, variable: string): Word | null {
  let assigned: Word | null = null;
  for (let i = loop.doIndex + 1; i < kill; i++) {
    if (tokens[i].type !== "word" || !isCommandPosition(tokens, i)) continue;
    if (assignmentName(tokens[i].word!) === variable) assigned = tokens[i].word!;
  }
  return assigned;
}

function whileSourceScansMain(tokens: Token[], loop: LoopBinding): boolean {
  const { start } = clauseRange(tokens, loop.header);
  const upstream = tokens.slice(start, loop.header);
  return upstream.some(t => t.type === "op" && t.op === "|") && tokensScanMainSignature(upstream);
}

/** 最内层同名循环绑定优先；kill 前最后重赋值优先于循环头，确认不了不回退外层兜底。 */
function variableFeedsMain(tokens: Token[], loops: LoopBinding[], kill: number, variable: string): boolean {
  const candidates = loops.filter(loop => loop.variables.includes(variable)
    && loop.doIndex < kill && kill < loop.doneIndex).sort((a, b) => b.doIndex - a.doIndex);
  const loop = candidates[0];
  if (!loop) return false;
  const assigned = lastAssignmentBefore(tokens, loop, kill, variable);
  if (assigned) return wordExpansionScansMain(assigned);
  if (loop.kind === "while") return whileSourceScansMain(tokens, loop);
  return loop.listWords.some(wordExpansionScansMain);
}

function killTokenIndex(tokens: Token[], start: number, end: number): number {
  return tokens.findIndex(token => token.span.start >= start && token.span.end <= end
    && ["kill", "skill"].includes(commandBasename(wordValue(token)) ?? ""));
}

function segmentTokens(tokens: Token[], start: number, end: number): Token[] {
  return tokens.filter(token => token.span.start >= start && token.span.end <= end);
}

function directExpansionFeedsKill(tokens: Token[], kill: number, clauseEnd: number): boolean {
  // 直接目标只在当前命令内：遇 | 即止——下游命令的 cmdsub 不是 kill argv（二轮 D）。
  const targets = tokens.slice(kill + 1, commandArgEnd(tokens, kill, clauseEnd));
  return executableWords(targets).some(wordExpansionScansMain);
}

/** kill 当前命令的 argv 终点：clause 内首个 | / 语句边界（下游命令不是本 kill 的目标）。 */
function commandArgEnd(tokens: Token[], kill: number, clauseEnd: number): number {
  for (let i = kill + 1; i < clauseEnd; i++) {
    if (tokens[i].type === "op" && (tokens[i].op === "|" || BOUNDARIES.has(tokens[i].op!))) return i;
  }
  return clauseEnd;
}

function xargsFeedsKill(tokens: Token[], segment: Token[], kill: number): boolean {
  const usesXargs = segment.some(token => token.span.start < tokens[kill].span.start
    && commandBasename(wordValue(token)) === "xargs");
  if (!usesXargs) return false;
  const { start, end } = clauseRange(tokens, kill);
  return tokensScanMainSignature(tokens.slice(start, end));
}

/** word 是否处于 bash/sh -c 载荷位（前一 token 是 -c，再前命令名是 bash/sh）。 */
function isDashCPayloadAt(tokens: Token[], tokenIndex: number): boolean {
  const prev = tokens[tokenIndex - 1];
  const prevPrev = tokens[tokenIndex - 2];
  const isDashC = prev?.type === "word" && prev.word?.evaluated === "-c";
  const runner = prevPrev?.type === "word" ? commandBasename(prevPrev.word?.evaluated ?? null) : null;
  return isDashC && (runner === "bash" || runner === "sh");
}

/** 外层 lex 中覆盖 kill 段的引号载荷 word——必须有 bash/sh -c 载荷 provenance
 *  （普通 echo/printf 参数不递归，二轮 A）；findKillSegments 按字符分段，载荷内
 *  ; / | 会切碎外层段使 extractDashCPayloads 拿不到成对引号——kill 段命中但
 *  payload 丢失，此时回词法层找覆盖段的引号 word。 */
function coveringDashCPayload(command: string, tokens: Token[], tokenIndex: number): { payload: string; delayed: boolean } | null {
  const token = tokens[tokenIndex];
  if (!token || token.type !== "word") return null;
  const { start, end } = token.span;
  const quote = command[start];
  if ((quote !== '"' && quote !== "'") || command[end - 1] !== quote) return null;
  if (!isDashCPayloadAt(tokens, tokenIndex)) return null;
  return { payload: command.slice(start + 1, end - 1), delayed: quote === '"' };
}

/** 载荷文本内重跑 findKillSegments 定位真实 kill 段（不沿用外层段首坐标，二轮 B）；
 *  嵌套 -c 由 finder 的 extractDashCPayloads 逐层展开。 */
function payloadFeedsKill(payload: string, delayed: boolean): boolean {
  for (const seg of findKillSegments(payload)) {
    if (psGrepMainSignatureFeedsKill(payload, seg.segment, seg.start, delayed)) return true;
  }
  return false;
}

/** cmdsub 内 kill 的目标变量：$(kill $p) 的 $p 引用外层绑定；只取 kill 段 argv
 *  内的变量（遇 | / 语句边界即止，三轮 E2）——非 kill 命令的变量不挂 kill。 */
function cmdsubKillArgVariables(payload: string, seg: { segment: string; start: number }): string[] {
  const parsed = lex(payload);
  if (!parsed.parseOk) return [];
  const tokens = parsed.tokens;
  const kill = killTokenIndex(tokens, seg.start, seg.start + seg.segment.length);
  if (kill < 0) return [];
  return executableWords(tokens.slice(kill + 1, commandArgEnd(tokens, kill, tokens.length)))
    .flatMap(word => variableNames(word, false));
}

/** kill 段落在引号载荷/cmdsub word 内的判定（顶层无 kill token 时）：
 *  段首可能是 bash -c / do echo 等前缀，引号/cmdsub word 只覆盖段尾——逐个相交 word 判定。
 *  -c 载荷 → 载荷内重新定位 kill 段递归；cmdsub 内 kill → kill 位置取该 word，
 *  变量绑定仍在当前层判定。 */
function coveringWordFeedsKill(command: string, tokens: Token[], killIdx: number, segmentEnd: number, delayedPayload: boolean): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "word") continue;
    if (token.span.end <= killIdx || token.span.start >= segmentEnd) continue;
    const dashC = coveringDashCPayload(command, tokens, i);
    if (dashC && payloadFeedsKill(dashC.payload, dashC.delayed || delayedPayload)) return true;
    if (cmdsubWordFeedsKill(tokens, i)) return true;
  }
  return false;
}

/** word 的 cmdsub part 含 kill 执行面时：先跑载荷自包含数据流（direct/xargs/内层
 *  循环全在 cmdsub 文本内，三轮 E1），再对引用外层变量的 kill 段只取该 kill 段
 *  argv 的变量回查外层绑定（三轮 E2）。 */
function cmdsubWordFeedsKill(tokens: Token[], tokenIndex: number): boolean {
  for (const part of tokens[tokenIndex].word!.parts) {
    if (part.type !== "cmdsub") continue;
    const segs = findKillSegments(part.text);
    if (segs.length === 0) continue;
    if (segs.some(seg => psGrepMainSignatureFeedsKill(part.text, seg.segment, seg.start, false))) return true;
    const loops = loopBindings(tokens);
    const variables = segs.flatMap(seg => cmdsubKillArgVariables(part.text, seg));
    if (variables.some(variable => variableFeedsMain(tokens, loops, tokenIndex, variable))) return true;
  }
  return false;
}

/** @param delayedPayload 双引号 bash -c 原始载荷；只放宽变量识别，不把 \$() 当执行面。 */
export function psGrepMainSignatureFeedsKill(
  command: string,
  killSegment: string,
  killIdx: number,
  delayedPayload = false,
): boolean {
  if (killIdx < 0) return false;
  const parsed = lex(command);
  if (!parsed.parseOk) return false;
  const tokens = parsed.tokens;
  const segmentEnd = killIdx + killSegment.length;
  const kill = killTokenIndex(tokens, killIdx, segmentEnd);
  if (kill < 0) return coveringWordFeedsKill(command, tokens, killIdx, segmentEnd, delayedPayload);
  const clause = clauseRange(tokens, kill);
  if (directExpansionFeedsKill(tokens, kill, clause.end)) return true;
  const segment = segmentTokens(tokens, killIdx, segmentEnd);
  if (xargsFeedsKill(tokens, segment, kill)) return true;
  const loops = loopBindings(tokens);
  const variables = executableWords(tokens.slice(kill + 1, commandArgEnd(tokens, kill, clause.end)))
    .flatMap(word => variableNames(word, delayedPayload));
  return variables.some(variable => variableFeedsMain(tokens, loops, kill, variable));
}

// 保留给词法扫描单测/诊断锚点：真实文本扫描与 kill 数据流判定分离。
export { textScansMainSignature };
