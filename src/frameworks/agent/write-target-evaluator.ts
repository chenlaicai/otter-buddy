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
 * - cmdsub 内路径变形（cd $(dirname x)/../main）——审视 S6，一步变形逃逸属合理留存
 * - $VAR 落点目标、父 shell 环境变量（BC-5：同命令内赋值才溯源）、pushd、解析失败
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
const GIT_WRITE_SUBCOMMAND = /^git\s+(?:-C\s+\S+\s+|--git-dir=\S+\s+|--work-tree=\S+\s+|-c\s+\S+\s+)*(?:commit(?!-tree)|rebase|merge(?!-)|cherry-pick|apply|stash\s+push|push\b(?!\s+(?:--dry-run|-n)\b)|reset\s+--hard|clean\s+-[a-zA-Z]*f)/;

/** Python/JS 等脚本解释器（载荷族——Phase 1 显式回落） */
const SCRIPT_RUNNERS = new Set(["python", "python3", "node", "perl", "ruby", "osascript"]);

/** worktree 区前缀（主仓树下的 worktree 物理目录不是主仓工作树——pathWithinMain 排除） */
const WORKTREE_PREFIX_RE = /(^|\/)\.otter\/worktrees(\/|$)/;

const DYNAMIC_RE = /[$`]/;

function bareName(argv0: string | null): string | null {
  return argv0?.split("/").pop() ?? argv0;
}

function hasPayloadFlag(seg: Segment): boolean {
  return seg.words.some(w => w.evaluated === "-c" || w.evaluated === "-e" || w.evaluated === "-");
}

/** 路径是否落在主仓工作树内（projectRoot 前缀判定，排除 worktrees 前缀）。
 *  语义：主仓「工作树内容区」= 主仓树 - .otter/worktrees/（worktree 物理上在主仓树下，
 *  但写 worktree 不是写主仓——与旧链 modelCdExemption 等效语义对齐）。
 *  data/workspaces 豁免由调用方政策层另行处理——本函数只报事实。 */
export function pathWithinMain(absPath: string, projectRoot: string): boolean {
  const p = normalizePath(absPath);
  const root = normalizePath(projectRoot);
  if (WORKTREE_PREFIX_RE.test(p.slice(root.length))) return false;
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

/** var part 提名：$NAME 形态取变量名；其余形态 null（cmdsub/$1 等不溯） */
function varNameOf(w: Word): string | null {
  const varPart = w.parts.find((p: { type: string }) => p.type === "var");
  if (!varPart) return null;
  const name = varPart.text.replace(/^\$\{?(\w+)\}?$/, "$1");
  return name === varPart.text ? null : name;
}

/** 从词对象求 cd 目标（evaluated 直取 / var part 同命令溯源）。null = 不可解。 */
function evalCdTarget(seg: Segment, segments: Segment[], cwd: string): string | null {
  const w1: Word | undefined = seg.words[1];
  if (!w1) return null;
  let target: string | null = w1.evaluated;
  if (target === null || DYNAMIC_RE.test(target)) {
    const name = target === null ? varNameOf(w1) : target.replace(/^\$\{?(\w+)\}?$/, "$1");
    if (name === null || name === "") return null; // cmdsub/形态不匹配：溯源不出
    target = resolveAssign(name, segments);
  }
  if (target === null || target === "-" || DYNAMIC_RE.test(target)) return null;
  return evalPath(target, cwd);
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

/** 重定向落点求值。返回 UnevalReason | null。 */
function evalRedirects(seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  for (const r of seg.redirects) {
    if (!isWriteRedirect(r.op)) continue;
    if (r.target === null) return "dynamic-path";
    const resolved = evalPath(r.target, cwd);
    if (resolved === null) return "dynamic-path";
    acc.targets.push({ path: resolved, via: "redirect", segmentIndex: acc.index });
  }
  return null;
}

/** git 写族落点（-C 目标优先，无 -C → cwd）。返回 UnevalReason | null。 */
function evalGitWrite(seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  if (seg.argv0 === null || seg.words.length === 0) return null;
  const segText = [seg.argv0, ...seg.args.map(a => a ?? "")].join(" ");
  if (!GIT_WRITE_SUBCOMMAND.test(segText)) return null;
  const cIdx = seg.words.findIndex((w, i) => i > 0 && w.evaluated === "-C");
  const cTarget = cIdx >= 0 ? seg.words[cIdx + 1]?.evaluated ?? null : null;
  if (cTarget !== null && DYNAMIC_RE.test(cTarget)) return "dynamic-path";
  const resolved = cTarget !== null ? evalPath(cTarget, cwd) : cwd;
  if (resolved === null) return "dynamic-path";
  acc.targets.push({ path: resolved, via: "git", segmentIndex: acc.index });
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

/** 单段求值：脚本载荷族回落 → 重定向 → git 写族 → 词表命令。返回 null 表示该段无 unevaluated。 */
function evalSegment(seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  const bare = bareName(seg.argv0);

  // Python/JS 等脚本载荷族：Phase 1 显式回落（审视 S1 锚点：载荷 model 是 shell 模型非脚本 AST）。
  // script.py 文件形态同理（脚本在盘上，静态求值不可知其内部写）→ 保守回落。
  if (bare !== null && SCRIPT_RUNNERS.has(bare)) return "heredoc-script-payload";

  const err = evalRedirects(seg, cwd, acc);
  if (err !== null) return err;
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
    const err = evalSegment(seg, cwd, acc);
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
export function evaluateWriteTargets(command: string, projectRoot: string): WriteEvalResult {
  const model: CommandModel = parseOnce(command, 0);

  // 先行载荷族检测（不依赖 parseOk——python 函数调用括号触发词法 fail-closed 时
  // segments 仍可读；此类命令本就属 Phase 1 回落族，先命中正确语义）
  if (detectScriptPayload(model)) return { kind: "unevaluated", reason: "heredoc-script-payload" };
  if (!model.parseOk) return { kind: "unevaluated", reason: "parse-failed" };

  // shell 递归载荷（bash -c / cmdsub）：子模型重走求值，子落点并入（子 shell cd 链独立）；
  // 任一子模型失败 → 回落。heredoc-quoted = 纯数据（模型层口径：不递归=数据），跳过。
  const subTargets: WriteTarget[] = [];
  for (const p of model.payloads) {
    if (p.kind === "heredoc-quoted") continue;
    if (p.model === null) {
      return { kind: "unevaluated", reason: p.depth >= 2 ? "depth-exceeded" : "parse-failed" };
    }
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
