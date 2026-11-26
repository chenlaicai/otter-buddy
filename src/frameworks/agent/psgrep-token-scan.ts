/**
 * 词法级 ps→grep 主服务入口签名扫描——固定可证明模板（明确拦，不明确必须放通）。只消费 command-lexer 可执行 token；comment/单引号
 * 字面量/转义展开不进入执行面。模板外形态（wrapper/非常见旗标/结构变体）一律
 * 按政策 A 放行，残余清单见特性文档。
 */
import { lex, type Token, type Word } from "./command-lexer";

/** 模板签名模式白名单：归一后精确等值（includes 不能证明匹配——^ 锚点/后缀变体运行时不匹配主行）。 */
const MAIN_SIGNATURES = new Set(["dist/src/main.js", "otter-buddy/dist/src/main.js"]);

/** otter 进程特征子串表（pkill/pgrep 共用）：按名匹配命令行判据。
 *  pkill 按名杀与 pgrep 按名查询是同语义，等价改写（pkill -f X ⇔ pgrep -f X | xargs kill）
 *  必须同拦；ps|grep 精确签名通道用 MAIN_SIGNATURES，不复用这张宽表。 */
export const PKILL_OTTER_PATTERNS = [
  "otter-buddy", "otter_buddy", "dist/src/main", "dist/src/main.js",
  ".otter-buddy.pid", "main.js", "node",
];
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
    // 仅 2>&1（stderr 并入 stdout）不断流；1>&2 把 stdout 改到 stderr，管道断
    const stdoutRedirect = current.some(t => t.type === "op" && /^([0-9]*>>?|&>>?)/.test(t.op!) && t.op !== "2>&1");
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

/** 剥除匹配集等价的 .* 通配前后缀（.*X ≡ 含 X 子串，* 可匹配空）；单点等其他元字符不剥。 */
function stripEquivalentWildcards(pattern: string): string {
  return pattern.replace(/^\.\*/, "").replace(/\.\*$/, "");
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
  const normalized = stripEquivalentWildcards(unbracketSelfMatch(parsed.pattern));
  if (parsed.inverted && normalized === "grep") return "self";
  return { positive: MAIN_SIGNATURES.has(normalized), inverted: parsed.inverted };
}

/** 模板内 awk：单引号字面 script，或双引号全静态 script（非 lit part 只允许 \\$ 类
 *  escape——单引号 -c 载荷内物理写不了单引号，awk "{print \\$2}" 是唯一朴素形态；
 *  未转义 $N 是 var 展开、语义不同构，不在模板）。 */
/** 定位链内 pgrep 命令词；只认命令位置（链首 / wrapper 前缀后），pgrep 作为参数不识别。 */
function findPgrepIndex(words: Word[]): number {
  for (let i = 0; i < words.length && i < 3; i++) {
    const n = basename(words[i].evaluated ?? "");
    if (n === "pgrep") return i;
    if (!["sudo", "env", "nohup", "timeout", "nice", "command"].includes(n)) break;
  }
  return -1;
}

/** 链内 pgrep 判定：argv 文字含 otter 特征子串即命中（对齐 pkillTargetsOtter 子串口径）。
 *  pgrep 本身是「查询」非「杀」——签名识别只为「pgrep → kill」数据流兑底，
 *  纯 pgrep 查询不在此判定（由 kill 段粗筛控制）。pgrep 与 pkill 等价改写的枚举形态
 *  （-f / -fl / --full / sudo 前缀）由 argv 文字子串统一覆盖，不允许一句话绕过。 */
function pgrepMatchesMain(words: Word[]): boolean {
  const pgrepIdx = findPgrepIndex(words);
  if (pgrepIdx < 0) return false;
  const argText = words.slice(pgrepIdx + 1).map(w => w.evaluated ?? "").join(" ").toLowerCase();
  return PKILL_OTTER_PATTERNS.some(p => argText.includes(p.toLowerCase()));
}

function isTemplateAwk(words: Word[]): boolean {
  if (words.length !== 2 || basename(words[0].evaluated ?? "") !== "awk") return false;
  const script = words[1];
  if (!script.evaluated || !script.evaluated.startsWith("{") || !script.evaluated.endsWith("}")) return false;
  const quotes = new Set(script.parts.map(p => p.quoted));
  if (quotes.has(false)) return false; // 裸词：shell 会切词，不是单 script
  return script.parts.every(p => p.type === "lit" || (p.type === "escape" && p.quoted === "double"));
}

/** xargs 带参短旗标（POSIX/GNU）：独立 token 出现时下一词是参数（-d '\n' / -I {} / -n 1），
 *  须连参数一并跳过再定位 kill；粘连形式（-d'\n' / -n1 / -I{}）参数已并入 token。
 *  覆盖 POSIX(-E/-I/-L/-n/-s) + GNU(-a/-d/-P) 与弃用别名 -e（eof）。 */
const XARGS_FLAGS_WITH_ARG = new Set(["-a", "-d", "-E", "-e", "-I", "-L", "-n", "-P", "-s"]);
/** xargs 带参长选项（GNU）：--xxx 独立（下一词是参数）跳 2；--xxx=value 粘连跳 1。 */
const XARGS_LONG_WITH_ARG = new Set([
  "--arg-file", "--delimiter", "--eof", "--replace",
  "--max-lines", "--max-args", "--max-procs", "--max-chars",
]);

/** 链尾形态：kill 直接收流，或 xargs [flags...] kill。xargs 自身 flag 可置于 kill 前，
 *  按 xargs 语义跳过：带参 flag（-d/-E/-I/-n/-a/-L/-P/-s + 长选项带参）连参数一并跳，
 *  无参 flag（-r/--no-run-if-empty/-0/-x/...）与粘连（-d'\n'/-n1/-I{}）直接跳；
 *  非 kill 的 xargs 目标不是链尾，维持放行。 */
function isChainTerminator(command: PipeCommand): boolean {
  const name = basename(command.words[0]?.evaluated ?? "");
  if (name === "kill") return true;
  if (name !== "xargs") return false;
  let i = 1;
  while (i < command.words.length) {
    const tok = command.words[i].evaluated ?? "";
    if (!tok.startsWith("-")) break;
    i += XARGS_FLAGS_WITH_ARG.has(tok) || XARGS_LONG_WITH_ARG.has(tok) ? 2 : 1;
  }
  return basename(command.words[i]?.evaluated ?? "") === "kill";
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

interface TemplateStage { started: boolean; signed: boolean }

/** 阶段机单命令流转；返回新阶段，null=链断裂（放行）。ps / pgrep 必须是链首命令
 *  （ps/pgrep 前的任何命令断模板）；第二个 ps/pgrep 无论在正签名前后都断。 */
function templateStep(stage: TemplateStage, command: PipeCommand): TemplateStage | null {
  const name = basename(command.words[0]?.evaluated ?? "");
  if (stage.started) {
    // 续链：仅 grep（唯一正签名）/ awk 单 script 合法，其余（含重复 ps/pgrep）断模板
    if (name === "grep") {
      const signed = grepTemplateStep(stage.signed, command);
      return signed === null ? null : { ...stage, signed };
    }
    if (name === "awk" && stage.signed && isTemplateAwk(command.words)) return stage;
    return null;
  }
  // 链首：ps 等后续 grep 签名；pgrep 直接带签名（含 sudo 前缀，无签名不确认=放行）
  if (name === "ps") return { started: true, signed: false };
  if (findPgrepIndex(command.words) >= 0) {
    return pgrepMatchesMain(command.words) ? { started: true, signed: true } : null;
  }
  return null; // 非链首命令
}

export function tokensScanMainSignature(tokens: Token[]): boolean {
  const commands = pipelineCommands(tokens);
  if (!commands) return false;
  let stage: TemplateStage | null = { started: false, signed: false };
  for (const command of commands) {
    if (isChainTerminator(command)) {
      // 链尾（kill/xargs kill）的 PID 来自 stdin：stdout/stderr 改向不影响数据流，
      // 只看 stdin 是否被真实替换（七轮）。
      return command.stdinRedirect ? false : stage.signed;
    }
    if (command.stdinRedirect || command.stdoutRedirect) return false;
    stage = templateStep(stage, command);
    if (stage === null) return false;
  }
  return stage.signed;
}

export function textScansMainSignature(text: string): boolean {
  const parsed = lex(text);
  return parsed.parseOk && tokensScanMainSignature(parsed.tokens);
}

/** 一个词中的全部真实命令替换；for 列表首项是其他字面值也不能遮蔽后续替换。 */
export function wordExpansionScansMain(word: Word): boolean {
  return word.parts.some(part => part.type === "cmdsub" && textScansMainSignature(part.text));
}
