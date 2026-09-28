/**
 * bash 守卫判定层 v2（F20260928grv2，guard-v2-redesign）。
 *
 * 统一结构模型的判定层入口：全部判定消费 CommandModel 而非原始文本
 * （方案 §3.3 判定层消费映射表）。旧文本判定链（findKillSegments 等）保留为
 * parseOk=false 时的 fail-closed 兜底（D3：kill 族解析失败必拦——兜底链语义
 * 等价于 V1 判定，保守侧不回归）。
 *
 * V2 行为变化白名单（搭档已拍板，双向锁）：
 * - 白名单内新拦：kill 0（进程组语义，U1/#1169）；bash <file> / bash file.sh
 *   从文件读脚本（U5，保守拦+提示改写）
 * - 白名单内放行（以前误拦）：#1170 管道/分号杀 cd 豁免、#1171 引号/heredoc 内
 *   词样字面量、$VAR 传参（r1-S3 口径由模型层继承）
 * - 白名单外任何「以前放行 → 现在拦截」= 失败（迁移矩阵断言）
 */
/* eslint-disable max-statements, complexity, max-depth, max-params */

import type { Logger } from "@usecases/ports/logger";
import type { CommandModel, Segment, Payload } from "./command-model";
import { parseOnce } from "./command-model";
import { loadAllowedServicePorts } from "./allowed-service-ports";
import type { AllowedService } from "./allowed-service-ports";

// ────────────────────────────── 词表（与 V1 对齐迁移） ──────────────────────────────

/** kill 族命令名（命令位置由模型段结构承担——不再需要正则前缀模拟） */
const KILL_NAMES = new Set(["kill", "skill"]);
/** pkill 族 */
const PKILL_NAMES = new Set(["pkill", "killall", "killall5"]);
/** wrapper 前缀词（V1 stripCommandPrefixes 语义） */
const WRAPPER_WORDS = new Set(["sudo", "env", "nohup", "command", "xargs", "nice", "watch", "exec", "time", "timeout", "do"]);
/** otter 进程特征名（V1 OTTER_PROCESS_PATTERNS 迁移） */
const OTTER_PROCESS_PATTERNS = [
  "otter-buddy", "otter_buddy", "dist/src/main", "main.js", "node",
];
/** PID 文件引用（词文本判定用） */
const PID_FILE_TEXT = /\.otter-buddy\.pid/;
/** 间接 PID 形态（模型版：var/cmdsub/arith/unknown part 即间接） */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

// ────────────────────────────── 工具函数 ──────────────────────────────

/** 段的「有效命令名」：剥 wrapper 前缀词与赋值前缀后的 argv0（V1 stripCommandPrefixes 模型版） */
function effectiveCommand(seg: Segment): { name: string | null; args: Array<string | null>; argWords: Segment["words"] } {
  let words = seg.words;
  // 赋值前缀已在模型层拆出（assignments）——直接剥 wrapper 词
  let guard = 0;
  while (words.length > 0 && guard++ < 8) {
    const w0 = words[0].evaluated;
    if (w0 !== null && WRAPPER_WORDS.has(w0)) {
      words = words.slice(1);
      // wrapper 参数（-n1 / 5 / VAR=val）跳过一个（timeout 5 / xargs -n1）
      if (words.length > 0) {
        const w1 = words[0].evaluated;
        if (w1 !== null && (/^[-]/.test(w1) || /^\d+$/.test(w1) || /^[A-Za-z_]\w*=/.test(w1))) {
          words = words.slice(1);
        }
      }
      continue;
    }
    break;
  }
  return {
    name: words[0]?.evaluated ?? null,
    args: words.slice(1).map(w => w.evaluated),
    argWords: words.slice(1),
  };
}

/** 词内是否含展开 part（var/cmdsub/arith/hex/unknown）→ 间接 */
function hasExpansionPart(seg: Segment, fromArg1 = false): boolean {
  const words = fromArg1 ? seg.words.slice(1) : seg.words;
  return words.some(w => w.parts.some(p => p.type === "var" || p.type === "cmdsub" || p.type === "arith" || p.type === "hex" || p.type === "unknown"));
}

/** 提取段内字面量数字参数（跳过信号 flag）——模型版 extractLiteralPids */
function literalPidsOf(seg: Segment): number[] {
  const pids: number[] = [];
  for (const w of seg.words.slice(1)) {
    if (w.evaluated === null) continue;
    const v = w.evaluated;
    if (v.startsWith("-")) continue;
    // 剥子 shell 括号尾（V1 #777 口径）
    const stripped = v.replace(/^[()]+|[()]+$/g, "");
    if (/^\d+$/.test(stripped)) pids.push(parseInt(stripped, 10));
  }
  return pids;
}

/** pkill 目标是否命中 otter 特征名（模型版 pkillTargetsOtter）——含词内 var part 展开文本 */
function pkillTargetsOtterModel(seg: Segment): boolean {
  for (const w of seg.words.slice(1)) {
    // 词文本基准：evaluated ?? 全 part 原文拼接（var 词看原文，如 $OTTER_NAME 里的名不含特征名则不命中——与 V1 文本正则等价）
    const text = (w.evaluated ?? w.parts.map(p => p.text).join("")).toLowerCase();
    if (OTTER_PROCESS_PATTERNS.some(pat => new RegExp(`\\b${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text))) {
      return true;
    }
  }
  return false;
}

/** 段是否引用 PID 文件（词文本含 .otter-buddy.pid） */
function referencesPidFile(seg: Segment): boolean {
  return seg.words.some(w => (w.evaluated ?? w.parts.map(p => p.text).join("")).includes(".otter-buddy.pid"));
}
void PID_FILE_TEXT;

/** 段间管道溯源：段的上游邻接段（joiner=| 的前段） */
function pipeUpstreamOf(model: CommandModel, seg: Segment): Segment | null {
  const idx = model.segments.indexOf(seg);
  if (idx <= 0) return null;
  return model.segments[idx - 1].joiner === "|" ? model.segments[idx - 1] : null;
}

// ────────────────────────────── kill 族判定（模型版） ──────────────────────────────

export interface ModelVerdict {
  blocked: string | null;
  /** 走了白名单放行（诊断用） */
  whitelisted?: boolean;
}

/** kill 段判定：模型版 checkKillSegment。
 *  语义映射：
 *  - pkill 族：目标词命中 otter 特征名 → 拦（文案同 V1）
 *  - kill 间接目标（var/cmdsub/arith/hex/unknown part 在参数位）→ 拦（文案同 V1）
 *  - PID 文件引用 → 拦
 *  - 字面量主 PID → 拦
 *  - U1 新增：字面量 0（进程组语义——载荷内 kill 0 信号覆盖含主进程的整组）→ 拦
 *  - 管道右段（上游 stdin 为 kill 参数来源）→ 参数不可静态求值 → 间接拦 */
function judgeKillSegment(
  seg: Segment,
  model: CommandModel,
  mainPid: number,
  logger: Logger | undefined,
  allowedServices: AllowedService[],
  depth: number,
): string | null {
  const { name } = effectiveCommand(seg);
  if (name === null) return null;
  const bare = name.includes("/") ? name.split("/").pop()! : name;
  const isPkill = PKILL_NAMES.has(bare);
  const isKill = KILL_NAMES.has(bare);
  if (!isPkill && !isKill) return null;

  // pkill 族：目标进程名判定
  if (isPkill) {
    if (pkillTargetsOtterModel(seg)) {
      logger?.warn("[guard-v2] BLOCKED pkill/killall targeting otter processes", { mainPid, depth });
      return "bash 命令包含按名匹配的批量终止命令（pkill/killall），可能影响主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
    }
    return null;
  }

  // kill 族：
  // PID 文件引用（跨段文本语义保留——词文本含即拦）
  if (referencesPidFile(seg)) {
    logger?.warn("[guard-v2] BLOCKED kill referencing .otter-buddy.pid file", { mainPid, depth });
    return "bash 命令中终止进程的命令引用了主进程 PID 文件。主进程是海獭运行时环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
  }  // 间接目标：参数位含展开 part（$VAR/$()/反引号/$(())/\xNN）
  if (hasExpansionPart(seg, true)) {
    // 管道右段且上游是白名单端口的 lsof → 白名单放行（#844 规则 2a/2c 模型版）
    const upstream = pipeUpstreamOf(model, seg);
    if (upstream && isWhitelistedLsofSegment(upstream, allowedServices)) return null;
    // #844 规则 2b 模型版：kill $VAR 且 VAR 在同命令内被赋值为白名单端口 lsof 结果
    if (killVarSourcedFromWhitelistedLsof(seg, model, allowedServices)) return null;
    logger?.warn("[guard-v2] BLOCKED kill with indirect PID target", { mainPid, depth });
    return "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop（alpha 实例的标准清理方式，勿用组合杀）；若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  // 管道右段：stdin 即间接来源（xargs kill 无字面参数也拦——V1 pipeSourced 语义）
  const upstream = pipeUpstreamOf(model, seg);
  if (upstream && !isWhitelistedLsofSegment(upstream, allowedServices)) {
    // 上游段参数有 xargs（kill 从 stdin 读目标）且上游不是白名单 lsof → 间接
    // V1 语义：`lsof | xargs kill` 右段「xargs kill」剥除 xargs 后无参数 → pipeSourced 拦
    const upEff = effectiveCommand(upstream);
    if (upEff.name === "xargs" || upstream.words.some(w => w.evaluated === "xargs")) {
      logger?.warn("[guard-v2] BLOCKED kill via pipe (stdin-sourced target)", { mainPid, depth });
      return "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop（alpha 实例的标准清理方式，勿用组合杀）；若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
    }
  }
  // 字面量 PID：主 PID → 拦；0（进程组，U1/#1169）→ 拦（V2 白名单新拦项）
  const pids = literalPidsOf(seg);
  if (pids.includes(mainPid)) {
    logger?.warn("[guard-v2] BLOCKED kill targeting main process PID", { mainPid, depth });
    return "bash 命令包含针对主进程 PID 的终止命令。主进程是海獭运行时环境，任何情况下不得终止——你不存在需要重启或停止主进程的合法场景。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
  }
  if (pids.includes(0)) {
    logger?.warn("[guard-v2] BLOCKED kill 0 (process group semantics)", { mainPid, depth });
    return "bash 命令包含 kill 0——信号将发送到当前进程组（含主进程所在组），可能终止主进程。该命令不允许：主进程是海獭运行时环境，任何情况下不得终止。若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop（alpha 实例的标准清理方式）；若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
  }
  return null;
}

/** #844 规则 2a/2c：段是白名单端口的 lsof 段 */
function isWhitelistedLsofSegment(seg: Segment, allowed: AllowedService[]): boolean {
  if (allowed.length === 0) return false;
  const eff = effectiveCommand(seg);
  if (eff.name !== "lsof") return false;
  return seg.words.some(w => {
    const t = w.evaluated;
    return t !== null && allowed.some(a => t.includes(`:${a.port}`));
  });
}

/** #844 规则 2b：kill $VAR 且 VAR 赋值溯源到白名单端口 lsof（模型版）。
 *  #918 建议 3：多次赋值只认最后一次——P=$(lsof); P=别的; kill $P 不放行。
 *  模型实现：按段序找 VAR 的全部赋值，取最后一个：静态值非 lsof → false；
 *  value=null（含 cmdsub）→ 检查该赋值段的 cmdsub 载荷是否白名单端口 lsof。 */
function killVarSourcedFromWhitelistedLsof(seg: Segment, model: CommandModel, allowed: AllowedService[]): boolean {
  if (allowed.length === 0) return false;
  // kill 段参数里的 var 名（排除位置参数/特殊变量）
  const varNames: string[] = [];
  for (const w of seg.words.slice(1)) {
    for (const p of w.parts) {
      if (p.type === "var") {
        const m = /^\$\{?([A-Za-z_]\w*)/.exec(p.text);
        if (m && /^[A-Za-z_]/.test(m[1])) varNames.push(m[1]);
      }
    }
  }
  if (varNames.length === 0) return false;
  for (const v of varNames) {
    // 按段序收集 VAR 的全部赋值，取最后一次
    let lastSegIdx = -1;
    let lastValue: string | null = null;
    for (let idx = 0; idx < model.segments.length; idx++) {
      for (const a of model.segments[idx].assignments) {
        if (a.name === v) { lastSegIdx = idx; lastValue = a.value; }
      }
    }
    if (lastSegIdx === -1) continue;
    if (lastValue !== null) continue; // 最后一次赋值是静态值（非 lsof cmdsub）→ 不放行
    // value=null：赋值含展开——检查该段赋值词的 cmdsub 载荷是否白名单端口 lsof
    const assignSeg = model.segments[lastSegIdx];
    const cmdsub = assignSeg.assignWords.flatMap(w => w.parts.filter(p => p.type === "cmdsub").map(p => p.text));
    if (cmdsub.some(cs => /\blsof\b/.test(cs) && allowed.some(a => cs.includes(`:${a.port}`)))) {
      return true;
    }
  }
  return false;
}

// ────────────────────────────── 全命令级判定（模型版） ──────────────────────────────

/** 管道到 shell（V1 checkCommandLevelPatterns 第 2 条模型版）：
 *  管道右段 argv0 ∈ {sh,bash,zsh} 且上游段（任一）含 kill 词元（命令位） */
function judgePipeToShell(model: CommandModel, mainPid: number, logger: Logger | undefined): string | null {
  for (let i = 1; i < model.segments.length; i++) {
    const seg = model.segments[i];
    if (seg.joiner !== "|") continue;
    const eff = effectiveCommand(seg);
    const bare = eff.name?.split("/").pop();
    if (bare && SHELL_INTERPRETERS.has(bare)) {
      // 上游任一段（含递归载荷）含 kill 命令位词元
      const upstream = model.segments.slice(0, i);
      const upstreamKill = upstream.some(s => isKillSegmentQuick(s)) || model.payloads.some(p => payloadHasKill(p));
      if (upstreamKill) {
        logger?.warn("[guard-v2] BLOCKED pipe-to-shell with kill content", { mainPid });
        return "bash 命令通过管道传入 shell 执行且包含终止进程操作，可能针对主进程。该命令不允许：主进程是海獭运行时环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
      }
      // 解码器上游（D5 矩阵 #9）：F20260928grv2-V2 双向锁回退——解码器中转拦截不在
      // 搭档拍板的 V2 白名单内（V1 PoC-8 用例断言放行），本层不拦，记入特性文档
      //「已知边界」待独立 issue 处置。
    }
  }
  return null;
}

/** 段快速判定：是否 kill 命令位（含 wrapper 剥除） */
function isKillSegmentQuick(seg: Segment): boolean {
  const { name } = effectiveCommand(seg);
  if (name === null) return false;
  const bare = name.includes("/") ? name.split("/").pop()! : name;
  return KILL_NAMES.has(bare) || PKILL_NAMES.has(bare);
}

/** 载荷（递归）含 kill 命令位 */
function payloadHasKill(p: Payload): boolean {
  if (p.model === null) return true; // 载荷不可知 → 保守按有（调用方拦）
  return p.model.segments.some(s => isKillSegmentQuick(s)) || p.model.payloads.some(sp => payloadHasKill(sp));
}

/** U5：bash <file> / bash file.sh 从文件读脚本（V2 白名单新拦项——保守拦+提示改写） */
function judgeBashFileScript(model: CommandModel, mainPid: number, logger: Logger | undefined): string | null {
  for (const seg of model.segments) {
    const eff = effectiveCommand(seg);
    const bare = eff.name?.split("/").pop();
    if (!bare || !SHELL_INTERPRETERS.has(bare)) continue;
    // 形态 1：< 重定向（bash < file.sh）
    const stdinRedir = seg.redirects.find(r => r.op === "<" || r.op === "<<" || r.op === "<<<");
    if (stdinRedir && stdinRedir.target && /\.(sh|bash)$/.test(stdinRedir.target)) {
      logger?.warn("[guard-v2] BLOCKED bash reading script from file (stdin)", { mainPid, target: stdinRedir.target });
      return "bash 命令从文件读取脚本执行（bash < file）——脚本内容未经守卫逐条判定，绕过面不可接受。该命令不允许：请改写为直接命令形态（把脚本内容拆成独立命令执行），或在 worktree 内以隔离实例验证。若确认此命令本意安全（脚本内容是纯只读操作），请改用保持原语义的不含敏感字样的方式达成目的；无法规避时告知搭档人工执行。";
    }
    // 形态 2：位置参数 .sh（bash file.sh）
    const shArg = eff.args.find(a => a !== null && /\.(sh|bash)$/.test(a));
    if (shArg) {
      logger?.warn("[guard-v2] BLOCKED bash script file argument", { mainPid, target: shArg });
      return "bash 命令从文件读取脚本执行（bash file.sh）——脚本内容未经守卫逐条判定，绕过面不可接受。该命令不允许：请改写为直接命令形态（把脚本内容拆成独立命令执行），或在 worktree 内以隔离实例验证。若确认此命令本意安全（脚本内容是纯只读操作），请改用保持原语义的不含敏感字样的方式达成目的；无法规避时告知搭档人工执行。";
    }
  }
  return null;
}

// ────────────────────────────── 主入口 ──────────────────────────────

/** 判定层 v2 主入口：模型判定。返回拦截文案或 null。
 *  caller 负责：parseOk=false 时走 V1 兜底链（本函数不兜底——D3 分层）。 */
export function checkWithModel(
  command: string,
  mainPid: number,
  logger?: Logger,
  allowedServices: AllowedService[] = [],
): string | null {
  const model = parseOnce(command);
  // U5（bash 文件脚本）——不依赖 parseOk 的段级判定（段存在即可判）
  const bashFile = judgeBashFileScript(model, mainPid, logger);
  if (bashFile) return bashFile;
  // 管道到 shell / 解码器中转
  const pipeShell = judgePipeToShell(model, mainPid, logger);
  if (pipeShell) return pipeShell;
  // kill 段逐段判定
  for (const seg of model.segments) {
    const r = judgeKillSegment(seg, model, mainPid, logger, allowedServices, 0);
    if (r) return r;
  }
  // 递归载荷内的 kill 段（bash -c 载荷/cmdsub/heredoc 裸定界——继承判定，含 U1 kill 0）
  for (const p of model.payloads) {
    if (p.kind === "heredoc-quoted") continue; // 引号定界 heredoc 体=绝对数据（#1171 误伤面归零的核心）
    if (p.model === null) {
      // 载荷不可知（深度超限/未闭合）：载荷文本含 kill 词样 → 保守拦（D2/D3）。
      // 注意：引号定界 heredoc（数据）已在上方 continue，不会进这里。
      if (/\b(?:kill|skill|pkill|killall)\b/i.test(p.raw)) {
        logger?.warn("[guard-v2] BLOCKED unparseable payload containing kill tokens", { mainPid, kind: p.kind });
        return "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop（alpha 实例的标准清理方式，勿用组合杀）；若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
      }
      continue;
    }
    for (const seg of p.model.segments) {
      const r = judgeKillSegment(seg, p.model, mainPid, logger, allowedServices, p.depth);
      if (r) return r;
    }
    // 载荷内的嵌套载荷
    for (const np of p.model.payloads) {
      if (np.model === null && /\b(?:kill|skill|pkill|killall)\b/i.test(np.raw)) {
        logger?.warn("[guard-v2] BLOCKED nested unparseable payload containing kill tokens", { mainPid, kind: np.kind });
        return "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop（alpha 实例的标准清理方式，勿用组合杀）；若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
      }
    }
  }
  return null;
}

/** parseOk 判定辅助（入口层用） */
export function modelParseOk(command: string): boolean {
  return parseOnce(command).parseOk;
}

// 保留 loadAllowedServicePorts 引用（入口层热加载；本模块签名对齐 V1 调用链）
export { loadAllowedServicePorts };

// ────────────────────────────── cd 豁免（主仓写检测 #1170 根治） ──────────────────────────────

/** 主仓写检测 v2（F20260928grv2）：模型版 cd 链。
 *  #1170 根因：hasRealCdSegment 对全命令检测管道/分号（`| tail` 纯输出截取杀豁免）。
 *  模型版：段级 cd 链——首段链（&& 链）上的 cd 生效；管道右段/分号新段不影响
 *  cd 豁免（管道右段在子进程、分号段继承 cwd——shell 语义）。
 *  cd 目标可静态求值且非主仓 → 豁免；目标含展开不可求值 → 不豁免（保守，与 V1
 *  「引号假 cd 不豁免」同向）。 */
export function modelCdExemption(command: string, v1Fallback: (c: string) => boolean): boolean {
  const model = parseOnce(command);
  if (!model.parseOk) return v1Fallback(command); // 解析失败回 V1 判定（保守侧一致）
  // 找首段链上的 cd：从段 0 开始沿 && 链前进，遇 cd 则解析目标；遇非 cd 命令段则停。
  // 关键 shell 语义（V1 行为保持）：cd 段自己被 & 后台化或 | 管道化时，cd 只影响
  // 子 shell——父 shell cwd 不变，后续段落主仓 → 不豁免。判定：cd 段的「下游
  // joiner」（它到下一段的连接符）是 & 或 | 时不豁免。
  let i = 0;
  while (i < model.segments.length) {
    const seg = model.segments[i];
    // 跳过纯赋值段（W=/path; cd $W 的赋值段）——赋值段不改变 shell 状态
    if (seg.words.length === 0 && seg.assignments.length > 0) {
      // 赋值段与 cd 段的连接符：; 或 && 都不影响（赋值不建子 shell）——继续沿链
      i++;
      continue;
    }
    // 首段前的 joiner 必须是 ""/&&/;/\n（语句序）——管道右段/后台段不是首段链位置
    if (seg.joiner === "|" || seg.joiner === "&" || seg.joiner === "|&") break;
    const eff = effectiveCommandOfSegment(seg);
    if (eff === "cd") {
      // cd 段自身被后台化/管道化（它的下游连接符是 & 或 |）→ cd 只在子 shell 生效，不豁免
      const nextJoiner = i + 1 < model.segments.length ? model.segments[i + 1].joiner : "";
      if (nextJoiner === "&" || nextJoiner === "|") return false;
      // cd 目标求值：静态词直接用；单变量引用 → 同命令赋值段溯源（F20260924gfpn #5：
      // W=/repo; cd $W && git commit 的 $W 溯源到赋值）；多次赋值只认最后一次（#918）
      const targetWord = seg.words[1];
      let target = targetWord?.evaluated ?? null;
      if (target === null && targetWord && targetWord.parts[0]?.type === "var"
          && targetWord.parts.slice(1).every(p => p.type === "lit" || p.type === "escape")) {
        // 首 part 变量 + 尾部静态拼接（$W/.otter/worktrees/x）：溯源赋值后拼接尾部
        const varName = /^\$\{?([A-Za-z_]\w*)/.exec(targetWord.parts[0].text)?.[1];
        if (varName) {
          const assigns = model.segments.flatMap(s => s.assignments).filter(a => a.name === varName && a.value !== null && a.value !== "");
          if (assigns.length > 0) {
            const tail = targetWord.parts.slice(1).map(p => p.type === "escape" ? (p.text.length === 2 ? p.text[1] : "") : p.text).join("");
            target = assigns[assigns.length - 1].value! + tail;
          }
        }
      }
      // 溯源后仍含展开（$/…）→ 不可静态求值 → 不豁免（保守）
      if (target !== null && target !== "" && target !== "." && !/[$`]/.test(target)) return true;
      return false;
    }
    break; // 非 cd 命令段 → 无豁免
  }
  return false;
}

/** 段的裸命令名（剥 wrapper），供 cd 链判定 */
function effectiveCommandOfSegment(seg: Segment): string | null {
  let words = seg.words;
  let guard = 0;
  while (words.length > 0 && guard++ < 8) {
    const w0 = words[0].evaluated;
    if (w0 !== null && WRAPPER_WORDS_FOR_WRITE.has(w0)) {
      words = words.slice(1);
      if (words.length > 0) {
        const w1 = words[0].evaluated;
        if (w1 !== null && (/^[-]/.test(w1) || /^\d+$/.test(w1) || /^[A-Za-z_]\w*=/.test(w1))) {
          words = words.slice(1);
        }
      }
      continue;
    }
    break;
  }
  return words[0]?.evaluated ?? null;
}

/** 写检测的 wrapper 词表（与 guard-model-judge 同族，这里只列写检测关心的） */
const WRAPPER_WORDS_FOR_WRITE = new Set(["sudo", "env", "nohup", "command", "nice", "watch", "exec", "time", "timeout"]);
