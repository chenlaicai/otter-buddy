/**
 * payload-extract-aux：能力 5 三病型手术辅助（拍板 2026-10-13）。
 *
 * 病型 A：check-only 形态判定（语法检查=读脚本不执行）。
 * 病型 C：引号自散架侦察 + 载荷级重组 span + 硬性负门（写词面/新 runner 交界）。
 *
 * 纯函数：无状态、无 IO（机制识别检查点非机制面）。
 */
import type { CommandModel, Segment } from "./command-model";
import type { Word } from "./command-lexer";

/** shell 递归/脚本载荷解释器族（与 bash-safety-guard 脚本族同源口径） */
export const SCRIPT_RUNNERS = new Set(["python", "python3", "node", "perl", "ruby", "osascript"]);

/** 病型 A：check-only 形态=语法检查（读脚本不执行）——node --check/-c、perl -c、ruby -c、
 *  python -m py_compile、--syntax-only（bash/sh -n 不在 SCRIPT_RUNNERS，本就走正常段求值）。
 *  与不透明执行形态（node script.js / bash attack.sh）严格分界：无 check 旗标一律不算，
 *  后者窄提取照旧回落（负门钉死不许被 check-only 放宽）。 */
const CHECK_ONLY_FLAGS: Record<string, string[]> = {
  node: ["--check", "-c", "--syntax-only"],
  perl: ["-c", "--syntax-only"],
  ruby: ["-c", "--syntax-only"],
  osascript: ["--syntax-only"],
};

export function isCheckOnlyWords(bare: string, args: Array<string | null>): boolean {
  const vals = args.filter((a): a is string => a !== null);
  if (vals.includes("-e")) return false; // 带执行载荷走载荷通道（含 perl -pi -e 原地编辑面）
  if (/^python/.test(bare)) return vals.includes("-m") && vals.includes("py_compile");
  const flags = CHECK_ONLY_FLAGS[bare];
  return flags !== undefined && flags.some(f => vals.includes(f));
}

export function isCheckOnlySeg(seg: Segment): boolean {
  const bare = (seg.argv0 ?? "").split("/").pop() ?? "";
  if (seg.argv0 === null) return false;
  return isCheckOnlyWords(bare, seg.args);
}

/** check-only 段的文件实参（读侧入账原料）——旗标与元词剔除后按序返回 */
export function checkOnlyFileArgs(seg: Segment): string[] {
  return seg.args.filter((a): a is string => a !== null && !a.startsWith("-") && a !== "py_compile");
}

/** 病型 C 侦察：bash 级引号状态扫描（转义对与单双引号区，与词法双引号扫描同语义）——
 *  命令收尾时引号未闭合 = 捕获命令在 bash 里亲手跑也会散架（引号塔转义断裂），
 *  需要载荷级重组按原意读回（方案 a，拍板 2026-10-13）。 */
export function quoteUnbalanced(raw: string): boolean {
  let state: "out" | "dquote" | "squote" = "out";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (state === "out") {
      if (c === "\\") i++;
      else if (c === "'") state = "squote";
      else if (c === '"') state = "dquote";
    } else if (state === "squote") {
      if (c === "'") state = "out";
    } else {
      if (c === "\\") i++;
      else if (c === '"') state = "out";
    }
  }
  return state !== "out";
}

/** 尾随重定向（重组边界：到重定向前）—— 2>&1 / >x / >>x / &>x / 2>/dev/null 等尾部形态 */
const TRAILING_REDIR = /\s+(?:&>{1,2}|[0-9]{0,2}>>?(?:&[0-9]|&-)?|>(?:&[0-9]|&-)?)\s*\S*\s*$/;

/** 载荷级重组 span：flag 词后到尾随重定向前的原始文本（跨引号开合，按原意读回） */
export function reassemblySpan(commandText: string, start: number): string {
  const tr = TRAILING_REDIR.exec(commandText);
  const end = tr !== null && tr.index > start ? tr.index : commandText.length;
  return commandText.slice(start, end);
}

/** 病型 C 负门②：新 runner 交界——重组 span 内分隔符后出现另一解释器执行形态（非 check-only）
 *  → 跨段藏写风险，回落不猜。echo/printf 等内建非 runner 不算交界。 */
const RUNNER_JUNCTION = /(?:^|[;&|\n])\s*(?:sudo\s+)?(?:bash|zsh|ksh|sh|node|python3?|perl|ruby|osascript)\s+[^\n;&|]*/g;

export function runnerJunctionUnsafe(span: string): boolean {
  for (const m of span.matchAll(RUNNER_JUNCTION)) {
    const segText = m[0].replace(/^[;&|\n]\s*/, "").replace(/^sudo\s+/, "");
    const words = segText.trim().split(/\s+/);
    const bare = (words[0] ?? "").split("/").pop() ?? "";
    if (!isCheckOnlyWords(bare, words.slice(1))) return true;
  }
  return false;
}

/** 段是否带载荷旗标（-c/-e/- 或词内 cmdsub/var 展开——有展开就有载荷面） */
export function hasPayloadFlag(seg: Segment): boolean {
  return seg.words.some(w => w.evaluated === "-c" || w.evaluated === "-e" || w.evaluated === "-");
}

/** 段是否脚本解释器段（argv0 命中 SCRIPT_RUNNERS） */
export function isScriptRunnerSeg(seg: Segment): boolean {
  const bare = (seg.argv0 ?? "").split("/").pop() ?? "";
  return seg.argv0 !== null && SCRIPT_RUNNERS.has(bare);
}

/** 模型是否含脚本载荷族（解释器载荷旗标段或 cmdsub/var 展开词） */
export function detectScriptPayload(model: CommandModel): boolean {
  for (const seg of model.segments) {
    if (isScriptRunnerSeg(seg) && (hasPayloadFlag(seg) || seg.words.some(w => w.parts.some(p => p.type === "cmdsub" || p.type === "var")))) {
      return true;
    }
  }
  return model.payloads.some(p => p.model !== null && detectScriptPayload(p.model));
}

/** 病型 B/C：载荷脚本文本解析——命令引号自散架时走载荷级重组 span（病型 C，硬性负门：
 *  span 内写词面/新 runner 交界 → null=回落）；否则 evaluated 优先，null 时 cmdsub 拼原文
 *  （病型 B，var/arith/unknown 不拼——展开值不可知不猜）。 */
export function resolvePayloadScript(payloadWord: Word, flagWord: Word, commandText: string): { script: string | null; cMode: boolean } {
  const cMode = quoteUnbalanced(commandText);
  if (cMode) {
    const span = reassemblySpan(commandText, flagWord.span.end);
    if (runnerJunctionUnsafe(span)) return { script: null, cMode };
    return { script: span, cMode };
  }
  if (payloadWord.evaluated !== null) return { script: payloadWord.evaluated, cMode };
  if (payloadWord.parts.every(p => p.type === "lit" || p.type === "escape" || p.type === "cmdsub")) {
    return { script: payloadWord.parts.map(p => p.text).join(""), cMode };
  }
  return { script: null, cMode };
}

// ────────────── git alias shell 展开提取（F20261015gali，M-edd889c2） ──────────────

export type GitAliasShellExtraction =
  | { kind: "payload"; texts: string[] }
  | { kind: "opaque" }
  | null;

/** 词的字面前缀（首个展开 part 之前的 lit/escape/hex 拼接）——动态词的可证部分。 */
function literalPrefixOf(word: Word): string {
  let s = "";
  for (const p of word.parts) {
    if (p.type === "lit" || p.type === "escape" || p.type === "hex") s += p.text;
    else break;
  }
  return s;
}

/** alias k=v 词解析：evaluated 词整词归一（引号三形态由词法层剥除）；动态词仅当字面
 *  前缀可见完整 alias 键（`alias.x=`）时判 opaque（键可见、值不可证）。其余=null。 */
function aliasDefOf(word: Word): { value: string } | "opaque" | null {
  if (word.evaluated !== null) {
    const m = /^alias\.[\w.-]+=(.*)$/i.exec(word.evaluated);
    return m ? { value: m[1] } : null;
  }
  // 动态词：字面前缀可见 alias 键（`alias.x=`）或键+`!`（`alias.x=!`载荷动态）→ 均不可证
  return /^alias\.[\w.-]+=!?$/i.test(literalPrefixOf(word)) ? "opaque" : null;
}

/** config 形态的独立值词（`git config alias.x '!cmd'`）：! 前缀=shell 展开载荷。 */
function aliasShellValueOf(word: Word): { payload: string } | "opaque" | null {
  if (word.evaluated !== null) {
    return word.evaluated.startsWith("!") ? { payload: word.evaluated.slice(1) } : null;
  }
  return literalPrefixOf(word).startsWith("!") ? "opaque" : null;
}

/** config 键值对处理（早退平铺，消 max-depth）：单词形 k=v / 独立键+值词。
 *  consumed=本对占用词数（独立键+值=2）；"stop"=首个非旗标键非 alias（无定义位）。 */
function configAliasPair(words: Word[], j: number): { texts: string[]; consumed: number } | "opaque" | "stop" {
  const wj = words[j];
  const d = aliasDefOf(wj);
  if (d === "opaque") return "opaque";
  if (d !== null) {
    return d.value.startsWith("!")
      ? { texts: [d.value.slice(1)], consumed: 1 }
      : { texts: [], consumed: 1 };
  }
  if (wj.evaluated === null || !/^alias\.[\w.-]+$/i.test(wj.evaluated)) return "stop";
  const val = words[j + 1];
  if (val === undefined) return { texts: [], consumed: 1 };
  const sv = aliasShellValueOf(val);
  if (sv === "opaque") return "opaque";
  return { texts: sv !== null ? [sv.payload] : [], consumed: 2 };
}

/** config 子命令形扫描（k/v 分离或 k=v 单词形，旗标位跳过）。
 *  返回载荷集 / "opaque" / null（无定义位）。 */
function scanConfigAliasWords(words: Word[], start: number): { texts: string[] } | "opaque" | null {
  const texts: string[] = [];
  let j = start;
  while (j < words.length) {
    const v = words[j].evaluated;
    if (v === null) break;
    if (v.startsWith("--") && v.includes("=")) { j++; continue; } // 附着形旗标
    if (v === "--file" || v === "-f" || v === "--blob") { j += 2; continue; } // 取值旗标
    if (v.startsWith("-")) { j++; continue; } // 无值旗标（--global/--unset/--get…）
    const pair = configAliasPair(words, j);
    if (pair === "opaque") return "opaque";
    if (pair === "stop") break;
    texts.push(...pair.texts);
    j += pair.consumed;
  }
  return texts.length > 0 ? { texts } : null;
}

/** F20261015gali（M-edd889c2）：git alias shell 展开（! 前缀）定义提取——真执行体载荷。
 *  `!` 前缀 alias 值是任意 shell 执行通道（git 原生语义：从仓库根以 shell 执行）。
 *  检出位（字面 argv0==="git"）：
 *   ① 子命令前全局旗标位 `-c alias.x=!载荷`（值词引号三形态由词法层归一）；
 *   ② `config [旗标…] alias.x '!载荷'`（含 `config 'alias.x=!载荷'` 单词形）。
 *  -c 只认子命令前旗标位——`git grep -c 'alias.x=!x'` 的 -c 是子命令参数非全局旗标
 *  （FP 陷阱：提及/参数位不得误判定义位）。非 ! 前缀=纯子命令别名（git 原生语义不进
 *  shell）不检出。间接构造（env 注入/包装词/整词动态 k=v）不追——F20261015gsub
 *  （#1513）拍板：常见直白形态兜底，物理隔离才是真守卫。
 *  返回 {kind:"payload",texts}（可静态提取载荷→调用方递归判读）| {kind:"opaque"}
 *  （检出 ! 定义但载荷不可静态提取→调用方 fail-closed）| null（无定义位）。 */
// eslint-disable-next-line max-statements, complexity -- git 全局旗标位形态穷举（-C/-c/--git-dir/--work-tree × =值/空格值）+ config 键值位判定，每分支对应一种已声明形态（c107 词切分错位教训：合并会再制造旗标解析 bug）
export function extractGitAliasShell(seg: Segment): GitAliasShellExtraction {
  if (seg.argv0 !== "git") return null;
  const words = seg.words;
  const texts: string[] = [];
  let i = 1;
  // 子命令前全局旗标位走查（与 write-target-evaluator evalGitWrite 旗标循环同构）：
  // -C/-c/--git-dir/--work-tree（含 =附着形）外的词=子命令位，停止旗标走查
  while (i < words.length) {
    const w = words[i].evaluated;
    if (w === null) break; // 旗标/子命令位动态词——间接构造不追（#1513），后续定义位扫描失去锚，按无定义位处置
    if (w === "-c") {
      const next = words[i + 1];
      if (next === undefined) { i++; continue; }
      const d = aliasDefOf(next);
      if (d === "opaque") return { kind: "opaque" };
      if (d !== null && d.value.startsWith("!")) texts.push(d.value.slice(1));
      i += 2;
      continue;
    }
    if (w === "-C" || w === "--git-dir" || w === "--work-tree") { i += 2; continue; }
    if (w.startsWith("--git-dir=") || w.startsWith("--work-tree=")) { i++; continue; }
    break;
  }
  // config 子命令形（k/v 分离或 k=v 单词形）
  if (i < words.length && words[i].evaluated === "config") {
    const r = scanConfigAliasWords(words, i + 1);
    if (r === "opaque") return { kind: "opaque" };
    if (r !== null) texts.push(...r.texts);
  }
  return texts.length > 0 ? { kind: "payload", texts } : null;
}
