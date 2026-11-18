/**
 * #1899 词法级 ps→grep 精确入口签名扫描。
 * 只消费 command-lexer 的可执行 token：comment / 单引号字面量 / 转义展开不进入执行面。
 */
import { lex, type Token, type Word } from "./command-lexer";

const MAIN_SIGNATURE = "dist/src/main.js";
const CLAUSE_BOUNDARIES = new Set([";", "\n", "&", "&&", "||", "(", ")"]);

function isRedirection(op: string): boolean {
  const bare = op.replace(/^[0-9]+/, "");
  return [">", ">>", "<", "<<", "<<<", "&>", "&>>", ">|", "<>", ">&", "<&"].includes(bare)
    || /^\d+[><]&\d+$/.test(op);
}

/** 段内 argv 词；重定向目标不是命令参数，签名出现在文件名中不构成 grep 匹配。 */
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

/** 仅接受单一管道链；||/;/& 两侧是独立执行面，调用方必须先切 clause。 */
function pipelineCommands(tokens: Token[]): Word[][] | null {
  const commands: Word[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.type === "op" && token.op === "|") {
      commands.push(executableWords(current));
      current = [];
      continue;
    }
    if (token.type === "op" && CLAUSE_BOUNDARIES.has(token.op!)) return null;
    current.push(token);
  }
  commands.push(executableWords(current));
  return commands;
}

function commandName(words: Word[]): string | null {
  const value = words[0]?.evaluated;
  if (!value) return null;
  return value.split("/").pop() ?? value;
}

/** [d]ist → dist：只归一单字符 self-match 类，不动真实多字符类。 */
function unbracketSelfMatch(pattern: string): string {
  return pattern.replace(/\[([A-Za-z0-9])\]/g, "$1");
}

interface GrepMatch { positive: boolean; inverted: boolean }

interface GrepArgs { patterns: string[]; inverted: boolean; ignoreCase: boolean }

type FlagAction = { consumeNext?: boolean };

/** 位置性模式词判定（-- 之后或非旗标形态；- 是 stdin 占位也算模式位）。 */
function patternPosition(options: boolean, arg: string): "dashdash" | "pattern" | "flag" {
  if (options && arg === "--") return "dashdash";
  if (!options || arg === "-" || !arg.startsWith("-")) return "pattern";
  return "flag";
}

/** 解析常见 grep 旗标与模式；解析不了即确认不了（返回 null 放行）。 */
function parseGrepArgs(args: Word[]): GrepArgs | null {
  const parsed: GrepArgs = { patterns: [], inverted: false, ignoreCase: false };
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].evaluated;
    if (arg === null) return null;
    const kind = patternPosition(options, arg);
    if (kind === "dashdash") { options = false; continue; }
    if (kind === "pattern") { parsed.patterns.push(arg); continue; }
    const flag = shortGrepFlag(arg, parsed);
    if (flag === undefined) return null;
    if (typeof flag === "string") { parsed.patterns.push(flag); continue; }
    if (flag.consumeNext) {
      const pattern = args[++i]?.evaluated;
      if (pattern == null) return null;
      parsed.patterns.push(pattern);
    }
  }
  return parsed;
}

/** 短旗标簇归位；返回 undefined=解析不了，string=内联模式，object=旗标动作。 */
function shortGrepFlag(arg: string, parsed: GrepArgs): undefined | string | FlagAction {
  if (arg === "--invert-match") { parsed.inverted = true; return {}; }
  if (arg === "--ignore-case") { parsed.ignoreCase = true; return {}; }
  if (arg.startsWith("--regexp=")) return arg.slice("--regexp=".length);
  if (arg === "--regexp" || arg === "-e") return { consumeNext: true };
  if (arg.startsWith("--") || !/^-[A-Za-z]+$/.test(arg)) return undefined;
  if (arg.includes("v")) parsed.inverted = true;
  if (arg.includes("i")) parsed.ignoreCase = true;
  if (!arg.includes("e")) return {};
  const attached = arg.slice(arg.indexOf("e") + 1);
  return attached || { consumeNext: true };
}

/** 签名模式匹配判定。 */
function grepMatchesMain(words: Word[]): GrepMatch | null {
  const parsed = parseGrepArgs(words.slice(1));
  if (!parsed) return null;
  const expected = parsed.ignoreCase ? MAIN_SIGNATURE.toLowerCase() : MAIN_SIGNATURE;
  const positive = parsed.patterns.some(pattern => {
    const normalized = unbracketSelfMatch(pattern);
    const actual = parsed.ignoreCase ? normalized.toLowerCase() : normalized;
    return actual.includes(expected);
  });
  return { positive, inverted: parsed.inverted };
}

/** 真实 ps→grep(精确签名) 管道；任一后续 grep -v 精确签名即已排除主服务。 */
export function tokensScanMainSignature(tokens: Token[]): boolean {
  const commands = pipelineCommands(tokens);
  if (!commands) return false;
  const psIndex = commands.findIndex(c => commandName(c) === "ps");
  if (psIndex < 0) return false;
  let positive = false;
  for (const command of commands.slice(psIndex + 1)) {
    if (commandName(command) !== "grep") continue;
    const match = grepMatchesMain(command);
    if (!match?.positive) continue;
    if (match.inverted) return false;
    positive = true;
  }
  return positive;
}

export function textScansMainSignature(text: string): boolean {
  const parsed = lex(text);
  return parsed.parseOk && tokensScanMainSignature(parsed.tokens);
}

/** 一个词中的全部真实命令替换；for 列表首项是其他字面值也不能遮蔽后续替换。 */
export function wordExpansionScansMain(word: Word): boolean {
  return word.parts.some(part => part.type === "cmdsub" && textScansMainSignature(part.text));
}
