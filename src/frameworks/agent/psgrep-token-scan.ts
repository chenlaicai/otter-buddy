/**
 * #1899 词法级 ps→grep 主服务入口签名扫描——固定可证明模板（M-de200a08 拍板：
 * 明确拦，不明确必须放通）。只消费 command-lexer 可执行 token；comment/单引号
 * 字面量/转义展开不进入执行面。模板外形态（wrapper/非常见旗标/结构变体）一律
 * 按政策 A 放行，残余清单见特性文档。
 */
import { lex, type Token, type Word } from "./command-lexer";

const MAIN_SIGNATURE = "dist/src/main.js";
const CLAUSE_BOUNDARIES = new Set([";", "\n", "&", "&&", "||", "(", ")"]);

function isRedirection(op: string): boolean {
  const bare = op.replace(/^[0-9]+/, "");
  return [">", ">>", "<", "<<", "<<<", "&>", "&>>", ">|", "<>", ">&", "<&"].includes(bare)
    || /^\d+[><]&\d+$/.test(op);
}

/** 段内 argv 词；重定向目标不是命令参数。 */
export function executableWords(tokens: Token[]): Word[] {
  const words: Word[] = [];
  let skipWord = false;
  for (const token of tokens) {
    if (token.type === "op" && isRedirection(token.op!)) {
      skipWord = !/[><]&\d+$/.test(token.op!);
      continue;
    }
    if (token.type !== "word") continue;
    if (skipWord) { skipWord = false; continue; }
    words.push(token.word!);
  }
  return words;
}

/** 仅接受单一管道链；||/;/& 两侧是独立执行面，调用方必须先切 clause。
 *  尾随 | 产生的空段跳过。每段同时记录真实文件重定向（stdin/stdout；
 *  N>&M 的 fd 复制不算——`xargs kill 2>&1` 不断流）。 */
interface PipeCommand { words: Word[]; stdinRedirect: boolean; stdoutRedirect: boolean }

function pipelineCommands(tokens: Token[]): PipeCommand[] | null {
  const commands: PipeCommand[] = [];
  let current: Token[] = [];
  const pushCurrent = () => {
    if (current.length === 0) return;
    const stdinRedirect = current.some(t => t.type === "op" && /^[0-9]*<(?!&)/.test(t.op!));
    const stdoutRedirect = current.some(t => t.type === "op" && /^([0-9]*>>?|&>>?)/.test(t.op!) && !/[>&]&\d+$/.test(t.op!));
    commands.push({ words: executableWords(current), stdinRedirect, stdoutRedirect });
    current = [];
  };
  for (const token of tokens) {
    if (token.type === "op" && token.op === "|") { pushCurrent(); continue; }
    if (token.type === "op" && CLAUSE_BOUNDARIES.has(token.op!)) return null;
    current.push(token);
  }
  pushCurrent();
  return commands;
}

/** [d]ist → dist：只归一单字符 self-match 类，不动真实多字符类。 */
function unbracketSelfMatch(pattern: string): string {
  return pattern.replace(/\[([A-Za-z0-9])\]/g, "$1");
}

function basename(value: string): string {
  return value.split("/").pop() ?? value;
}

export interface GrepMatch { positive: boolean; inverted: boolean }

interface TemplateGrep { pattern: string; inverted: boolean }

/** 模板 grep argv 解析：只认 [模式] / [-e 模式] / [--regexp=模式] / [-v 模式]
 *  （-v 与上述可组合）；其余任何形态 → null（不确认，放行）。 */
function parseTemplateGrep(args: (string | null)[]): TemplateGrep | null {
  if (args.some(a => a === null)) return null;
  let rest = args as string[];
  let inverted = false;
  if (rest[0] === "-v") { inverted = true; rest = rest.slice(1); }
  const [first, second, third] = rest;
  if (first === undefined || third !== undefined) return null;
  if (first === "-e" && second !== undefined) return { pattern: second, inverted };
  if (first === "-e" || first === "--regexp" || first === "-v") return null;
  if (second === undefined) {
    if (first.startsWith("--regexp=")) return { pattern: first.slice("--regexp=".length), inverted };
    return { pattern: first, inverted };
  }
  return null;
}

/** 模板内 grep 判定：模式含签名 → 正向；-v 签名 → 排除；-v grep/[g]rep → 自引用透明。
 *  其他任何形态（文件操作数、-f/-q/-o/-m/-i/-n、未知旗标、多模式）→ null 放行。 */
function grepMatchesMain(words: Word[]): GrepMatch | "self" | null {
  if (words.length === 0 || basename(words[0].evaluated ?? "") !== "grep") return null;
  const parsed = parseTemplateGrep(words.slice(1).map(w => w.evaluated));
  if (!parsed) return null;
  const normalized = unbracketSelfMatch(parsed.pattern);
  if (parsed.inverted && normalized === "grep") return "self";
  return { positive: normalized.includes(MAIN_SIGNATURE), inverted: parsed.inverted };
}

/** 模板内 awk：单引号字面 script，或双引号全静态 script（非 lit part 只允许 \\$ 类
 *  escape——单引号 -c 载荷内物理写不了单引号，awk "{print \\$2}" 是唯一朴素形态；
 *  未转义 $N 是 var 展开、语义不同构，不在模板）。 */
function isTemplateAwk(words: Word[]): boolean {
  if (words.length !== 2 || basename(words[0].evaluated ?? "") !== "awk") return false;
  const script = words[1];
  if (!script.evaluated || !script.evaluated.startsWith("{") || !script.evaluated.endsWith("}")) return false;
  const quotes = new Set(script.parts.map(p => p.quoted));
  if (quotes.has(false)) return false; // 裸词：shell 会切词，不是单 script
  return script.parts.every(p => p.type === "lit" || (p.type === "escape" && p.quoted === "double"));
}

/** 链尾形态：kill 直接收流，或 xargs kill（xargs 其他内层命令非链尾）。 */
function isChainTerminator(command: PipeCommand): boolean {
  const name = basename(command.words[0]?.evaluated ?? "");
  if (name === "kill") return true;
  if (name !== "xargs") return false;
  return basename(command.words[1]?.evaluated ?? "") === "kill";
}

/**
 * 固定模板阶段机（M-de200a08）：ps → [grep -v grep]* → 唯一 grep(签名) →
 * [grep -v grep | awk 单script]* → 链尾（kill / xargs kill）。
 * 任何白名单外形态（双 ps/第二正签名/awk 前置/非单引号 script/真实文件重定向）
 * → 数据流确认不了 → false（放行）。fd 复制（2>&1）不断流。
 */

/** grep 阶段流转：self 透明；唯一正签名置位；其余断裂。 */
function grepTemplateStep(signed: boolean, command: PipeCommand): boolean | null {
  const match = grepMatchesMain(command.words);
  if (match === "self") return signed;
  if (!match || !match.positive || match.inverted) return null;
  return signed ? null : true; // 第二个正签名：模板外
}

/** 阶段机单命令流转；返回新 signed，null=链断裂（放行）。 */
function templateStep(signed: boolean, command: PipeCommand): boolean | null {
  const name = basename(command.words[0]?.evaluated ?? "");
  if (name === "ps") return signed ? null : signed; // 第二个 ps：双 ps 结构不在模板
  if (name === "grep") return grepTemplateStep(signed, command);
  if (name === "awk" && signed && isTemplateAwk(command.words)) return signed;
  return null; // ps 前的命令不关心；ps 后白名单外断
}

export function tokensScanMainSignature(tokens: Token[]): boolean {
  const commands = pipelineCommands(tokens);
  if (!commands) return false;
  let signed = false; // 是否已过唯一正签名 grep
  for (const command of commands) {
    if (command.stdinRedirect || command.stdoutRedirect) return false;
    if (isChainTerminator(command)) return signed;
    const next = templateStep(signed, command);
    if (next === null) return false;
    signed = next;
  }
  return signed;
}

export function textScansMainSignature(text: string): boolean {
  const parsed = lex(text);
  return parsed.parseOk && tokensScanMainSignature(parsed.tokens);
}

/** 一个词中的全部真实命令替换；for 列表首项是其他字面值也不能遮蔽后续替换。 */
export function wordExpansionScansMain(word: Word): boolean {
  return word.parts.some(part => part.type === "cmdsub" && textScansMainSignature(part.text));
}
