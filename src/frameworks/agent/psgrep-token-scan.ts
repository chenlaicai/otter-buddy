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
 *  尾随 |（如 slice 到 while 前的边界）产生的空段跳过——不是命令。 */
function pipelineCommands(tokens: Token[]): Word[][] | null {
  const commands: Word[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.type === "op" && token.op === "|") {
      if (current.length > 0) commands.push(executableWords(current));
      current = [];
      continue;
    }
    if (token.type === "op" && CLAUSE_BOUNDARIES.has(token.op!)) return null;
    current.push(token);
  }
  if (current.length > 0) commands.push(executableWords(current));
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
  const [first, second, third] = args as string[];
  if (first === undefined || third !== undefined) return null;
  if (first === "-v" && second !== undefined) return { pattern: second, inverted: true };
  if (first === "-e" && second !== undefined) return { pattern: second, inverted: false };
  if (first === "-v" || first === "-e") return null;
  if (second === undefined) {
    if (first.startsWith("--regexp=")) return { pattern: first.slice("--regexp=".length), inverted: false };
    return { pattern: first, inverted: false };
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

/** 模板内 awk：单 script 参数、无文件操作数、无选项（awk '{print $2}' 形态）。 */
function isTemplateAwk(words: Word[]): boolean {
  if (words.length !== 2 || basename(words[0].evaluated ?? "") !== "awk") return false;
  const script = words[1].evaluated;
  return script !== null && script.startsWith("{") && script.endsWith("}");
}

interface TemplateState { sawPs: boolean; positive: boolean }

/** 模板链单命令流转；返回 false=链断裂（放行），true=继续。 */
function applyTemplateCommand(state: TemplateState, command: Word[]): boolean {
  const name = basename(command[0]?.evaluated ?? "");
  if (name === "ps") { state.sawPs = true; return true; }
  if (!state.sawPs) return true;
  if (isTemplateAwk(command)) return true;
  const match = grepMatchesMain(command);
  if (match === "self") return true;
  if (!match || !match.positive || match.inverted) return false;
  state.positive = true;
  return true;
}

/** 链尾形态：kill 直接收流，或 xargs kill（xargs 其他内层命令非链尾）。 */
function isChainTerminator(command: Word[]): boolean {
  const name = basename(command[0]?.evaluated ?? "");
  if (name === "kill") return true;
  if (name !== "xargs") return false;
  return basename(command[1]?.evaluated ?? "") === "kill";
}

/**
 * 固定模板数据流判定：ps(任意 argv) → [grep -v grep]* → grep(签名) →
 * [grep -v grep | awk 单script]* → 链尾（kill / xargs kill）。
 * 链中出现任何非白名单命令/旗标形态 → 数据流确认不了 → false（放行）。
 */
export function tokensScanMainSignature(tokens: Token[]): boolean {
  const commands = pipelineCommands(tokens);
  if (!commands) return false;
  const state: TemplateState = { sawPs: false, positive: false };
  for (const command of commands) {
    if (isChainTerminator(command)) return state.positive; // 链尾形态：到此为止
    if (!applyTemplateCommand(state, command)) return false;
  }
  return state.positive;
}

export function textScansMainSignature(text: string): boolean {
  const parsed = lex(text);
  return parsed.parseOk && tokensScanMainSignature(parsed.tokens);
}

/** 一个词中的全部真实命令替换；for 列表首项是其他字面值也不能遮蔽后续替换。 */
export function wordExpansionScansMain(word: Word): boolean {
  return word.parts.some(part => part.type === "cmdsub" && textScansMainSignature(part.text));
}
