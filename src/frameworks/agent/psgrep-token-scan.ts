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

/** 仅接受单一管道链；||/;/& 两侧是独立执行面，调用方必须先切 clause。
 *  尾随 | （如 slice 到 while 前的边界）产生的空段跳过——不是命令。 */
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

/** 赋值前缀词（FOO=1 grep）任意位置可剥。 */
const ASSIGNMENT_PREFIX = /^[A-Za-z_]\w*=\S+$/;
/** env/sudo 中消费下一词的选项（-u FOO / --user root）。 */
const OPTION_WITH_ARG = /^--?(?:u|user|unset)$/;
/** timeout/nice 的数值参数（5 / 5s）。 */
const NUMERIC_ARG = /^\d+(\.\d+)?[smhd]?$/;
/** 简单 wrapper（其后可跟数值/选项参数，参数后即真实命令）。 */
const TIMED_WRAPPERS = new Set(["timeout", "nice", "nohup", "watch", "exec", "time"]);

/** 剥 env/sudo 及其选项与赋值参数；返回指向真实命令的索引。 */
function stripEnvSudo(words: Word[], start: number): number {
  let i = start;
  while (i < words.length) {
    const value = words[i].evaluated;
    if (value === null) break;
    if (ASSIGNMENT_PREFIX.test(value)) { i++; continue; }
    if (OPTION_WITH_ARG.test(value)) { i += 2; continue; }
    if (value === "-i" || value === "--ignore-environment") { i++; continue; }
    if (value.startsWith("-") && value !== "-") { i++; continue; }
    break;
  }
  return i;
}

/** 剥简单 wrapper 及其数值/优先级/选项参数。 */
function stripTimedWrapper(words: Word[], start: number): number {
  let i = start;
  while (i < words.length) {
    const value = words[i].evaluated;
    if (value === null) break;
    if (NUMERIC_ARG.test(value)) { i++; continue; }
    if (value === "-n") { i += 2; continue; }
    if (value.startsWith("-") && value !== "-") { i++; continue; }
    break;
  }
  return i;
}

/** 剥除 argv 前缀的 wrapper 词（按各自 option arity）。xargs 不剥——xargs grep 的
 *  stdin 语义与 grep 过滤不同。command/builtin 只允许 -p：-v/-V 是查询非执行，
 *  停在原地让后续判定认不出目标命令。eval 不了的词不剥（宁漏勿误）。 */
function stripWrappers(words: Word[]): Word[] {
  let i = 0;
  while (i < words.length) {
    const value = words[i].evaluated;
    if (value === null) break;
    if (ASSIGNMENT_PREFIX.test(value)) { i++; continue; }
    if (value === "env" || value === "sudo") { i = stripEnvSudo(words, i + 1); continue; }
    if (value === "command" || value === "builtin") {
      i = words[i + 1]?.evaluated === "-p" ? i + 2 : i + 1;
      continue;
    }
    if (TIMED_WRAPPERS.has(value)) { i = stripTimedWrapper(words, i + 1); continue; }
    break;
  }
  return words.slice(i);
}

/** [d]ist → dist：只归一单字符 self-match 类，不动真实多字符类。 */
function unbracketSelfMatch(pattern: string): string {
  return pattern.replace(/\[([A-Za-z0-9])\]/g, "$1");
}

export interface GrepMatch { positive: boolean; inverted: boolean; patterns: string[] }

interface GrepArgs {
  patterns: string[];            // 显式模式（-e/位置首个）
  dataFiles: string[];           // 数据文件操作数（stdin 占位 '-' 不入列）
  positionalPatternTaken: boolean;
  inverted: boolean;
  ignoreCase: boolean;
  quiet: boolean;                // -q/-s：无 stdout
  matchesOnly: boolean;          // -o：只输出匹配文本
  noOriginalLines: boolean;      // -l/-L/-c：输出文件名/计数非原行
}

type FlagAction = { consumeNext?: "pattern" | "ignore" };

/** 位置性参数形态判定（-- 之后或非旗标形态；- 是 stdin 占位）。 */
function patternPosition(options: boolean, arg: string): "dashdash" | "operand" | "flag" {
  if (options && arg === "--") return "dashdash";
  if (!options || arg === "-" || !arg.startsWith("-")) return "operand";
  return "flag";
}

/** 不改变行输出语义的长选项白名单。 */
const LONG_NOARG = new Set([
  "--extended-regexp", "--fixed-strings", "--basic-regexp", "--perl-regexp",
  "--line-buffered", "--text", "--line-number", "--no-messages", "--word-regexp",
  "--with-filename", "--no-filename", "--invert-match", "--ignore-case",
  "--quiet", "--silent", "--only-matching",
  "--files-with-matches", "--files-without-match", "--count",
]);
/** 带数值参数的长选项（参数丢弃，不影响行输出语义）。 */
const LONG_NUMERIC = new Set(["--max-count", "--before-context", "--after-context", "--context", "--threads", "--file"]);

/** 长选项归位；返回 undefined=解析不了，string=内联模式，object=旗标动作。 */
function longGrepFlag(arg: string, parsed: GrepArgs): undefined | string | FlagAction {
  if (arg === "--regexp") return { consumeNext: "pattern" };
  if (arg.startsWith("--regexp=")) return arg.slice("--regexp=".length);
  if (LONG_NUMERIC.has(arg)) return { consumeNext: "ignore" };
  if ([...LONG_NUMERIC].some(k => arg.startsWith(`${k}=`))) return {};
  if (LONG_NOARG.has(arg)) return applyLongNoArg(arg, parsed);
  return undefined;
}

/** 无参长选项的输出语义副作用。 */
function applyLongNoArg(arg: string, parsed: GrepArgs): FlagAction {
  if (arg === "--invert-match") parsed.inverted = true;
  else if (arg === "--ignore-case") parsed.ignoreCase = true;
  else if (arg === "--quiet" || arg === "--silent") parsed.quiet = true;
  else if (arg === "--only-matching") parsed.matchesOnly = true;
  else if (arg === "--files-with-matches" || arg === "--files-without-match" || arg === "--count") parsed.noOriginalLines = true;
  return {};
}

/** 输出语义字母的动作表（e/f/m 带参，另行特判）。 */
const CLUSTER_LETTERS: Record<string, (p: GrepArgs) => void> = {
  v: p => { p.inverted = true; },
  i: p => { p.ignoreCase = true; },
  q: p => { p.quiet = true; },
  s: p => { p.quiet = true; },
  o: p => { p.matchesOnly = true; },
  l: p => { p.noOriginalLines = true; },
  L: p => { p.noOriginalLines = true; },
  c: p => { p.noOriginalLines = true; },
};

/** 组合短旗标簇顺序解析：带参字母（e/f/m）后的余文是该选项参数，其后字母不再当旗标；
 *  数字只出现在带参字母的余文中（-m1）。 */
function shortClusterFlag(arg: string, parsed: GrepArgs): string | FlagAction {
  for (let i = 1; i < arg.length; i++) {
    const c = arg[i];
    if (c === "e") return arg.slice(i + 1) || { consumeNext: "pattern" };
    if (c === "f" || c === "m") return attachedOrIgnore(arg.slice(i + 1));
    CLUSTER_LETTERS[c]?.(parsed);
    // 其余字母（E/F/P/a/n/w 等）与数字不改变行输出语义，跳过
  }
  return {};
}

/** 簇内带参字母的余文处理：有余文即参数已附着，无余文消费下一参数。 */
function attachedOrIgnore(attached: string): FlagAction {
  return attached ? {} : { consumeNext: "ignore" };
}

/** 短旗标归位。 */
function shortGrepFlag(arg: string, parsed: GrepArgs): undefined | string | FlagAction {
  if (arg === "-e") return { consumeNext: "pattern" };
  if (arg === "-f" || arg === "-m") return { consumeNext: "ignore" };
  if (arg.startsWith("--")) return longGrepFlag(arg, parsed);
  if (!/^-[A-Za-z][A-Za-z0-9]*$/.test(arg)) return undefined;
  return shortClusterFlag(arg, parsed);
}

/** 位置参数归位：首参是模式，其余是被搜索文件（'-' 是 stdin 占位不入列）。 */
function applyOperand(parsed: GrepArgs, arg: string): void {
  if (!parsed.positionalPatternTaken) {
    parsed.patterns.push(arg);
    parsed.positionalPatternTaken = true;
    return;
  }
  if (arg !== "-") parsed.dataFiles.push(arg);
}

/** 应用一个旗标；返回处理后的索引（消费下一参数时 +1），解析不了返回 null。 */
function applyGrepFlag(parsed: GrepArgs, args: Word[], i: number): number | null {
  const flag = shortGrepFlag(args[i].evaluated!, parsed);
  if (flag === undefined) return null;
  if (typeof flag === "string") {
    parsed.patterns.push(flag);
    parsed.positionalPatternTaken = true;
    return i;
  }
  if (!flag.consumeNext) return i;
  const value = args[i + 1]?.evaluated;
  if (value == null) return null;
  if (flag.consumeNext === "pattern") {
    parsed.patterns.push(value);
    parsed.positionalPatternTaken = true;
  }
  return i + 1;
}

/** 解析 grep argv（GNU 文法）；解析不了即确认不了（返回 null）。 */
function parseGrepArgs(args: Word[]): GrepArgs | null {
  const parsed: GrepArgs = {
    patterns: [], dataFiles: [], positionalPatternTaken: false,
    inverted: false, ignoreCase: false, quiet: false, matchesOnly: false, noOriginalLines: false,
  };
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].evaluated;
    if (arg === null) return null;
    const kind = patternPosition(options, arg);
    if (kind === "dashdash") { options = false; continue; }
    if (kind === "operand") { applyOperand(parsed, arg); continue; }
    const next = applyGrepFlag(parsed, args, i);
    if (next === null) return null;
    i = next;
  }
  return parsed;
}

/** 签名模式匹配判定；输出语义不携带原行（q/o/l/L/c）或读数据文件（非 '-'）时
 *  ps→grep→…→kill 数据流断开，返回 null。 */
function grepMatchesMain(words: Word[]): GrepMatch | null {
  const parsed = parseGrepArgs(stripWrappers(words).slice(1));
  if (!parsed) return null;
  if (parsed.quiet || parsed.matchesOnly || parsed.noOriginalLines || parsed.dataFiles.length > 0) return null;
  const expected = parsed.ignoreCase ? MAIN_SIGNATURE.toLowerCase() : MAIN_SIGNATURE;
  const positive = parsed.patterns.some(pattern => {
    const normalized = unbracketSelfMatch(pattern);
    const actual = parsed.ignoreCase ? normalized.toLowerCase() : normalized;
    return actual.includes(expected);
  });
  return { positive, inverted: parsed.inverted, patterns: parsed.patterns };
}

/** grep -v grep / [g]rep：排除 grep 自身进程的惯用法，对主进程流透明。 */
function isSelfGrepExclusion(match: GrepMatch): boolean {
  return match.inverted && match.patterns.length > 0
    && match.patterns.every(p => unbracketSelfMatch(p) === "grep");
}

/** 位置参数可能是数据文件的常见工具。 */
const FILE_OPERAND_TOOLS = new Set(["head", "tail", "sort", "uniq", "cut", "wc"]);

function hasFileOperand(stripped: Word[]): boolean {
  return stripped.slice(1).some(w => w.evaluated !== null && !w.evaluated!.startsWith("-"));
}

/** xargs 的 stdin 语义取决于内层命令：kill/pkill 继续 PID 数据流，其他不可确认。 */
function xargsEffect(stripped: Word[]): "transparent" | "unknown" {
  const inner = stripped.slice(1).find(w => w.evaluated !== null && !w.evaluated!.startsWith("-"));
  const name = inner?.evaluated?.split("/").pop();
  return name === "kill" || name === "pkill" ? "transparent" : "unknown";
}

/** 常见工具的 stdin 语义特判（ps/grep 由状态机特判，不在此表）。 */
function simpleStdinEffect(base: string, stripped: Word[]): "transparent" | "replaces" | "unknown" | null {
  if (base === "tr") return "transparent";
  if (base === "cat") return stripped.length > 1 ? "replaces" : "transparent";
  if (base === "echo" || base === "printf") return "replaces";
  if (base === "awk" || base === "sed") return stripped.length > 2 ? "replaces" : "transparent";
  if (base === "xargs") return xargsEffect(stripped);
  if (FILE_OPERAND_TOOLS.has(base)) return hasFileOperand(stripped) ? "replaces" : "transparent";
  return null;
}

/** 管道中间命令的 stdin 语义：transparent=过滤 stdin；replaces=忽略 stdin 自有来源；
 *  unknown=确认不了；ps/grep 由状态机特判。 */
function stdinEffect(words: Word[]): "ps" | "grep" | "transparent" | "replaces" | "unknown" {
  const stripped = stripWrappers(words);
  const name = stripped[0]?.evaluated;
  if (!name) return "unknown";
  const base = name.split("/").pop() ?? name;
  if (base === "ps") return "ps";
  if (base === "grep") return "grep";
  return simpleStdinEffect(base, stripped) ?? "unknown";
}

interface FlowState { hasMain: boolean | null; scanned: boolean }

/** grep 流转：自引用排除透明；反向签名排除主进程；正向签名记扫描；确认不了断流。 */
function applyGrepToFlow(state: FlowState, match: GrepMatch | null): void {
  if (match === null) { state.hasMain = null; return; }
  if (isSelfGrepExclusion(match)) return;
  if (match.inverted) { state.hasMain = false; return; }
  if (match.positive) { state.scanned = true; return; }
  state.hasMain = null;
}

function applyCommandToFlow(state: FlowState, command: Word[]): void {
  const effect = stdinEffect(command);
  if (effect === "ps") { state.hasMain = true; state.scanned = false; return; }
  if (effect === "grep") { applyGrepToFlow(state, grepMatchesMain(command)); return; }
  if (effect === "replaces" || effect === "unknown") { state.hasMain = null; state.scanned = false; }
}

/** ps→grep(精确签名) 管道数据流状态机：新 ps 重置数据源；grep -v 签名即排除主进程；
 *  忽略 stdin 的中间命令（cat file/echo/带数据文件）替换数据流；确认不了一律放行。 */
export function tokensScanMainSignature(tokens: Token[]): boolean {
  const commands = pipelineCommands(tokens);
  if (!commands) return false;
  const state: FlowState = { hasMain: null, scanned: false };
  for (const command of commands) applyCommandToFlow(state, command);
  return state.hasMain === true && state.scanned;
}

export function textScansMainSignature(text: string): boolean {
  const parsed = lex(text);
  return parsed.parseOk && tokensScanMainSignature(parsed.tokens);
}

/** 一个词中的全部真实命令替换；for 列表首项是其他字面值也不能遮蔽后续替换。 */
export function wordExpansionScansMain(word: Word): boolean {
  return word.parts.some(part => part.type === "cmdsub" && textScansMainSignature(part.text));
}
