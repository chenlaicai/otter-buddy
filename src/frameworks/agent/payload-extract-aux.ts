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
/** 包装词旗标形态表：包装词 → 跳过时吞食后续 token 的规则。
 *  词表外未知包装词一律 fail-closed——三轮枚举爆破的教训：不扩词表换结构，
 *  但「已知包装词」仍需一张表承载其旗标语法；表的职责从「枚举全宇宙包装词」
 *  收窄为「描述已知词的旗标形态」，未知词由结构兜底拦。
 *  吞食规则（确定性，防贪婪误吞解释器名）：
 *    flags: 吞连续的 - 开头 token（含合写/内联值形态：-o0 / --user=root 属之）；
 *    valueFlags: 带值旗标分写形态（M-c36b9847 值参盲区收编）——恰为集合成员的
 *           旗标 token（无内联值，token 本身即旗标名，如 -u / --user）后随的一个
 *           token 是它的值（FOO/root/KILL），一并吞食。只收「必带值」旗标：
 *           可选值旗标（sudo --preserve-env[=list] 类）不入表，防贪婪误吞解释器名；
 *           值吞食语义与真实 wrapper 语法同构——值恰为解释器名时（env -u bash）
 *           真实语义就是「值不是命令」，吞掉才是正确解析；
 *    assigns: env 专有——吞 FOO=v 形态；
 *    duration: timeout 专有——旗标吞完后吞一个时长 token（\d 开头或数字+单位）。
 *  delta r1（检视獭1604）：本表随段首解析收敛迁入共享内层（guard/wte 同一识别域）；
 *  值旗标分写形态不吞的盲区（M-c36b9847）由本层 valueFlags 收编（F20261022vwfg）。 */
export interface WrapperSpec {
  flags?: boolean;   // 吞连续 - 开头 token
  /** 必带值旗标集合（分写形态：旗标后随一个值 token）——恰为成员才吞值；
   *  合写形态（-o0 / --user=root）由 flags 域覆盖，不在此表 */
  valueFlags?: ReadonlySet<string>;
  assigns?: boolean; // 吞 FOO=v token（可夹于 flags 之后）
  duration?: boolean; // 吞一个时长/数值 token（timeout/watch -n 之外的独立参数）
}
export const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  env: { flags: true, assigns: true, valueFlags: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"]) },
  nice: { flags: true, duration: true, valueFlags: new Set(["-n", "--adjustment"]) },      // nice -n 5（-n 带值）/ nice -5
  timeout: { flags: true, duration: true, valueFlags: new Set(["-s", "--signal", "-k", "--kill-after"]) },   // timeout [-s KILL] 5 cmd
  watch: { flags: true, duration: true, valueFlags: new Set(["-n", "--interval"]) },       // watch -n 1 cmd
  setsid: { flags: true },
  stdbuf: { flags: true, valueFlags: new Set(["-o", "--output", "-e", "--error", "-i", "--input"]) }, // stdbuf -o0（合写）/ stdbuf -o 0（分写）
  arch: {},
  sudo: { flags: true, valueFlags: new Set(["-u", "--user", "-g", "--group", "-U", "--other-user", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir", "-R", "--chroot", "-T", "--command-timeout", "-r", "--role", "-t", "--type"]) }, // -h/--host 歧义（help/远程）不入表
  nohup: {},
  command: { flags: true },
  exec: { flags: true },
  time: { flags: true },
  xargs: { flags: true, valueFlags: new Set(["-I", "-i", "--replace", "-n", "--max-args", "-d", "--delimiter", "-P", "--max-procs", "-s", "--max-chars", "-L", "-l", "--max-lines", "-a", "--arg-file"]) }, // xargs -I{}（值内联）/ xargs -I {}（分写收编）
};

/** 多调分发器二进制（M-38fb45c0 A 面）：<dispatcher> <子命令> = 子命令语义别名
 *  （busybox sh ≡ sh）——delta r1：裸分发器（无子命令）按默认 applet ash 归位
 *  （busybox 默认 shell；toybox 同保守归位——最短攻击形态收编，检视獭1604 严重 3）。 */
export const MULTI_CALL_DISPATCHERS = new Set(["busybox", "toybox"]);

export const tokenBasename = (t: string): string => {
  const stripped = t.replace(/^["']|["']$/g, "");
  const base = stripped.includes("/") ? stripped.split("/").pop()! : stripped;
  return base.toLowerCase();
};

/** 跳过一个包装词及其旗标参数（parseSegmentHead/stdinShellKind/resolveExecHead 共用
 *  内层——wrapper 吞食规则单一真相源，抽函数控圈复杂度）。
 *  确定性吞食（防贪婪误吞解释器名）：flags 连续 - 开头（valueFlags 成员吞一个后随值 token）
 *  / assigns FOO=v / duration 单个数值。 */
export function skipWrapperArgs(tokens: ReadonlyArray<{ text: string }>, k: number, spec: WrapperSpec): number {
  let durationTaken = false;
  while (k < tokens.length) {
    const t = tokens[k].text;
    if (spec.flags && /^-/.test(t)) {
      k++;
      // 值参分写形态（M-c36b9847）：旗标恰为 valueFlags 成员（无内联值，token 即旗标名）
      //  → 后随一个 token 是它的值（env -u FOO / sudo -u root / timeout -s KILL），一并吞。
      //  防贪婪边界：只对「必带值」旗标成立；可选值旗标不入表（否则会误吞解释器名）。
      if (spec.valueFlags?.has(t) && k < tokens.length) k++;
      continue;
    }
    if (spec.assigns && /^[A-Za-z_]\w*=\S*$/.test(t)) { k++; continue; }
    if (spec.duration && !durationTaken && /^\d/.test(t)) { durationTaken = true; k++; continue; }
    break;
  }
  return k;
}

/** 执行名归一（识别域一致性共享内层）：剥路径 → 版本后缀剥离（python2/python3.11/
 *  perl5.36 → python/perl）→ 别名归一（pypy* → python 族——pypy 执行 Python 语义，
 *  pythonBodyReadOnly 同判据适用）。识别域比对一律用归一名——单侧各写各的归一
 *  正是检视獭1604 严重 2 的漂移源（guard 归一认 python2、wte 入口闸裸词拒收）。 */
const EXEC_NAME_ALIASES: Record<string, string> = { pypy: "python" };
export function canonicalExecName(raw: string): string {
  const base = tokenBasename(raw);
  const stripped = base.replace(/[\d.]+$/, "");
  return EXEC_NAME_ALIASES[stripped] ?? stripped;
}

export interface ExecHead {
  /** 归一化执行名（SCRIPT_RUNNERS/SHELL 名单比对用） */
  name: string;
  /** 执行名所在 words 下标（其后是执行参） */
  headIndex: number;
  /** 落点前消耗过 wrapper/多调分发器 */
  wrapped: boolean;
}

/** 段首执行名解析（guard/wte 识别域一致性共享内层——检视獭1604 严重 1/2/3 同根因
 *  收敛）：两侧各自解析段首时 guard 认定 feed 形态域 ⊃ wte 识别域（wte 裸 argv0 词
 *  不跳 wrapper/不归一版本名），guard 以为在管、求值器看不见 → evaluated 空集放行。
 *  解析序：跳赋值前缀（不算包装）→ 跳 wrapper 词及其旗标/赋值/时长参（WRAPPER_SPECS
 *  同基座）→ 多调分发器子命令归位（busybox sh ≡ sh；裸分发器默认 applet ash）→
 *  版本名归一（canonicalExecName）。段首链动态词（evaluated=null）→ null（判不出，
 *  调用方保守处理）。 */
/** 无命令回退=跑 shell 的包装词（F20261022vwfg）：包装词吞尽全段、无执行词时的真实
 *  语义是 shell 执行（管道喂入=shell 读上游，fail-closed 归位 sh）。依据：sudo(8)
 *  「If no command is specified, an interactive shell is executed」；反向实证：
 *  nice/nohup 无命令仅 usage 报错（非 shell）不入表；setsid 本机无从实证按残余记档。 */
export const SHELL_EXEC_ON_EMPTY = new Set(["sudo"]);

// eslint-disable-next-line complexity -- 解析序四段穷举（赋值前缀/wrapper 吞食/分发器归位/版本归一）是识别域一致性的判定面，拆函数会把单段首解析真相源切碎（delta r1 收敛核心——先例 interpreterScriptFileArg 双域判定豁免同款）
export function resolveExecHead(seg: Segment): ExecHead | null {
  const words = seg.words;
  const tokens = words.map(w => ({ text: w.evaluated ?? "" }));
  let i = 0;
  let wrapped = false;
  for (;;) {
    const t = words[i]?.evaluated ?? null;
    if (t === null) return null;
    if (/^[A-Za-z_]\w*=/.test(t)) { i++; continue; } // 赋值前缀不算包装
    const wrapperBase = tokenBasename(t);
    const spec = WRAPPER_SPECS[wrapperBase];
    if (!spec) break;
    wrapped = true;
    i = skipWrapperArgs(tokens, i + 1, spec);
    if (i >= words.length) {
      return SHELL_EXEC_ON_EMPTY.has(wrapperBase)
        ? { name: "sh", headIndex: words.length - 1, wrapped: true }
        : null;
    }
  }
  const rawBase = tokenBasename(words[i].evaluated!);
  if (MULTI_CALL_DISPATCHERS.has(rawBase)) {
    const next = words[i + 1]?.evaluated ?? null;
    if (next !== null && next.length > 0 && !next.startsWith("-")) {
      return { name: canonicalExecName(next), headIndex: i + 1, wrapped: true };
    }
    return { name: "ash", headIndex: i, wrapped: true }; // 裸分发器=默认 applet ash
  }
  return { name: canonicalExecName(rawBase), headIndex: i, wrapped };
}

/** 解释器 stdin 喂入的执行参白名单（两侧共用）：裸词/单短旗标/lone -（-c/-e/--x=v/
 *  脚本文件参走既有载荷通道不收）；空参（裸 python）也算——stdin 即程序来源。 */
export function isStdinFeedRest(rest: Array<string | null>): boolean {
  return rest.every(t => t !== null && (/^-[a-zA-Z]$/.test(t) || t === "-"));
}


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
const RUNNER_JUNCTION = /(?:^|[;&|\n])\s*(?:sudo\s+)?(?:bash|zsh|ksh|ash|sh|node|python3?|perl|ruby|osascript)\s+[^\n;&|]*/g;

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

/** 段是否脚本解释器段（段首执行名归一后命中 SCRIPT_RUNNERS——resolveExecHead 共用
 *  内层：跳赋值前缀/wrapper/分发器 + 版本名归一，与 guard interpreterStdinKind、wte
 *  interpreterStdinFeedContent 同一识别域）。delta r1（检视獭1604 严重 1/2 根因）：
 *  旧裸 argv0 词判定是窄提取入口闸——env python（argv0="env"）、python2 在此被拒，
 *  feed 分支不可达 → evaluated 空集放行；归一后 wrapper/版本别名形态同尺进窄提取。 */
export function isScriptRunnerSeg(seg: Segment): boolean {
  const head = resolveExecHead(seg);
  return head !== null && SCRIPT_RUNNERS.has(head.name);
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

// ────────────── git 写族子命令判定（F20261016gwr1，M-46f0e74d） ──────────────

/** git 写族子命令词表（求值器 isWrite 口径=宽词表，双签终版 2026-10-12：reset/clean/
 *  stash/pull 一律写族、落点/排除语义在上层判定；**与 prod 严格语义不同**——prod gate
 *  的 push --dry-run 排除/stash push 限定/reset --hard 限定见 gitWriteSubcommandHit）。 */
export const GIT_WRITE_SUBS = new Set(["commit", "rebase", "merge", "cherry-pick", "apply", "reset", "clean", "push", "stash", "pull"]);

/** F20261016gdfv（#1522）：git stash 写族子命令全集（git-stash(1) 明文）——push/pop/apply/
 *  drop/clear/store/branch 均改工作区或 stash ref；缺省（bare）≡ push（明文）；旗标形
 *  （stash -m …）= push 形态。只读面=list/show/create（create 只打印对象名不落 stash
 *  ref/不动工作区——git-stash(1) 明文，归读面）。两侧共享（isWriteVerbAt / evalGitWrite
 *  / 写族正则同步），词表漂移=静动/双链反判。 */
export const STASH_WRITE_SUBS = new Set(["push", "pop", "apply", "drop", "clear", "store", "branch"]);

/** F20261016gwr1（M-46f0e74d）：git 写族子命令判定（词级，prod 严格语义）——引号含空格/
 *  attached/反引号值全覆盖（旧 GIT_WRITE_SUBCOMMAND 正则 \S+ 词面解析对这三形态整体
 *  失明=fail-open 实证，正则已退役）。语义=旧正则锚同款（r2-C 基线）：push 排除
 *  --dry-run/-n、stash 限 push、reset 限 --hard、clean 限 f 旗标；词等值天然排除
 *  commit-tree/merge-base 词族。走查与 extractGitAliasShell/evalGitWrite 同构（c107
 *  教训：不合并走查，语义注释对齐）。动态值位照常消费后找子命令；动态旗标/子命令位
 *  →false（间接构造不追，#1513 边界）。 */
/** git 取值型全局旗标（旗标词后跟独立值词）——gitWriteSubcommandHit 与 lookAheadWriteSubcommand
 *  两走查共享（词表漂移会再造静动反判；走查不合并=c107 教训，语义注释对齐）。
 *  F20261016gsbx 导出：受保护分支直推窄规则同基座复用（单一真相源）。 */
export const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);

export function gitWriteSubcommandHit(seg: Segment): boolean {
  if (seg.argv0 !== "git") return false;
  const words = seg.words;
  let i = 1;
  while (i < words.length) {
    const w = words[i].evaluated;
    if (w === null) {
      // F20261016gwr1 修复轮（M-46f0e74d 严重 1，检视獭1519）：动态词位不弃权——后续静态写族
      // 子命令照判 write（`git -c"$P" commit`/`git -C$P commit` 附着+动态混合形态曾双层
      // fail-open，同语义空格/附着拼接反判）。红线：后续无写族子命令（`git -C"$P" status`
      //）照常 false，只读面不误拦。间接构造（整词动态子命令 `git "$X"`）仍不追（#1513）。
      return lookAheadWriteSubcommand(words, i + 1);
    }
    if (GIT_VALUE_FLAGS.has(w)) {
      const nxt = words[i + 1]?.evaluated ?? null;
      i += words[i + 1] !== undefined && !(nxt ?? "").startsWith("-") ? 2 : 1; // 值位（含动态值）照常消费
      continue;
    }
    if (w.startsWith("-")) { i++; continue; } // 静态旗标（含 attached 值形——子命令识别不受影响）
    break;
  }
  return isWriteVerbAt(words, i);
}

/** 写族子命令判定（严格语义，位置定在 words[i]）：push 排除 --dry-run/-n、stash 限写族全集
 *  （F20261016gdfv/#1522：pop/apply/drop/clear/store/branch 真写面收编——旧「限 push」漏拦；
 *  bare ≡ push（F20261016gwr1 修复轮 建议 2）；读面 list/show/create 不入）
 *  、reset 限 --hard、clean 限 f 旗标；词等值天然排除 commit-tree/merge-base 词族。 */
// eslint-disable-next-line complexity -- 写族子命令严格语义逐分支（push 排除/stash 写族全集/reset --hard 限定/clean f 旗标，r2-C 基线形态穷举）
function isWriteVerbAt(words: Word[], i: number): boolean {
  const sub = words[i]?.evaluated ?? null;
  if (sub === null) return false;
  const next = words[i + 1]?.evaluated ?? null;
  if (sub === "commit" || sub === "rebase" || sub === "merge" || sub === "cherry-pick" || sub === "apply") return true;
  if (sub === "stash") return next === null || STASH_WRITE_SUBS.has(next) || (next !== null && next.startsWith("-"));
  if (sub === "push") return next !== "--dry-run" && next !== "-n";
  if (sub === "reset") return next === "--hard";
  if (sub === "clean") return next !== null && /^-[a-zA-Z]*f/.test(next);
  return false;
}

/** F20261016gwr1 修复轮二（delta 残留 1，检视獭1519）：动态词位后的写族前瞻——与主走查
 *  同构（旗标/取值旗标消费后停在首个静态非旗标词=子命令位）就地判 write 即停，**不越位
 *  扫参数**——旧版从 from 全量扫描把参数词当子命令位（`git -C"$P" log -G push` 的 push 被
 *  isWriteVerbAt 命中 → 与静态 `git -C /repo log -G push` 反判=本 PR 病核复发，误拦方向）。
 *  取值旗标必须吞值（`git -c"$P" -C /repo commit` 的 /repo 是值不是子命令位，漏吞=新 fail-open）。
 *  动态词跳过不追（间接构造不追，#1513）；后续无静态非旗标词（`git -C"$P" status` 红线）照常 false。 */
function lookAheadWriteSubcommand(words: Word[], from: number): boolean {
  let j = from;
  while (j < words.length) {
    const w = words[j].evaluated;
    if (w === null) { j++; continue; } // 动态词跳过（非静态子命令候选）
    if (GIT_VALUE_FLAGS.has(w)) {
      const nxt = words[j + 1]?.evaluated ?? null;
      j += words[j + 1] !== undefined && !(nxt ?? "").startsWith("-") ? 2 : 1; // 值位照常消费（漏吞=值词误当子命令位）
      continue;
    }
    if (w.startsWith("-")) { j++; continue; }
    return isWriteVerbAt(words, j); // 首个静态非旗标词=子命令位，就地判定（勿越位扫参数）
  }
  return false;
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

/** alias k=v 字符串解析（attached -c<kv> 形态共用）。 */
function aliasKvOfString(kv: string): { value: string } | null {
  const m = /^alias\.[\w.-]+=(.*)$/i.exec(kv);
  return m ? { value: m[1] } : null;
}

/** alias k=v 词解析：evaluated 词整词归一（引号三形态由词法层剥除）；动态词仅当字面
 *  前缀可见完整 alias 键（`alias.x=`）时判 opaque（键可见、值不可证）。其余=null。 */
function aliasDefOf(word: Word): { value: string } | "opaque" | null {
  if (word.evaluated !== null) {
    return aliasKvOfString(word.evaluated);
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
/** 引号平衡校验（X4，检视獭1518）：单引号/双引号各自成对（双引号内反斜杠可转义）——
 *  `'\'''` 转义截断伪影会留下不平残痕，判 opaque 防伪影载荷带病过递归。 */
function quotesBalanced(s: string): boolean {
  let sq = false;
  let dq = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (sq) { if (c === "'") sq = false; continue; }
    if (dq) { if (c === "\\") { i++; continue; } if (c === '"') dq = false; continue; }
    if (c === "'") sq = true;
    else if (c === '"') dq = true;
    else if (c === "\\") i++;
  }
  return !sq && !dq;
}

// eslint-disable-next-line max-statements, complexity -- git 全局旗标位形态穷举（-C/-c/--git-dir/--work-tree × =值/空格值）+ config 键值位判定，每分支对应一种已声明形态（c107 词切分错位教训：合并会再制造旗标解析 bug）
export function extractGitAliasShell(seg: Segment): GitAliasShellExtraction {
  if (seg.argv0 !== "git") return null;
  const words = seg.words;
  const texts: string[] = [];
  let i = 1;
  // 子命令前全局旗标位走查（与 write-target-evaluator evalGitWrite 旗标循环同构）：
  // 首个非旗标词=子命令位才停。X1（检视獭1518）：静态旗标一律 continue 不 break——
  // `git --no-pager -c alias.pwn='!x' pwn` 类 wrapper 旗标曾使走查提前折断→提取
  // 静默失效；取值旗标（git 全局集 -C/-c/--git-dir/--work-tree/--exec-path/--namespace
  //，=附着形或独立值形）消费其值，其余静态旗标无值跳过。
  while (i < words.length) {
    const w = words[i].evaluated;
    if (w === null) {
      // F20261016gwr1 修复轮（严重 1 对称面）：附着+动态 alias 定义（`-c"alias.x=!$P"`）——
      // 键+! 字面前缀可见证、载荷动态 → opaque（与 evaluate 词位同病同治）；其余动态词位
      // 间接构造不追（#1513），后续定义位扫描失去锚，按无定义位处置
      const p = literalPrefixOf(words[i]);
      if (/^-c["']?alias\.[\w.-]+=/.test(p)) return { kind: "opaque" };
      break;
    }
    if (w === "-c") {
      const next = words[i + 1];
      if (next === undefined) { i++; continue; }
      const d = aliasDefOf(next);
      if (d === "opaque") return { kind: "opaque" };
      if (d !== null && d.value.startsWith("!")) texts.push(d.value.slice(1));
      i += 2;
      continue;
    }
    if (w.startsWith("-c") && w.length > 2) {
      // F20261016gwr1（M-46f0e74d）：attached -ckey=val 形态（值在词内）
      const d = aliasKvOfString(w.slice(2));
      if (d !== null && d.value.startsWith("!")) texts.push(d.value.slice(1));
      i++;
      continue;
    }
    if (w === "-C" || w === "--git-dir" || w === "--work-tree" || w === "--exec-path" || w === "--namespace") {
      const nxt = words[i + 1]?.evaluated ?? null;
      i += nxt !== null && !nxt.startsWith("-") ? 2 : 1; // 无值单写形（--exec-path 单独出现）不吞后词
      continue;
    }
    if (/^--(?:git-dir|work-tree|exec-path|namespace)=/.test(w)) { i++; continue; }
    if (w.startsWith("-")) { i++; continue; } // 其余静态旗标（无值全局旗标全集）——X1：continue 非 break
    break;
  }
  // config 子命令形（k/v 分离或 k=v 单词形）
  if (i < words.length && words[i].evaluated === "config") {
    const r = scanConfigAliasWords(words, i + 1);
    if (r === "opaque") return { kind: "opaque" };
    if (r !== null) texts.push(...r.texts);
  }
  if (texts.length === 0) return null;
  // X4：引号截断伪影（`'\'''` 转义形态词法层截断）载荷不完整→opaque（不可证不豁免）
  if (texts.some(t => !quotesBalanced(t))) return { kind: "opaque" };
  return { kind: "payload", texts };
}
