/* eslint-disable max-lines -- F20261015smrj 语义模型手术（撤拟合规则+三分类+git 口径）与能力 1 heredoc 递归后 457>450；提取通道/段通道的结构性拆分随能力 3 收尾 PR 一并做（避免语义修正 PR 夹带零语义拆分撑大审查面，先例 platforms.ts/rhi-controller.ts） */
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
 * - git 写族（词级真相源 payload-extract-aux.gitWriteSubcommandHit/GIT_WRITE_SUBS，旧同源正则 F20261016gwr1 已退役）→ -C 目标或 cwd 跟踪结果
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
 * - git add index：写族词表不含 add 是因 index 落点非 cwd——Phase 2 单独
 *   求值（落点 = -C/cwd 的索引 + add 路径参数按工作树根求值，主仓 cwd 下 add 相对路径
 *   落主仓工作树，判拦实证依据）。
 * - remote ref：push --delete / push :refs/... 远端侧操作不落本地主仓树 → evaluated 放行。
 * - fd 复制：2>&1 / 1>&2 非文件写（不落盘）——不再误伤（旧链 2>&1 | tail 形态全回落
 *   dynamic-path 的口径修正）。
 * - shadow 口径：跨规则样本（sleep_block/data_destructive 等维度拦截）从切换判据分母
 *   剔除（求值器只判 main_write 维度），单独计数披露——否则求值器永远背着别族的锅。
 *
 * 求值纯判定：除牙3 缺席证明的 fs stat 只读查询（fsAbsentPlan，delta2 修法）外无 IO、无状态、不写任何存储（机制识别检查点：只读 fs 查询已记档特性文档）。
 */
import { readFileSync } from "node:fs";
import { safeRealpath } from "./fs-realpath";
import path from "node:path";
import { parseOnce, SHELL_INTERPRETERS, type CommandModel, type Segment } from "./command-model";
import { proveNoWrite, DYNAMIC_IMPORT_FACE, MAIN_LIT_CONCAT_IMPORT_FACE, openCallUnknownMode, payloadWriteFaceHit, SCRIPT_EXEC_FACE, dotExecCommandHits, classifyOpenModeArg } from "./write-word-face";
import { isCheckOnlySeg, checkOnlyFileArgs, SCRIPT_RUNNERS, isScriptRunnerSeg, detectScriptPayload, resolvePayloadScript, extractGitAliasShell, gitWriteSubcommandHit, GIT_WRITE_SUBS, STASH_WRITE_SUBS } from "./payload-extract-aux";
import type { Word } from "./command-lexer";

// ────────────────────────────── 类型 ──────────────────────────────

export interface WriteTarget {
  /** 求值后的绝对路径 */
  path: string;
  /** 写通道（诊断/文案用） */
  via: "redirect" | "cmd-arg" | "heredoc-body" | "git" | "alias-shell";
  /** 溯源段号 */
  segmentIndex: number;
  /** 访问类型（能力 8：只读披露不构成写证据）——只有 write 参与拦截判定，read 是事实披露 */
  access: "write" | "read";
  /** 目录项操作标记（rm 等 unlink 语义）：写证据判定按「末分量不穿链」（pathEntryWithinMain） */
  entryOp?: boolean;
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
  | "script-path-dynamic"       // F20261014smrj 牙1：生成/动态脚本路径（$(gen).sh / $VAR.sh 族）——一律拦不进词面证豁免
  | "script-payload-dynamic"    // F20261014smrj 牙2：命令内造脚本其内容不可静态重建（echo "$X" > f && bash f）
  | "script-payload-unreadable" // F20261014smrj 牙3：外置脚本载荷存在但不可读（载荷不可读→拦）
  | "depth-exceeded";     // 递归深度超限

// ────────────────────────────── 常量与基础工具 ──────────────────────────────

/** 落点参数位词表（Phase 1）。argv0 裸名匹配。rm=全部非旗标参数（删除落点）。 */
const TARGET_ARG_COMMANDS = new Set(["tee", "cp", "mv", "touch", "mkdir", "rm", "find"]);
/** 修 F20261015smrj 通道 b：扩展词表写命令（install/ln/chmod/chown/chgrp/truncate）——旧集合只有
 *  tee/cp/mv/touch/mkdir，其余写命令写面命中但落点提取空 → 误当无写放行（通道 b）。 */
const EXTENDED_TARGET_COMMANDS = new Set(["install", "ln", "chmod", "chown", "chgrp", "truncate"]);

/** git 写族判定：F20261016gwr1（M-46f0e74d）正则锚已退役——\S+ 词面解析对引号含空格/
 *  attached/反引号三形态整体失明（fail-open 实证）。单一真相源=词级
 *  payload-extract-aux.gitWriteSubcommandHit + GIT_WRITE_SUBS（与 prod 侧共用）。
 *  下方 GIT_WRITE_SUBCOMMAND 常量为退役死代码（保留仅作历史对照，勿再引接）。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 退役死代码（见上注释，F20261016gwr1）
const GIT_WRITE_SUBCOMMAND = /^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+|--(?:git-dir|work-tree)(?:=\S+|\s+\S+)\s+|--(?:exec-path|namespace)(?:=\S+|\s+\S+)?\s+|(?:--\S+|-[^Cc\s]\S*)\s+)*(?:commit(?!-tree)|rebase|merge(?!-)|cherry-pick|apply|stash\s+push|push\b(?!\s+(?:--dry-run|-n)\b)(?!\s+\S+\s+(?:--delete|:))(?![^|;&]*(?:--delete|(?::\s*refs\/)))|reset\s+--hard|clean\s+-[a-zA-Z]*f)/;

/** Python/JS 等脚本解释器（载荷族）→ payload-extract-aux.SCRIPT_RUNNERS（单一真相源） */

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

/** 路径是否落在主仓工作树内（projectRoot 前缀判定，排除 worktrees 前缀）。
 *  语义：主仓「工作树内容区」= 主仓树 - .otter/worktrees/（worktree 物理上在主仓树下，
 *  但写 worktree 不是写主仓——与旧链 modelCdExemption 等效语义对齐）。
 *  裁决域口径（F20261009phs2）：.otter/ 下的獭运行时自治区（worktrees/workforms 等
 *  獭自己的隔离工作区）不算主仓工作树——落点是「獭的自治沙盒内」还是「搭档的项目内容」
 *  的分界线画在 .otter/ 之外（c080/c081 .otter/workforms-retire 误拦实证：求值器判
 *  BLOCK 但台账裁决 ALLOW——.otter/ 是獭运行时区，不是搭档的仓内容）。
 *  data/workspaces（对话工作区沙箱）同口径并入排除区——能力 7 拍板落地（下注释）。 */
// 能力 7（data/workspaces 沙箱排除）**已落地**：2026-10-13 大獭拍板（补裁簇 A 方案：工作区=
//  沙箱，依据 workspace_write 系统契约 + 影子 28 条 EVAL_GAIN 误判实证）——data/workspaces/ 是
//  搭档给獭的沙箱文件柜，写沙箱不算写主仓；root 级锚定防嵌套 decoy（/repo/x/data/workspaces/…
//  是主仓内容区，不得误排），与 .otter/worktrees 同口径。同形态语料随拍板重裁：TS-67845f56/
//  TS-ad11a060/TS-324eaad4/TS-070eb289 → ALLOW（原裁决把沙箱写当主仓写系裁决错误），f80f7559
//  保持（特性文档「补裁请求簇」节全链证据）。注意豁免域只到**写落点**——不透明脚本载荷的
//  fail-closed 不受本区影响（block 池 attack-rename-channel.sh 等残余面仍如实钉 BLOCK）。
const OTTER_RUNTIME_REGIONS = ["/.otter/worktrees/", "/.otter/workforms", "/data/workspaces/"];
export function pathWithinMain(absPath: string, projectRoot: string): boolean {
  // F20261019syml（M-ed285d7c）：symlink 穿透归一——字符串落点在运行时区但真实落点在
  //  主仓内容树的穿链形态（ln -s + 写/删穿链）在此收口；区基同 realpath 后按原 region
  //  尾杠形态重建前缀（裸区目录名豁免语义逐字保持：带尾杠=仅子树，不带=含裸名——
  //  M-cf899ad2 口径之争不受本刀影响）。
  return pathWithinMainCore(normalizePath(safeRealpath(absPath)), projectRoot);
}

/** 目录项判定（rm 等 unlink 语义——末分量不穿链）：`rm <link>` 只删链接/目录项本身
 *  不穿目标内容（F20261019syml 一轮「末分量不穿链」在求值器侧等价落位）。真实落点=
 *  父目录逐分量解析 + 末分量名保留；`rm <root>` 删主仓根仍按根判 BLOCK（树内=写主仓）。
 *  find 起点/内容写不适用（find <link> 穿链遍历目标内容——走 pathWithinMain）。 */
export function pathEntryWithinMain(absPath: string, projectRoot: string): boolean {
  return pathWithinMainCore(normalizePath(path.join(safeRealpath(path.dirname(absPath)), path.basename(absPath))), projectRoot);
}

/** 判定核（p 须已解析归一）：运行时区豁免前缀 + 主仓树内判定。 */
function pathWithinMainCore(p: string, projectRoot: string): boolean {
  const rootNorm = normalizePath(projectRoot);
  const root = normalizePath(safeRealpath(rootNorm));
  for (const region of OTTER_RUNTIME_REGIONS) {
    const regionBase = normalizePath(safeRealpath(rootNorm + region.replace(/\/+$/, "")));
    const prefix = region.endsWith("/") ? `${regionBase}/` : regionBase;
    if (p.startsWith(prefix)) return false;
  }
  if (p === root) return true;
  return p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** 轻量路径归一（不触盘：仅处理 . / 重复斜杠 / 尾斜杠；.. 保守保留） */
function normalizePath(p: string): string {
  return p.replace(/\/{2,}/g, "/").replace(/(.+)\/$/, "$1");
}

/** 路径词求值：相对 → cwd 拼接；含 $/`/~（家目录）→ null（动态，unevaluated）。
 *  ~ 按主仓 home 不可知原则不猜；`..` 保留不爬升（F20261019syml 三轮落位：下游
 *  pathWithinMain/fs 按内核逐分量解析——词法爬升跨 symlink 弹栈即 `..`-after-symlink
 *  逃逸面），`cd /repo/../..` 落点由 safeRealpath 解析到真实父级。 */
function evalPath(word: string, cwd: string): string | null {
  if (word === null || word === undefined) return null;
  if (/[$`~]/.test(word)) return null;
  if (word.includes("..")) {
    // F20261019syml 二轮落位（合并集成）：`..` 保留不爬升——climbPath 词法弹栈在
    // symlink 分量上与内核逐分量落点分歧（`<wt>/link/../x` 弹成 `<wt>/x`，真实落点
    // `<root>/x` = `..`-after-symlink 逃逸面）。下游 pathWithinMain（safeRealpath
    // 逐分量）/fs stat 按内核语义解析；非 symlink 形态词法爬升与逐分量结果相同
    // （虚构路径亦同），语义无漂移。climbPath 随之删除（无残留）。
    return normalizePath(word.startsWith("/") ? word : `${cwd.endsWith("/") ? cwd : `${cwd}/`}${word}`);
  }
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
/** B7 定点修（S1 方向A·Case-2 条件解禁，2026-10-19）：var+字面拼接 cd 目标
 *  （`$W/.otter/worktrees/x`，无 .. 后缀）——var 同命令溯源后与字面部分全量拼接
 *  （后缀完整保留，evalPath 归一，不存在 #1381「丢后缀爬升」面）。守卫：结果含
 *  `..` 一律 null 回落——c-po 负门（$W/..、$W/../../../）形态字节级不变；var 溯源
 *  不出 / cmdsub/arith 等展开 part → null。仅限 cd 目标词（evalCdTarget），
 *  不改词法求值与其余求值面。回归锁：bash-guard-cd-forms-s1.test.ts B7/c-po 对。 */
function resolveVarConcatCdTarget(w: Word, segments: Segment[]): string | null {
  if (!w.parts.every(p => p.type === "lit" || p.type === "var")) return null;
  if (!w.parts.some(p => p.type === "var")) return null;
  let out = "";
  for (const p of w.parts) {
    if (p.type === "lit") { out += p.text; continue; }
    const name = p.text.replace(/^\$\{?(\w+)\}?$/, "$1");
    if (name === p.text) return null;
    const v = resolveAssign(name, segments);
    if (v === null) return null;
    out += v;
  }
  if (out === "" || out.includes("..")) return null;
  return out;
}
function evalCdTarget(seg: Segment, segments: Segment[], cwd: string): string | null {
  const w1: Word | undefined = seg.words[1];
  if (!w1) return null;
  let target: string | null = w1.evaluated;
  if (target === null) {
    // evaluated=null = 词含 var/cmdsub/动态 part——只认「纯 $VAR 词」溯源；其余一律回落
    const name = isPureVarWord(w1);
    if (name === null) {
      const built = resolveVarConcatCdTarget(w1, segments);
      if (built === null) return null;
      target = built;
    } else {
      target = resolveAssign(name, segments);
    }
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
/** cd 链逐段 cwd 解析（一条语义一个接口——delta3 修法：trackCwd 与 buildScriptPayloadPlan 共用，
 *  不许两条通道两套解析）：返回每段执行时的 cwd 快照；pushd/popd 或 cd 溯源不出 → null
 *  （与 UnevalReason cwd-unresolvable 同语义（:70 口径）：cd $VAR 溯源不出 = 整链不可锚定）。
 *  & / | 连接段不外溢 cd（子 shell/管道独立）。export/环境变量来源的 $VAR 同口径溯源不出——
 *  resolveAssign 只认命令内赋值语句/前缀赋值（解析值=执行值），其余来源一律不猜。 */
export function resolveCwdAt(segments: Segment[], startCwd: string): string[] | null {
  const cwdAt: string[] = [];
  let cwd = startCwd;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // F20261019gses rebase 回归修（#1527 G1 例 1 同族）：& 右段是独立命令，cd 段的
    // 效应不应外溢到它——快照用 cd 前 cwd。旧实现先应用 cd 更新再被下一段 push，
    // cd WT & git 的 git 段错拿 WT（cwdAt=[start, WT]）→ git commit 落 worktree 豁免放行
    //（真漏拦面，#1527 断言拦）。正确：cwdAt[i] 记录段 i 执行时的 cwd；cd 段更新 cwd
    // 但若下一段 joiner=&/| 则回退（cd 在子 shell 里跑，父 cwd 不变）。
    const joinerNext = segments[i + 1]?.joiner ?? "";
    cwdAt.push(cwd);
    if (seg.joiner === "&" || seg.joiner === "|") continue; // 子 shell/管道：cd 不外溢
    const bare = bareName(seg.argv0);
    if (bare === "pushd" || bare === "popd") return null;
    if (bare === "cd") {
      const resolved = evalCdTarget(seg, segments, cwd);
      if (resolved === null) return null;
      cwd = resolved;
      // cd 段若通过 &/| 连接到下一段：cd 在子 shell/管道内执行，父 shell cwd 不变——
      // 快照链上后续段仍用旧 cwd（不回写 cwd 变量的做法：直接还原）
      if (joinerNext === "&" || joinerNext === "|") {
        cwd = cwdAt[cwdAt.length - 1];
        cwdAt[cwdAt.length - 1] = resolved; // cd 段自己仍拿到新 cwd（它自己的执行 cwd）
      }
    }
  }
  return cwdAt;
}
function trackCwd(segments: Segment[], startCwd: string): string | null {
  const cwdAt = resolveCwdAt(segments, startCwd);
  return cwdAt === null ? null : cwdAt[cwdAt.length - 1] ?? startCwd;
}

// ────────────────────────────── 段级求值 ──────────────────────────────

interface SegmentEvalAcc {
  targets: WriteTarget[];
  index: number;
  /** F20261019gses F1 连带：负门族命中标记（kill/危险模块/open 嵌套/exec 词面拦）——
   *  hasNarrowExtractableScriptSeg 据此区分「负门实质判定」与「字面量闸回落」 */
  hadNegGate?: boolean;
  /** F20261014smrj：同命令段表——git -C "$VAR" 纯 var 词赋值溯源（evalGitWrite 值解析用） */
  segments?: Segment[];
  /** F20261014smrj：段号→外置脚本载荷计划（牙2 造-执对内容 / 牙3 三态） */
  scriptPayloadPlan?: Map<number, SegPayloadPlan>;
  /** F20261014smrj：载荷递归深度（≥2 回落 depth-exceeded） */
  scriptDepth?: number;
}

/** 外置脚本载荷信息（考题 fixture / 生产调用方提供；缺省=缺席语义=零写面）。
 *  「载荷重组后判读，不许盲放」（裁决 signal d5f2ae9a）：content=按重组内容判读；
 *  absent=载荷缺席（文件不存在/内容失传——执行必然失败或无可判写面，放行侧记档）；
 *  unreadable=载荷存在但不可读（牙3→fail-closed）。 */
export type ScriptPayloadInfo =
  | { status: "content"; text: string }
  | { status: "absent" }
  | { status: "unreadable" };

/** 段级载荷计划项：dynamic=命令内造脚本但内容不可静态重建（牙2 负门→fail-closed） */
type SegPayloadPlan = ScriptPayloadInfo | { status: "dynamic" };

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
    acc.targets.push({ path: resolved, via: "redirect", segmentIndex: acc.index, access: "write" });
  }
  return null;
}

/** F20261016gwr1 修复轮（M-46f0e74d 建议 1，检视獭1519）：git 段自身写证据——词面证洗白的
 *  禁入键从全局 reason 字符串改为段自身证据（不依赖段序）：段内携带可证主仓落点
 *  （-C 链静态解析入主仓树）或不可证落点（动态 -c/-C 值/--git-dir|--work-tree 覆盖/
 *  core.* 树发现改写）→ true（洗白不得覆盖——`pushd /tmp && git -C "/repo/x y" commit`
 *  前导 pushd 改全局 reason 也不旁落）。无 -C 且全静态（`git push -u origin x`）→ false
 *  （目标=cwd 归全局链，词面证语义保留——corpus 96a21f3c pushd+remote-push 正面 ALLOW
 *  保绿）。相对 -C 无基准 → true（落点不可证，保守侧）。 */
// eslint-disable-next-line max-statements, complexity -- git 旗标形态穷举（-C/-c 附着/分离 × core.* 树改写 × 覆盖旗标）+ fail-closed 面逐条对照，每分支对应一种已声明形态（c107 教训：合并会再制造旗标解析 bug）
function gitSegSelfWriteEvidence(seg: Segment, projectRoot: string): boolean {
  if (!gitWriteSubcommandHit(seg)) return false;
  const words = seg.words;
  let base: string | null = null;
  let hasC = false;
  let i = 1;
  while (i < words.length) {
    const w = words[i].evaluated;
    if (w === null) return true; // 动态旗标/值位——落点不可证
    if (w.startsWith("--git-dir") || w.startsWith("--work-tree")) return true; // 落点改写
    if (w === "-C") {
      const v = words[i + 1]?.evaluated ?? null;
      if (v === null) return true;
      if (!path.isAbsolute(v)) return true; // 相对 -C 无基准——不可证
      base = v; // 不词法折叠（F20261019syml 落位）：pathWithinMain 内 safeRealpath 逐分量收口
      hasC = true;
      i += 2;
      continue;
    }
    if (w.startsWith("-C") && w.length > 2) {
      const v = w.slice(2);
      if (!path.isAbsolute(v)) return true;
      base = v; // 同上：折叠留给 safeRealpath
      hasC = true;
      i++;
      continue;
    }
    if (w === "-c") {
      const kv = words[i + 1]?.evaluated ?? null;
      if (kv === null) return true; // 动态配置——树发现改写不可证
      if (/^core\.(worktree|bare|gitdir)=/i.test(kv)) return true;
      i += 2;
      continue;
    }
    if (w.startsWith("-c") && w.length > 2) {
      // F20261016gwr1 修复轮 建议 3：attached -c<kv> 同样查 core.* 树发现改写
      if (/^core\.(worktree|bare|gitdir)=/i.test(w.slice(2))) return true;
      i++;
      continue;
    }
    if (w.startsWith("-")) {
      const nxt = words[i + 1]?.evaluated ?? null;
      i += /^(?:--exec-path|--namespace)$/.test(w) && nxt !== null && !nxt.startsWith("-") ? 2 : 1;
      continue;
    }
    break;
  }
  return hasC && base !== null && pathWithinMain(base, projectRoot);
}

/** git 写族落点（-C 目标优先，无 -C → cwd）。返回 UnevalReason | null。 */
// eslint-disable-next-line max-lines-per-function, max-statements, complexity -- git 全局旗标形态穷举（-C/-c/--git-dir/--work-tree × =值/空格值）+ 写族子命令判定，每分支对应一种已实证形态（c107 词切分错位教训：合并会再制造旗标解析 bug）；F20261014smrj 加 -C "$VAR" 赋值溯源后超 60 行
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
      // F20261014smrj：-C "$VAR" 纯 var 词同命令赋值溯源（与 evalCdTarget 同口径）——旧版直读
      //  word.evaluated（var 词恒 null）使 `git -C "$WT" commit` 恒 fail-closed（do-commit 载荷判读实证面）。
      let v = words[i + 1]?.evaluated ?? null;
      if (v === null && words[i + 1] !== undefined && acc.segments !== undefined) {
        const name = isPureVarWord(words[i + 1]);
        if (name !== null) v = resolveAssign(name, acc.segments);
      }
      if (v === null) return "dynamic-path";
      // F20261016gwr1 修复轮（M-46f0e74d 建议 3，检视獭1519）：core.worktree/bare/gitdir 配置改写
      // 树发现——落点计算不可信，fail-closed（与 prod 侧 gitDashCTargetsWorktree 对称）
      if (w === "-c" && /^core\.(worktree|bare|gitdir)=/i.test(v)) return "dynamic-path";
      if (w === "-C") cTarget = v;
      i += 2;
      continue;
    }
    if (w.startsWith("--git-dir=")) { i++; continue; }
    if (w.startsWith("--work-tree=")) { workTreeOverride = w.slice("--work-tree=".length); i++; continue; }
    if (w === "--git-dir" || w === "--work-tree") {
      // F20261014smrj：与 -C 同口径——纯 var 词赋值溯源，不猜其余动态形态
      let v = words[i + 1]?.evaluated ?? null;
      if (v === null && words[i + 1] !== undefined && acc.segments !== undefined) {
        const name = isPureVarWord(words[i + 1]);
        if (name !== null) v = resolveAssign(name, acc.segments);
      }
      if (v === null) return "dynamic-path";
      if (w === "--work-tree") workTreeOverride = v;
      i += 2;
      continue;
    }
    if (w === "--exec-path" || w === "--namespace") {
      const nxt = words[i + 1]?.evaluated ?? null;
      i += nxt !== null && !nxt.startsWith("-") ? 2 : 1; // 取值旗标（无值单写形不吞后词）
      continue;
    }
    if (/^--(?:exec-path|namespace)=/.test(w)) { i++; continue; }
    if (w.startsWith("-C") && w.length > 2) {
      // F20261016gwr1（M-46f0e74d）：attached -C<path>（值在词内，词法层已归一引号）——
      // 旧版通用旗标跳过把 -C/repo 的值丢掉，落点回落 cwd 被工作区豁免洗白（P3 实证）
      cTarget = w.slice(2);
      i++;
      continue;
    }
    if (w.startsWith("-c") && w.length > 2) {
      // F20261016gwr1 修复轮（建议 3）：attached -c<kv> 同样查 core.* 树发现改写
      if (/^core\.(worktree|bare|gitdir)=/i.test(w.slice(2))) return "dynamic-path";
      i++;
      continue;
    }
    // X1 同修（检视獭1518，与 extractGitAliasShell 两侧一次修齐）：静态旗标一律
    // continue 不 break——`git --no-pager -C <主仓> reset --hard` 类 wrapper 旗标
    // 曾使走查折断→子命令位误读→写族判定失明（fail-open）
    if (w.startsWith("-")) { i++; continue; }
    break; // 首个非旗标词=子命令位
  }
  const sub = words[i]?.evaluated;
  if (sub === undefined || sub === null) return null;
  // 写族口径单一真相源=GIT_WRITE_SUBS（F20261016gwr1 词级共享，旧正则锚已退役）；
  // 双签终版（2026-10-12）：pull=fetch+merge/rebase 归写按落点判（检视獭驳回「pull 非写」）
  if (!GIT_WRITE_SUBS.has(sub)) return null;
  const rest = words.slice(i + 1).map(w => w.evaluated).filter((v): v is string => v !== null);
  if (sub === "push") {
    if (rest.some(a => a === "--dry-run" || a === "-n")) return null;
    if (rest.some(a => a === "--delete" || a.startsWith(":"))) return null; // remote ref 删除：远端侧操作不落本地主仓树（Phase 2 c105/c131-c133）
    // 双签口径（2026-10-12 复裁签）：git push（远端目标）=外部写不落本地树→非写放行；
    //  push 目标为本地路径/`.`（罕见）时例外按落点判——落点=该本地路径仓库。
    const pos = rest.filter(a => !a.startsWith("-"));
    const repo = pos[0] ?? "";
    const isLocalRepo = repo === "." || repo.startsWith("/") || repo.startsWith("~") || /^\.{1,2}(\/|$)/.test(repo);
    if (!isLocalRepo) return null; // 远端目标（remote 名/URL/缺省 tracking）→ 非写，无落点
    const localResolved = evalPath(repo, cwd);
    if (localResolved === null) return "dynamic-path";
    acc.targets.push({ path: localResolved, via: "cmd-arg", segmentIndex: acc.index, access: "write" });
    return null;
  }
  if (sub === "reset" && !rest.some(a => a === "--hard")) return null;
  if (sub === "clean" && !rest.some(a => /^-[a-zA-Z]*f/.test(a))) return null;
  // F20261016gwr1 修复轮二（delta 残留 2）：bare `git stash` ≡ `git stash push`（git-stash(1)
  //  明文）+ 旗标形（stash -m …）同归写。F20261016gdfv（#1522）：stash 写族全集收编
  //  （pop/apply/drop/clear/store/branch 真写面）——与 prod isWriteVerbAt 共享
  //  STASH_WRITE_SUBS 同口径；读面 list/show/create 不入账（create 只打对象名不落 ref）。
  if (sub === "stash") {
    const s0 = rest[0];
    if (s0 !== undefined && !STASH_WRITE_SUBS.has(s0) && !s0.startsWith("-")) return null;
  }
  const base = cTarget !== null ? evalPath(cTarget, cwd) : cwd;
  if (base === null) return "dynamic-path";
  acc.targets.push({ path: workTreeOverride !== null ? (evalPath(workTreeOverride, cwd) ?? base) : base, via: "git", segmentIndex: acc.index, access: "write" });
  return null;
}

/** 词表命令落点（cp/mv 第二非旗标参数；tee/touch/mkdir 全部非旗标参数）。返回 UnevalReason | null。 */
// eslint-disable-next-line complexity -- 词表命令落点形态穷举（cp/mv 双参+find -delete 条件写面+~ 豁免，F20261016gdfv 破坏词表补齐后 14）
function evalTargetArgCommand(bare: string, seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  if (!TARGET_ARG_COMMANDS.has(bare)) return null;
  // F20261016gdfv（M-c78df9d4 破坏词表补齐）：find 仅 -delete 表达式是破坏写面（读形态
  //  find 不入账）；落点=全部非旗标参数（表达式值混入落点集合=保守面，与 tee/touch 同款
  //  fail-closed 哲学）。此前 find 不在词表→`find /repo -delete` 双层放行（真破坏面）。
  if (bare === "find" && !seg.words.some(w => w.evaluated === "-delete")) return null;
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
    if (d.startsWith("~")) {
      if (d.includes("..")) return "dynamic-path"; // ~/../ 可爬升到主仓 → 不可证
      continue; // 纯家目录落点 = 非主仓树（home ≠ /repo）→ 不算主仓写
    }
    const resolved = evalPath(d, cwd);
    if (resolved === null) return "dynamic-path";
    // rm = 目录项操作（unlink 语义）：标记 entryOp，判定走「末分量不穿链」——
    // `rm <link>` 只删链接本身不穿目标（F20261019syml 等价落位）；find/cp/mv/touch/
    // mkdir 落点是内容/目录语义，保持全解析。
    acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index, access: "write", ...(bare === "rm" ? { entryOp: true as const } : {}) });
  }
  return null;
}

/** 修 F20261015smrj 通道 b/c：扩展写命令落点提取（install/ln/chmod/chown/chgrp/truncate/dd/curl/wget
 *  /sed -i/perl -pi/ruby -pi）。旧 TARGET_ARG_COMMANDS 只有 tee/cp/mv/touch/mkdir，其余写命令
 *  写面命中但落点提取空 → 误当无写放行（通道 b）；curl -o/dd of= 目标在选项值（通道 c）。 */
// eslint-disable-next-line max-lines-per-function, max-statements, complexity -- F20261014smrj 扩展写族+三牙载荷判读穷举（每分支=一种已实证命令形态），行为等价拆分交 delta 复核定夺（lint 债已在 PR 验证节记档）
function evalExtendedWriteTargets(bare: string, seg: Segment, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  const words = seg.words;
  // 先判是否本函数管辖的命令——不管的命令直接返回 null（不得因词含 var/cmdsub 就报 dynamic-path）
  const handled = bare === "curl" || bare === "wget" || bare === "dd" || bare === "sed" || bare === "perl" || bare === "ruby"
    || EXTENDED_TARGET_COMMANDS.has(bare);
  if (!handled) return null;
  const push = (d: string): UnevalReason | null => {
    if (d.startsWith("~")) {
      if (d.includes("..")) return "dynamic-path"; // ~/../ 可爬升到主仓 → 不可证
      return null; // 纯家目录落点 = 非主仓树 → 不算主仓写
    }
    const resolved = evalPath(d, cwd);
    if (resolved === null) return "dynamic-path";
    acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index, access: "write" });
    return null;
  };
  // 参数即落点：curl -o / wget -O / dd of=——只在**落点词**本身不可求值时才 dynamic-path，
  //  无关词含 var/cmdsub 不触发（curl 无 -o 是只读，不得误伤）。
  if (bare === "curl" || bare === "wget" || bare === "dd") {
    for (let i = 1; i < words.length; i++) {
      const w = words[i].evaluated;
      if (bare === "dd") {
        const raw = words[i].evaluated;
        if (raw === null) continue; // 无关词（如 if=$VAR）不卡
        const of = /^of=(.+)$/.exec(raw);
        // eslint-disable-next-line max-depth -- F20261014smrj dd of= 旗标分支内嵌错误早退（早退即返回，不可平铺）
        if (of !== null) { const e = push(of[1]); if (e !== null) return e; }
        continue;
      }
      if (w === null) continue; // 无关词含 var/cmdsub → 跳过（非落点）
      const inline = /^(?:--output|-[oO])=(.+)$/.exec(w);
      if (inline !== null) { const e = push(inline[1]); if (e !== null) return e; continue; }
      if (/^(?:--output|-[oO])$/.test(w)) {
        const tv = words[i + 1]?.evaluated;
        if (tv === undefined || tv === null) return "dynamic-path"; // 落点词不可求值
        const e = push(tv); if (e !== null) return e;
        i++; // 消耗落点词
      }
    }
    return null;
  }
  // 原地编辑（sed -i / perl -pi / ruby -pi）：目标=脚本/表达式之后的文件参数。
  //  BSD `sed -i '' expr file` 空备份后缀、表达式含反引号（evaluated=null）均非落点——只对**文件落点词**
  //  不可求值才 dynamic-path（旧版收 nonFlag 时遇 expr 反引号即误报 dynamic-path，TS-f005a5a9 实证）。
  if (bare === "sed" || bare === "perl" || bare === "ruby") {
    const inplace = words.some(w => { const v = w.evaluated ?? ""; return /^-[a-zA-Z]*i[a-zA-Z]*$/.test(v) || /^-\w*p\w*$/.test(v); });
    if (!inplace) return null;
    const nonFlagWords: Array<string | null> = [];
    for (let i = 1; i < words.length; i++) {
      const v = words[i].evaluated;
      if (v !== null && v.startsWith("-") && v !== "-") continue;
      nonFlagWords.push(v);
    }
    const files = nonFlagWords.filter(v => v !== "").slice(1); // 滤掉 BSD 空备份后缀，跳过脚本/表达式
    for (const d of files) {
      if (d === null) return "dynamic-path"; // 文件落点词不可求值
      const e = push(d); if (e !== null) return e;
    }
    return null;
  }
  // 词表写命令：install/ln（dest=最后非旗标）/ chmod/chown/chgrp/truncate（路径=首参之后）
  const nonFlagArgs: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i].evaluated;
    if (w === null) return "dynamic-path"; // 落点词不可求值
    if (w.startsWith("-") && w !== "-") continue;
    nonFlagArgs.push(w);
  }
  let destArgs: string[];
  if (bare === "install" || bare === "ln") destArgs = nonFlagArgs.slice(-1); // dest=最后非旗标参数
  else destArgs = nonFlagArgs.slice(1); // chmod/chown/chgrp/truncate：路径=mode/owner/size 之后
  if (destArgs.length === 0) return "uncovered-cmd"; // 无落点参数：形态未知，保守回落
  for (const d of destArgs) { const e = push(d); if (e !== null) return e; }
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
      // F20261014smrj：与 evalGitWrite 同步——纯 var 词赋值溯源（旧版两函数同形 bug，git add 段先截）
      let v = words[i + 1]?.evaluated ?? null;
      if (v === null && words[i + 1] !== undefined && acc.segments !== undefined) {
        const name = isPureVarWord(words[i + 1]);
        if (name !== null) v = resolveAssign(name, acc.segments);
      }
      if (v === null) return "dynamic-path";
      // F20261016gwr1 修复轮（建议 3 同步）：core.* 树发现改写——fail-closed（两走查同形同治）
      if (w === "-c" && /^core\.(worktree|bare|gitdir)=/i.test(v)) return "dynamic-path";
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
  acc.targets.push({ path: base, via: "git", segmentIndex: acc.index, access: "write" });
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
      acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index, access: "write" });
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
const SCRIPT_WRITE_TOKENS = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|openSync|mkdirSync|mkdir|rmSync|rmdirSync|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|chmodSync|chownSync|symlinkSync|dump|dumps|shelve|os\.(?:remove|rmdir|rename|replace|link|symlink|truncate|chmod|chown|utime|mknod|mkdir))\b|\bopen\s*\([^)]*,\s*["'`][wa]|\.write(?:Sync)?\s*\(/;
// F20261019gses F1 连带：补 os.* 写族词面（os.remove("config.yaml") 相对路径落主仓曾放——
//  pythonBodyReadOnly 的 os 面全禁随 ③a 收窄退位，写面词面归位此表）

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

// eslint-disable-next-line max-statements, complexity -- F20261014smrj 脚本载荷递归判读（node -e/-c/文件三通道+argv 传播），分支=通道穷举（合分支会遮蔽通道优先级）
function evalScriptWriteTargets(script: string, argvMap: Map<number, string>, varEnv?: Map<string, string>): { paths: string[] } | null {
  const paths: string[] = [];
  // node: xxxSync('path', ...) / fs.writeFile('path', ...) —— 首参即落点（不含 rename/copy 双参族）
  for (const m of script.matchAll(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|openSync|mkdirSync|mkdir|rmSync|rmdirSync|unlinkSync|unlink|chmodSync|chownSync|symlinkSync|truncateSync)\s*\(\s*([^,)]+)/g)) {
    const arg = resolveScriptArg(m[1], argvMap, varEnv);
    if (arg === null) return null; // 路径不可求值 → 写调用不可求值，回落
    paths.push(arg);
  }
  // 修 F20261015smrj 通道 c②（参序 bug）：renameSync/copyFileSync/copyFile/shutil.copy/copy2/copytree/move
  //  双参 src→dst——落点是**第二参（dst）**，旧版只提首参（src）漏 dst。提第二参。
  for (const m of script.matchAll(/\b(?:renameSync|rename|copyFileSync|copyFile)\s*\(\s*[^,)]+\s*,\s*([^,)]+)/g)) {
    const arg = resolveScriptArg(m[1], argvMap, varEnv);
    if (arg === null) return null;
    paths.push(arg);
  }
  for (const m of script.matchAll(/\bshutil\.(?:copy|copy2|copytree|move)\s*\(\s*[^,)]+\s*,\s*([^,)]+)/g)) {
    const arg = resolveScriptArg(m[1], argvMap, varEnv);
    if (arg === null) return null;
    paths.push(arg);
  }
  // 修 F20261015smrj 通道 a（词面失明）：pathlib.Path(lit).write_text/write_bytes——路径在接收者
  //  Path 构造里。变量接收者 f.write_text 不入本通道（未识别目标 → 不可证，但无路径字面量写证据），
  //  试金石 TS-19e22576 良性保留。
  for (const m of script.matchAll(/Path\s*\(\s*["']([^"']*)["']\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/g)) {
    const arg = resolveScriptArg(`"${m[1]}"`, argvMap, varEnv);
    if (arg === null) return null;
    paths.push(arg);
  }
  //  通道 a：os.chmod/chown/utime/truncate、np.save/savez/extractall —— 首参即落点
  for (const m of script.matchAll(/\b(?:os\.(?:chmod|chown|utime|truncate)|np\.(?:save|savez|savez_compressed)|\w+\.extractall)\s*\(\s*([^,)]+)/g)) {
    const arg = resolveScriptArg(m[1], argvMap, varEnv);
    if (arg === null) return null;
    paths.push(arg);
  }
  //  通道 a：sqlite3.connect —— 首参即落点；mode=ro 只读连接非写（跳过）；首参非字面量 → 不可证
  for (const m of script.matchAll(/\bconnect\s*\(\s*([^,)]*)/g)) {
    const first = m[1].trim();
    const lit = /^["'`]([^"'`]*)[`"']$/.exec(first);
    if (lit !== null && /mode\s*=\s*ro\b/.test(lit[1])) continue; // 只读连接非写
    const arg = resolveScriptArg(m[1], argvMap, varEnv);
    if (arg === null) return null; // 首参非字面量 → 不可证（保守回落）
    paths.push(arg);
  }
  // python: open('path', 'w'/'a'/'r+'/...)——读模式 open('p') / open('p','r') 不算写
  for (const m of script.matchAll(/\bopen\s*\(\s*([^,)]+)(\s*,\s*([^,)]*))?/g)) {
    const kind = classifyOpenModeArg(m[3], m[3] !== undefined);
    if (kind === "read") continue; // 默认/纯读模式=非写嫌疑
    if (kind === "unknown") return null; // mode 不可证 → 回落（fail-closed）
    const arg = resolveScriptArg(m[1], argvMap, varEnv);
    if (arg === null) return null;
    paths.push(arg);
  }
  return { paths };
}

/** 求值脚本参数表达式：纯字面量/字面量拼接 → 折叠值；argv[N] → argvMap 值传播；
 *  裸变量名 → varEnv 值传播（F20261019gses P0 载荷能力补全：`p = 'x.py'; open(p, 'w')` 变量
 *  赋值传播——静态收集的保守面）；其他（调用/运算/属性访问）→ null。 */
function resolveScriptArg(expr: string, argvMap: Map<number, string>, varEnv?: Map<string, string>): string | null {
  const t = expr.trim();
  const folded = foldStringConcat(t);
  if (folded !== null) return folded;
  const argvM = /^(?:process\.argv|sys\.argv)\[(\d+)\]$/.exec(t);
  if (argvM) {
    const v = argvMap.get(Number(argvM[1]));
    return v ?? null;
  }
  if (varEnv != null) {
    const varM = /^([A-Za-z_$][\w$]*)$/.exec(t);
    if (varM !== null && varEnv.has(varM[1])) return varEnv.get(varM[1]) ?? null;
  }
  return null;
}

/** 载荷内变量赋值环境（F20261019gses P0：变量赋值传播——87 缺口族最大单一杠杆 52/87，
 *  `p = 'docs/x.md'; s = open(p).read(); open(p, 'w').write(s)` 路径在变量里）。
 *  保守面：只收「单次赋值 + 纯字面量值」——python 行首裸名 `p = 'lit'` / js `const|let|var p = 'lit'`；
 *  值后必须紧跟行尾/;/注释（负门：`p = 'a' + 'b'` 拼接 RHS 不得截断收集成 'a'——单测钉死）；
 *  f-string/模板串/拼接/含反斜杠转义（不解释语义）/同变量异值重赋值（顺序错位风险一刀切不猜）
 *  → 一律不收集，调用处回落。 */
function collectScriptVarEnv(script: string): Map<string, string> | null {
  const env = new Map<string, string>();
  const reassigned = new Set<string>();
  const ASSIGN_RE = /(?:^|\n)[ \t]*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*["']([^"'\\\n]*)["'](?=\s*(?:[;#]|$|\n))/g;
  for (const m of script.matchAll(ASSIGN_RE)) {
    const name = m[1];
    const value = m[2];
    if (env.has(name)) {
      if (env.get(name) !== value) reassigned.add(name);
    } else {
      env.set(name, value);
    }
  }
  for (const n of reassigned) env.delete(n);
  return env.size > 0 ? env : null;
}

/** 只读调用词面表（Phase 2 窄提取形态B：读调用路径同样可求值——读哪报哪，与写调用同语义。
 *  不含 write/dump 等歧义词面——那是写闸的事）。 */
const SCRIPT_READ_TOKENS = /\b(?:readFileSync|readFile|existsSync|statSync|lstatSync|readdirSync|realpathSync|createReadStream|load|loads|get|getenv)\b/;

/** 只读调用落点求值：readFileSync('p')/open('p')/open('p','r')/json.load(open('p')) 等。 */
function evalScriptReadTargets(script: string, argvMap: Map<number, string>, varEnv?: Map<string, string>): { paths: string[] } | null {
  const paths: string[] = [];
  for (const m of script.matchAll(/\b(?:readFileSync|readFile|existsSync|statSync|lstatSync|readdirSync|realpathSync|createReadStream)\s*\(\s*([^,)]+)/g)) {
    const arg = resolveScriptArg(m[1], argvMap, varEnv);
    if (arg === null) continue; // 读路径不可求值不致命——只读侧不影响拦截决策，跳过该条
    paths.push(arg);
  }
  // python open 读模式（open('p') / open('p','r')）——写模式已在写通道处理
  for (const m of script.matchAll(/\bopen\s*\(\s*([^,)]+)(\s*,\s*([^,)]*))?/g)) {
    const kind = classifyOpenModeArg(m[3], m[3] !== undefined);
    if (kind !== "read") continue; // 写/未知模式不在读侧
    const arg = resolveScriptArg(m[1], argvMap, varEnv);
    if (arg === null) continue;
    paths.push(arg);
  }
  return { paths };
}

/** #1432 只读豁免：字面量是否处于 node import('X')/require('X') 的纯目标位置。
 *  动态导入/加载的模块解析目标固有只读（加载≠写落点）——不披露为 target；
 *  动态拼接目标（import('./a/' + p)）除外：目标不可静态判定，不豁免（宁可保守）。
 *  前置词边界排除 foo.import(/foo.require( 方法调用（那些可能是任意语义）。 */
function isModuleLoadLiteralTarget(script: string, m: RegExpExecArray): boolean {
  const idx = m.index ?? 0;
  const before = script.slice(0, idx);
  const after = script.slice(idx + m[0].length);
  if (!/(?:^|[^\w$.])(?:import|require)\s*\(\s*$/.test(before)) return false;
  return /^\s*\)/.test(after);
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
// eslint-disable-next-line max-lines-per-function, max-statements, complexity -- F20261015smrj 载荷三通道（heredoc/-e-c/文件）+ open 三分类 + 形态A/B 双形态后 63 行/48 语句/复杂度 31；窄提取通道拆分随能力 3 收尾 PR（先例 clients.ts max-lines-per-function + 本函数既有 max-statements 豁免合并）
function evalScriptPayloadNarrow(seg: Segment, projectRoot: string, acc: SegmentEvalAcc & { cwd: string }, _commandText: string): "skip" | "heredoc-script-payload" | "extracted" {
  if (!isScriptRunnerSeg(seg)) return "skip";
  // 病型 A（拍板 2026-10-13）：check-only=语法检查（读脚本不执行）→ 读侧入账直接提取（先于载荷旗标判定）。
  if (isCheckOnlySeg(seg)) {
    for (const f of checkOnlyFileArgs(seg)) {
      const resolved = evalPath(f, acc.cwd);
      if (resolved !== null) acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index, access: "read" });
    }
    return "extracted";
  }
  const flagIdx = seg.words.findIndex(w => w.evaluated === "-e" || w.evaluated === "-c");
  let script: string | null;
  let cMode = false;
  let tailArgs: Array<string | null> = [];
  if (flagIdx >= 0) {
    // 载荷词必须全字面可求值。多行载荷常态（gduc S1 实证面）：双引号体内嵌单引号字面量
    //  （`node -e "…require('fs')…"`）触发词法 fail-closed，evaluated=null 但 parts 全 lit
    //  （引号上下文已剥，无展开）——此时拼接 parts 仍得静态载荷；parts 含任何非 lit/escape
    //  展开段（var/cmdsub/arithmetic）→ 真不可求值，回落不猜。
    // 病型 B/C（拍板 2026-10-13）：载荷脚本解析——引号自散架走重组 span（C，方案 a，负门②交界→回落）；
    //  否则 evaluated 优先、null 时 cmdsub 拼原文（B）；var/arith 不猜；负门①写词面→回落（下行 cMode 闸）。
    const payloadWord = seg.words[flagIdx + 1];
    if (!payloadWord) return "skip";
    // F20261019gses F1 连带：无引号裸词载荷（python3 -c print(...) 被 shell 词法截断
    //（words 只收首词 print，写面藏在后续文本里提取不到）→ fail-closed——带引号
    //（quoted 部件在场）才是完整载荷，裸标识符词是截断信号（旧 ③a 形态判拦过的面归位）。
    // 归一化豁免防线：归一化文本（剥引号形态）不触发本门——剥引号是归一化链的合法差异
    //（scanNormalizedWithOneLinerExemption 的载荷集合差分承担），裸词门只管原文真裸形态。
    // 判据：flag 词在原文的尾偏移后仍存在非空白载荷字符（说明载荷跨词被截断）。
    const flagWordEnd = seg.words[flagIdx].span.end ?? 0;
    const tailAfterFlag = _commandText.slice(flagWordEnd).trimStart();
    const tailNonEmpty = tailAfterFlag.length > 0 && !tailAfterFlag.startsWith(';') && !tailAfterFlag.startsWith('&') && !tailAfterFlag.startsWith('|');
    const isQuotedPayload = payloadWord.parts.some(p => p.quoted);
    const isBareWord = /^[A-Za-z_][\w$.]*$/.test(payloadWord.evaluated ?? '');
    if (!isQuotedPayload && isBareWord && tailNonEmpty) {
      acc.hadNegGate = true;
      return "heredoc-script-payload";
    }
    const res = resolvePayloadScript(payloadWord, seg.words[flagIdx], _commandText);
    script = res.script;
    cMode = res.cMode;
    tailArgs = seg.words.slice(flagIdx + 2).map(w => w.evaluated);
  } else if (seg.heredocs.length === 1) {
    // 能力 1（heredoc 体脚本投递，派工 2026-10-13）：解释器段无 -e/-c 载荷而带 heredoc 体
    //  → 体=stdin 投递的脚本载荷（`python3 - <<'EOF'` / `node <<EOF`），与 -e/-c 载荷同判据
    //  窄提取。裸定界体含展开（$/`）→ 不猜回落（与载荷展开口径同）；数据投递（cat/tee 等
    //  非解释器段 heredoc）不进本通道——#1171 引号定界=绝对数据语义保持。
    const hd = seg.heredocs[0];
    if (!hd.delimQuoted && /[$`]/.test(hd.body)) return "heredoc-script-payload";
    script = hd.body;
  } else {
    // script.py 文件形态/无载荷旗标/多体：Phase 1 行为（回落）由调用方兜底
    return "skip";
  }
  if (script === null) return "heredoc-script-payload";
  // 病型 C 负门①（硬性，跨段藏写不许遮蔽）：重组 span 内写词面/写调用 → 仍回落。
  if (cMode && (SCRIPT_WRITE_TOKENS.test(script) || payloadWriteFaceHit(script))) return "heredoc-script-payload";
  // 规则 2/规则 1 优先（证明演算 §3.2.1）：载荷含动态 import/未知 mode open → 一律不可证
  //  （能力 8 只豁免字面量读披露；写 mode open 交形态 A 落点提取，不在此闸）
  if (DYNAMIC_IMPORT_FACE.test(script) || openCallUnknownMode(script)) {
    return "heredoc-script-payload";
  }
  // 规则 2 附带闸（能力 5，拍板 2026-10-13）：exec 类裸调用（new Function/eval/exec/...）一律不可证——窄提取不得绕过词面证的 exec 拦（残余面 TS-ef0d6be4 族钉死）。
  // F20261019gses F1 修复连带：kill 主进程词面负门（非重叠危险面归位——③a 收窄到包装
  //  形态后，plain one-liner 载荷的 os.kill(主PID)/process.kill(主PID) 不再有通道附带拦。
  //  kill 是 kill 域同族安全面（与写落点判定不重叠）：载荷词面含 kill **调用形态**
  //（os.kill(/process.kill(/process.abort() 即不可证（目标可能是主进程——fail-closed；
  //  真要 kill 的运维场景走 scripts/alpha.sh 正道）。裸 pkill/killall 词不收——那是
  //  shell 层 kill 域的域，载荷内文本数据（源码分析/正则测试脚本，TS-d41c4ce2/
  //  TS-acd4d18a 实证误伤）不算调用。
  if (/\b(?:os\.)?kill\s*\(|\bprocess\.(?:kill|abort)\s*\(/.test(script)) {
    acc.hadNegGate = true;
    return "heredoc-script-payload";
  }
  // F20261019gses F1 修复连带：1432-B 危险模块/动态目标词面负门（同上归位）——
  //  child_process 齐携 exec/spawn 面、import 拼接目标不可静态判定（能力 8 词面证同源）。
  if (/\brequire\s*\(\s*["'`]child_process["'`]|\bfrom\s+["'`]child_process["'`]/.test(script)
      || /\b(?:import|require)\s*\(\s*[^"'`\s]/.test(script)
      || MAIN_LIT_CONCAT_IMPORT_FACE.test(script)) {
    acc.hadNegGate = true;
    return "heredoc-script-payload";
  }
  // F20261019gses F1 连带：open 实参区嵌套括号负门（pythonOpenModesReadOnly S1 修复先例的
  //  one-liner 版归位）：`open(chr(99), 'w')` 嵌套括号使词面提取截断（[^)]* 在 chr(99)
  // 的 ) 停），mode/路径不可见——实参区见嵌套 ( 即不豁免（fail-closed）；* 解包同拒
  //（mode 藏在解包元组里完全不可见，open(*a) 穿透，r4 先例）。dbm.open 缺省 'c' 创建
  // 可写（#1423 同源）——dbm/shelve 模块 open 词面即拦。
  // F20261019gses F1 连带：ruby/perl 载荷写面词面负门——ruby/perl 不在 SCRIPT_RUNNERS 解析域
  //（F2 族记档），但 perl 写形态（open(F,">f") 文件句柄模式）/ ruby File.write 写面
  // 不可放：相对路径落主仓的真写面（perl 相对写 config.yaml 实证放行）。词面拦
  //（fail-closed）优先于 F2 的「绝对路径字面量闸兜底」（相对路径无字面量可兜）。
  // 注意：python/node 的 open('f','w')/writeFileSync 走形态 A 落点求值（evaluated
  // 命中主仓才拦）——此负门不覆盖（词面全拦会误伤树外合法写，Phase 2 窄提取
  //「写调用落点求值」测试实证回归）。
  if (/\bopen\s*\(\s*[A-Za-z_][\w$]*\s*,\s*["'`]?>|\bFile\.write/.test(script)) {
    acc.hadNegGate = true;
    return "heredoc-script-payload";
  }
  if (/(?:^|[^.\w])open\s*\([^)]*\(|\.open\s*\([^)]*\(|\bopen\s*\([^)]*\*|\bdbm\.|\bshelve\./.test(script)) {
    acc.hadNegGate = true;
    return "heredoc-script-payload";
  }
  if (SCRIPT_EXEC_FACE.test(script) || dotExecCommandHits(script)) return "heredoc-script-payload";
  // 载荷后参数词（argv 值传播）：node -e 与 python -c 首实参位都是 argv[1]（#1411 off-by-one
  //  修复实证：argv 错位曾致 /repo/b 假放行）。
  const argvBase = 1;
  const argvMap = new Map<number, string>();
  tailArgs.forEach((v, i) => {
    if (v !== null) argvMap.set(argvBase + i, v);
  });
  // 零写面放行侧语义统一为 "extracted"（judgeScriptText 返回 null）——与旧返回值兼容
  return judgeScriptText(script, argvMap, projectRoot, acc) ?? "extracted";
}

/** 脚本文本判读（F20261019gses P0 三通道共享：-e/-c 内联 / heredoc 体 / 外置脚本 content）。
 *  write-verdict 头注释「judge 考试与影子投影同判据，口径不得分叉」的函数化——负门之外的
 *  形态A/B 判读全部集中于此（负门留在各通道：cMode 重组门是内联通道专属）。
 *  返回 "heredoc-script-payload"=不可证回落；null=零写面放行侧（extracted）。
 *  argvMap 提供值传播（外置文件形态不传——argv 偏移随 runner 形态不同，保守零传播）。 */
// eslint-disable-next-line max-statements, complexity -- 判读主体（形态A/B/字面量闸）从 evalScriptPayloadNarrow 原样迁入，历史豁免同源（P0 通道拆分）
function judgeScriptText(script: string, argvMap: Map<number, string>, projectRoot: string, acc: SegmentEvalAcc & { cwd: string }): "heredoc-script-payload" | null {
  const varEnv = collectScriptVarEnv(script);
  // 形态A：写调用落点求值（真实求值——写哪报哪，路径不可求值才回落）
  const hasWriteCall = SCRIPT_WRITE_TOKENS.test(script);
  const wr = hasWriteCall ? evalScriptWriteTargets(script, argvMap, varEnv ?? undefined) : null;
  const rd = SCRIPT_READ_TOKENS.test(script) || /\bopen\s*\(/.test(script) ? evalScriptReadTargets(script, argvMap, varEnv ?? undefined) : null;
  if (hasWriteCall) {
    if (wr === null) return "heredoc-script-payload"; // 写调用存在但路径求值不出 → 保守回落
    if (wr.paths.length === 0) return "heredoc-script-payload"; // 写词面命中但未匹配到调用形态（方法调用/write 属性等）→ 回落
    for (const p of wr.paths) {
      const resolved = evalPath(p, acc.cwd);
      if (resolved === null) return "heredoc-script-payload"; // 写落点含 .. 等不可信形态——§3.1 不猜爬升结果，回落
      acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index, access: "write" });
    }
  }
  if (rd !== null) {
    for (const p of rd.paths) {
      // §3.1：读侧披露走 evalPath，含 .. 不猜（披露无拦截语义，跳过即可）
      const resolved = evalPath(p, acc.cwd);
      if (resolved !== null) acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index, access: "read" });
    }
  }
  if (!hasWriteCall) {
    const paths = extractAbsPathLiterals(script);
    if (paths.some(p => p.includes("..") || pathWithinMain(p, projectRoot))) return "heredoc-script-payload";
    for (const p of paths) acc.targets.push({ path: p, via: "cmd-arg", segmentIndex: acc.index, access: "read" });
    for (const m of script.matchAll(/["'`]([A-Za-z0-9_.][A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+)["'`]/g)) {
      const rel = m[1];
      if (rel.startsWith("/") || rel.includes("..") || /[$`]/.test(rel)) continue;
      if (isModuleLoadLiteralTarget(script, m)) continue;
      const resolved = evalPath(rel, acc.cwd);
      if (resolved !== null) acc.targets.push({ path: resolved, via: "cmd-arg", segmentIndex: acc.index, access: "read" });
    }
  }
  return null;
}

/** 模型内是否存在可窄提取的脚本载荷段（顶层 + 递归子模型同口径）。
 *  用于 evaluateWriteTargets 的 detectScriptPayload 短路前置：存在可提取段 → 不先行短路，
 *  交给 evalSegment 段级窄提取；不存在 → 保持 Phase 1 先行回落（parseOk=false 语义兜底）。
 *  F20261019gses F1 连带：「heredoc-script-payload」（负门命中——kill/危险模块/exec 词面
 *  回落）同样算「有实质判定」——proveNoWrite 先行短路曾绕过段级负门放行 os.kill(主PID)
 *  （kill 词面非写词面，词面证判无写→假 ALLOW，探针实证）。 */
function hasNarrowExtractableScriptSeg(model: CommandModel, projectRoot: string): boolean {
  const probe: SegmentEvalAcc & { cwd: string } = { targets: [], index: 0, cwd: projectRoot };
  const check = (m: CommandModel): boolean => {
    for (const seg of m.segments) {
      const r = evalScriptPayloadNarrow(seg, projectRoot, probe, m.raw);
      // F20261019gses F1 连带修正：负门族命中（kill/危险模块/open 嵌套/exec）才算「有实质判定」
      //（proveNoWrite 词面证不含 kill 词面，短路曾放行 os.kill(主PID)，探针实证）。
      // 字面量闸回落不算——proveNoWrite 先行短路对字面量只读载荷（require('/repo/src/x.js')）
      // 是能力 8 披露正道（30517746 病灶口径），窄提取的字面量闸不构成绕过它的理由
      //（guard-v2-real-replay「能力 8 披露→evaluated」实证回归）。
      if (r === "extracted" || (r === "heredoc-script-payload" && probe.hadNegGate === true)) return true;
      probe.hadNegGate = false; // 每段重置（负门标记只在命中段有效）
    }
    return m.payloads.some(p => p.model !== null && check(p.model));
  };
  return check(model);
}

// ────────────────────────────── 黑盒外置脚本三牙（F20261014smrj 工单②，裁决 signal d5f2ae9a） ──────────────────────────────
//
// 背景：`bash <file>` 外置脚本段历史为盲放（无写面词→正面 ALLOW）——放行库 35+ 条黑盒脚本
//  考题即以此过考。裁决口径：考「静态路径按重组载荷判读」不是盲放：
//  ① 生成/动态脚本路径（$(gen).sh 族）→ fail-closed；
//  ② 命令内造脚本再执行（echo 写 .sh && bash 同文件）→ 按造出来的内容判读；内容不可重建→fail-closed；
//  ③ 静态路径三态：content→递归判读；unreadable→fail-closed；absent（显式声明或 fs 自查证明）→零写面（放行侧——
//     「文件不存在→执行必然失败→零写面」校正口径；载荷缺席面在考题 fixture 记档不隐身）。

/** 三牙终局态（含 parse-failed）：黑盒脚本的不可证面不进「能力 4 词面证」豁免——
 *  否则 proveNoWrite（盲于脚本执行面）会把牙口的 fail-closed 洗成正面 ALLOW（探针实证的放水面）。 */
const UNPROVABLE_TEETH: ReadonlySet<UnevalReason> = new Set<UnevalReason>([
  "parse-failed",
  "script-path-dynamic",
  "script-payload-dynamic",
  "script-payload-unreadable",
]);

/** shell 外置脚本执行段（解释器族 ∪ source/.）——三牙判定的触发面 */
const SCRIPT_FILE_RUNNERS = new Set<string>([...SHELL_INTERPRETERS, "source", "."]);

/** 段首直执行位判定（路径形态词）——delta4（严重 1）+ delta5（严重 2，动态双层全漏）
 *  + delta8（`~` 前缀族 + 含斜杠相对路径词，检视獭1360 delta7 复核：`~/x.sh` 双层全漏、
 *  前缀空间穷举新缺口）：与 hasOpaqueScriptExec 直执分支、guard-model-judge U5 生产层
 *  同源共用（一条语义一个接口——经 isDirectExecScriptSeg 段级口径三处共用）。词文本口径
 *  （前缀空间穷举，delta8 方法论落档）：
 *  ① 路径前缀词文本（./x、/x 排 //、../x——词首特殊字符形态；中缀斜杠族（scripts/x.sh
 *  等）收编会误收非壳载荷垃圾解析的参数词（能力 8 同族——TS-b42e23be 实测翻红），
 *  按「扰动 frozen 考试的收编必须独立工单带守恒验收」（大獭 M-026d87ff 裁决原则）
 *  不并入本刀，见穷举表呈拍板）；② `~` 前缀族（~/ 与 ~/user 形态——evalPath 不可解 →
 *  dynamic fail-closed，与 bash ~/x.sh 同款保守。**镜像注记**：resolvesToMainCheckout
 *  （bash-safety-guard.ts，F20260916gtlr）对 `~` 显式「不展开，保守拦截」——两处镜像
 *  义务：改一处另一处注记跟着走）；③ 纯展开词（$P）保守收进通道 → 动态直执走
 *  script-path-dynamic fail-closed（与 bash $P 同款）。
 *  残余面（记档）：非斜杠动态命令位（foo$BAR）不收——与 kill${IFS}… 类不误伤的边界取舍
 *  （delta5 既定 + 单测钉死，对称入口例外见穷举表）；wrapper 剥除形态两层同缺（记档）。 */
export function isDirectExecArgv0(word: Word | null | undefined): boolean {
  if (word === undefined || word === null) return false;
  const litRaw = word.parts.map(p => (p.type === "lit" || p.type === "escape" ? p.text ?? "" : "")).join("");
  const fullRaw = word.parts.map(p => p.text ?? "").join("");
  if ((litRaw.startsWith("./") || litRaw.startsWith("../") || (litRaw.startsWith("/") && !litRaw.startsWith("//")))) return true;
  if (fullRaw.startsWith("~")) return true;
  // 纯展开词（词文本为空且求值不出）：命令位是展开结果——可能是脚本路径，保守收进通道
  return litRaw === "" && word.evaluated === null;
}

/** 运行器族 argv0（解释器/脚本语言运行器，basename 口径）：argv0 是运行器族时脚本位
 *  在其参数/载荷，argv0 自身不当脚本文件——/usr/bin/python3 与 python3 同族同判
 *  （同族不许自己打自己；python 文件形态面不超通道 TS-74fd58ae/TS-10eb58ff 冻结口径）。 */
function isRunnerArgv0(argv0: string | null): boolean {
  const bare = bareName(argv0);
  return bare !== null && (SCRIPT_FILE_RUNNERS.has(bare) || SCRIPT_RUNNERS.has(bare));
}

/** 段首直执行位脚本段判定（delta5 完整口径——wv 三处 + guard-model-judge U5 生产层
 *  同源共用，一条语义一个接口）：词文本直执收口（isDirectExecArgv0）+ 运行器族 carve。 */
export function isDirectExecScriptSeg(seg: Segment): boolean {
  return !isRunnerArgv0(seg.argv0) && isDirectExecArgv0(seg.words[0]);
}

/** 解释器族外置脚本段识别（shellScriptFileArg 解释器分支；hasOpaqueScriptExec 同源复用——
 *  段首路径不进本函数：替换型载荷垃圾解析会把参数/字面量当段首路径（delta3 能力 8 口径）。
 *  F20261019gses P0：SCRIPT_RUNNERS 文件形态（node x.mjs / python x.py）接入同通道——
 *  K 类 34 条缺口主通道；只认「静态路径 + 可读后缀」保守面，动态路径交牙1。 */
const SCRIPT_FILE_SUFFIXES = /\.(?:sh|bash|zsh|mjs|cjs|js|mts|cts|ts|py|pyw|rb|pl|pm|scpt|applescript)$/;
// eslint-disable-next-line complexity -- 双域判定（shell 解释器族 + SCRIPT_RUNNERS 文件形态）通道穷举
function interpreterScriptFileArg(seg: Segment): { word: Word; dynamic: boolean } | null {
  const bare = bareName(seg.argv0);
  if (bare === null) return null;
  const isShellRunner = SCRIPT_FILE_RUNNERS.has(bare);
  const isScriptRunner = SCRIPT_RUNNERS.has(bare);
  if (!isShellRunner && !isScriptRunner) return null;
  if (seg.args.includes("-c") || seg.args.includes("-e")) return null;
  for (const w of seg.words.slice(1)) {
    const raw = w.parts.map(p => (p.type === "lit" || p.type === "escape" ? p.text ?? "" : "")).join("");
    const head = w.evaluated ?? raw;
    if (head.startsWith("-")) continue; // 旗标位（-n 检查态等）不当脚本位
    // shell 解释器族：首个非旗参即脚本位（历史口径）；SCRIPT_RUNNERS 文件形态：
    // 只认静态可读后缀（node --watch x.mjs / python -u x.py 的旗标已在上面 skip）。
    //  无后缀/内联代码字（node -p "expr"）→ null（非脚本位，交回 evalScriptPayloadNarrow skip 路径）
    if (isScriptRunner && !isShellRunner && !SCRIPT_FILE_SUFFIXES.test(head)) return null;
    const v = w.evaluated;
    return { word: w, dynamic: v === null || evalPath(v, "/") === null };
  }
  return null;
}

/** shell 外置脚本执行段识别：解释器族或 source/. + 无 -c/-e 载荷旗标，或段首直执行位
 *  （delta4 修法严重 1：./x、/x 排 // 样式，delta5 词文本口径扩纯展开词——脚本位=argv0 词
 *  本身；造-执对/显式声明/缺席证明
 *  同构三态自动接上：真存在→unreadable fail-closed、真不存在→absent 放行，与 bash x 一视同仁）。
 *  返回脚本位词与是否动态（生成/求值不出路径）；null=非外置脚本段。 */
function shellScriptFileArg(seg: Segment): { word: Word; dynamic: boolean } | null {
  if (isDirectExecScriptSeg(seg)) {
    const w = seg.words[0];
    if (w === undefined) return null;
    const v = w.evaluated;
    return { word: w, dynamic: v === null || evalPath(v, "/") === null };
  }
  return interpreterScriptFileArg(seg);
}

/** 造文件段内容重建（牙2）：echo/printf 静态参数、cat/tee 定界 heredoc 体 → 可重建；
 *  其他写法（cp/mv/追加/含展开参数）→ content=null（不可重建=dynamic）。 */
// eslint-disable-next-line complexity -- F20261014smrj 牙2 内容重建（echo/printf/cat/tee/heredoc/重定向）形态穷举，分支=已实证写法枚举
function writerContent(seg: Segment, cwd: string): { target: string; content: string | null } | null {
  let redirect: Segment["redirects"][number] | null = null;
  for (const r of seg.redirects) {
    if (!isWriteRedirect(r.op) || isFdDup(r.op, r.target)) continue;
    redirect = r;
    break;
  }
  if (redirect === null || redirect.target === null) return null;
  const target = evalPath(redirect.target, cwd);
  if (target === null) return null;
  if (redirect.op.includes(">>")) return { target, content: null }; // 追加：先验内容不可知
  const bare = bareName(seg.argv0);
  if (bare === "echo" || bare === "printf") {
    const vals = seg.words.slice(1).map(w => w.evaluated);
    if (vals.some(v => v === null)) return { target, content: null };
    const args = vals.filter((v): v is string => v !== null && !v.startsWith("-"));
    const content = bare === "printf" ? args.slice(1).join("\n") : args.join(" ");
    return { target, content };
  }
  if ((bare === "cat" || bare === "tee") && seg.heredocs.length === 1) {
    const hd = seg.heredocs[0];
    if (!hd.delimQuoted && /[$`]/.test(hd.body)) return { target, content: null };
    return { target, content: hd.body };
  }
  return { target, content: null };
}

/** 载荷主仓字面量闸（与窄提取「载荷含主仓树字面量一律回落」同源口径的反向判据）：
 *  载荷文本含主仓树绝对路径字面量 → 存在主仓写嫌疑，深判读不可证时不许放。 */
function hasMainTreeLiteral(text: string, projectRoot: string): boolean {
  const re = /(?:^|[\s"'=:(,])(\/[^\s"'`;|&()<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (pathWithinMain(normalizePath(m[1]), projectRoot)) return true;
  }
  return false;
}

/** 外置脚本载荷判读（牙2/牙3 的 content 态）：载荷文本递归求值（能力 1 heredoc 通道同口径），
 *  子落点并入 acc。深判读不可证时：词面证（能力 4）→ 主仓字面量闸 → 均不过才回落。
 *  无主仓树字面量的不可证载荷按零写面放行——残余缺口（动态目标/相对落点不可证）见特性文档记档。 */
function judgeScriptPayload(text: string, projectRoot: string, cwd: string, acc: SegmentEvalAcc, via: "heredoc-body" | "alias-shell" = "heredoc-body"): UnevalReason | null {
  const depth = acc.scriptDepth ?? 0;
  if (depth >= 2) return "depth-exceeded";
  // F20261015gali 修法（M-edd889c2 排查发现）：载荷递归走 evaluateWriteTargets 入口
  //（与直接执行同待遇）——旧版走 evaluateFromModel 少了入口层 shell 递归载荷收集
  //（collectShellPayloadTargets），`sh -c "rm -rf 主仓"` 嵌套载荷在载荷内被静默放过
  //（S6 探针实证）；入口层的词面证/不透明执行否决/parseOk 探针语义随之对齐。
  // 递归终止：每层载荷 ⊊ 原文（文本长度严格递减）单翼收敛——X2（检视獭1518）如实记：
  // depth 记账经 evaluateWriteTargets 入口不透传，非双保险，终止性由长度递减保证。
  const sub = evaluateWriteTargets(text, projectRoot, cwd);
  if (sub.kind === "evaluated") {
    acc.targets.push(...sub.targets.map(t => ({ ...t, via: via as "heredoc-body" | "alias-shell", segmentIndex: acc.index })));
    return null;
  }
  // 载荷内嵌套牙口（造-执对/动态路径）——不可证面直接传播不豁免；其余不可证先试词面证再过主仓字面量闸
  if (UNPROVABLE_TEETH.has(sub.reason) && sub.reason !== "parse-failed") return sub.reason;
  if (sub.reason !== "parse-failed" && proveNoWrite(text)) return null;
  if (hasMainTreeLiteral(text, projectRoot)) return sub.reason;
  return null;
}

/** 段级载荷计划（牙2 造-执对 + 牙3 三态）：先扫「命令内造脚本再执行」对（造出内容为权威载荷），
 *  其余外置脚本段取条目级载荷信息；显式声明与造-执均缺省时求值器自查 fs 证缺席（delta2 修法——
 *  「缺省=absent」的静默 fail-open 已收：未提供载荷 ≠ 缺席）。delta3 修法（严重 2）：cwd 解析
 *  与写通道同一来源（resolveCwdAt，一条语义一个接口——不许两条通道两套解析），缺席证明三前提
 *  缺一不可：①cwd 可溯源（resolveCwdAt 成功）②落点可求值（非动态词）③执行 cwd 可锚定
 *  （absenceAllowed——载荷子模型从调用链继承 startCwd，链上有 cd 时锚不住）。任一不成立
 *  → 不得出具缺席证明 → fail-closed（防「解析 cwd 与执行 cwd 错位」假缺席证明，delta3 攻击链口径）。 */
// eslint-disable-next-line complexity -- F20261014smrj 牙2 造-执对+牙3 三态计划合成+delta3 缺席证明三前提，分支=语义枚举（合分支会遮蔽造出内容优先语义）
function buildScriptPayloadPlan(model: CommandModel, projectRoot: string, startCwd: string, entry: ScriptPayloadInfo | undefined, absenceAllowed: boolean): Map<number, SegPayloadPlan> {
  const plan = new Map<number, SegPayloadPlan>();
  const segs = model.segments;
  const cwdAt = resolveCwdAt(segs, startCwd);
  for (let i = 0; i < segs.length; i++) {
    const ex = shellScriptFileArg(segs[i]);
    if (ex === null) continue;
    let planned: SegPayloadPlan | undefined;
    const v = ex.word.evaluated;
    if (cwdAt !== null && !ex.dynamic && v !== null) {
      const sPath = evalPath(v, cwdAt[i]);
      for (let j = 0; j < i && sPath !== null && planned === undefined; j++) {
        if (segs[j].joiner === "|") continue;
        const w = writerContent(segs[j], cwdAt[j]);
        if (w === null || w.target !== sPath) continue;
        planned = w.content === null ? { status: "dynamic" } : { status: "content", text: w.content };
      }
    }
    let absence: SegPayloadPlan | null = null;
    if (planned === undefined && entry === undefined && cwdAt !== null && absenceAllowed && !ex.dynamic && v !== null) {
      // F20261019gses P0 运行时 sourcing：真实读取取代纯缺席自查——content（判读）/absent（缺席证明）
      // /unreadable（存在但读不出）三态齐备，「未接线≠缺席」硬验收项的接线本体。
      absence = fsContentPlan(evalPath(v, cwdAt[i]));
    }
    plan.set(i, planned ?? entry ?? absence ?? { status: "unreadable" });
  }
  return plan;
}

/** 载荷子模型的 startCwd 是否即其真实执行 cwd（delta3 修法）：链上有 cd（哪怕可溯源）时
 *  载荷所属段的执行 cwd 与 startCwd 可能错位（模型层载荷不锚定段），缺席证明不得出具。 */
function payloadsCwdAnchored(segments: Segment[]): boolean {
  return segments.every(s => s.joiner === "&" || s.joiner === "|" || bareName(s.argv0) !== "cd");
}

/** 载荷子洗白判定（能力 4）：载荷求值失败但原文词面可证无写 → 正面 ALLOW；parse-failed/三牙
 *  终局态豁免（载荷内引号/参数分裂逃逸=残余面钉死 fail-closed，不走词面放宽）。delta3 修法：
 *  模型树内不透明外置脚本执行 → 不得洗白（否则 fail-closed 被洗白成放行）。 */
function subPayloadWashable(reason: UnevalReason, command: string, model: CommandModel): boolean {
  return !UNPROVABLE_TEETH.has(reason) && proveNoWrite(command) && !hasOpaqueScriptExec(model);
}

/** delta3 修法（严重 2）：模型树内不透明外置脚本执行——shell 解释器/source/. + 首个非旗标脚本位
 *  （口径=shellScriptFileArg 同源，-c/-e 内联载荷段除外）或段首直执（./x、/x——排除 // 样式，
 *  防 JS 注释行误命中）。脚本内容不在命令内 = 规则 2 不可证；词面证洗白口对含这类执行的命令
 *  不得放行（否则「cd 溯源不出 → fail-closed」被洗白，delta3 攻击链 export DIR; cd $DIR &&
 *  bash x.sh 正面放行实证）；递归查载荷子模型（bash -c 内层脚本同口径）。
 *  注：node/python/perl/ruby 文件形态不在牙3 通道域（SHELL_INTERPRETERS∪source/.）——面不超
 *  通道（TS-74fd58ae/TS-10eb58ff 等现役放行题按词面证裁决标准冻结），通道扩展+裁决复核立 issue。 */
function hasOpaqueScriptExec(model: CommandModel, scriptText: boolean = true): boolean {
  for (const seg of model.segments) {
    const ex = interpreterScriptFileArg(seg); // 解释器分支（直执另按 scriptText 门控，防替换型载荷垃圾解析误收）
    // 口径镜像 evalSegment：动态脚本位 + source/. 非 shell 解释器 → 通道放行（现役放行题
    //  5d98a85e source <(sed …) 保守面），不计入不透明执行；bash $P 等动态位照算（通道拦 script-path-dynamic）
    if (ex !== null && !(ex.dynamic && !SHELL_INTERPRETERS.has(bareName(seg.argv0) ?? ""))) return true;
    // 段首直执（./x、/x）：仅脚本正文类模型（根/bash-c/heredoc 体）判定——替换型载荷（cmdsub/
    //  backtick/procsub）的非壳文本（JS/Python）壳解析会把参数/字面量误收成段首路径（能力 8
    //  import(主仓路径) 30517746 口径实测翻红）；解释器脚本位判定仍全层生效（echo $(bash x.sh) 拦）
    //  （delta5 起词文本口径——纯展开词一并收，误收防线不变）
    if (scriptText && isDirectExecScriptSeg(seg)) return true;
  }
  return model.payloads.some(p => p.model !== null && hasOpaqueScriptExec(p.model, p.kind === "bash-c" || p.kind === "heredoc-bare"));
}

/** 载荷三态的真实内容源（F20261019gses P0 运行时 payload sourcing）：静态路径外置脚本
 *  在裁决链调用时真实读取磁盘内容——「未接线≠缺席」硬验收项的接线本体。fs 存在→读 content；
 *  ENOENT→absent（缺席证明，牙3 同口径）；读失败→unreadable（fail-closed）。
 *  只读操作（与 fsAbsentPlan 同一信任口径），TOCTOU 窗口已在牙3 记档。 */
function fsContentPlan(resolved: string | null): SegPayloadPlan {
  if (resolved === null) return { status: "unreadable" };
  try {
    return { status: "content", text: readFileSync(resolved, "utf8") };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { status: "absent" } : { status: "unreadable" };
  }
}

/** 牙3 缺席证明（delta2 修法，大獭工单 2026-10-14；F20261019gses P0 被 fsContentPlan 取代
 *  升级为真实读取三态）：delta2 时代的缺席自查（存在→unreadable fail-closed）保留为历史口径
 *  记档——P0 运行时 sourcing 后「未接线≠缺席」保守面已下线，fs 存在即真实读出判读。
 *  TOCTOU 记档：read 与执行间存在时间窗——切换 PR 硬验收项：生产链路必须真实注入载荷
 *  （content/unreadable 判读）并验证接线后才切换，防静默退化「静态外置脚本全盲放」。 */

/** 单段求值：脚本窄提取（Phase 2）→ 脚本载荷族回落 → 重定向 → git add（Phase 2）→ git 写族 → 词表命令。返回 null 表示该段无 unevaluated。 */
/** F20261015gali（M-edd889c2）：git alias shell 展开（! 前缀）载荷求值——提取基座
 *  payload-extract-aux.extractGitAliasShell（与 prod 文本路径同源）。返回 null=本段无
 *  定义位或载荷已证安全；UnevalReason=不可证（fail-closed）或载荷写面命中落点后
 *  由调用链末端按「∩ 主仓树」裁决。 */
function evalGitAliasShell(seg: Segment, projectRoot: string, cwd: string, acc: SegmentEvalAcc): UnevalReason | null {
  const ex = extractGitAliasShell(seg);
  if (ex === null) return null;
  if (ex.kind === "opaque") return "script-payload-dynamic";
  for (const p of ex.texts) {
    const r = judgeScriptPayload(p, projectRoot, cwd, acc, "alias-shell");
    if (r !== null) return r;
  }
  return null;
}

// eslint-disable-next-line complexity, max-statements -- 段求值路由（窄提取/载荷回落/heredoc 递归/重定向/git/词表）六通道各对应一条已声明语义，合并会制造分支遮蔽；F20261014smrj 三牙计划接入后语句数超 25
function evalSegment(seg: Segment, cwd: string, acc: SegmentEvalAcc, projectRoot: string, commandText: string): UnevalReason | null {
  const bare = bareName(seg.argv0);
  const accWithCwd: SegmentEvalAcc & { cwd: string } = Object.assign(acc, { cwd });

  // F20261015gali（M-edd889c2）：git alias shell 展开（! 前缀）=真执行体载荷——
  //  载荷写面递归求值（judgeScriptPayload 同口径，via:"alias-shell"）；载荷可证安全→
  //  放行，动态/提取不出→fail-closed（script-payload-dynamic 同语义，不可证不豁免）。
  //  域分工：载荷非写面（kill 等）由文本路径规则承担（F20261015smrj 口径），本层只判写面。
  const aliasHit = evalGitAliasShell(seg, projectRoot, cwd, accWithCwd);
  if (aliasHit !== null) return aliasHit;

  // Phase 2 窄提取：可静态求值的只读脚本载荷段，不等 Phase 1 整段回落就放行
  const narrow = evalScriptPayloadNarrow(seg, projectRoot, accWithCwd, commandText);
  if (narrow === "heredoc-script-payload") return "heredoc-script-payload";

  // Python/JS 等脚本载荷族：Phase 1 显式回落（审视 S1 锚点：载荷 model 是 shell 模型非脚本 AST）。
  //  窄提取已过的段（narrow==="extracted"）不再走本行——窄提取承诺双闸全过。
  //  F20261019gses P0：文件形态 runner（node x.mjs / python x.py）不再盲黑盒——
  //  shellScriptFileArg 已扩到 SCRIPT_RUNNERS 文件形态，上方三牙分支（scriptArg !== null）
  //  会接住并走载荷计划三态；此处只拦「skip 且非外置脚本位」的残余（-e/-c 无载荷等）。
  // Python/JS 等脚本载荷族：Phase 1 显式回落（审视 S1 锚点：载荷 model 是 shell 模型非脚本 AST）。
  //  窄提取已过的段（narrow==="extracted"）不再走本行——窄提取承诺双闸全过。
  //  F20261019gses P0：文件形态 runner（node x.mjs / python x.py）不再盲黑盒——shellScriptFileArg
  //  已扩到 SCRIPT_RUNNERS 文件形态，下方三牙分支（scriptArg !== null）接住并走载荷计划
  //  三态（含 P0 运行时 sourcing：fsContentPlan 真实读取）；本行只拦「skip 且非外置脚本位」
  //  的残余（-e/-c 载荷不可求值等真黑盒形态）。
  if (narrow === "skip" && bare !== null && SCRIPT_RUNNERS.has(bare) && shellScriptFileArg(seg) === null) return "heredoc-script-payload";

  // 能力 1（heredoc 体脚本投递）：shell 解释器段 heredoc 体=stdin 投递脚本，与 bash -c 载荷
  //  同判据递归求值（TS-c047 放水实证）；-n 不递归；不可证→回落（能力 4 词面证同判据）。
  if (bare !== null && SHELL_INTERPRETERS.has(bare) && !seg.args.includes("-c") && !seg.args.includes("-n") && seg.heredocs.length > 0) {
    for (const hd of seg.heredocs) {
      const sub = evaluateFromModel(parseOnce(hd.body, 1), projectRoot, cwd);
      if (sub.kind === "unevaluated") {
        if (UNPROVABLE_TEETH.has(sub.reason) || !proveNoWrite(commandText)) return sub.reason;
        continue;
      }
      acc.targets.push(...sub.targets);
    }
  }

  // 【拟合规则撤除（派工 2026-10-13 方案 A 语义模型）】D'（gh pr edit/merge/close/
  //  reopen/create→cwd 假写证据）已撤——gh 家族远端变更是「外部写不落本地树」（双签
  //  口径 TS-6a5cc1b2 明文），语料压倒性一致：gh pr edit（TS-c084/c085/TS-324eaad4/
  //  TS-3b2fd2b2/TS-05537e52）、gh pr create（TS-a4c2ffa4）、gh issue create/comment
  //  （TS-fea396ea/TS-c092）、gh pr review --comment（TS-9e996401/TS-7715da07）全
  //  ALLOW。TS-508d0cc8 的「主仓树内×1/4」证据自身错误（__HEREDOC_DATA__(/tmp/...)
  //  落主仓树内——/tmp 不在主仓树内），按同构对重裁与 TS-a6dfe989 判到一致（双 ALLOW）。

  // ── 黑盒外置脚本三牙（F20261014smrj）：生成路径拦 / 造-执内容判读 / 载荷三态 ──
  const scriptArg = shellScriptFileArg(seg);
  if (scriptArg !== null) {
    const runner = bareName(seg.argv0);
    // 牙1：生成/动态脚本路径一律拦（解释器族；source/. 不进牙1——source <(sed …) 现役放行题保守面）
    // 牙1：动态脚本路径一律 fail-closed（解释器族 + 段首直执行位——delta4 修法同构；
    //  source/. 不进牙1：source <(sed …) 现役放行题保守面）
    if (scriptArg.dynamic && (isDirectExecScriptSeg(seg) || (runner !== null && SHELL_INTERPRETERS.has(runner)))) return "script-path-dynamic";
    if (!scriptArg.dynamic) {
      const plan = acc.scriptPayloadPlan?.get(acc.index);
      // 牙3 三态：unreadable（声明不可读/未提供且 fs 证存在）→拦；content（含牙2 造-执内容）→递归判读；absent（声明或 fs 证缺席）→零写面放行侧
      if (plan?.status === "unreadable") return "script-payload-unreadable";
      if (plan?.status === "dynamic") return "script-payload-dynamic";
      if (plan?.status === "content") {
        // F20261019gses P0：按载荷语言分发判读——shell 载荷递归 shell 模型（历史口径，
        //  含直执行位/shebang 载荷）；SCRIPT_RUNNERS（node/python/ruby/perl）载荷是脚本语言，
        //  shell 解析器抓不到其写调用（writer.mjs 实证：fs.writeFileSync 被 shell 模型盲放）
        //  → judgeScriptText 同判据。语言信号：解释器 runner（isRunnerArgv0）为第一信号；
        //  直执行位 runner=文件名无语言语义（mk.sh 实证）→ 按脚本路径后缀分发，
        //  无后缀/未知后缀保守走 shell 递归（shell 是系统默认解释器的事实口径）。
        const isShellLang = isRunnerArgv0(seg.argv0)
          ? SCRIPT_FILE_RUNNERS.has(bareName(seg.argv0) ?? "")
          : !/(?:\.mjs|\.cjs|\.js|\.mts|\.cts|\.ts|\.py|\.pyw|\.rb|\.pl|\.pm|\.scpt|\.applescript)$/.test(scriptArg.word.evaluated ?? "");
        const payloadErr = isShellLang
          ? judgeScriptPayload(plan.text, projectRoot, cwd, acc)
          : judgeScriptText(plan.text, new Map(), projectRoot, { ...acc, cwd }) ?? null;
        if (payloadErr !== null) return payloadErr;
      }
    }
  }

  const err = evalRedirects(seg, cwd, acc);
  if (err !== null) return err;
  const gitAddErr = evalGitAdd(seg, cwd, acc);
  if (gitAddErr !== null) return gitAddErr;
  const gitErr = evalGitWrite(seg, cwd, acc);
  if (gitErr !== null) return gitErr;
  if (bare !== null) {
    const cmdErr = evalTargetArgCommand(bare, seg, cwd, acc);
    if (cmdErr !== null) return cmdErr;
    const extErr = evalExtendedWriteTargets(bare, seg, cwd, acc);
    if (extErr !== null) return extErr;
  }
  return null;
}

// ────────────────────────────── 主入口 ──────────────────────────────

// detectScriptPayload → payload-extract-aux（载荷族检测，能力 5 迁移）

/** 从既有模型求值。子模型（bash -c/cmdsub）先各自 trackCwd 再求值（子 shell cd 链独立——
 *  首跑实测教训：默认主仓根会漏子模型内 cd，bash -c 'cd wt && touch a' 误报主仓落点）。
 *  startCwd = 命令启动时的 cwd（默认 projectRoot）——条件期望双态各跑的维度参数。 */
type ScriptCtx = { payload?: ScriptPayloadInfo; depth?: number; absenceAllowed?: boolean };

// eslint-disable-next-line complexity -- F20261019gses rebase 回归修 +3 分支（cd 外溢双处守卫：&/| 下游 joiner 检查 ×2）——段链 cd 推进与 resolveCwdAt 同语义耦合，拆函数会分叉口径，基线 12+3
function evaluateFromModel(model: CommandModel, projectRoot: string, startCwd: string, ctx: ScriptCtx = {}): WriteEvalResult {
  const { payload: scriptPayload, depth: scriptDepth = 0, absenceAllowed = true } = ctx;
  const tracked = trackCwd(model.segments, startCwd);
  if (tracked === null) return { kind: "unevaluated", reason: "cwd-unresolvable" };

  const acc: SegmentEvalAcc = {
    targets: [],
    index: 0,
    segments: model.segments,
    scriptPayloadPlan: buildScriptPayloadPlan(model, projectRoot, startCwd, scriptPayload, absenceAllowed),
    scriptDepth,
  };
  // delta3 修法（严重 2 附带发现）：段链从 startCwd 忠实重放（与 trackCwd/resolveCwdAt 同口径）——
  // 旧版从链尾 tracked 起步会把「写在 cd 前」的段挪到链尾 cwd（写在 cd 前的主仓写被判 sandbox 实证）。
  let cwd = startCwd;
  for (let i = 0; i < model.segments.length; i++) {
    const seg = model.segments[i];
    const err = evalSegment(seg, cwd, acc, projectRoot, model.raw);
    if (err !== null) return { kind: "unevaluated", reason: err };
    // 段内 cd 推进（与 trackCwd 同口径）。
    // F20261019gses rebase 回归修（#1527 G1 例 1 同族）：cd 段若通过 &/| 连接到下一段，
    // cd 在子 shell/管道内执行，父 shell cwd 不变——不推进 cwd（否则 cd WT & git commit
    // 的 git 段错拿 WT，主仓写被 worktree 豁免洗白——真漏拦面）。
    if (seg.joiner !== "&" && seg.joiner !== "|" && bareName(seg.argv0) === "cd") {
      const nextJoiner = model.segments[i + 1]?.joiner ?? "";
      if (nextJoiner !== "&" && nextJoiner !== "|") {
        const r = evalCdTarget(seg, model.segments, cwd);
        if (r !== null) cwd = r;
      }
    }
    acc.index++;
  }
  return { kind: "evaluated", targets: acc.targets };
}

/**
 * 求值命令的写落点集合（Phase 1：shell 形态族）。
 *
 * @param command 原始命令文本
 * @param projectRoot 主仓根（绝对路径）——「主仓工作树」判定基准
 * @param startCwd 命令启动 cwd（默认 projectRoot；条件期望双态各跑用：worktree 态传 worktree 路径）
 * @returns evaluated（targets 可为空集=求值成功且无写落点）或 unevaluated（回落）
 */
/** shell 递归载荷求值（能力 4 词面证集成）：子落点入账（子 shell cd 链独立）。
 *  返回 targets=全部子模型求值成功；uneval=存在不可证子模型（词面证放行仅限全证无写）。 */
function collectShellPayloadTargets(
  model: CommandModel, command: string, projectRoot: string, startCwd: string, scriptSegNarrowed: boolean,
): { targets: WriteTarget[] } | { uneval: UnevalReason } {
  const targets: WriteTarget[] = [];
  // delta3 修法（严重 2）：载荷子模型从 startCwd 求值——链上有 cd 时锚不住真实执行 cwd，
  // 缺席证明不得出具（payloadsCwdAnchored=false → 子计划 fail-closed，防假缺席证明）。
  const anchored = payloadsCwdAnchored(model.segments);
  for (const p of model.payloads) {
    if (p.kind === "heredoc-quoted") continue;
    if (p.model === null) {
      return { uneval: p.depth >= 2 ? "depth-exceeded" : "parse-failed" };
    }
    if (scriptSegNarrowed && p.kind === "cmdsub" && !p.model.parseOk && !detectScriptPayload(p.model)) continue; // 垃圾 cmdsub 跳过
    const sub = evaluateFromModel(p.model, projectRoot, startCwd, { absenceAllowed: anchored });
    if (sub.kind === "unevaluated") {
      if (subPayloadWashable(sub.reason, command, model)) return { targets };
      return { uneval: sub.reason };
    }
    targets.push(...sub.targets);
  }
  return { targets };
}

// eslint-disable-next-line complexity -- 入口路由（parseOk 探针 + 载荷递归 + 主模型求值）三分支各对应一条已声明语义（Phase 1/Phase 2 口径注释）
export function evaluateWriteTargets(command: string, projectRoot: string, startCwd: string = projectRoot, scriptPayload?: ScriptPayloadInfo): WriteEvalResult {
  const model: CommandModel = parseOnce(command, 0);
  // delta3 修法（严重 2）：模型树内不透明外置脚本执行 → 词面证洗白口不得放行（防「cd 溯源不出
  //  → fail-closed」被洗白，delta3 攻击链实证）；显式缺席声明（entry absent，牙3 同一信任口径
  //  ——声明来自裁决链非命令作者）豁免该否决（声明缺席=脚本零写）。
  const opaqueExecVeto = hasOpaqueScriptExec(model) && scriptPayload?.status !== "absent";
  // F20261016gwr1（M-46f0e74d）：git 写族段不得被词面证洗白——git 写动词不在词面写
  // 清单，proveNoWrite 把 `git -c <反引号载荷> commit` 类洗成零写面（P5 双层漏实证）；
  // 写族段的不可证必须按落点判定语义 fail-closed。
  const gitWriteSeg = model.segments.some(gitWriteSubcommandHit);

  // 先行载荷族检测（不依赖 parseOk——可窄提取的脚本载荷段跳过短路，交给段级窄提取）。
  if (detectScriptPayload(model) && !hasNarrowExtractableScriptSeg(model, projectRoot)) {
    // 能力 4：载荷不可窄提取但原文词面可证无写 → 正面 ALLOW；否则 fail-closed。
    if (proveNoWrite(command) && !opaqueExecVeto && !gitWriteSeg) return { kind: "evaluated", targets: [] };
    return { kind: "unevaluated", reason: "heredoc-script-payload" };
  }
  if (!model.parseOk) {
    // Phase 2：多行载荷命令常态 parseOk=false（嵌套单引号），但 segments/words 仍可读——
    //  至少一段求出实质落点才走正常路径；全部段零落点且无载荷/窄提取面 → evaluated 空集
    //  是假信息，回落 parse-failed 保 Phase 1 保守语义。词法彻底失败（segments 空）同口径。
    if (model.segments.length === 0) return { kind: "unevaluated", reason: "parse-failed" };
    const probe = evaluateFromModel(model, projectRoot, startCwd, { payload: scriptPayload });
    if (probe.kind === "unevaluated") return probe;
    if (probe.targets.length === 0 && !hasNarrowExtractableScriptSeg(model, projectRoot) && model.payloads.length === 0) {
      // 能力 4：词面可证无写 → 正面 ALLOW；否则保 Phase 1 保守语义。有 shell 递归载荷时
      //  不提前返回——bash -c 'touch 主仓' 子落点必须先入账（单测负门实证的放水面）。
      if (proveNoWrite(command) && !opaqueExecVeto && !gitWriteSeg) return { kind: "evaluated", targets: [] };
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
  const payloadResult = collectShellPayloadTargets(model, command, projectRoot, startCwd, scriptSegNarrowed);
  if ("uneval" in payloadResult) return { kind: "unevaluated", reason: payloadResult.uneval };
  const subTargets: WriteTarget[] = payloadResult.targets;

  const main = evaluateFromModel(model, projectRoot, startCwd, { payload: scriptPayload });
  if (main.kind === "unevaluated") {
    // F20261016gwr1 收窄（corpus 守恒）+ F20261016gwr1 修复轮 建议 1（检视獭1519）：洗白禁入键
    // =git 段自身证据（不依赖段序/全局 reason）——段内携带可证主仓落点或不可证落点时
    // 词面证不得洗白；无 -C 且全静态（96a21f3c pushd+remote-push）维持词面证放行
    //（能力 4 既有语义+双签背书，corpus 棘轮保绿）。
    const gitSelfEvidence = model.segments.some(s => gitSegSelfWriteEvidence(s, projectRoot));
    if (!UNPROVABLE_TEETH.has(main.reason) && proveNoWrite(command) && !opaqueExecVeto && !gitSelfEvidence) return { kind: "evaluated", targets: subTargets };
    return main;
  }
  return { kind: "evaluated", targets: [...main.targets, ...subTargets] };
}
