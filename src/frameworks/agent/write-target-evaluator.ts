/**
 * F20261009gwte Phase 1：bash 写落点静态求值器（shell 形态族）。
 *
 * 方案：docs/features/2026/10/09/F20261009gwte-write-target-evaluator.md（v2）。
 *
 * 第一性原理（搭档拍板）：黑名单猜意图 → 落点求值看事实。求值写命令的落点集合，
 * 判「落点 ∩ 主仓工作树」；求值不出（unevaluated）→ 调用方回落旧判定链（fail-closed，
 * 绝不因「看不懂」放行）。
 *
 * Phase 1 覆盖面（显式声明，方案 v2 求值规则表）：
 * - 重定向（> >> >| 及 fd 写向形态）——Segment.redirects evaluated target
 * - 词表命令（tee/cp/mv/touch/mkdir）落点参数位
 * - git 写族（GIT_WRITE_SUBCOMMAND 同源正则）→ -C 目标或 cwd 跟踪结果
 * - bash heredoc 体 / bash -c 体：shell 递归模型可用时体内通道重走
 *
 * Phase 1 显式回落（unevaluated）：
 * - python/node/ruby/perl 载荷族（-c/-e/heredoc 体）——Payload.model 是 shell 模型
 *   非 Python/JS AST（审视 S1 实测锚点 command-model.ts:315/339），不做求值
 *   （F20261009phs2 Phase 2 起改为窄提取——见下文 Phase 2 节）
 * - cmdsub 内路径变形（cd $(dirname x)/../main）——审视 S6，一步变形逃逸属合理留存
 * - $VAR 落点目标、父 shell 环境变量（BC-5：同命令内赋值才溯源）、pushd、解析失败
 *
 * F20261009phs2 Phase 2（窄字面量路线，搭档 2026-10-09 拍板，不做完整 AST）：
 * - 脚本载荷窄提取：-c/-e 载荷 parts 全 lit/escape 时可静态拼接（多行双引号体内嵌
 *   单引号触发词法 fail-closed 是 gduc S1 常态面），写调用落点真实求值（写哪报哪，
 *   argv[N] 值传播 + 纯字面量拼接折叠），只读载荷以「主仓字面量闸」为安全负门
 *   （载荷含主仓树字面量一律回落旧链——c062 import() 主仓路径实证）；
 *   词法把脚本括号误当 $( 产生的垃圾 cmdsub 子模型不计回落（命令内层已求值载荷，
 *   子模型再回落是同一事实的重复保守——parseOk=false 假载荷族实证 c032）。
 * - git add index：GIT_WRITE_SUBCOMMAND 不含 add 是因 index 落点非 cwd——Phase 2 单独
 *   求值（落点 = -C/cwd 的索引 + add 路径参数按工作树根求值，主仓 cwd 下 add 相对路径
 *   落主仓工作树，判拦实证依据）。
 * - remote ref：push --delete / push :refs/... 远端侧操作不落本地主仓树 → evaluated 放行。
 * - fd 复制：2>&1 / 1>&2 非文件写（不落盘）——不再误伤（旧链 2>&1 | tail 形态全回落
 *   dynamic-path 的口径修正）。
 * - shadow 口径：跨规则样本（sleep_block/data_destructive 等维度拦截）从切换判据分母
 *   剔除（求值器只判 main_write 维度），单独计数披露——否则求值器永远背着别族的锅。
 *
 * 纯函数：无状态、无 IO、不写任何存储（机制识别检查点通过）。
 */
import { parseOnce, type CommandModel, type Segment } from "./command-model";
import type { Word } from "./command-lexer";

// ────────────────────────────── 类型 ──────────────────────────────

export interface WriteTarget {
  /** 求值后的绝对路径 */
  path: string;
  /** 写通道（诊断/文案用） */
  via: "redirect" | "cmd-arg" | "heredoc-body" | "git";
  /** 溯源段号 */
  segmentIndex: number;
}

export type WriteEvalResult =
  | { kind: "evaluated"; targets: WriteTarget[] }
  | { kind: "unevaluated"; reason: UnevalReason };

export type UnevalReason =
  | "parse-failed"        // parseOnce parseOk=false
  | "dynamic-path"        // $VAR/命令替换落点，同命令内无法溯源
  | "uncovered-cmd"       // 词表外命令携带写特征（重定向已单独算，此处指参数位疑似写）
  | "heredoc-script-payload" // Python/JS 等脚本载荷（Phase 1 不求值）
  | "cwd-unresolvable"    // pushd/popd/cd $VAR 溯源不出
  | "depth-exceeded";     // 递归深度超限

// ────────────────────────────── 常量与基础工具 ──────────────────────────────

/** 落点参数位词表（Phase 1）。argv0 裸名匹配。 */
const TARGET_ARG_COMMANDS = new Set(["tee", "cp", "mv", "touch", "mkdir"]);

/** git 写族（与 bash-safety-guard.ts GIT_WRITE_SUBCOMMAND 同源——单一真相源对齐，改动须两侧同步） */
/** git 写族（旧链正则版——F20261009phs2 起求值层改用 evalGitWrite 词级解析，本常量保留
 *  作旧链单一真相源对齐锚：改动须两侧同步——求值层 isWrite 子命令表与本正则一致） */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 对齐锚（见上注释）
const GIT_WRITE_SUBCOMMAND = /^git\s+(?:-C\s+\S+\s+|--git-dir=\S+\s+|--work-tree=\S+\s+|-c\s+\S+\s+)*(?:commit(?!-tree)|rebase|merge(?!-)|cherry-pick|apply|stash\s+push|push\b(?!\s+(?:--dry-run|-n)\b)(?!\s+\S+\s+(?:--delete|:))(?![^|;&]*(?:--delete|(?::\s*refs\/)))|reset\s+--hard|clean\s+-[a-zA-Z]*f)/;

/** Python/JS 等脚本解释器（载荷族——Phase 1 显式回落） */
const SCRIPT_RUNNERS = new Set(["python", "python3", "node", "perl", "ruby", "osascript"]);

/** worktree 区前缀（主仓树下的 worktree 物理目录不是主仓工作树——pathWithinMain 排除）。
 *  审视 §3.3（PR #1381）：只认 root 级（^<root>/.otter/worktrees/），不匹配嵌套 decoy
 *  （/repo/data/.otter/worktrees/... 是主仓内容区，不得误排）。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- isWorktreeRegion 语义并入 pathWithinMain 的 OTTER_RUNTIME_REGIONS（F20261009phs2）；保留函数备查
function isWorktreeRegion(p: string, root: string): boolean {
  // 精确前缀：.otter/worktrees/ 才是 worktree 区——.otter/workforms-retire 等其他
  //  .otter/ 子路径是独立仓目录，不是 worktree（c080/c081 前缀误伤实证：
  //  `${root}/.otter/worktrees/` startsWith 把 workforms-retire 也吞了）。
  return p.startsWith(`${root}/.otter/worktrees/`) || p === `${root}/.otter/worktrees`;
}

const DYNAMIC_RE = /[$`]/;

function bareName(argv0: string | null): string | null {
  return argv0?.split("/").pop() ?? argv0;
}

function hasPayloadFlag(seg: Segment): boolean {
  return seg.words.some(w => w.evaluated === "-c" || w.evaluated === "-e" || w.evaluated === "-");
}

/** 段是否脚本解释器段（argv0 命中 SCRIPT_RUNNERS） */
function isScriptRunnerSeg(seg: Segment): boolean {
  const bare = bareName(seg.argv0);
  return bare !== null && SCRIPT_RUNNERS.has(bare);
}

/** 路径是否落在主仓工作树内（projectRoot 前缀判定，排除 worktrees 前缀）。
 *  语义：主仓「工作树内容区」= 主仓树 - .otter/worktrees/（worktree 物理上在主仓树下，
 *  但写 worktree 不是写主仓——与旧链 modelCdExemption 等效语义对齐）。
 *  裁决域口径（F20261009phs2）：.otter/ 下的獭运行时自治区（worktrees/workforms 等
 *  獭自己的隔离工作区）不算主仓工作树——落点是「獭的自治沙盒内」还是「搭档的项目内容」
 *  的分界线画在 .otter/ 之外（c080/c081 .otter/workforms-retire 误拦实证：求值器判
 *  BLOCK 但台账裁决 ALLOW——.otter/ 是獭运行时区，不是搭档的仓内容）。
 *  data/workspaces 豁免由调用方政策层另行处理——本函数只报事实。 */
const OTTER_RUNTIME_REGIONS = ["/.otter/worktrees/", "/.otter/workforms"];
export function pathWithinMain(absPath: string, projectRoot: string): boolean {
  const p = normalizePath(absPath);
  const root = normalizePath(projectRoot);
  for (const region of OTTER_RUNTIME_REGIONS) {
    if (p.startsWith(`${root}${region}`)) return false;
  }
  if (p === root) return true;
  return p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** 轻量路径归一（不触盘：仅处理 . / 重复斜杠 / 尾斜杠；.. 保守保留） */
function normalizePath(p: string): string {
  return p.replace(/\/{2,}/g, "/").replace(/(.+)\/$/, "$1");
}

/** 路径词求值：相对 → cwd 拼接；含 $/`/~（家目录）/.. → null（动态，unevaluated）。
 *  ~ 按主仓 home 不可知原则不猜；.. 不猜目录爬升结果（首跑实测：cd /repo/../.. 回落）。 */
function evalPath(word: string, cwd: string): string | null {
  if (word === null || word === undefined) return null;
  if (/[$`~]/.test(word)) return null;
  if (word.includes("..")) return null;
  if (word.startsWith("/")) return normalizePath(word);
  return normalizePath(`${cwd.endsWith("/") ? cwd : `${cwd}/`}${word}`);
}

/** 同命令赋值溯源：取变量名的最后一次静态赋值（#918 同口径）。
 *  BC-5 边界：仅同命令内 assignments——父 shell 环境变量不溯（回落）。 */
function resolveAssign(name: string, segments: Segment[]): string | null {
  const assign = segments
    .filter(s => s.joiner !== "&" && s.joiner !== "|")
    .flatMap(s => s.assignments)
    .filter(a => a.name === name && a.value !== null && !DYNAMIC_RE.test(a.value))
    .pop();
  return assign?.value ?? null;
}

// ────────────────────────────── cwd 跟踪 ──────────────────────────────

/** cd 目标词是否「纯 $VAR 词」：单 var part（无字面后缀/前缀拼接）。
 *  审视 §3.1（PR #1381，严重）：$W/../../main 形态 evaluated=null，若只取 var 段名
 *  溯源赋值会丢弃字面后缀爬升 → 假放行真主仓写（红线逃逸 + fail-closed 破防）。
 *  修法（检视獭给）：只认纯 $VAR 词；带任何字面后缀/前缀一律 null 回落。
 *  语料负门已钉：c-po-01/02（$W/..、$W/../../../）。 */
function isPureVarWord(w: Word): string | null {
  if (w.parts.length !== 1 || w.parts[0].type !== "var") return null;
  const varPart = w.parts[0];
  const name = varPart.text.replace(/^\$\{?(\w+)\}?$/, "$1");
  return name !== varPart.text ? name : null; // 匹配上（name≠text）返回变量名；未匹配（形态怪异）回落
}

/** 从词对象求 cd 目标（evaluated 直取 / 纯 $VAR 词同命令溯源）。null = 不可解。
 *  审视 §3.1 修订：非纯 var 词（含字面后缀 $W/..、前缀拼接）一律 null——
  * 「求值不出」必须回落保守侧，不能错误求值后放行。 */
function evalCdTarget(seg: Segment, segments: Segment[], cwd: string): string | null {
  const w1: Word | undefined = seg.words[1];
  if (!w1) return null;
  let target: string | null = w1.evaluated;
  if (target === null) {
    // evaluated=null = 词含 var/cmdsub/动态 part——只认「纯 $VAR 词」溯源；其余一律回落
    const name = isPureVarWord(w1);
    if (name === null) return null;
    target = resolveAssign(name, segments);
  } else if (DYNAMIC_RE.test(target)) {
    // evaluated 值内含动态段（如 "$W/x" 部分展开）：同为非纯形态，回落
    const name = isPureVarWord(w1);
    if (name === null) return null;
    target = resolveAssign(name, segments);
  }
  if (target === null || target === "-" || DYNAMIC_RE.test(target)) return null;
  const _p = evalPath(target, cwd);
  return _p;
}

/** 语句序 cwd 跟踪：返回最终 cwd 或 null（不可解）。
 *  - joiner 为 & 或 | 的段是子 shell/管道上下文，其 cd 不影响后续段（与 modelCdExemption 子 shell 化语义同源）
 *  - cd 同命令内赋值溯源；pushd/popd Phase 1 不覆盖（回落） */
function trackCwd(segments: Segment[], startCwd: string): string | null {
  let cwd = startCwd;
  for (const seg of segments) {
    if (seg.joiner === "&" || seg.joiner === "|") continue; // 子 shell/管道：cd 不外溢
    const bare = bareName(seg.argv0);
    if (bare === "pushd" || bare === "popd") return null;
    if (bare === "cd") {
      const resolved = evalCdTarget(seg, segments, cwd);
      if (resolved === null) return null;
      cwd = resolved;
    }
  }
  return cwd;
}

// ────────────────────────────── 段级求值 ──────────────────────────────

interface SegmentEvalAcc {
  targets: WriteTarget[];
  index: number;
}

const WRITE_REDIR_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const isWriteRedirect = (op: string): boolean => {
  const bareOp = op.replace(/^[0-9]+/, "");
  return WRITE_REDIR_OPS.has(bareOp) || op.startsWith("2>") || op.startsWith("1>");
};
/** fd 复制/关闭（2>&1 / 1>&2 / 2>&-）不是文件写——不落盘，不构成写落点。
 *  词法层把 2>&1 表示为 op="2>&1" + target=null（&1 是 fd 引用非目标词），或 op="2>&" + target="1"。 */
const isFdDup = (op: string, target: string | null): boolean =>
  (/^[0-9]*>&[0-9-]+$/.test(op) && target === null) || (/^[0-9]*>&$/.test(op) && target !== null && /^[0-9-]$/.test(target));

/** 重定向落点求值。返回 UnevalReason | null。 */
function evalRedirects(seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  for (const r of seg.redirects) {
    if (!isWriteRedirect(r.op)) continue;
    if (isFdDup(r.op, r.target)) continue; // 2>&1 等 fd 复制非文件写
    if (r.target === null) return "dynamic-path";
    const resolved = evalPath(r.target, cwd);
    if (resolved === null) return "dynamic-path";
    acc.targets.push({ path: resolved, via: "redirect", segmentIndex: acc.index });
  }
  return null;
}

/** git 写族落点（-C 目标优先，无 -C → cwd）。返回 UnevalReason | null。 */
// eslint-disable-next-line max-statements, complexity -- git 全局旗标形态穷举（-C/-c/--git-dir/--work-tree × =值/空格值）+ 写族子命令判定，每分支对应一种已实证形态（c107 词切分错位教训：合并会再制造旗标解析 bug）
function evalGitWrite(seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  if (seg.argv0 !== "git") return null; // argv0 必须字面 git——非 git 命令不進旗标循环
  //  （旧版 argv0===null 守卫后从 words[1] 扫，echo "unclosed 的 words[1]=null 被误读为
  //  git 旗标位的动态值——c044 parse-failed 语义被覆盖为 dynamic-path 的回归教训）
  // 词级解析求值 git 全局旗标（-C <dir> / --work-tree=<dir> / --work-tree <dir> / -c <kv>）——
  //  Phase 2 重写：GIT_WRITE_SUBCOMMAND 正则只管「是否写族」的旧链语义；求值层以词为准
  //  （c107 `git -c http.proxy= -c https.proxy= push --delete` 正则 \S+ 形态与词切分错位教训）。
  const words = seg.words;
  let i = 1;
  let cTarget: string | null = null;
  let workTreeOverride: string | null = null;
  while (i < words.length) {
    const w = words[i].evaluated;
    if (w === null) return "dynamic-path";
    if (w === "-C" || w === "-c") {
      const v = words[i + 1]?.evaluated;
      if (v === undefined || v === null) return "dynamic-path";
      if (w === "-C") cTarget = v;
      i += 2;
      continue;
    }
    if (w.startsWith("--git-dir=")) { i++; continue; }
    if (w.startsWith("--work-tree=")) { workTreeOverride = w.slice("--work-tree=".length); i++; continue; }
    if (w === "--git-dir" || w === "--work-tree") {
      const v = words[i + 1]?.evaluated;
      if (v === undefined || v === null) return "dynamic-path";
      if (w === "--work-tree") workTreeOverride = v;
      i += 2;
      continue;
    }
    break;
  }
  const sub = words[i]?.evaluated;
  if (sub === undefined || sub === null) return null;
  // 写族口径与旧链 GIT_WRITE_SUBCOMMAND 同源（单一真相源在旧链，改动须两侧同步）
  const isWrite = sub === "commit" || sub === "rebase" || sub === "merge" || sub === "cherry-pick"
    || sub === "apply" || sub === "reset" || sub === "clean" || sub === "push" || sub === "stash";
  if (!isWrite) return null;
  const rest = words.slice(i + 1).map(w => w.evaluated).filter((v): v is string => v !== null);
  if (sub === "push") {
    if (rest.some(a => a === "--dry-run" || a === "-n")) return null;
    if (rest.some(a => a === "--delete" || a.startsWith(":"))) return null; // remote ref 删除：远端侧操作不落本地主仓树（Phase 2 c105/c131-c133）
  }
  if (sub === "reset" && !rest.some(a => a === "--hard")) return null;
  if (sub === "clean" && !rest.some(a => /^-[a-zA-Z]*f/.test(a))) return null;
  if (sub === "stash" && rest[0] !== "push") return null;
  const base = cTarget !== null ? evalPath(cTarget, cwd) : cwd;
  if (base === null) return "dynamic-path";
  acc.targets.push({ path: workTreeOverride !== null ? (evalPath(workTreeOverride, cwd) ?? base) : base, via: "git", segmentIndex: acc.index });
  return null;
}

/** 词表命令落点（cp/mv 第二非旗标参数；tee/touch/mkdir 全部非旗标参数）。返回 UnevalReason | null。 */
function evalTargetArgCommand(bare: string, seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  if (!TARGET_ARG_COMMANDS.has(bare)) return null;
  const nonFlagArgs: string[] = [];
  for (let i = 1; i < seg.words.length; i++) {
    const w = seg.words[i].evaluated;
    if (w === null) return "dynamic-path";
    if (w.startsWith("-")) continue;
    nonFlagArgs.push(w);
  }
  const destArgs = (bare === "cp" || bare === "mv") ? nonFlagArgs.slice(1) : nonFlagArgs;
  if (destArgs.length === 0) return "uncovered-cmd"; // 词表命令无落点参数：形态未知，保守回落
  for (const d of destArgs) {
    const resolved = evalPath(d, cwd);
    if (resolved === null) return "dynamic-path";
    acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index });
  }
  return null;
}

// ────────────────────────────── Phase 2 窄提取（F20261009phs2） ──────────────────────────────

/** git add index 求值（Phase 2，gwte 语料实测教训：git add 写索引不落 cwd，cwd 放行的 worktree
 *  commit 形态下相对路径会被误判主仓落点——GIT_WRITE_SUBCOMMAND 不含 add 正因 index 落点非 cwd）。
 *  落点 = 主仓索引（index 跟 HEAD 不跟 cwd）+ 各 add 路径参数按 -C 目标/cwd 求值的工作树文件。 */
// eslint-disable-next-line max-statements, complexity -- 与 evalGitWrite 同构的旗标穷举 + index/路径双落点
function evalGitAdd(seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  if (seg.argv0 !== "git") return null;
  const words = seg.words;
  // 求值段头：git + 全局旗标（-C <dir> / -c <kv> / --git-dir= / --work-tree=）
  let i = 1;
  let cTarget: string | null = null;
  let workTreeOverride: string | null = null;
  while (i < words.length) {
    const w = words[i].evaluated;
    if (w === null) return "dynamic-path";
    if (w === "-C" || w === "-c") {
      const v = words[i + 1]?.evaluated;
      if (v === undefined || v === null) return "dynamic-path";
      if (w === "-C") cTarget = v;
      i += 2;
      continue;
    }
    if (w.startsWith("--git-dir=")) { i++; continue; }
    if (w.startsWith("--work-tree=")) { workTreeOverride = w.slice("--work-tree=".length); i++; continue; }
    break;
  }
  if (i >= words.length || words[i].evaluated !== "add") return null;
  i++;
  const base = cTarget !== null ? evalPath(cTarget, cwd) : cwd;
  if (base === null) return "dynamic-path";
  // 落点①：索引（主仓侧元数据——无 -C 时 cwd 是主仓才构成主仓写；有 -C 时 base 是目标仓）
  acc.targets.push({ path: base, via: "git", segmentIndex: acc.index });
  // 落点②：add 路径参数（add 的语义是"从工作树读文件写入索引"——路径相对工作树根/cwd；
  //  主仓 cwd 下 `git add docs/x.md` 的相对路径落主仓工作树，判拦的实证依据）
  const pathBase = workTreeOverride !== null ? (evalPath(workTreeOverride, cwd) ?? base) : base;
  const pathWords = words.slice(i).filter(w => {
    const v = w.evaluated;
    return v !== null && !v.startsWith("-") && v !== "--";
  });
  const optsOnly = pathWords.length === 0;
  if (!optsOnly) {
    for (const w of pathWords) {
      const v = w.evaluated as string;
      const resolved = evalPath(v, pathBase);
      if (resolved === null) return "dynamic-path";
      acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index });
    }
  }
  return null;
}

/** 脚本载荷窄提取（Phase 2，gwte 方案 Phase 2 候选：窄字面量路线，不做完整 AST）。
 *  从 node/python -e|-c 载荷提取「可求值写调用落点」与「只读载荷」两类形态：
 *  形态A 写调用：writeFileSync/open('p','w') 等，路径参数可静态求值（字面量 / argv[N]
 *         值传播 / 纯字面量拼接折叠——语料 P2 边界锚点 c128-c130）→ 落点入 targets
 *         （真实求值，写哪报哪）；写调用存在但路径不可求值 → 回落（不做值传播的
 *         其余形态一律保守）。
 *  形态B 只读载荷：无写调用词面 → 提取静态绝对路径字面量，∩ 主仓树为空 → evaluated
 *         放行；∩ 主仓树非空 → 回落（c062 import() 动态加载主仓路径是旧链能拦而
 *         窄提取会误放的实样，主仓字面量一律回落旧链）。
 *  设计判据：路径出现 ≠ 写（事实锚），但「写调用 + 可求值路径」= 可算落点（求值语义）；
 *  求值不出的写形态一律回落旧链（fail-closed），绝不用「没看到路径」放行写调用。 */
/** 写调用词面表（node fs 同步族 + python open 写模式 + 通用）。
 *  注意：open/write 单独命中不算写调用——python open('p') 默认读模式、`.write()` 是
 *  读文件后的方法调用链（c032 `print(open('a').read())` 实证）；真正写语义由
 *  evalScriptWriteTargets 的调用形态匹配判定（open 带写模式 / writeFileSync 等明确写函数）。 */
const SCRIPT_WRITE_TOKENS = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|openSync|mkdirSync|mkdir|rmSync|rmdirSync|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|chmodSync|chownSync|symlinkSync|dump|dumps|shelve)\b|\bopen\s*\([^)]*,\s*["'`][wa]|\.write(?:Sync)?\s*\(/;

/** argv[N] / sys.argv[N] 引用提取（值传播的键）。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 值传播键模式备查（resolveScriptArg 内联正则同源）
const ARGV_REF_RE = /\b(?:process\.argv|sys\.argv)\[(\d+)\]/g;

/** 纯字面量字符串拼接折叠（"a" + "b" / 'a' + 'b' 链，无变量/调用穿插）。 */
function foldStringConcat(expr: string): string | null {
  const parts = expr.split(/\s*\+\s*/);
  const out: string[] = [];
  for (const p of parts) {
    const m = /^["'`]([^"'`$`]*)["'`]$/.exec(p.trim());
    if (!m) return null; // 任一段非纯字面量 → 不折叠
    out.push(m[1]);
  }
  return out.join("");
}

/** 写调用落点求值：在载荷文本中找写调用词面，其首个路径参数可静态求值 → 返回路径；
 *  写调用存在但路径不可求值 → 返回 null（调用方回落）。argv 值传播：argvMap[N] 提供
 *  process.argv[2+N]/sys.argv[1+N] 的实际参数词（node -e s A → argv[2]=A；python -c s A → sys.argv[1]=A）。 */
function evalScriptWriteTargets(script: string, argvMap: Map<number, string>): { paths: string[] } | null {
  const paths: string[] = [];
  // node: xxxSync('path', ...) / fs.writeFile('path', ...) / open('path','w')
  for (const m of script.matchAll(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|openSync|mkdirSync|mkdir|rmSync|rmdirSync|unlinkSync|unlink|renameSync|copyFileSync|copyFile|chmodSync|chownSync|symlinkSync)\s*\(\s*([^,)]+)/g)) {
    const arg = resolveScriptArg(m[1], argvMap);
    if (arg === null) return null; // 路径不可求值 → 写调用不可求值，回落
    paths.push(arg);
  }
  // python: open('path', 'w'/'a'/'r+'/...)——读模式 open('p') / open('p','r') 不算写
  for (const m of script.matchAll(/\bopen\s*\(\s*([^,)]+)(?:\s*,\s*["'`]([^"'`]*)["'`])?/g)) {
    const mode = m[2] ?? "r";
    if (!/^[wa][+bt]*$|^r\+$|^x/.test(mode)) continue; // 读模式不判写
    const arg = resolveScriptArg(m[1], argvMap);
    if (arg === null) return null;
    paths.push(arg);
  }
  return { paths };
}

/** 求值脚本参数表达式：纯字面量/字面量拼接 → 折叠值；argv[N] → argvMap 值传播；
 *  其他（变量/调用/运算）→ null。 */
function resolveScriptArg(expr: string, argvMap: Map<number, string>): string | null {
  const t = expr.trim();
  const folded = foldStringConcat(t);
  if (folded !== null) return folded;
  const argvM = /^(?:process\.argv|sys\.argv)\[(\d+)\]$/.exec(t);
  if (argvM) {
    const v = argvMap.get(Number(argvM[1]));
    return v ?? null;
  }
  return null;
}

/** 只读调用词面表（Phase 2 窄提取形态B：读调用路径同样可求值——读哪报哪，与写调用同语义。
 *  不含 write/dump 等歧义词面——那是写闸的事）。 */
const SCRIPT_READ_TOKENS = /\b(?:readFileSync|readFile|existsSync|statSync|lstatSync|readdirSync|realpathSync|createReadStream|load|loads|get|getenv)\b/;

/** 只读调用落点求值：readFileSync('p')/open('p')/open('p','r')/json.load(open('p')) 等。 */
function evalScriptReadTargets(script: string, argvMap: Map<number, string>): { paths: string[] } | null {
  const paths: string[] = [];
  for (const m of script.matchAll(/\b(?:readFileSync|readFile|existsSync|statSync|lstatSync|readdirSync|realpathSync|createReadStream)\s*\(\s*([^,)]+)/g)) {
    const arg = resolveScriptArg(m[1], argvMap);
    if (arg === null) continue; // 读路径不可求值不致命——只读侧不影响拦截决策，跳过该条
    paths.push(arg);
  }
  // python open 读模式（open('p') / open('p','r')）——写模式已在写通道处理
  for (const m of script.matchAll(/\bopen\s*\(\s*([^,)]+)(?:\s*,\s*["'`]([^"'`]*)["'`])?/g)) {
    const mode = m[2] ?? "r";
    if (/^[wa][+bt]*$|^r\+$|^x/.test(mode)) continue; // 写模式不在这里（写通道已收/已回落）
    const arg = resolveScriptArg(m[1], argvMap);
    if (arg === null) continue;
    paths.push(arg);
  }
  return { paths };
}

/** 从载荷文本提取静态绝对路径字面量（引号内、无 $/` 展开、/ 开头）。
 *  #1411 §3.1 口径统一：含 .. 的字面量不再跳过——交由调用方字面量闸 fail-closed
 *  （.. 解析结果不猜，与 evalPath 同源口径；披露侧由调用方跳过）。 */
function extractAbsPathLiterals(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/["'`](\/[A-Za-z0-9_./+@-]+)["'`]/g)) {
    const p = m[1];
    if (/[$`]/.test(p)) continue;
    out.push(normalizePath(p));
  }
  return [...new Set(out)];
}

/** 脚本段窄提取。返回 null=不适用（非脚本段/无载荷）；"heredoc-script-payload"=回落。 */
// eslint-disable-next-line max-statements, complexity -- 窄提取双形态（写调用求值/只读字面量闸）× 双闸负门，分支与 gwte 方案 Phase 2 取舍表一一对应
function evalScriptPayloadNarrow(seg: Segment, projectRoot: string, acc: SegmentEvalAcc & { cwd: string }): "skip" | "heredoc-script-payload" | "extracted" {
  if (!isScriptRunnerSeg(seg)) return "skip";
  const flagIdx = seg.words.findIndex(w => w.evaluated === "-e" || w.evaluated === "-c");
  if (flagIdx < 0) return "skip"; // script.py 文件形态/无载荷旗标：Phase 1 行为（回落）由调用方兜底
  const payloadWord = seg.words[flagIdx + 1];
  if (!payloadWord) return "skip";
  // 载荷词必须全字面可求值（含 var/cmdsub 拼接 → evaluated=null → 回落，不猜）
  // 载荷词必须全字面可求值。多行载荷常态（gduc S1 实证面）：双引号体内嵌单引号字面量
  //  （`node -e "…require('fs')…"`）触发词法 fail-closed，evaluated=null 但 parts 全 lit
  //  （引号上下文已剥，无展开）——此时拼接 parts 仍得静态载荷；parts 含任何非 lit/escape
  //  展开段（var/cmdsub/arithmetic）→ 真不可求值，回落不猜。
  let script = payloadWord.evaluated;
  if (script === null) {
    if (payloadWord.parts.every(p => p.type === "lit" || p.type === "escape")) {
      script = payloadWord.parts.map(p => p.text).join("");
    } else {
      return "heredoc-script-payload";
    }
  }
  // 载荷后参数词（argv 值传播原料）——实测口径（#1411 处置实证）：
  //   node -e s A B → process.argv=[execPath, A, B]（无脚本文件插入 argv）→ argv[1]=A
  //   python3 -c s A → sys.argv=['-c', A] → argv[1]=A
  // 两者首实参位都是 1。旧代码 node 取 2 是 off-by-one：argv[2] 映射到第一实参而真值
  // 是第二实参——`node -e "fs.writeFileSync(process.argv[2],'x')" /tmp/a /repo/b` 曾
  // 被求值器按 argv[2]=/tmp/a 判 ALLOW，真实落点 /repo/b（主仓）——同通道假放行。
  const tailArgs = seg.words.slice(flagIdx + 2).map(w => w.evaluated);
  const argvBase = 1;
  const argvMap = new Map<number, string>();
  tailArgs.forEach((v, i) => {
    if (v !== null) argvMap.set(argvBase + i, v);
  });
  // 形态A：写调用落点求值（真实求值——写哪报哪，路径不可求值才回落）
  const hasWriteCall = SCRIPT_WRITE_TOKENS.test(script);
  if (hasWriteCall) {
    const wr = evalScriptWriteTargets(script, argvMap);
    if (wr === null) return "heredoc-script-payload"; // 写调用存在但路径求值不出 → 保守回落
    if (wr.paths.length === 0) return "heredoc-script-payload"; // 写词面命中但未匹配到调用形态（方法调用/write 属性等）→ 回落
    for (const p of wr.paths) {
      // 相对路径：脚本写落点 = 进程 cwd（syscall 语义）——cwd 是求值器已跟踪事实，
      //  直接拼接（c123 `open('sub/rel.txt','w')` cwd=wt → 落 wt；cwd=主仓 → 落主仓）。
      //  evalPath 处理动态词面（$VAR/`cmd` → null → 回落）。
      // 审视 §3.1（PR #1411 严重）：绝对/相对统一走 evalPath——`..`/$/`/~ 一律拒（回落）。
      //  绝对路径曾用 normalizePath 直取（不解析 ..），`<wt>/../../../main/y` 字面量含
      //  worktree 前缀 → pathWithinMain 判非主仓 → 假放行真主仓写（OS 解析 .. 后落主仓）。
      //  evalPath 绝对分支语义与 normalizePath 等同，本修只收窄「含 .. 的绝对路径」：
      //  ALLOW → 回落，无放行面扩大。语料负门 c137/c138（§3.1 逃逸形态原样钉回落）。
      const resolved = evalPath(p, acc.cwd);
      if (resolved === null) return "heredoc-script-payload";
      acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index });
    }
    return "extracted"; // 写调用落点已真实求值——不再走路径字面量闸（写的就是这些）
  }
  // 形态B：只读载荷——读调用落点同样求值（读哪报哪；cwd 相对路径拼接）。
  //  路径字面量闸（安全负门，决定放行/回落）：只看静态引号绝对路径字面量（require/import
  //  目标、配置路径、日志路径——出现在任何代码位置都算主仓耦合信号），∩ 主仓树非空 →
  //  回落旧链（c062 import() 主仓路径回落；c100 载荷引用主仓 data 路径回落——求值器
  //  不猜运行时读取后果，字面量防线不破）。
  //  targets 记录（事实披露，只读路径绝不构成拦截依据）：读调用路径 + 绝对字面量 +
  //  相对路径字面量按 cwd 拼接（c083/c084 `p='web/src/...'` cwd=外部仓 → 外部落点，
  //  shadow 报告看得见求值器「读哪」的事实）。
  if (SCRIPT_READ_TOKENS.test(script) || /\bopen\s*\(/.test(script)) {
    const rd = evalScriptReadTargets(script, argvMap);
    for (const p of rd?.paths ?? []) {
      // §3.1 同口径：读侧落点披露统一走 evalPath——含 .. 的读路径不猜爬升结果，
      //  披露无拦截语义，求值不出跳过即可（不构成回落理由）
      const resolved = evalPath(p, acc.cwd);
      if (resolved !== null) acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index });
    }
  }
  const paths = extractAbsPathLiterals(script);
  // #1411 §3.1：含 .. 的绝对字面量 fail-closed——解析结果不猜（旧：跳过 → 字面量闸
  //  漏判 `'/wt/../../../main/config.json'` 这类主仓耦合信号；跳过=闸的盲区）
  if (paths.some(p => p.includes("..") || pathWithinMain(p, projectRoot))) return "heredoc-script-payload";
  for (const p of paths) acc.targets.push({ path: p, via: "cmd-arg", segmentIndex: acc.index });
  // 相对路径字面量披露（不进门判定——只读侧 cwd 拼接为事实锚，求值不出跳过即可）
  for (const m of script.matchAll(/["'`]([A-Za-z0-9_.][A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+)["'`]/g)) {
    const rel = m[1];
    if (rel.startsWith("/") || rel.includes("..") || /[$`]/.test(rel)) continue;
    const resolved = evalPath(rel, acc.cwd);
    if (resolved !== null) acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index });
  }
  return "extracted"; // 窄提取成功——调用方跳过 detectScriptPayload 短路，段求值继续
}

/** 模型内是否存在可窄提取的脚本载荷段（顶层 + 递归子模型同口径）。
 *  用于 evaluateWriteTargets 的 detectScriptPayload 短路前置：存在可提取段 → 不先行短路，
 *  交给 evalSegment 段级窄提取；不存在 → 保持 Phase 1 先行回落（parseOk=false 语义兜底）。 */
function hasNarrowExtractableScriptSeg(model: CommandModel, projectRoot: string): boolean {
  const probe: SegmentEvalAcc & { cwd: string } = { targets: [], index: 0, cwd: projectRoot };
  const check = (m: CommandModel): boolean => {
    for (const seg of m.segments) {
      if (evalScriptPayloadNarrow(seg, projectRoot, probe) === "extracted") return true;
    }
    return m.payloads.some(p => p.model !== null && check(p.model));
  };
  return check(model);
}

/** 单段求值：脚本窄提取（Phase 2）→ 脚本载荷族回落 → 重定向 → git add（Phase 2）→ git 写族 → 词表命令。返回 null 表示该段无 unevaluated。 */
function evalSegment(seg: Segment, cwd: string, acc: SegmentEvalAcc, projectRoot: string): UnevalReason | null {
  const bare = bareName(seg.argv0);
  const accWithCwd: SegmentEvalAcc & { cwd: string } = Object.assign(acc, { cwd });

  // Phase 2 窄提取：可静态求值的只读脚本载荷段，不等 Phase 1 整段回落就放行
  const narrow = evalScriptPayloadNarrow(seg, projectRoot, accWithCwd);
  if (narrow === "heredoc-script-payload") return "heredoc-script-payload";

  // Python/JS 等脚本载荷族：Phase 1 显式回落（审视 S1 锚点：载荷 model 是 shell 模型非脚本 AST）。
  //  窄提取已过的段（narrow==="extracted"）不再走本行——窄提取承诺双闸全过。
  if (narrow === "skip" && bare !== null && SCRIPT_RUNNERS.has(bare)) return "heredoc-script-payload";

  const err = evalRedirects(seg, cwd, acc);
  if (err !== null) return err;
  const gitAddErr = evalGitAdd(seg, cwd, acc);
  if (gitAddErr !== null) return gitAddErr;
  const gitErr = evalGitWrite(seg, cwd, acc);
  if (gitErr !== null) return gitErr;
  if (bare !== null) {
    const cmdErr = evalTargetArgCommand(bare, seg, cwd, acc);
    if (cmdErr !== null) return cmdErr;
  }
  return null;
}

// ────────────────────────────── 主入口 ──────────────────────────────

/** 先行载荷族检测：段级 argv0 命中脚本解释器且带载荷特征 → Phase 1 回落。
 *  parseOk=false 也要走此检测（python 函数调用括号触发词法 function-definition
 *  fail-closed 的命令，segments 仍可读——审视 S1 补充实测：command-lexer.ts:514）。
 *  递归模型 payloads 里 kind=bash-c 的不算（bash -c 是 shell，走递归求值）。 */
function detectScriptPayload(model: CommandModel): boolean {
  const checkSegments = (segments: CommandModel["segments"]): boolean =>
    segments.some(seg => {
      const bare = bareName(seg.argv0);
      if (bare === null || !SCRIPT_RUNNERS.has(bare)) return false;
      return hasPayloadFlag(seg) || seg.words.some(w => w.parts.some(p => p.type === "cmdsub" || p.type === "var"));
    });
  if (checkSegments(model.segments)) return true;
  for (const p of model.payloads) {
    if (p.model && detectScriptPayload(p.model)) return true;
  }
  return false;
}

/** 从既有模型求值。子模型（bash -c/cmdsub）先各自 trackCwd 再求值（子 shell cd 链独立——
 *  首跑实测教训：默认主仓根会漏子模型内 cd，bash -c 'cd wt && touch a' 误报主仓落点）。 */
function evaluateFromModel(model: CommandModel, projectRoot: string): WriteEvalResult {
  const tracked = trackCwd(model.segments, projectRoot);
  if (tracked === null) return { kind: "unevaluated", reason: "cwd-unresolvable" };

  const acc: SegmentEvalAcc = { targets: [], index: 0 };
  let cwd = tracked;
  for (const seg of model.segments) {
    const err = evalSegment(seg, cwd, acc, projectRoot);
    if (err !== null) return { kind: "unevaluated", reason: err };
    // 段内 cd 推进（与 trackCwd 同口径）
    if (seg.joiner !== "&" && seg.joiner !== "|" && bareName(seg.argv0) === "cd") {
      const r = evalCdTarget(seg, model.segments, cwd);
      if (r !== null) cwd = r;
    }
    acc.index++;
  }
  return { kind: "evaluated", targets: acc.targets };
}

/**
 * 求值命令的写落点集合（Phase 1：shell 形态族）。
 *
 * @param command 原始命令文本
 * @param projectRoot 主仓根（绝对路径）——cwd 起点与「主仓工作树」判定基准
 * @returns evaluated（targets 可为空集=求值成功且无写落点）或 unevaluated（回落旧链）
 */
// eslint-disable-next-line complexity -- 入口路由（parseOk 探针 + 载荷递归 + 主模型求值）三分支各对应一条已声明语义（Phase 1/Phase 2 口径注释）
export function evaluateWriteTargets(command: string, projectRoot: string): WriteEvalResult {
  const model: CommandModel = parseOnce(command, 0);

  // 先行载荷族检测（不依赖 parseOk——python 函数调用括号触发词法 fail-closed 时
  // segments 仍可读；此类命令本就属 Phase 1 回落族，先命中正确语义）。
  // Phase 2 例外：存在可窄提取的脚本载荷段时跳过短路，交给段级窄提取（gduc S1
  //  多行载荷常态面——双引号内嵌单引号触发词法 fail-closed 但 parts 全 lit 可拼）。
  if (detectScriptPayload(model) && !hasNarrowExtractableScriptSeg(model, projectRoot)) {
    return { kind: "unevaluated", reason: "heredoc-script-payload" };
  }
  if (!model.parseOk) {
    // Phase 2：多行载荷命令常态 parseOk=false（嵌套单引号），但 segments/words 仍可读。
    //  词法层 segments 可读时继续段级求值——前提是至少一段求值出了实质落点信息
    //  （脚本窄提取成功 / git/词表/重定向落点）；全部段零落点（词面求值不出，如
    //  `echo "unclosed` 的唯一参数词 evaluated=null）→ evaluated 空集是假信息，
    //  回落 parse-failed 保 Phase 1 保守语义。词法彻底失败（segments 空）同口径回落。
    if (model.segments.length === 0) return { kind: "unevaluated", reason: "parse-failed" };
    const probe = evaluateFromModel(model, projectRoot);
    if (probe.kind === "unevaluated") return probe;
    if (probe.targets.length === 0 && !hasNarrowExtractableScriptSeg(model, projectRoot)) {
      return { kind: "unevaluated", reason: "parse-failed" };
    }
    // 探针已证明可求值——走正常路径（幂等纯函数，重求值无副作用）
  }

  // shell 递归载荷（bash -c / cmdsub）：子模型重走求值，子落点并入（子 shell cd 链独立）；
  // 任一子模型失败 → 回落。heredoc-quoted = 纯数据（模型层口径：不递归=数据），跳过。
  // F20261009phs2：命令内层窄提取已求值过脚本载荷时，词法把脚本括号误当 $( 产生的垃圾
  //  cmdsub 子模型（parseOk=false、段全是脚本 token 碎片、非脚本载荷族）不构成独立回落
  //  理由——同一事实的重复保守（c032 `print(open(...).read())` 假 $( 族实证）。
  const scriptSegNarrowed = hasNarrowExtractableScriptSeg(model, projectRoot);
  const subTargets: WriteTarget[] = [];
  for (const p of model.payloads) {
    if (p.kind === "heredoc-quoted") continue;
    if (p.model === null) {
      return { kind: "unevaluated", reason: p.depth >= 2 ? "depth-exceeded" : "parse-failed" };
    }
    if (scriptSegNarrowed && p.kind === "cmdsub" && !p.model.parseOk && !detectScriptPayload(p.model)) continue; // 垃圾 cmdsub 跳过
    const sub = evaluateFromModel(p.model, projectRoot);
    if (sub.kind === "unevaluated") {
      return { kind: "unevaluated", reason: sub.reason === "parse-failed" ? "parse-failed" : sub.reason };
    }
    subTargets.push(...sub.targets);
  }

  const main = evaluateFromModel(model, projectRoot);
  if (main.kind === "unevaluated") return main;
  return { kind: "evaluated", targets: [...main.targets, ...subTargets] };
}
