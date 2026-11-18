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

/** 受限命令前缀词（与 kill-segment-finder 的 wrapper 语义对齐）：语义是「执行后面的命令」。 */
const COMMAND_PREFIXES = new Set(["sudo", "env", "nohup", "command", "xargs", "nice", "watch", "exec", "time", "timeout"]);
/** 前缀词的参数（timeout 5 / nice -n3 / xargs -n1 等） */
const WRAPPER_ARG = /^(?:-\S+|\d+)$/;
/** 赋值前缀词（FOO=1 grep）任意位置可剥 */
const ASSIGNMENT_PREFIX = /^[A-Za-z_]\w*=\S+$/;

/** 剥除 argv 前缀的 wrapper 词/参数/赋值；遇到第一个非 wrapper 词即止（后续是要执行的命令）。
 *  eval 不了的词不剥（确认不了按原 argv 判定，宁漏勿误）。 */
function stripWrappers(words: Word[]): Word[] {
  let i = 0;
  while (i < words.length) {
    const value = words[i].evaluated;
    if (value === null) break;
    if (COMMAND_PREFIXES.has(value) || ASSIGNMENT_PREFIX.test(value)) { i++; continue; }
    if (WRAPPER_ARG.test(value) && i > 0) { i++; continue; }
    break;
  }
  return words.slice(i);
}

function commandName(words: Word[]): string | null {
  const stripped = stripWrappers(words);
  const value = stripped[0]?.evaluated;
  if (!value) return null;
  return value.split("/").pop() ?? value;
}

/** [d]ist → dist：只归一单字符 self-match 类，不动真实多字符类。 */
function unbracketSelfMatch(pattern: string): string {
  return pattern.replace(/\[([A-Za-z0-9])\]/g, "$1");
}

interface GrepMatch { positive: boolean; inverted: boolean }

interface GrepArgs { patterns: string[]; files: string[]; inverted: boolean; ignoreCase: boolean; readsStdin: boolean; positionalPatternTaken: boolean }

type FlagAction = { consumeNext?: "pattern" | "file" };

/** 位置性参数形态判定（-- 之后或非旗标形态；- 是 stdin 占位也算模式位）。 */
function patternPosition(options: boolean, arg: string): "dashdash" | "operand" | "flag" {
  if (options && arg === "--") return "dashdash";
  if (!options || arg === "-" || !arg.startsWith("-")) return "operand";
  return "flag";
}

/** 位置参数归位：首参是模式，其余是被搜索文件（grep 文法）。 */
function applyOperand(parsed: GrepArgs, arg: string): void {
  if (parsed.positionalPatternTaken) parsed.files.push(arg);
  else { parsed.patterns.push(arg); parsed.positionalPatternTaken = true; }
}

/** 解析 grep argv：区分 pattern 与 file operands（GNU 文法：无 -e 时首个位置参数是模式，
 *  其余位置参数都是被搜索文件；有文件操作数时 grep 不读 stdin，ps→grep 数据流断开）。
 *  解析不了即确认不了（返回 null）。 */
function parseGrepArgs(args: Word[]): GrepArgs | null {
  const parsed: GrepArgs = { patterns: [], files: [], inverted: false, ignoreCase: false, readsStdin: true, positionalPatternTaken: false };
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
  parsed.readsStdin = parsed.files.length === 0;
  return parsed;
}

/** 应用一个旗标参数；返回处理后的索引（消费下一参数时 +1），解析不了返回 null。 */
function applyGrepFlag(parsed: GrepArgs, args: Word[], i: number): number | null {
  const flag = shortGrepFlag(args[i].evaluated!, parsed);
  if (flag === undefined) return null;
  if (typeof flag === "string") { parsed.patterns.push(flag); parsed.positionalPatternTaken = true; return i; }
  if (!flag.consumeNext) return i;
  const value = args[i + 1]?.evaluated;
  if (value == null) return null;
  if (flag.consumeNext === "pattern") { parsed.patterns.push(value); parsed.positionalPatternTaken = true; }
  else parsed.files.push(value);
  return i + 1;
}

/** 长选项归位（--invert-match / --regexp[=pat] / --file[=f]）。 */
function longGrepFlag(arg: string, parsed: GrepArgs): undefined | string | FlagAction {
  if (arg === "--invert-match") { parsed.inverted = true; return {}; }
  if (arg === "--ignore-case") { parsed.ignoreCase = true; return {}; }
  if (arg.startsWith("--regexp=")) return arg.slice("--regexp=".length);
  if (arg === "--regexp") return { consumeNext: "pattern" };
  if (arg.startsWith("--file=")) return fileAction(arg.slice("--file=".length), parsed);
  if (arg === "--file") return { consumeNext: "file" };
  return undefined;
}

/** 组合短旗标簇顺序解析：e/f 后的余文是该选项的参数，其后字母不再当旗标。 */
function shortClusterFlag(arg: string, parsed: GrepArgs): string | FlagAction {
  for (let i = 1; i < arg.length; i++) {
    const c = arg[i];
    if (c === "v") parsed.inverted = true;
    else if (c === "i") parsed.ignoreCase = true;
    else if (c === "e" || c === "f") {
      const attached = arg.slice(i + 1);
      return attached
        ? fileOrPattern(c === "e", attached, parsed)
        : { consumeNext: c === "e" ? "pattern" : "file" };
    }
  }
  return {};
}

/** 短旗标簇顺序归位；返回 undefined=解析不了，string=内联模式，object=旗标动作。 */
function shortGrepFlag(arg: string, parsed: GrepArgs): undefined | string | FlagAction {
  if (arg === "-e") return { consumeNext: "pattern" };
  if (arg === "-f") return { consumeNext: "file" };
  if (arg.startsWith("--")) return longGrepFlag(arg, parsed);
  if (!/^-[A-Za-z]+$/.test(arg)) return undefined;
  return shortClusterFlag(arg, parsed);
}

/** e=内联模式 / f=模式文件名（文件内容不可静态确认，不作为模式）。 */
function fileOrPattern(isPattern: boolean, attached: string, parsed: GrepArgs): string | FlagAction {
  return isPattern ? attached : fileAction(attached, parsed);
}

/** -f 的内联值进 files（数据流不来自 stdin；文件内容确认不了）。返回 {}=已消化非模式。 */
function fileAction(value: string, parsed: GrepArgs): FlagAction {
  parsed.files.push(value);
  return {};
}

/** 签名模式匹配判定；不读 stdin 的 grep（有文件操作数）不构成 ps→grep 数据流。
 *  argv 先剥 wrapper（command grep …）再取参数。 */
function grepMatchesMain(words: Word[]): GrepMatch | null {
  const args = stripWrappers(words).slice(1);
  const parsed = parseGrepArgs(args);
  if (!parsed || !parsed.readsStdin) return null;
  const expected = parsed.ignoreCase ? MAIN_SIGNATURE.toLowerCase() : MAIN_SIGNATURE;
  const positive = parsed.patterns.some(pattern => {
    const normalized = unbracketSelfMatch(pattern);
    const actual = parsed.ignoreCase ? normalized.toLowerCase() : normalized;
    return actual.includes(expected);
  });
  return { positive, inverted: parsed.inverted };
}

/** ps→grep(精确签名) 管道数据流状态机：新 ps 重置数据源（忽略上游重新输出全量），
 *  同一数据源内 grep -v 精确签名即已排除主服务；正向签名选择后流仍含主进程才确认。 */
export function tokensScanMainSignature(tokens: Token[]): boolean {
  const commands = pipelineCommands(tokens);
  if (!commands) return false;
  let flowHasMain: boolean | null = null; // null=未见 ps；true=当前数据流含主进程
  let scanned = false;                    // 当前数据源上是否发生精确签名正向扫描
  for (const command of commands) {
    const name = commandName(command);
    if (name === "ps") { flowHasMain = true; scanned = false; continue; }
    if (flowHasMain !== true || name !== "grep") continue;
    const match = grepMatchesMain(command);
    if (!match?.positive) continue;
    if (match.inverted) { flowHasMain = false; continue; } // 反向签名：主进程已被排除
    scanned = true;
  }
  return flowHasMain === true && scanned;
}

export function textScansMainSignature(text: string): boolean {
  const parsed = lex(text);
  return parsed.parseOk && tokensScanMainSignature(parsed.tokens);
}

/** 一个词中的全部真实命令替换；for 列表首项是其他字面值也不能遮蔽后续替换。 */
export function wordExpansionScansMain(word: Word): boolean {
  return word.parts.some(part => part.type === "cmdsub" && textScansMainSignature(part.text));
}
