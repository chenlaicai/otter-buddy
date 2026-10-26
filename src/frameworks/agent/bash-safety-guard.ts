/**
 * Bash 命令安全守卫（F20260830bsgr）。
 * 宪法：docs/designs/bash-guard-constitution.md——改本文件行为 的 PR 必答三问
 * （挂哪层/carve-out/退役条件），新规则必须挂靠五层之一，见宪法「生长规则」。
 *
 * 防止 LLM 通过 bash 工具直接 kill 主进程 PID。
 * 8/30 事故根因：小獭 7708a033 在开发任务中执行 `kill 42877` 直接杀了主进程。
 *
 * 对抗 LLM 自适应变形设计（F20260830bsgr-r2，对抗审视修正）：
 * - 字面量黑名单必输：LLM 可用变量、$()、反引号、xargs、base64、eval 绕过
 * - 翻转策略：非字面量 kill 目标保守拦截，字面量 kill 精确匹配
 * - 每次检查实时读 PID 文件（不缓存，支持热重启换 PID）
 */

/* eslint-disable max-lines -- V1 判定链保留（fail-closed 兜底）+ V2 路由共存期 */
import fs from "fs";
import path from "path";
import type { Logger } from "@usecases/ports/logger";
import { loadAllowedServicePorts, extractWhitelistedPortRefs, type AllowedService } from "./allowed-service-ports";
import { shouldSanitizeForScan, sanitizeQuotedText, stripQuotedTextSpans, stripHeredocPayloads, extractHeredocSpans } from "./quoted-text-sanitizer";
import { findKillSegments, isKillAtCommandPosition } from "./kill-segment-finder";
import { INDIRECT_KILL_BLOCK_MSG, PKILL_BYNAME_BLOCK_MSG } from "./kill-block-messages";

/** F20260928slan：sleep 命令位置判定——复用 kill-segment-finder 的位置感知
 * （isKillAtCommandPosition 对任意 pattern 通用，sleep 词元复用同一套位置白名单） */
const isCommandPositionFor = (text: string, pattern: RegExp): boolean => isKillAtCommandPosition(text, pattern);
import { checkWithModel, modelParseOk } from "./guard-model-judge";
import { parseOnce } from "./command-model";
import type { Segment } from "./command-model";
import { extractGitAliasShell, gitWriteSubcommandHit, SCRIPT_RUNNERS, GIT_VALUE_FLAGS, WRAPPER_SPECS, tokenBasename, skipWrapperArgs, resolveExecHead, isStdinFeedRest, FIND_EXEC_LEADS, findExecVerbAt } from "./payload-extract-aux";
import { evaluateWriteVerdict } from "./write-verdict";
import { segmentStdoutContent, evalInterpreterStdinBody, gitCrawlInfo } from "./write-target-evaluator";
import { joinNoFold, safeRealpath, safeRealpathParent } from "./fs-realpath";

export type { AllowedService };

/** F20261014cwsp S1 处置：session 工作目录跨特性判定参数打包（max-params 约束——
 *  sessionCwd 引入后 V1 链各函数参数面 +1，与 MainCheckoutWriteCtx/HeredocJudgeCtx
 *  同先例打包）。调用点构造一次、全链透传；独立字段读比打包对象读更直观处
 *  （如 projectRoot 单独参与白名单加载）调用方自行解构。 */
interface GuardCwdCtx {
  /** 主仓根绝对路径（守卫锚点：PID 文件/白名单/落点判定基准） */
  projectRoot?: string;
  /** session 工作目录（invoke 时的对话工作区）——落点判定的 cwd 语义基准 */
  sessionCwd?: string;
  /** F20261016gsbx 二期 2b：沙箱接防时="file-write"——main_write 文件写族退役（G3 枚举表） */
  writeChannelSkip?: "file-write";
}

/** 守卫放行判定输入（#844）：projectRoot 用于定位白名单文件 */
export interface GuardOptions {
  projectRoot?: string;
  /** F20261014cwsp：session 工作目录（invoke 时的对话工作区）。
   *  统一工作区后獭 bash cwd=工作区，data 破坏/主仓写判定的相对路径解析基准
   *  必须从 projectRoot（恒=主仓）换成本值，否则未 cd 的工作区命令被误拦。 */
  sessionCwd?: string;
  /** F20261016gsbx 二期 2a/2b：沙箱 spawnHook 真实挂载决策（session 创建点绑定，R-2b）——
   *  true 时守卫 main_write 文件写族退役（沙箱 deny file-write* 物理接防）；
   *  不可用/未绑定（readOnly 合成会话）→ 写面回位（降级不降安全）。 */
  sandboxGuarded?: boolean;
}

/** 读取主进程 PID 文件，返回 PID 或 null。每次调用都读文件（不缓存）。 */
export function readMainProcessPid(projectRoot: string): number | null {
  try {
    const pidFile = path.join(projectRoot, ".otter-buddy.pid");
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

// ─── 危险命令模式匹配 ───

const OTTER_PROCESS_PATTERNS = [
  "otter-buddy", "otter_buddy",
  "node.*main", "dist/src/main", "dist/src/main.js",
  "dist/src", "node.*dist", ".otter-buddy.pid",
  "main.js", // pkill -f main.js 等直接按文件名搜索
  "node", // killall node 会杀所有 node 进程包括 otter-buddy 主进程
];

/** 非字面量 kill 目标模式：变量、命令替换、管道、特殊字符 */
const INDIRECT_PID_PATTERNS = [
  /\$[{(a-zA-Z_]/, // $VAR / $(cmd) / ${VAR}
  /`[^`]*[\s|;&><][^`]*`/, // `cmd arg` 反引号命令替换（要求含空格/管道/重定向等命令特征，排除 markdown 单词代码块如 `skill`）
  /\|.*\bkill\b/, // 管道到 kill（如 ... | xargs kill）
  /xargs\b[^|;&]*\bkill\b/, // xargs kill（容忍 xargs 与目标间的参数，如 xargs -n1 kill）
  /\beval\b/, // eval 包装
  /\\x[0-9a-f]{2}/i, // hex 转义
  /\$\(cat\b.*pid/i, // $(cat ...pid)
  /cat\b.*\.otter-buddy\.pid.*kill/i, // cat pid file → kill
];

/** .otter-buddy.pid 文件引用模式 */
const PID_FILE_REFERENCE = /\.otter-buddy\.pid/;

/** F20260917alph 端口语义声明（纯注释，无放行逻辑）：3100-3198 偶数段是
 *  scripts/alpha.sh 的 alpha 验证实例专用段（worktree 隔离实例，独立数据根
 *  ~/.otter/alpha/<hash>，独立 config 副本）。守卫对该段的组合杀形态
 *  （kill $(lsof -ti :3102) 等）现状仍拦——alpha 清理的正道是 alpha.sh stop
 *  （锁文件持有 PID）；兜底是 lsof 查 PID 后字面量 kill <pid>（字面量不拦）。
 *  未来若要给该段加静态放行，应走 .otter/allowed-service-ports.json 白名单
 *  机制扩展，不要在守卫里加端口段放行逻辑（详见 F20260917alph 方案四）。 */

/** F20260916gsrd：主服务管理脚本调用模式（自杀命令清单）。
 *  9/16 事故：獭执行 `./scripts/otter-buddy.sh restart` 杀掉主进程 31385——字面不含
 *  kill 词元，完全在 kill 族检测视野外。脚本内部 stop→kill -15 主 PID，restart 再拉起，
 *  搭档感知为「全场停摆又自恢复」。覆盖形态：相对/绝对/波浪线路径、bash|sh 显式解释器、
 *  sudo 包装、stop|restart 子命令（start/status/logs 不拦）。
 *  F20260916gtlr：判定逻辑迁移至 SCRIPT_PATH_EXTRACT（捕获组版，路径词元口径一致）——
 *  本常量保留供诊断词表（locateTriggerContext「主服务脚本」）与口径参照使用。 */
const SERVICE_SCRIPT_KILL = /(?:^|[;&|`$(])\s*(?:sudo\s+)?(?:(?:bash|sh)\s+)?(?:[\w.~/-]*\/)?(?:scripts\/)?otter-buddy\.sh\s+(?:stop|restart)\b/;

/**
 * #844 白名单放行（方案 A 静态形态）：命令可静态解析为「白名单端口的监听者」为目标时放行。
 * 判定要素（全过才放行）：
 *   1. 命令含白名单端口引用（lsof -t -i:PORT / lsof -i :PORT -t 等形态）
 *   2. 每个 kill 段的目标可溯源到该端口：同段管道含 lsof:PORT（lsof … | xargs kill），
 *      或 kill 的 $VAR 在同命令内被赋值为白名单端口的 lsof 结果（P=$(lsof …:PORT); kill $P）
 *   3. 铁拦永不放行：主进程 PID 字面量 / PID 文件引用 / pkill 族 otter 特征名
 * Why 不放行 ps-grep 类（#844 变体 1）：grep 名字取 PID 无法静态绑定到端口，且模式串
 * （main.js/node）与 otter 主进程天然撞名——这类诉求引导到 lsof 形态或受控脚本。
 * 实际终止动作的 cwd/PID 级校验由 scripts/restart-service.mjs 受控执行。
 */
function whitelistedPortAllow(
  segments: { segment: string; isPkill: boolean }[],
  command: string,
  allowed: AllowedService[],
  mainPid: number,
): boolean {
  if (allowed.length === 0) return false;
  // 铁拦 ①：PID 文件引用
  if (PID_FILE_REFERENCE.test(command)) return false;
  for (const k of segments) {
    // 铁拦 ②：字面量主进程 PID
    if (extractLiteralPids(k.segment).includes(mainPid)) return false;
    // 铁拦 ③：pkill/killall 族命中 otter 特征名（按名匹配无法区分，永不放行）
    if (k.isPkill && pkillTargetsOtter(k.segment)) return false;
  }
  const portHits = extractWhitelistedPortRefs(command, allowed);
  if (portHits.length === 0) return false;
  // 完整分段序列（含非 kill 段）——规则 2c 需要在原始邻接关系中找 lsof 左邻段
  const allSegments = command.split(/&&|\|\||[;&|\n]/).map(s => s.trim()).filter(Boolean);
  return segments.every(k => {
    const seg = k.segment;
    if (!/\b(?:kill|skill|pkill|killall)\b/.test(seg)) return true; // 非 kill 段不参与
    // 规则 2a：同段管道含 lsof + 端口引用（lsof -i :3100 -t | xargs -n1 kill 同段形态）
    if (/\blsof\b/.test(seg) && portHits.some(p => seg.includes(`:${p}`))) return true;
    // 规则 2c：管道右段 kill 的左邻段是白名单端口 lsof（| 切段后跨段溯源。
    // killSegments 只含 kill 段，左邻 lsof 段不在其中——必须在完整分段序列里找邻接）
    const rawIdx = allSegments.indexOf(seg);
    if (rawIdx > 0) {
      const prev = allSegments[rawIdx - 1];
      if (/\blsof\b/.test(prev) && portHits.some(p => prev.includes(`:${p}`))) return true;
    }
    // 规则 2b：kill 目标变量在同命令内被赋值为白名单端口的 lsof 结果
    const vars = [...seg.matchAll(/\$([A-Za-z_]\w*)/g)].map(m => m[1]);
    // #918 检视建议 3：多次赋值只认「最后一次」——P=$(lsof :3100); P=别的; kill $P
    // 不能因首次赋值合法而放行（取最后赋值点，其后不允许再对该变量重赋值）
    const provenance = vars.some(v =>
      portHits.some(p => {
        const assign = new RegExp(`\\b${v}\\s*=\\s*\\$\\(\\s*lsof[^)]*:${p}\\b`, "g");
        const matches = [...command.matchAll(assign)];
        if (matches.length === 0) return false;
        const last = matches[matches.length - 1];
        const lastAssignEnd = (last.index ?? 0) + last[0].length;
        const reassign = new RegExp(`\\b${v}\\s*=`);
        return !reassign.test(command.slice(lastAssignEnd));
      }),
    );
    return provenance;
  });
}

/**
 * F20260831aksp §2c：检测前归一化——塔死引号拼接/字母间反斜杠的文本规避通道。
 * `ki''ll 123` / `k\ill 123` 归一化后命中 kill 正则。只影响检测，不改日志留存（日志记原始命令）。
 */
export function normalizeForDetection(command: string): string {
  const stripped = command
    .replace(/''/g, "")   // 空单引号对（shell 空串拼接）
    .replace(/""/g, "");  // 空双引号对
  // 字母间反斜杠（k\ill → kill）。lookbehind/lookahead 只匹配反斜杠本身、前后字母不消耗——
  // 单遍即可处理连续转义 k\i\ll → kill（检视 R1 发现2：贪婪消耗式正则会漏连续转义形态）
  const deEscaped = stripped.replace(/(?<=[a-zA-Z])\\(?=[a-zA-Z])/g, "");
  // #850 严重 1：全词引号包裹等价裸命令（'kill' 42877 / "kill" 42877）——剥词周引号
  // #850 严重 2：词首反斜杠是 no-op（\kill ≡ kill，bash 引用单字符语义）——剥字母前反斜杠
  return deEscaped
    .replace(/(["'])([a-zA-Z][a-zA-Z0-9]*)\1/g, "$2") // 'kill' → kill（全词引号）
    .replace(/\\(?=[a-zA-Z])/g, ""); // \k → k（词首反斜杠；字母间已在上一步处理）
}

/**
 * 检查 kill 段是否有非字面量 PID 目标。
 * 非字面量 = 变量引用 / 命令替换 / 管道 / eval / hex 转义
 * #1154 r1（S3）：xargs 剥除仅限「无 stdin 来源」形态——管道上游（|）或命令替换
 * $(...)/`...` 存在时 kill 目标来自外部输入（属间接，不剥，lsof | xargs kill
 * 拦截面保留）；裸 xargs kill 无输入来源，剥除后走字面量判定与裸 kill 语义一致。
 */
function hasIndirectPidTarget(segment: string, pipeSourced = false): boolean {
  if (pipeSourced) {
    // 上游 stdin 即间接来源——xargs 剥除禁用（剥除会让 `lsof | xargs kill` 的右段
    // 「xargs kill」剥成空串放行，发现 1 实证）；`kill $P` 等形态按常规模式判定。
    if (/xargs\b[^|;&]*\bkill\b/i.test(segment)) return true;
    return INDIRECT_PID_PATTERNS.some(pat => pat.test(segment));
  }
  if (/[|`]|\$\(/.test(segment)) {
    return INDIRECT_PID_PATTERNS.some(pat => pat.test(segment));
  }
  const stripped = segment.replace(/xargs\b[^|;&]*\bkill\b/i, "");
  return INDIRECT_PID_PATTERNS.some(pat => pat.test(stripped));
}

/**
 * 提取 kill 命令参数中的字面量数字 PID 列表。
 * 仅返回纯数字参数（非负整数），跳过信号参数（-N、-SIGTERM 等）。
 * F20260903gh698：去引号——bash -c 'kill 42877' 中 PID 被引号包裹，需先去引号再解析。
 */
function extractLiteralPids(segment: string): number[] {
  const pids: number[] = [];
  // 去掉命令名部分，只看参数
  const afterCmd = segment.replace(/^.*?\b(?:kill|skill)\b\s*/, "");
  const words = afterCmd.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (w.startsWith("-")) continue; // 跳过信号参数
    // #777：去引号外再去子 shell 括号（`(kill 42877)` 的 PID 带右括号尾，parseInt 前剥除）
    const stripped = w.replace(/^["']|["']$/g, "").replace(/^[()]+|[()]+$/g, "");
    const pid = parseInt(stripped, 10);
    if (!isNaN(pid) && pid > 0 && String(pid) === stripped) pids.push(pid);
  }
  return pids;
}

/**
 * 检查 pkill/killall 命令是否可能命中 otter 主进程。
 * 检查 -f/-n 参数值和位置参数中的关键词。
 * F20260903gh698：改用 word-boundary 正则——lower.includes("node") 会误匹配 "ffmpeg" 中的子串 "node"。
 */
function pkillTargetsOtter(segment: string): boolean {
  // #1154 r1（S3）：剥 shell 注释再判定——`-f myapp # node` 的 `# node` 是注释
  // 不是目标，不剥会让注释文本命中进程名表（node 在表内）造成误拦。
  const noComment = segment.replace(/#.*$/, "");
  const lower = noComment.toLowerCase();
  return OTTER_PROCESS_PATTERNS.some(
    pat => new RegExp("\\b" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(lower),
  );
}

/** F20260916gtlr：脚本路径提取（捕获组），与 SERVICE_SCRIPT_KILL 路径词元口径 + 前导约束一致，改动需同步。
 *  前导分组（^/操作符/命令替换位）保证只匹配命令位置——中文语境裸文本提及（echo otter-buddy.sh restart 是危险操作）不误拦。 */
const SCRIPT_PATH_EXTRACT = /(?:^|[;&|`$(])\s*(?:sudo\s+)?(?:(?:bash|sh)\s+)?((?:[\w.~/-]*\/)?(?:scripts\/)?otter-buddy\.sh)\s+(?:stop|restart)\b/gi;
// F20261015gsub 收敛：SCRIPT_REFERENCE / INDIRECT_CALL_FEATURE 随形态 2 删除而删除。

/** F20260916gtlr：脚本路径解析——相对路径基于 projectRoot（=主仓根，海獭 bash cwd 恒为主仓）resolve 并归一化。
 *  返回 true 表示解析到主仓 scripts（目标是进程1 的管理脚本）。projectRoot 缺失时保守按主仓对待。
 *  大小写归一化与 classifyDestructiveTarget 同步（同根因：macOS case-insensitive FS 漏拦）。
 *  镜像注记（M-1438463a）：`//` 前缀族词文本收编后本函数不变——path.normalize 折叠
 *  `//x`≡`/x`（node 实证），`//<主仓>/scripts/…` 形态天然同判，无旁路面。 */
function resolvesToMainCheckout(scriptPath: string, projectRoot?: string): boolean {
  if (!projectRoot) return true; // 保守退化
  if (scriptPath.startsWith("~")) return true; // ~ 不展开，保守拦截
  const resolved = path.isAbsolute(scriptPath)
    ? path.normalize(scriptPath)
    : path.normalize(path.resolve(projectRoot, scriptPath));
  return path.dirname(resolved).toLowerCase() === path.normalize(path.join(projectRoot, "scripts")).toLowerCase();
}

/** F20260922pmgd：PR 合入命令检测（独立规则）。
 *  事故锚：2026-09-22 大獭在搭档未显式授权时自行 gh pr merge 合入 #1095——
 *  纯文字规则（「PR 合入不是 LLM 执行的动作」）在流水线惯性下失效。
 *  定位：提醒 + 审计（非物理闸，搭档拍板「并不强制」）——拦截文案引导到
 *  merge_pr 工具（partnerApproval 必填搭档授权原话）。
 *  覆盖形态（与方案「第一步」一致，确定性拦截无「可选」）：
 *  ① gh pr merge <N|url> [--squash|--merge|--rebase|--auto|--admin]
 *  ② gh api .../pulls/<N>/merge -X PUT（REST 变形）
 *  ③ gh api .../repos/{owner}/{repo}/merges -X POST（REST 底层变形）
 *  不拦：gh pr close / ready / review 等其他 PR 操作（权利红线精确在 merge）。 */
const GH_PR_MERGE = /\bgh\s+pr\s+merge\b/i;
const GH_API_PULLS_MERGE = /\bgh\s+api\b[^|;&]*\bpulls\/\d+\/merge\b/i;
/** gh api 语法是 `gh api repos/{o}/{r}/merges`（路径无 leading slash）——正则写成
 *  `/repos/` 会结构性失配（检视严重 1：真实命令永远匹配不到，拦截形同虚设）。 */
const GH_API_REPOS_MERGES = /\bgh\s+api\b[^|;&]*\brepos\/[^\s"'/]+\/[^\s"'/]+\/merges\b/i;

const PR_MERGE_MSG = "bash 命令包含 gh pr merge——PR 合入是搭档专属动作（PR 后硬规则：LLM 执行 PR 创建和呈终审，合入按钮属于搭档）。请改用 merge_pr 工具，并在 partnerApproval 参数中原样引用搭档的授权原话（如搭档说「1095合入」就填那句话）。原话经机械校验：必须逐字命中搭档历史消息（短引用不足4实义字须整条等值），推断/拼接/转述会被拒绝。无授权原话不得合入；搭档尚未拍板时先呈终审简报（决策简报卡）。";

function checkPrMergeCommand(command: string, logger?: Logger): string | null {
  if (GH_PR_MERGE.test(command) || GH_API_PULLS_MERGE.test(command) || GH_API_REPOS_MERGES.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED gh pr merge (partner-gate)", { command: command.substring(0, 200) });
    return PR_MERGE_MSG;
  }
  return null;
}

/** F20260916gsrd：主服务脚本自杀命令检测（独立规则，调用点在 checkBashCommandSafetyOnText）
 *  F20260916gtlr：从全局文本拦改为主仓路径限定拦（worktree 绝对路径调用放行，脚本层兜底已删，
 *  守卫是唯一防线）。
 *  F20261015gsub 收敛：形态 2（间接调用保守拦截）删除——守卫定位从「防绕过军备竞赛」退回
 *  「常见直白形态兜底」（搭档 10/15 决策：bash 守卫永远无法百分百，物理隔离才是真正守卫）。
 *  间接形态（变量/命令替换隐藏子命令）由形态 1 字面检测 + 物理隔离兜底，不再静态保守拦。 */
function checkServiceScriptKill(command: string, mainPid: number, logger?: Logger, projectRoot?: string): string | null {
  // 形态 1：字面 stop/restart——提取全部脚本路径，任一解析到主仓 scripts 即拦；全部不在主仓（worktree 自管实例）放行
  const matches = [...command.matchAll(SCRIPT_PATH_EXTRACT)];
  if (matches.length > 0) {
    const hitsMain = matches.some((m) => resolvesToMainCheckout(m[1], projectRoot));
    if (!hitsMain) return null;
    logger?.warn("[bash-safety-guard] BLOCKED otter-buddy.sh stop/restart targeting main checkout", { mainPid, command: command.substring(0, 200) });
    return "bash 命令调用的 otter-buddy.sh 解析到主仓，其 stop/restart 会终止主进程。该命令不允许：主进程是海獭运行环境，任何形态不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；确需管理主服务时请用脚本绝对路径 + 字面子命令，由搭档人工执行；服务异常请报告搭档。";
  }
  return null;
}
// F20261015gsub 收敛：checkCommandLevelPatterns 军备规则族（eval 包装+数字 / 管道 shell kill /
// 脚本 one-liner kill）全部删除——守卫定位退回「常见直白形态兜底」（搭档 10/15 决策）。
// eval 载荷递归（judgeEvalPayload V2 层）仍保留（真执行体语义）；kill 段检测仍拦字面 PID/
// 间接目标。壳函数恒 null 避免调用点改动，后续清理。
function checkCommandLevelPatterns(): string | null {
  return null;
}

interface KillSegmentCtx {
  segment: string;
  isPkill: boolean;
  mainPid: number;
  command: string;
  logger?: Logger;
  payload?: string;
  source?: "pipe";
  outer?: string;
}

/** 检查 kill 段：pkill/killall 模式 或 kill 间接/字面量 PID */
// eslint-disable-next-line complexity -- #1154 r1：pkill/间接/PID 文件/字面量四分支各对应一条已实证形态，合并会牺牲「一形态一分支」可读性
function checkKillSegment(ctx: KillSegmentCtx): string | null {
  const { segment, isPkill, mainPid, logger, payload, source, outer } = ctx;
  // #1154 r1（S3）：载荷级命中的段，外层段文本剥离载荷后再参与判定——外层包装/
  // 传参（如 bash -c '…' "$VAR" 的 $VAR）不是 kill 目标语义的一部分，混入会把
  // 传参变量误判为间接 PID。
  const outerContext = payload ? segment.replace(payload, " ") : segment;
  // #1154 r2（N1，检视獭终局复核发现）：载荷引用位置参数（$0/$1/$@…）时外层
  // 参数绑定到载荷内引用，成为 kill 目标的一部分（`bash -c 'nohup kill $0' 42877`
  // 的 $0 绑定主 PID）——PID 判定（间接+字面量）输入换成真外层段，恢复字面主 PID
  // 拦截面；无位置参数引用时维持 r1-S3 口径（外层传参不混入，防 $VAR 误拦）。
  // pkill 进程名判定维持载荷级（r1-S3 方向正确——外层包装/注释不是目标名语义）。
  // #1154 r3（S1-r2，检视獭 r2 delta 复核发现）：位置参数引用正则改 lookahead 写法——
  // 旧写法 `\$(?:0|[1-9]\d*|@|\*)\b` 双缺陷：(a) `${0}` 花括号形态失配（$ 后紧跟 {，
  // 非数字/@/*）；(b) `@`/`*` 是非词字符，`\b` 在其后永不成立，$@/$* 分支是死代码。
  // 三种 shell 语义等价的杀主形态（`kill ${0}` / `kill $@` / `kill $*`）曾全部绕过 N1 修复。
  const refsPositional = !!outer && !!payload && /\$\{?(?:0|[1-9]\d*|@|\*)\}?(?![\w$])/.test(payload);
  const pidTextA = refsPositional ? outer : segment;
  const pidTextB = refsPositional ? segment : outerContext;
  // #1154 r1：管道右段（findKillSegments 标记 source:"pipe"）的 kill 目标来自上游
  // stdin——分段后管道符不在段文本内，语义层按「含管道」路径恢复间接来源判定。
  const pipeSourced = source === "pipe";
  if (isPkill) {
    if (pkillTargetsOtter(segment) || pkillTargetsOtter(outerContext)) {
      logger?.warn("[bash-safety-guard] BLOCKED pkill/killall targeting otter processes", { mainPid, segment: segment.substring(0, 200) });
      return PKILL_BYNAME_BLOCK_MSG;
    }
    return null;
  }
  if (hasIndirectPidTarget(pidTextA, pipeSourced) || hasIndirectPidTarget(pidTextB, pipeSourced)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill with indirect PID target", { mainPid, segment: segment.substring(0, 200) });
    return INDIRECT_KILL_BLOCK_MSG;
  }
  if (PID_FILE_REFERENCE.test(segment)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill referencing .otter-buddy.pid file", { mainPid, segment: segment.substring(0, 200) });
    return "bash 命令中终止进程的命令引用了主进程 PID 文件。主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
  }
  const pids = [...new Set([...extractLiteralPids(pidTextA), ...extractLiteralPids(pidTextB)])];
  if (pids.length > 0 && pids.includes(mainPid)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill targeting main process PID", { mainPid, commandPids: pids, segment: segment.substring(0, 200) });
    // F20260831aksp：PID 数字脱敏——堵「错误 PID 试探 → 拦截文案回显真实 PID → 精准二次打击」链（结构化日志字段 commandPids 保留数值）
    return "bash 命令包含针对主进程 PID 的终止命令。主进程是海獭运行环境，任何情况下不得终止——你不存在需要重启或停止主进程的合法场景。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
  }
  return null;
}

/**
 * 在单份文本上执行全量检测（原始与归一化文本各调一次）。
 */
/** #1038：主仓 data/ 破坏性命令检测（rm/rmdir/mv/find -delete 指向主仓运行时数据）。
 *  9/17 事故：獭在主仓 cwd 执行 `rm -rf data/metrics`（本意删 worktree 内验证数据），
 *  主仓 metrics + golden 执行历史不可恢复丢失。海獭 bash cwd 恒为主仓，相对路径
 *  data/… 一伸手就是生产数据。与 alpha 启停同款双重措施：守卫拦截（本函数）+
 *  正向脚本（alpha.sh 隔离实例，拦截文案引导）。
 *  放行面：worktree/tmp/alpha 数据根（~/.otter/alpha）等非主仓路径；只读命令不在此检测范围。
 *  已知局限（第一版，特性文档 Known Limitations 记录）：shell 重定向截断（> data/…）、
 *  路径前段 glob 变形（dat[glob]…）不覆盖——主流形态覆盖后由对抗审视评估是否补面。 */
const DATA_DESTRUCTIVE_MSG = "bash 命令对主仓 data/（运行时数据：metrics/logs/workspaces）执行了删除/移动操作。data/ 是主服务运行时数据，海獭不得直接改删：验证类操作请在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根 ~/.otter/alpha/）；需临时数据目录时用 os.tmpdir() 或 worktree 内路径；确需清理主仓数据时报告搭档人工执行（data/backups/ 有定期备份兑底）。";

/** F20261016gdfv（M-c78df9d4，宪法洞表修复）：主仓内容树破坏面文案（非 data/ 目标）。
 *  X1/X2 探针实证：主仓根/内容树的 rm 等曾 prod:ALLOW / wv:BLOCK 双层反判——
 *  data-destructive 只盖 data/，内容树目标漏拦。与 wv pathWithinMain 同口径豁免运行时区。 */
const MAIN_DESTRUCTIVE_MSG = "bash 命令对主仓内容区执行了删除/移动操作（rm/mv/find -delete 落点在主仓 git 内容树，非 data/）。主仓内容受 R1 红线保护（改动须走 worktree+PR）：请在 worktree（.otter/worktrees/）内操作；worktree 区/工作区/运行时区清理不受限；确需动主仓内容时报告搭档人工执行。";

/** 路径参数解析到主仓 data/ 下（含 data/ 本身）？
 *  cwd：相对路径的解析基准（跟踪 cd 后的当前目录）；projectRoot：主仓根（data 根的比较基准）。
 *  两者角色不同——cwd 只影响解析，主仓归属只看 projectRoot。
 *  大小写归一化：比较双侧 toLowerCase（macOS case-insensitive FS 上 `dAta/` 实际命中
 *  主仓 data/，区分大小写比较会漏拦——检视獭-1040 严重发现，修复与本函数同步应用于
 *  resolvesToMainCheckout） */
/** 破坏命令目标落点分类（F20261016gdfv，M-c78df9d4）："data"=主仓 data/（9/17 事故面）；
 *  "mainTree"=主仓内容树（git 内容区，非 data）；null=非主仓保护面。保守面（projectRoot
 *  缺失/~ 前缀/cwd 不可知）归 "data"——沿用旧 resolvesToMainData 的保守文案与语义，
 *  ~ 误拦面（GAP 键 TS-21cee677/TS-a32f51e7）另单治理不动。
 *  cwd：相对路径解析基准（跟踪 cd 后的当前目录）；大小写归一化（macOS case-insensitive FS）。 */
type DestructiveZone = "data" | "mainTree" | null;

// eslint-disable-next-line complexity -- 破坏目标落点分类形态穷举（data/内容树双域+own-ws/~ 保守面+运行时区三豁免，F20261016gdfv 目标域扩面后 17）
function classifyDestructiveTarget(target: string, cwd: string, projectRoot?: string, sessionCwd?: string): DestructiveZone {
  if (!projectRoot) return "data"; // projectRoot 缺失时保守拦截（与 resolvesToMainCheckout 同策略）
  // #1418：macOS 废纸篓正道白名单——~/.Trash 精确前缀放行（仅 mv 目的端受益；rm 源端命中时
  //  由 segmentDestructive 的 kind 判定收口，~/.Trash 作为 rm 目标本就无害）。
  //  其余 ~ 前缀仍保守拦截（~/…/otter-buddy/data 可能指向主仓，展开判不了静态安全）。
  if (target === "~/.Trash" || target.startsWith("~/.Trash/")) return null;
  if (target.startsWith("~")) return "data"; // ~ 不展开，保守拦截（~/…/otter-buddy/data 可能指向主仓）
  // 尾部 glob 剥除：data/metrics/* -> data/metrics（glob 只影响目录内容范围，不影响目录归属）
  const stripped = target.replace(/\/+$/, "").replace(/\/[*?]+$/, "");
  if (!stripped) return null;
  // 相对路径且 cwd 不可知（cd ~ 后）-> 静态无法解析，保守拦截
  if (!path.isAbsolute(stripped) && !cwd) return "data";
  const resolvedRaw = path.isAbsolute(stripped)
    ? stripped
    : joinNoFold(cwd, stripped);
  // F20261019syml（M-ed285d7c）：symlink 穿透归一——默认末分量不穿链（unlink/rename
  //  语义：rm <link> 删链本体无害放行；link 作父目录时由 dirname 侧穿链收口）；原目标
  //  带尾杠/glob（操作发生在链内，如 rm link/* 删进真实目录）时全穿链。
  const actsInside = target !== stripped;
  const resolved = actsInside ? safeRealpath(resolvedRaw) : safeRealpathParent(resolvedRaw);
  const rootLower = path.normalize(safeRealpath(projectRoot)).toLowerCase();
  const resolvedLower = resolved.toLowerCase();
  // F20261014cwsp S2/S8 处置：仅豁免**本会话工作区子树**（sessionCwd 归一化后前缀）——
  // 清自己工作区缓存放行（10/14 三连误拦实证）；整树豁免是越权面（round-2 S8）。
  // 无 sessionCwd 不豁免——守旧行为。
  if (sessionCwd && path.isAbsolute(sessionCwd)) {
    const ownWs = path.normalize(safeRealpath(sessionCwd)).toLowerCase();
    if (resolvedLower === ownWs || resolvedLower.startsWith(ownWs + path.sep)) return null;
  }
  const dataRootLower = path.normalize(safeRealpath(path.join(projectRoot, "data"))).toLowerCase();
  if (resolvedLower === dataRootLower || resolvedLower.startsWith(dataRootLower + path.sep)) return "data";
  // F20261016gdfv（M-c78df9d4）：主仓内容树补齐——X1/X2 反判的 prod 侧缺口（rm -rf 主仓根
  //  曾漏拦）。与 wv pathWithinMain 同口径豁免运行时区（OTTER_RUNTIME_REGIONS 三区）——
  //  worktree 清理/工作区操作照常放；边界同 wv（精确子树前缀，裸区目录名不豁免）。
  if (resolvedLower === rootLower || resolvedLower.startsWith(rootLower + path.sep)) {
    for (const region of ["/.otter/worktrees/", "/.otter/workforms", "/data/workspaces/"]) {
      // F20261019syml：区基同 realpath，尾杠形态逐字保持（带尾杠=仅子树）；
      // M-cf899ad2 A′（2026-10-20 拍板）：不带尾杠=本体+子树（边界匹配，仿名 sibling 不豁免）
      const regionBase = path.normalize(safeRealpath(projectRoot + region.replace(/\/+$/, ""))).toLowerCase();
      const inSubtree = resolvedLower.startsWith(regionBase + path.sep);
      const inBare = !region.endsWith("/") && resolvedLower === regionBase;
      if (inSubtree || inBare) return null;
    }
    return "mainTree";
  }
  return null;
}

/** 提取段内非 flag 路径参数（去引号，滤 flag） */
function pathArgsOf(seg: string): string[] {
  return seg.split(/\s+/).slice(1)
    .map(a => a.replace(/^["']|["']$/g, ""))
    .filter(a => a && !a.startsWith("-"));
}

/** 形态检测：段是否对主仓保护面（data/ 或内容树）执行删除/移动（cwd 为相对路径解析基准）。
 *  F20261016gdfv：目标域从 data/ 扩主仓内容树（M-c78df9d4 X1/X2 反判面）；mv 双端判定
 *  （源=主仓内容被移走，目标=移入主仓——旧版只查源，mv 入主仓曾双层反判）。 */
function segmentDestructive(seg: string, cwd: string, projectRoot?: string, sessionCwd?: string): { kind: string; zone: DestructiveZone } {
  const zoneOf = (args: string[]): DestructiveZone => {
    let z: DestructiveZone = null;
    for (const a of args) {
      const t = classifyDestructiveTarget(a, cwd, projectRoot, sessionCwd);
      if (t === "data") return "data"; // data 面优先（更严文案）
      if (t === "mainTree") z = "mainTree";
    }
    return z;
  };
  if (isKillAtCommandPosition(seg, /\br(?:m|mdir)\b/)) {
    return { kind: "rm", zone: zoneOf(pathArgsOf(seg)) };
  }
  if (isKillAtCommandPosition(seg, /\bmv\b/)) {
    return { kind: "mv", zone: zoneOf(pathArgsOf(seg)) };
  }
  if (isKillAtCommandPosition(seg, /\bfind\b/)) {
    // M-48ac4e39（词表补齐族单 B）：find 执行体破坏词表缺口——-exec/-execdir + rm/rmdir/mv
    //  与 -delete 同语义（对走查树批量删/移，落点=走查根 pathArgsOf 同款）；执行体泛化
    //  （任意载荷）按 #1513 口径记档不追，只收词表内破坏动词（含路径形 /bin/rm）。
    if (/(?:^|\s)-delete\b/.test(seg)) return { kind: "find -delete", zone: zoneOf(pathArgsOf(seg)) };
    // delta（检视獭1630）：执行体判定改词位（findExecVerbAt 双层同源）——-ok/-okdir 同族
    //  收（交互确认可 echo y 喂答绕过）、wrapper 剥除对称延伸（env rm）、引号整词对齐；
    //  数据位（-name '-exec rm'）不再被段文本子串误命中。tokenize 失败（未闭合引号）回退
    //  段文本正则（不弱于修复前口径，fail-closed）。
    const tokens = tokenizeSegment(seg);
    if (tokens !== null) {
      for (let i = 0; i < tokens.length; i++) {
        const lead = tokenBasename(tokens[i].text);
        if (!FIND_EXEC_LEADS.has(lead)) continue;
        if (findExecVerbAt(tokens, i + 1)) {
          return { kind: lead === "-ok" || lead === "-okdir" ? "find -ok" : "find -exec", zone: zoneOf(pathArgsOf(seg)) };
        }
      }
    } else if (/(?:^|\s)-(?:execdir|exec|okdir|ok)\s+["']?(?:\S*\/)?(?:rm|rmdir|mv)\b/.test(seg)) {
      return { kind: "find -exec", zone: zoneOf(pathArgsOf(seg)) };
    }
  }
  return { kind: "", zone: null };
}

/** #1038：主仓 data/ 破坏性操作检测。返回拦截文案或 null。
 *  cwd 跟踪：逐段扫 cd <dir> 更新当前目录，相对路径按当前 cwd 解析（
 *  `cd worktree && rm -rf data/…` 是验证正道，必须放行；子 shell / pushd 不跟踪，
 *  Known Limitations 记录）。
 *  F20261014cwsp：起始 cwd 显式入参（session 工作目录）。统一工作区后獭 bash cwd=
 *  对话工作区，不能再以 projectRoot（主仓）为解析基准——否则未 cd 的工作区相对
 *  命令（如 `rm -rf data` 清工作区缓存）解析到主仓 data/ 被误拦（10/14 三连实证）。 */
// eslint-disable-next-line complexity -- 破坏目标域分类分流（data/mainTree 两文案+豁免面）+ cd 跟踪，每分支对应一种已实证形态（F20261016gdfv 目标域扩面后 13）
function checkDataDirDestructive(command: string, logger: Logger | undefined, ctx: GuardCwdCtx): string | null {
  const segments = command.split(/&&|\|\||[;&\n]/).map(s => s.trim()).filter(Boolean);
  let cwd = ctx.sessionCwd ? path.normalize(ctx.sessionCwd) : (ctx.projectRoot ? path.normalize(ctx.projectRoot) : "");
  for (const seg of segments) {
    // 形态 0：cd 更新跟踪 cwd（后续段的相对路径基准）
    if (isKillAtCommandPosition(seg, /\bcd\b/)) {
      const target = seg.split(/\s+/)[1]?.replace(/^["']|["']$/g, "");
      if (!target || target.startsWith("~")) { cwd = ""; continue; } // ~ / 无参无法静态解析 → 后续按保守路径处理
      cwd = path.isAbsolute(target) ? safeRealpath(target) : (cwd ? safeRealpath(joinNoFold(cwd, target)) : "");
      continue;
    }
    const { kind, zone } = segmentDestructive(seg, cwd, ctx.projectRoot, ctx.sessionCwd);
    if (zone !== null) {
      logger?.warn(`[bash-safety-guard] BLOCKED ${kind} targeting main-checkout ${zone}`, { command: command.substring(0, 200) });
      return zone === "data" ? DATA_DESTRUCTIVE_MSG : MAIN_DESTRUCTIVE_MSG;
    }
  }
  return null;
}

/* eslint-disable complexity -- sleep 检测挂点（F20260928slan）新增一分支：V1 判定链原 12 分支 + sleep 检测，合并后 13——每分支对应一条已断言语义；F20261014cwsp：sessionCwd 穿透（判定基准解耦进程 cwd）参数/分支各 +1 */
/** F20261015gali（M-edd889c2）：git alias shell 展开（! 前缀）注入——载荷不可静态提取文案。 */
export const GIT_ALIAS_SHELL_OPAQUE_REASON =
  "bash 命令通过 git alias shell 展开（! 前缀）注入载荷，且载荷不可静态提取（动态/解析失败），无法静态确认其行为。该命令不允许：git alias 的 ! 前缀展开是任意 shell 执行通道。请直接执行目标命令；确需 git 别名时只用纯子命令别名（不含 ! 前缀）。";

/** F20261015gali（M-edd889c2）：载荷递归命中文案（子文案换行携带——首句只承载本规则指纹）。 */
export function gitAliasShellPayloadReason(sub: string): string {
  return `bash 命令通过 git alias shell 展开（! 前缀）执行任意载荷，载荷命中拦截：\n${sub}`;
}

/** F20261015gali（M-edd889c2，宪法 L4 bypass_guard）：git alias shell 展开（! 前缀）
 *  注入——真执行体语义（#1513 F20261015gsub 取向：内容判定而非通道封杀，与
 *  judgeEvalPayload 载荷递归同款）。`!` 前缀 alias 值是任意 shell 执行通道（git 原生
 *  语义：从仓库根以 shell 执行）——载荷提取后递归过全量文本路径规则（输入长度严格
 *  递减收敛，checkHeredocScriptBodies 同口径）；载荷可证安全→放行，动态/提取不出→
 *  fail-closed（不可证不豁免，牙3 同判据）。
 *  检出面（payload-extract-aux 单一真相源，与 v2 求值器同源）：字面 git 段的子命令前
 *  `-c alias.x=!载荷` 旗标定义位 + `config [旗标…] alias.x '!载荷'`。间接构造（env
 *  注入/包装词/整词动态 k=v）不追——#1513 拍板：物理隔离才是真守卫。
 *  双向生长自查：本规则是拆解（拆载荷交既有规则全量判定）非豁免——不新增豁免通道，
 *  放行面=载荷过既有规则判定，不豁免任何一层拦截面。
 *  挂点：checkBashCommandSafety 主流（parseOk 双路共喉）+ OnText 兜底链（mainPid 缺失
 *  路径）；递归走 checkBashCommandSafety 全量（载荷过完整规则链，输入长度严格递减收敛）。 */
function checkGitAliasShellInjection(
  text: string,
  mainPid: number,
  logger: Logger | undefined,
  guardOptions: GuardOptions | undefined,
): string | null {
  // X5（检视獭1518，「记档说一套代码做一套」第四发改齐）：heredoc 体是数据（写入文件的
  // 文本提及非定义位）——剥闭合体后扫描，与本文档承诺「heredoc 文本体不检出」一致；
  // 否则体内的 `git -c alias.x='!y'` 行被切段伪命中（写复盘/文档场景误拦）。
  for (const seg of splitShellSegments(stripHeredocPayloads(text))) {
    const model = parseOnce(seg, 1);
    for (const s of model.segments) {
      const ex = extractGitAliasShell(s);
      if (ex === null) continue;
      if (ex.kind === "opaque") {
        logger?.warn("[bash-safety-guard] BLOCKED git alias shell injection (opaque payload)", { command: seg.substring(0, 200) });
        return GIT_ALIAS_SHELL_OPAQUE_REASON;
      }
      for (const p of ex.texts) {
        const sub = checkBashCommandSafety(p, mainPid, logger, guardOptions);
        if (sub !== null) {
          logger?.warn("[bash-safety-guard] BLOCKED git alias shell injection (payload hit)", { command: seg.substring(0, 200) });
          return gitAliasShellPayloadReason(sub);
        }
      }
    }
  }
  return null;
}

function checkBashCommandSafetyOnText(
  text: string,
  mainPid: number,
  logger: Logger | undefined,
  allowedServices: AllowedService[],
  ctx: GuardCwdCtx,
): string | null {
  const { projectRoot, sessionCwd } = ctx;
  // F20260916gsrd：主服务脚本自杀命令——最优先判定（9/16 事故：otter-buddy.sh restart
  // 杀主进程，kill 族检测看不到脚本名；脚本调用语义明确，无需保守降级）
  const scriptKill = checkServiceScriptKill(text, mainPid, logger, projectRoot);
  if (scriptKill) return scriptKill;
  // F20260922pmgd + #1038：不依赖 mainPid 的独立规则（PR 合入 / data 破坏）——
  // 提前判定，两路调用链（正常 / PID 缺失）都覆盖；抽函数控圈复杂度
  const pidFree = checkPidIndependentRules(text, logger, ctx);
  if (pidFree) return pidFree;
  // F20261015gali（M-edd889c2）：git alias shell 展开注入——真执行体载荷拆解
  //（宪法 L4 bypass_guard：与「脚本文件执行必须拆解」同款语义；载荷递归走本函数
  // 全量规则，输入长度严格递减收敛）
  const aliasHit = checkGitAliasShellInjection(text, mainPid, logger, { projectRoot, sessionCwd });
  if (aliasHit) return aliasHit;
  // #1207 delta r1：heredoc 体级判定挂进 V1 OnText 链（检视严重 2b 修正——初版
  // 漏挂致未闭合 node heredoc 体 process.kill 主 PID 放行）。入口已剥闭合体的输入
  // 在此 extractHeredocSpans 只命中空白体 → 自然 no-op；未闭合（fail-closed 保留
  // 原文）时体在场 → 白名单判定生效。与 shell 体递归互调按输入长度严格递减收敛。
  const bodyHit = checkHeredocScriptBodies(text, { mainPid, logger, allowedServices, projectRoot, sessionCwd });
  if (bodyHit) return bodyHit;
  // F20260928slan：裸 sleep 静默等待检测——独立于 kill 域（感知问题非安全问题），
  // 命中返回带 SLEEP_REASON_PREFIX 标记的文案，出口处由 checkBashCommandSafety 剥离标记
  const sleepBlock = checkSleepCommand(text, logger, { isCommandPosition: isCommandPositionFor });
  if (sleepBlock) return sleepBlock;
  // F20261015gsub：cmdLevel 军备规则已删（壳函数恒 null），调用点保留占位。
  const cmdLevelResult = checkCommandLevelPatterns();
  if (cmdLevelResult) return cmdLevelResult;

  const killSegments = findKillSegments(text);
  // #844 白名单放行：cmdLevel 检测之后、分段级检测之前（cmdLevel 是全命令级铁闸，
  // 白名单只豁免「分段级 kill 目标检测」这一层）
  if (killSegments.length > 0 && whitelistedPortAllow(killSegments, text, allowedServices, mainPid)) {
    return null;
  }
  if (killSegments.length === 0) return null;

  // 全命令级：有 kill 段 + 全命令含 .otter-buddy.pid 引用（跨段检测）
  if (PID_FILE_REFERENCE.test(text)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill with cross-segment PID file reference", { mainPid, command: text.substring(0, 200) });
    return "bash 命令中包含主进程 PID 文件引用和终止进程操作，可能针对主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }

  for (const { segment, isPkill, payload, source, outer } of killSegments) {
    const result = checkKillSegment({ segment, isPkill, mainPid, command: text, logger, payload, source, outer });
    if (result) return result;
  }
  return null;
}

/** 命中规则定位（F20260902gvrd，#730）：拦截文案从静态说明升级为带诊断上下文。
 *  扫描命令中命中各高危词表的子串，返回「规则名 × 片段 × 位置」行。
 *  只做诊断回显，不参与拦截判定——拦截逻辑本身不变。 */
function locateTriggerContext(command: string, mainPid: number | null): string[] {
  const hits: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ["kill 族命令", /\b(?:sudo\s+)?(?:\/usr\/(?:local\/)?bin\/)?(?:p?kill|skill|killall5?|pgrep)\b/gi],
    ["主服务脚本", new RegExp(SERVICE_SCRIPT_KILL.source, "gi")],
    ["eval 引用", /\beval\b/gi],
    ["PID 文件引用", /\.otter-buddy\.pid/g],
    // F20261019f714（M-f7148deb 第 3 条）：收窄到真实进程名语义——紧邻 `/` 的匹配是
    // 路径型 token（/…/otter-buddy/…、…/dist/src/main.js）不是进程名，不参与回显。
    // J3 补充（F20261022j2j3）：旧实现 (?<!\/) 只挡绝对路径邻接，相对路径形态
    // `dist/src/main`（d 前是空格）仍命中。曾尝试可变宽 lookbehind `(?<![^\s/]*\/)`
    // 表达「token 含 / 不标」，但该写法与 (?<!\/) 等价——`[^\s/]*` 字符类本身排除
    // `/` 跨不过 `/`，数学上只够到紧邻字符，达不到预期（#1620 审视纠错：是正则
    // 写错，非 V8 缺陷；正确写法 `(?<![^\s]*\/[^\s]*)` 可达目标语义）。改为执行期
    // token 判定：正则原样匹配，命中后检查匹配片段或 token 前缀段（同空白分隔 token
    // 内、起点之前的部分）含 / 则跳过，语义即建议的「token 含 / 一律不标」；执行期
    // 判定较 lookbehind 更直白可控（诊断面粒度允许），不误伤真实进程名形态。
    // 该模式仅做诊断回显、不参与拦截判定（locateTriggerContext 注释在案；F20260924gfpn
    // 曾实测证伪同名「第五缺陷」误判），但回显误标曾连续误导两次根因归因——路径命中
    // 不再挂「进程名模式」标签；kill/pkill 目标语义的判定在 kill-segment 通道，不受此改影响。
    ["进程名模式", /(?<!\/)\b(?:otter-buddy|otter_buddy|dist\/src\/main|main\.js|node)\b(?!\/)/g],
  ];
  for (const [name, pat] of patterns) {
    const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g");
    let m: RegExpExecArray | null;
    // F20260923glay：同类命中只取首条 + 计数（路径类命中一拦 5-6 段长路径无信息量，刷屏）
    let typeCount = 0;
    let firstSnippet = "";
    let firstIndex = 0;
    while ((m = re.exec(command)) !== null && hits.length < 6) {
      // J3（F20261022j2j3）：「进程名模式」执行期 token 判定——匹配片段本身含 /，或
      // 同空白分隔 token 的前缀段（token 起点到匹配起点之间）含 /，即路径型 token，
      // 跳过不标。lookbehind 等价方案见上方模式注释（初写正则不达预期后改此路径，
      // 非 V8 缺陷）；仅影响诊断回显，不影响拦截。
      if (name === "进程名模式") {
        const tokenStart = Math.max(command.lastIndexOf(" ", m.index - 1), command.lastIndexOf("\t", m.index - 1), command.lastIndexOf("\n", m.index - 1)) + 1;
        if (m[0].includes("/") || command.slice(tokenStart, m.index).includes("/")) continue;
      }
      const start = Math.max(0, m.index - 10);
      const end = Math.min(command.length, m.index + m[0].length + 10);
      // PID 脱敏铁律（F20260831aksp）：片段中的真实主进程 PID 替换为占位符——
      // 防「错误试探 → 文案回显真实 PID → 精准二次打击」。其他数字（日期/行号）无害保留。
      const raw = command.slice(start, end).replace(/\n/g, " ");
      const snippet = mainPid !== null ? raw.split(String(mainPid)).join("<main-pid>") : raw;
      if (typeCount === 0) { firstSnippet = snippet; firstIndex = m.index; }
      typeCount++;
    }
    if (typeCount > 0) {
      hits.push(`${name}：…${firstSnippet}… @${firstIndex}${typeCount > 1 ? `（共 ${typeCount} 处）` : ""}`);
    }
  }
  return hits;
}

/** F20260923glay：拦截文案附加诊断块（#730）；同类命中已在 locateTriggerContext 合并计数。 */
function withDiagnostics(message: string, scanText: string, mainPid: number | null): string {
  let hits = locateTriggerContext(scanText, mainPid);
  // F20260928grv2：塔死引号拼接形态（e""val）在原始文本上打不中诊断正则——
  // 用归一化视图二次定位（#730 诊断块与判定口径对齐；两视图都试，命中即报）
  if (hits.length === 0) {
    const normalized = normalizeForDetection(scanText);
    if (normalized !== scanText) hits = locateTriggerContext(normalized, mainPid);
  }
  if (hits.length === 0) return message;
  return `${message}\n【命中详情】${hits.join("；")}`;
}

/**
 * 检查 bash 命令是否安全（不针对主进程的 kill 操作）。
 *
 * 对抗设计（F20260830bsgr-r2）：
 * 1. 全命令级高危模式（eval/pipe-to-shell/脚本语言）→ 拦截
 * 2. pkill/killall + otter 相关模式 → 拦截
 * 3. kill + 非字面量 PID / .otter-buddy.pid 引用 / 字面量主进程 PID → 拦截
 * 4. PID 文件缺失 → 放行（保守降级）
 *
 * F20260831aksp §2c：原始与归一化两份文本都过全量正则——塔死 `ki''ll` / `k\\ill` 类文本规避（R1 严重1）。
 *
 * @returns null 表示安全；字符串表示危险原因
 */
/**
 * F20260916gtlr：入口快速通道——mainPid 为 null（PID 文件缺失/损坏）时只做脚本判定。
 * 脚本路径判定不依赖 PID 信息，仍需拦截主仓脚本 stop/restart（脚本层兜底已删，
 * 此处是唯一防线）；kill 族判定无 PID 可比对，保守放行。抽为独立函数控制主入口圈复杂度。
 */
/** F20260922scwd：主仓写拦截文案（感知对齐保护闸） */
const MAIN_WRITE_BLOCK_MSG = "当前 bash 工作目录在主仓（未 cd 到 worktree）。落点为主仓的写命令被拦截——若目标在 worktree，请先 cd <worktree 路径> 再执行；若确实要写主仓，用绝对路径（写主仓受 R1 红线约束，请确认意图）。";

// ── #1275：解释器直执行（one-liner）形态判定（F20261005i1275）──
// 盲区实证：9/29 #1252 事故——小獭用 `python3 -c "open('config/config.yaml','w').write(…)"`
// 在主仓 cwd 绕过主仓写检测（MAIN_WRITE_PATTERNS 只覆盖重定向/python heredoc/git 写族），
// 污染主仓 config（session entry 417）。与 :316-319 kill 检测侧 `python -c`/`node -e`/`
// `perl -e`/`ruby -e` 形态检测（F20260923glay）是同一盲区在主仓写检测侧的对齐补齐。
// 判定原则与 heredoc 体感知判定（#1207）同构：只读白名单豁免 + 白名单外保守拦（fail-closed）。
// 检视獭-1278 处置（delta r1）：
// ① 锚集对齐 git 写族（单 | / & 同样切段——管道右段写载荷绕过实证，严重 1）；
// ② 提取器循环提取全部同型载荷（`python3 -c "print(1)" && python3 -c "open('w')…"`
//    只读掩护写实测放行，严重 2）；
// ③ 豁免判定基准为原始命令文本（checkBashCommandSafety 首次扫描路径），
//    V1 归一化二次扫描剥载荷内引号（require('fs') → require(fs)）导致白名单断言失败
//    的误拦不发生在首次扫描（严重 3 的修复口径）；
// ④ 通道/预闸/提取三处正则抽公共常量统一（-W 带参旗标位漂移实证，严重 4）；
// ⑤ ruby/perl 只读全拦（fail-closed 起步，先堵写面，放行面后续放宽，严重 5）。

/** one-liner 通道锚集——对齐 git 写族（:670 的 [|&] 锚 + env 赋值前缀）。
 *  单 | / & 同样切段（S-1）；赋值前缀与包装词合并单一循环组，任意形态×顺序×
 *  层数匹配（r2 严重 2：sudo env / nohup env / env FOO=1 组合形态曾放行，W1/W2/W3）。
 *  #1285 洞3：赋值前缀 \S+ → \S*——`FOO= node -e "<写>"` 空赋值形态曾放行
 * （shell 语义上空赋值是合法赋值前缀，与 FOO=1 等价参与环境传递）。 */
const ONELINER_ANCHOR = "(?:^|[;&\\n|]|&&|\\|\\||\\(|\\{)\\s*(?:(?:[A-Za-z_]\\w*=\\S*|env|sudo|nohup|command|nice|exec|time|xargs(?:\\s+-[^\\s]+)*)\\s+)*(?:[\\w./-]+\\/)?";

/** one-liner 旗标位（python）：容许带参旗标（-W ignore / -X dev）。
 *  单字母旗标后可选一个非 - 开头的参数（`(?:\\s+(?!-)\\S+)?`），循环容许连续多旗标。 */
const PY_FLAG_GROUP = "(?:-[A-Za-z](?:\\s+(?!-)\\S+)?\\s+)*";

/** one-liner 旗标位（node）：长旗标带可选参数（--max-old-space-size 4096）。 */
const NODE_FLAG_GROUP = "(?:--[A-Za-z-]+(?:\\s+[^\\s;&|]+)?\\s+)*";

/** one-liner 载荷形态（引号包裹或无引号裸标识符——后者提取失败 fail-closed）。 */
const ONELINER_PAYLOAD = "(?:\\s*[\"'`]|\\s+(?![\"'`])\\S)";

/** python -c 通道形态（不含锚集，供通道正则/预闸/提取三处复用）。 */
const PY_ONELINER_FORM = "python[\\d.]*\\s+" + PY_FLAG_GROUP + "-c" + ONELINER_PAYLOAD;

/** node -e|--eval 通道形态（不含锚集）。 */
const NODE_ONELINER_FORM = "node(?:\\d+)?\\s+" + NODE_FLAG_GROUP + "(?:-e|--eval)" + ONELINER_PAYLOAD;

/** ruby -e 通道形态（不含锚集）。 */
const RUBY_ONELINER_FORM = "ruby[\\d.]*\\s+(?:-[A-Za-z]+\\s+)*-e" + ONELINER_PAYLOAD;

/** perl -e 通道形态（不含锚集）。 */
const PERL_ONELINER_FORM = "perl[\\d.]*\\s+(?:-[A-Za-z]+\\s+)*-e" + ONELINER_PAYLOAD;

type OneLinerInterp = "python" | "node" | "ruby" | "perl";


/** 预闸正则（checkMainCheckoutWrite 内 oneLinerReadOnly 预计算用——与通道同源）。 */
const ONELINER_PRE_GATE = new RegExp("\\b(?:" + PY_ONELINER_FORM + "|" + NODE_ONELINER_FORM + "|" + RUBY_ONELINER_FORM + "|" + PERL_ONELINER_FORM + ")");

/** 提取器正则（引号载荷捕获，g 旗标循环提取全部同型载荷——与通道同源）。 */
const ONELINER_EXTRACT_PATTERNS: Record<OneLinerInterp, RegExp> = {
  python: new RegExp(ONELINER_ANCHOR + "python[\\d.]*\\s+" + PY_FLAG_GROUP + "-c\\s+([\"'`])", "g"),
  node: new RegExp(ONELINER_ANCHOR + "node(?:\\d+)?\\s+" + NODE_FLAG_GROUP + "(?:-e|--eval)\\s+([\"'`])", "g"),
  ruby: new RegExp(ONELINER_ANCHOR + "ruby[\\d.]*\\s+(?:-[A-Za-z]+\\s+)*-e\\s+([\"'`])", "g"),
  perl: new RegExp(ONELINER_ANCHOR + "perl[\\d.]*\\s+(?:-[A-Za-z]+\\s+)*-e\\s+([\"'`])", "g"),
};

// ── #1285 洞1/洞2：bash -c 载荷递归检测 + 段首包装词结构化判定 ──
// 设计根源（四轮对抗审视教训：逐洞枚举式修复每轮都开新变体洞——#1275/#1278 枚举
// 包装词表连爆三轮）。本次换结构：
//   洞2（包装词表封闭性）：段首 token 解析器（与 heredocInterpreter 同构的
//     「跳前缀词认解释器」式）——跳过赋值前缀 + 已知包装词（含带旗标形态）后
//     落在解释器（python/node/ruby/perl）上即按 one-liner 通道判定；落在 shell
//     解释器（bash/sh/zsh）+ -c 上递归洞1；未知包装词 fail-closed 拦。
//   洞1（bash -c wrapper）：shell -c 载荷提取后递归跑主仓写判定链（同一基座
//     checkMainCheckoutWrite——基座对齐：豁免与拦截同一提取基座）。
// 已知包装词表 + 各自旗标形态（跳过时连旗标参数一并跳）：
//   env(-i/-u NAME/-C DIR) / nice(-n N) / timeout(DUR) / watch(-n N) / setsid /
//   stdbuf(-o0/-e0/-i0/-oL…) / arch / sudo / nohup / command / nice / exec / time /
//   xargs(-I{} 等)。unknown 即拦的取舍：段首解析后落点既非解释器、又非已知只读
//   常见词、也非已知包装词——静态无法判定其语义，按 fail-closed 拦（与 ruby/perl
//   只读全拦同先例；误拦面由「已知只读常见词放行表」收口——git/grep/cat/ls/echo/
//   cd/npm/npx 等高频词在表内不会误拦）。

/** shell 解释器名（洞1 识别面——basename 归一后比对）。 */
const SHELL_INTERP_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);

/** one-liner 解释器名 → 通道 key（洞2 落点判定）。 */
const ONELINER_INTERP_NAMES: Record<string, OneLinerInterp> = {
  python: "python", python3: "python", node: "node", ruby: "ruby", perl: "perl",
};

/** 段首解析后落点在这些词上 → 明显非解释器/非 shell，放行交后续层判定
 * （高频只读/构建词，防 fail-closed 误拦面破窗）。 */
const SEGMENT_HEAD_PASS_THROUGH = new Set([
  "git", "grep", "cat", "ls", "echo", "cd", "pwd", "find", "head", "tail", "wc",
  "sort", "uniq", "awk", "sed", "cut", "tr", "diff", "which", "type", "file",
  "stat", "date", "uname", "whoami", "hostname", "ps", "top", "df", "du", "free",
  "npm", "npx", "node_modules", "yarn", "pnpm", "tsc", "vitest", "jest", "eslint",
  "gh", "curl", "wget", "tar", "zip", "unzip", "gzip", "mkdir", "touch", "cp", "mv",
  "ln", "readlink", "realpath", "basename", "dirname", "true", "false", "test", "[",
  "jq", "yq", "sqlite3", "lsof", "netstat", "ss", "open", "pbcopy", "pbpaste",
]);

interface SegmentHead {
  /** 落点 basename（小写，路径已剥）。空串 = 段为空或纯赋值。 */
  head: string;
  /** 落点在全段中的字符 offset（shell -c 载荷定位用）；-1 = 无落点。 */
  offset: number;
  /** F20261019gses F1 修复：落点前是否消耗过包装词（sudo/env/timeout/nohup 等
   *  WRAPPER_SPECS 族）——true=包装形态（求值器无此基座，结构通道承担）；
   *  false=plain/纯赋值前缀（求值器判定完备，结构通道不得重复拦）。 */
  wrapped: boolean;
}

/** 单 token 扫描（tokenizeSegment 内层，抽函数控圈复杂度）。
 *  从 seg[i]（非空白）扫一个 token，返回 token 文本与扫描后位置；未闭合引号返回 null。 */
function scanOneToken(seg: string, i: number): { text: string; next: number } | null {
  let cur = "";
  let quote: string | null = null;
  while (i < seg.length) {
    const ch = seg[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < seg.length) { cur += seg[i + 1]; i++; }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; i++; continue; }
    if (/\s/.test(ch)) break;
    cur += ch; i++;
  }
  return quote ? null : { text: cur, next: i };
}

/** 引号感知 token 化（单/双引号内空格不切；token 保留引号字符）。
 *  未闭合引号返回 null → 调用方保守拦。 */
function tokenizeSegment(seg: string): { text: string; offset: number }[] | null {
  const tokens: { text: string; offset: number }[] = [];
  let i = 0;
  while (i < seg.length) {
    while (i < seg.length && /\s/.test(seg[i])) i++;
    if (i >= seg.length) break;
    const tok = scanOneToken(seg, i);
    if (tok === null) return null; // 未闭合引号 → 解析失败
    if (tok.text) tokens.push({ text: tok.text, offset: i });
    i = tok.next;
  }
  return tokens;
}



/** 段首 token 解析器（洞2 换结构核心）：跳过「赋值前缀 + 已知包装词（含旗标）」
 *  后返回落点 token。引号感知——引号内空格不切 token。解析失败（未闭合引号等）
 *  返回 null → 调用方保守拦。 */
function parseSegmentHead(seg: string): SegmentHead | null {
  const tokens = tokenizeSegment(seg);
  if (tokens === null) return null;
  if (tokens.length === 0) return { head: "", offset: -1, wrapped: false };
  let k = 0;
  let wrapped = false;
  for (;;) {
    if (k >= tokens.length) return { head: "", offset: -1, wrapped };
    const t = tokens[k].text;
    // 赋值前缀（含空值 #1285 洞3：FOO= 合法赋值）——不算包装
    if (/^[A-Za-z_]\w*=\S*$/.test(t)) { k++; continue; }
    const base = tokenBasename(t);
    const spec = WRAPPER_SPECS[base];
    if (!spec) return { head: base, offset: tokens[k].offset, wrapped };
    wrapped = true;
    k = skipWrapperArgs(tokens, k + 1, spec);
  }
}

/** shell -c 载荷提取三态（#1285 r1 严重 2 处置：null 三态拆分——
 *  初版 null 单态把「旗标在 -c 前」与「无 -c 文件落点」混同，
 *  `bash -x -c '写'` 返回 null 被归文件落点放行，注释写「保守拒」实际放行）。
 *  - FILE：无 -c 形态（bash script.sh）——写面在脚本文件自身，本层放行；
 *  - FAIL_CLOSED：-c 存在但旗标形态未识别（白名单外）——fail-closed 拦；
 *  - PAYLOAD：-c 载荷成功提取——payload 供递归判定，consumedEnd 为载荷在段内
 *    的结束 offset（③b 后继续判定剩余 token 用，r1 严重 3）。 */
type ShellCExtract =
  | { kind: "FILE" }
  | { kind: "FAIL_CLOSED" }
  | { kind: "PAYLOAD"; payload: string; consumedEnd: number };

/** shell 短旗标白名单（-c 前置容许形态，与 PY_FLAG_GROUP 同模式）。
 *  bash/sh/zsh/dash/ksh 共有常见旗标：a b c d e f h i k l m n o p r s t u v x y C E F H T W X
 *  #1285 r2 严重 B：前缀字符类补 [+-]——bash 的 `+x`（关 xtrace）是合法旗标形态，
 *  只认 `-` 前缀时 `sh +x -c '写'` 曾绕过。
 *  白名单外（含长旗标 --posix / --norc 等带参形态）→ FAIL_CLOSED。 */
const SHELL_FLAG_WHITELIST = /^[+-][abcdefhiklmnoprstuvxyCEFHTWX]+$/;

/** F20261006gfvl (#1307)：-o/+o 带值旗标的封闭 optname 白名单（shopt set -o 集）。
 *  白名单外 fail-closed——不是所有 \w+ 都放（evilopt/monitor 等注入面）。 */
const SHELL_O_OPTNAME_WHITELIST = new Set([
  "allexport", "braceexpand", "emacs", "errexit", "errtrace", "functrace",
  "hashall", "histexpand", "history", "ignoreeof", "interactive-comments",
  "keyword", "noclobber", "noexec", "noglob", "nolog", "notify",
  "nounset", "onecmd", "physical", "pipefail", "posix", "privileged",
  "verbose", "vi", "xtrace",
]);

/** 旗标扫描结果（extractShellCPayload 内层，抽函数控圈复杂度）。 */
type FlagScan =
  | { kind: "C_FOUND" }      // 遇 -c，进载荷提取
  | { kind: "FILE" }         // 无 -c / 非旗标 token → bash script.sh
  | { kind: "FAIL_CLOSED" }; // 白名单外旗标/值 → fail-closed

/** 逐 token 扫描 shell 旗标（F20261006gfvl #1307：argM 正则 → 逐 token 扫描）。
 *  带值旗标（-o/+o/-C）的值 token 一并消费并校验，白名单外 fail-closed。 */
function scanShellFlags(tokens: string[]): FlagScan {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "") continue; // F20261020c2sm：空白切分残留空 token 非形态异常
    if (tok === "-c") return { kind: "C_FOUND" };
    // 带值旗标：-o/+o <optname>
    // F20261006gfvl 修正：-C 是无参 noclobber 旗标（大写 C 已在 SHELL_FLAG_WHITELIST 字符类），
    // 不接值——大獭实测 `bash -C -c 'echo OK'` payload 正常执行，`bash -C /tmp -c 'echo OK'`
    // 报 /tmp is a directory（/tmp 被当脚本文件名）。原「-C 带值」建模被真 bash 推翻。
    if (/^[+-]o$/.test(tok)) {
      i++; // 消费值 token
      if (i >= tokens.length) return { kind: "FAIL_CLOSED" }; // -o 后无值
      // F20261006gfvl 合并修（原 #1314）：白名单匹配前剥引号——真 bash 3.2 实测
      // `bash -o "pipefail" -c 'echo hello'` 合法执行，token 化不剥引号会误拦。
      // 空格注入面保持拦：`"pipe fail"` 拆词后 `fail"` 白名单外 → FAIL_CLOSED。
      const optname = tokens[i].replace(/^["']|["']$/g, "");
      if (!SHELL_O_OPTNAME_WHITELIST.has(optname)) return { kind: "FAIL_CLOSED" };
      continue;
    }
    if (SHELL_FLAG_WHITELIST.test(tok)) continue; // 白名单短旗标（含 -C 无参 noclobber）
    if (tok === "-") return { kind: "FILE" }; // heredoc stdin 标记（bash - <<'EOF'）——交外层 heredoc 检测
    if (tok.startsWith("<<")) return { kind: "FILE" }; // F20261020c2sm：heredoc stdin 投递（bash <<'EOF'——dash 可省）同交体判通道，不按「旗标位非旗标」误拦
    if (/^--/.test(tok)) return { kind: "FAIL_CLOSED" }; // 长旗标（V5/V7 已收口）
    // F20261006gfvl 修正：-C 后遇非旗标 token（如 bash -C /tmp -c 'x' 的 /tmp）——
    // 真 bash 实测 /tmp 被当脚本文件名报 is a directory，payload 不执行。
    // 但守卫保守拦（fail-closed）：非旗标 token 出现在旗标位 = 形态异常，不放行。
    return { kind: "FAIL_CLOSED" };
  }
  return { kind: "FILE" }; // 无 -c
}

/** 提取引号包裹的 -c 载荷（extractShellCPayload 内层，抽函数控圈复杂度）。
 *  返回 null = 未闭合引号（fail-closed）。 */
function scanQuotedPayload(rest: string, i: number, shellOffset: number): ShellCExtract {
  const q = rest[i];
  i++;
  const start = i;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === q) {
      return { kind: "PAYLOAD", payload: rest.slice(start, i), consumedEnd: shellOffset + i + 1 };
    }
    i++;
  }
  return { kind: "FAIL_CLOSED" }; // 未闭合引号 → fail-closed
}

/** 从段文本 offset 处判定 shell 调用的 -c 载荷（引号感知，escape 感知）。 */
function extractShellCPayload(seg: string, shellOffset: number): ShellCExtract {
  const rest = seg.slice(shellOffset);
  // shell 名（容许路径/版本号尾缀）
  const nameM = rest.match(/^[\w./-]*\/?(?:bash|sh|zsh|dash|ksh)\d*/i);
  if (!nameM) return { kind: "FILE" };
  const after = rest.slice(nameM[0].length);
  // 逐 token 扫描旗标：白名单短旗标跳过；带值旗标（-o/+o/-C）校验值在封闭白名单内；
  // 白名单外旗标/值 → FAIL_CLOSED；遇 -c 进载荷提取；其他 → FILE。
  // r2 严重 B：旗标 token 形态含 [+-] 前缀（bash `+x` 关 xtrace 合法）。
  // F20261006gfvl (#1307)：argM 正则 `(?:\s+[+-]\S+)*?` 只认 [+-] 前缀 token——
  // `bash -o pipefail -c 'x'` 的 `pipefail` 值无前缀 → argM 从值后重新匹配 -c 成功、
  // flagStr 只含 -o（白名单内）→ 值被静默跳过（R1-R4 绕过实锤）。修复：逐 token 扫描，
  // 带值旗标的值 token 一并消费并校验，白名单外 fail-closed。
  const tokens = after.trim() === "" ? [] : after.trim().split(/\s+/); // F20261020c2sm：空参段不留幻影空 token（旧 "".split→[""] 被当「旗标位非旗标」FAIL_CLOSED）
  const scan = scanShellFlags(tokens);
  if (scan.kind === "FILE") return { kind: "FILE" };
  if (scan.kind === "FAIL_CLOSED") return { kind: "FAIL_CLOSED" };
  // scan.kind === "C_FOUND"：旗标扫描已确认 -c 存在且前面全是合法旗标/值。
  // indexOf 定位第一个 -c（前面全是合法旗标不含 -c，这就是目标）。
  const cIdx = after.indexOf("-c");
  let j = nameM[0].length + cIdx + 2; // rest 内 -c 后位置
  // 跳过 -c 后空白（`bash -c 'payload'` 的 -c 与引号间有空格）
  while (j < rest.length && /\s/.test(rest[j])) j++;
  if (j >= rest.length) return { kind: "FAIL_CLOSED" }; // -c 后无载荷
  const q = rest[j];
  if (q === "'" || q === '"' || q === "`") return scanQuotedPayload(rest, j, shellOffset);
  // 无引号载荷（bash -c node…）——取至段尾
  const payload = rest.slice(j).trim();
  return payload ? { kind: "PAYLOAD", payload, consumedEnd: seg.length } : { kind: "FAIL_CLOSED" };
}

/** splitShellSegments 单字符处理。
 *  返回消耗后的新 index；命中分隔符时把 cur 推入 segs 并重置。 */
 
function splitStep(
  command: string, i: number, state: { quote: string | null; cur: string }, segs: string[],
): number {
  const ch = command[i];
  if (state.quote) {
    if (ch === "\\") { state.cur += ch + (command[i + 1] ?? ""); return i + 1; }
    if (ch === state.quote) state.quote = null;
    state.cur += ch;
    return i;
  }
  if (ch === "'" || ch === '"' || ch === "`") { state.quote = ch; state.cur += ch; return i; }
  if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
    const double = (ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|");
    if (state.cur.trim()) segs.push(state.cur.trim());
    state.cur = "";
    return double ? i + 1 : i;
  }
  state.cur += ch;
  return i;
}

/** 引号感知切段（one-liner 载荷内 ; | & \n 是数据不是 shell 分隔——
 *  `python3 -c "print('a;b')"` 引号内分号曾被朴素 split 切段造成只读豁免面误判）。
 *  && / || 视作单一切点。 */
function splitShellSegments(command: string): string[] {
  const segs: string[] = [];
  const state = { quote: null as string | null, cur: "" };
  for (let i = 0; i < command.length; i++) {
    i = splitStep(command, i, state, segs);
  }
  if (state.cur.trim()) segs.push(state.cur.trim());
  return segs;
}

/** one-liner 载荷只读判定（#1285 洞2 基座对齐修复）：
 *  词表内包装形态（timeout 5 node -e … / env -i python3 -c …）下，既有提取基座
 * （ONELINER_ANCHOR 词表）与拦截通道（段首解析器）不同源——词表外/带旗标包装
 *  会让 oneLinerPayloadReadOnly 返回 false，只读载荷被误拦（豁免失明）。
 *  基座对齐原则：豁免判定与拦截判定必须基于同一提取基座。
 *  实现：对「段首解析后落点为 one-liner 解释器」的段，剥掉段首前缀（赋值+包装词）
 *  得到裸解释器起始的剩余文本，在该文本上跑既有 oneLinerPayloadReadOnly——
 *  提取基座与拦截落点同一解析器产出，词表差异归零。
 *  全部「落点解释器段」的载荷均提取成功且只读 → true；无此类段 → false。 */
function wrappedOneLinerPayloadsReadOnly(command: string): boolean {
  let saw = false;
  for (const seg of splitShellSegments(command)) {
    const parsed = parseSegmentHead(seg);
    if (parsed === null || parsed.offset < 0 || parsed.head === "") continue;
    const interpKey = ONELINER_INTERP_NAMES[parsed.head.replace(/[\d.]+$/, "")];
    if (!interpKey) continue;
    // 落点是 one-liner 解释器——剥前缀后剩余文本上做只读判定（既有白名单基座）
    const rest = seg.slice(parsed.offset);
    if (!ONELINER_PRE_GATE.test(rest)) continue; // 非 one-liner 形态（裸脚本调用）不涉及
    saw = true;
    if (!oneLinerPayloadReadOnly(rest)) return false;
  }
  return saw;
}

/** git 写子命令判定（#1285 r1 严重 1：段首解析剥包装前缀后落 git 的写族判定——
 *  正则锚只认赋值前缀不认包装词，`env git commit` / `sudo git commit` 曾全放。
 *  比 MAIN_WRITE_PATTERNS[5] 宽：补 push / reset --hard / clean -f 等同属写族但
 *  原正则未覆盖的子命令——段首解析通道既然接了 git 落点，写族口径一次补齐）。 */
/** git 写族子命令判定：F20261016gwr1（M-46f0e74d）起词级化——GIT_WRITE_SUBCOMMAND
 *  正则已退役（\S+ 词面对引号含空格/attached/反引号三形态整体失明 fail-open），
 *  单一真相源=payload-extract-aux.gitWriteSubcommandHit（与 v2 求值器共用）。 */

/** F20261015glfp（M-bf4049a3 止血）：git -C 落点解析——写族段的落点是 -C 目标（多级累积），
 *  落 worktree 区（<projectRoot>/.otter/worktrees/<name>[/…]，root 级精确前缀）时该段
 *  git 写是 worktree 自树的 git 操作、非主仓写——豁免语义与 cwd 形态
 *  （cwdInGitWorktree→skipGitWrite）等价；**豁免分支**与 write-target-evaluator
 *  evalGitWrite「-C 目标优先，无 -C → cwd」口径对齐（只对豁免分支成立——全命令
 *  对齐声称不实：skipGitWrite 短路在前不看 -C 目标，`git -C <主仓> commit`
 *  （cwd=worktree）与 `cd <主仓> && git commit` 均 prod:ALLOW/wv:BLOCK 反判，
 *  差异面挂 M-026d87ff 第三项；本句是「记档说一套代码做一套」第三发的收窄修正）。
 *  双链割裂背景：v2 求值器早有 -C 落点跟踪，V1 生产链只认 cd 形态，
 *  `git -C <worktree> commit` 同形态两链反判。
 *  fail-closed 面（任一命中即不豁免）：--git-dir/--work-tree 覆盖（落点被改写）、
 *  ~ 前缀（shell 不展开）、动态/引号含空格 token（与 GIT_WRITE_SUBCOMMAND 的 \S+
 *  词面解析同基座，解析不完整就不豁免）；无 -C 时归 cwd 形态（skipGitWrite）不重复。
 *  段级粒度：豁免只对本 git 段生效，命令内其他段照常判定（混合段回归钉死）。 */
// eslint-disable-next-line max-statements -- git 旗标形态穷举（-C/-c/--git-dir/--work-tree/--exec-path/--namespace × =值/空格值/attached）+ fail-closed 面逐条对照，每分支对应一种已声明形态（c107 教训：合并会再制造旗标解析 bug）
function gitDashCTargetsWorktree(gseg: Segment, projectRoot?: string, sessionCwd?: string): boolean {
  if (!projectRoot) return false;
  // F20261016gwr1（M-46f0e74d）：解析基座词级化（词法层归一引号/attached/转义）——旧版
  // 字符串正则对引号含空格/attached 形态失明。fail-closed 面：--git-dir/--work-tree
  // 覆盖（落点被改写）、core.worktree/core.bare/core.gitdir 配置改写树发现、动态 -c
  // 值（不可证非树发现改写）、动态旗标/值位、~ 前缀、相对 -C 无绝对基准、worktrees
  // 根自身（上溯发现主仓 .git）一律不豁免；段级粒度（混合段回归钉死）。
  const words = gseg.words;
  let base: string | null = sessionCwd !== undefined && path.isAbsolute(sessionCwd) ? path.normalize(sessionCwd) : null;
  let hasC = false;
  const resolveTarget = (v: string): boolean => {
    if (v.startsWith("~")) return false;
    const resolved = path.isAbsolute(v)
      ? v // 不词法折叠（F20261019syml 二轮）；函数尾 safeRealpath(base) 逐分量收口
      : base !== null ? joinNoFold(base, v) : null;
    if (resolved === null) return false;
    base = resolved;
    hasC = true;
    return true;
  };
  // while 形态（勿改 for：for 的 i++ 在 continue 后照跑会跳词过冲——审查实证踩过）
  let i = 1;
  while (i < words.length) {
    const w = words[i].evaluated;
    if (w === null) return false; // 动态旗标/值位——不可证，不豁免
    if (w.startsWith("--git-dir") || w.startsWith("--work-tree")) return false;
    if (w === "-C") {
      const v = words[i + 1]?.evaluated ?? null;
      if (v === null || !resolveTarget(v)) return false;
      i += 2;
      continue;
    }
    if (w.startsWith("-C") && w.length > 2) {
      // attached -C<path>（值在词内，词 evaluated 已归一引号）
      if (!resolveTarget(w.slice(2))) return false;
      i++;
      continue;
    }
    if (w === "-c") {
      const kv = words[i + 1]?.evaluated ?? null;
      if (kv === null) return false; // 动态 -c 值——不可证非树发现改写
      if (/^core\.(worktree|bare|gitdir)=/i.test(kv)) return false; // 配置改写树发现
      i += 2;
      continue;
    }
    if (w.startsWith("-c") && w.length > 2) {
      if (/^core\.(worktree|bare|gitdir)=/i.test(w.slice(2))) return false;
      i++;
      continue;
    }
    if (w === "--exec-path" || w === "--namespace") {
      const nxt = words[i + 1]?.evaluated ?? null;
      i += nxt !== null && !nxt.startsWith("-") ? 2 : 1;
      continue;
    }
    if (w.startsWith("-")) { i++; continue; }
    break; // 子命令位——后续词是子命令参数非 git 全局旗标
  }
  if (!hasC || base === null) return false;
  // F20261019syml（M-ed285d7c）：-C 目标 symlink 穿透归一——git -C <link>（链进主仓内容）
  //  不得因字符串形态在 worktrees 下沉层而豁免。
  const wtRoot = safeRealpath(path.normalize(path.join(projectRoot, ".otter/worktrees")));
  const realBase = safeRealpath(base);
  const rel = path.relative(wtRoot, realBase);
  // worktrees 根自身不豁免（上溯发现主仓 .git = 写主仓树）；必须是 <name>[/…] 下沉层
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 剥子壳包装（#1285 r1 严重 1 连带形态：`(git commit)` / `{ git commit; }`——
 *  子 shell/命令组剥壳后按同一段判定链重判；剥壳无界循环防护上限 8 层。
 *  注意：剥壳只在「全段恰好被一对壳包裹」时生效（正则锚定 ^$）——
 *  多命令组 `{ a; b; }` 剥壳后残留内层分号由 splitShellSegments 切段重判。） */
function stripSubshellWrap(seg: string): string {
  let s = seg.trim();
  for (let n = 0; n < 8; n++) {
    const m = s.match(/^[({]\s*(.*?)[)}]\s*;?$/s);
    if (!m) return s;
    s = m[1].trim().replace(/;+$/, "").trim(); // 命令组壳内尾分号一并剥（`{ git commit; }` 剥壳残留 `git commit;` 曾放行）
  }
  return s;
}

/** 段内是否含子壳/命令组包裹的可疑写形态（#1285 r1 严重 1 连带，预存洞收窄拦）：
 *  splitShellSegments 不剥壳（引号感知不管括号），`(git commit)` / `{ git commit; }`
 *  段首是壳字符，parseSegmentHead 落点为 "(" / "{" ——未知落点。模型层（parseOk=true）
 *  也不识命令组内 git 写族（预存洞，旧基线 git 正则锚同样不含壳字符）。
 *  fail-closed 收窄：壳落点 + 段内含 git 写族字面即拦（与 ③d 未知落点同策略）。
 *  剥壳重判（stripSubshellWrap）只覆盖「全段单壳」形态；壳内多命令/嵌套壳由本闸兜底。 */
const SUBSHELL_GIT_WRITE_GATE = /[({][^)}]*\bgit\s+(?:commit(?!-tree)|rebase|merge(?!-)|cherry-pick|apply|stash\b(?!\s+(?:list|show|create)\b)|push\b|reset\s+--hard|clean\s+-[a-zA-Z]*f)/;

/** ③b shell 落点处理（judgeSegment 内层，抽函数控圈复杂度/语句数）：
 *  三态拆分（r1 严重 2）+ 载荷递归 + 剩余 token 重判（r1 严重 3）。 */
function judgeShellCSegment(
  seg: string,
  offset: number,
  ctx: { logger?: Logger; projectRoot?: string; sessionCwd?: string; oneLinerReadOnly: boolean; depth: number; writeChannelSkip?: "file-write" },
): boolean {
  const ex = extractShellCPayload(seg, offset);
  if (ex.kind === "FILE") return false; // bash script.sh——写面在脚本文件自身，不在本层
  if (ex.kind === "FAIL_CLOSED") return true; // -c 存在但旗标形态白名单外/未闭合 → fail-closed（G3 缺表不退役）
  // 递归：载荷作为独立命令重走主仓写判定（基座对齐——同一 checkMainCheckoutWrite，
  //  F20261016gsbx writeChannelSkip 随递归透传）
  const payloadHit = checkMainCheckoutWrite({ command: ex.payload, logger: ctx.logger, projectRoot: ctx.projectRoot, sessionCwd: ctx.sessionCwd, depth: ctx.depth - 1, writeChannelSkip: ctx.writeChannelSkip }) !== null;
  if (payloadHit) return true;
  // F20261006gfvl 合并修（原 #1315）：载荷内 rm/mv/find -delete 主仓 data 破坏感知——
  // 复用 checkDataDirDestructive 完整通道（含 cd 跟踪循环），不逐段独立 segmentDestructive。
  // 基座对齐铁律：顶层 cd 豁免（checkDataDirDestructive :452 cd 跟踪）与载荷内 cd 豁免必须同一实现——
  // 检视獭实证 `bash -c 'cd /wt && rm -rf data'` 误拦（cwd 硬编码 projectRoot 不跟踪载荷内 cd），
  // 与既有测试「顶层 cd /wt && rm data → 放行」基座不一致。
  if (ctx.projectRoot && checkDataDirDestructive(ex.payload, ctx.logger, { projectRoot: ctx.projectRoot, sessionCwd: ctx.sessionCwd })) return true;
  const tail = seg.slice(ex.consumedEnd).trim();
  // r2 严重 A：载荷引用位置参数（$1-$9/$@/$*/${N}）时参数位内容会被真实执行
  //（`bash -c '$1 $2' x git commit -m y` 真 bash 沙箱实测 touch 落盘）——载荷与
  // 剩余段互相看不见是判定链盲区。kill 通道 #1154 r2 同款正则先例（:356 附近）。
  // 载荷含位置参数引用且参数位非空 → fail-closed 拦（参数位语义是数据还是命令
  // 由 shell 运行时决定，静态不可分——不逐 token 判定，保守拦）。
  const refsPositional = /\$\{?(?:0|[1-9]\d*|@|\*)\}?(?![\w$])/.test(ex.payload);
  if (refsPositional && tail) return true;
  // r1 严重 3：载荷后剩余 token 重新过判定链——`bash -c 'echo a' timeout 5 node -e "写"`
  // 载荷干净但段内第二命令曾裸奔；`env C=k bash -c 'python3 -c "写"' _` 参数位同型。
  // 剩余段按同判定链递归（depth 消耗与载荷递归同级，终止性：consumedEnd 严格右移）。
  if (tail) {
    for (const tailSeg of splitShellSegments(tail)) {
      if (judgeSegment(tailSeg, { ...ctx, depth: ctx.depth - 1 })) return true;
    }
  }
  return false;
}

/** `-c` 载荷是否 stdin 中继（r1 严重 1——检视獭1565：`printf 'touch x' | bash -c sh`
 *  双通道落空）：载荷是裸 shell 名时命令是 stdin 中继（`sh` 读管道内容真执行，写面在
 *  stdin 里），按载荷递归只判 `sh` 词则两通道都看不着管道内容。载荷含任一 stdin 读入
 *  shell 段即中继（`bash -c 'echo x; sh'` 真 bash 同样吃 stdin）；载荷解析失败/递归深度
 *  耗尽 → fail-closed 按中继判（管道内容至少会被判一遍）。 */
function isStdinRelayPayload(payload: string, depth: number): boolean {
  const model = parseOnce(payload);
  if (!model.parseOk) return true;
  return model.segments.some(s => stdinShellKind(s, depth) === "stdin");
}

/** stdin 喂入 shell 段的尾参分类（stdinShellKind 内层，抽函数控语句数）：
 *  -c 中继判定（严重 1）+ `-s` 旗标语义（建议 3a）+ lone `-` 族残余面（建议 3b）。 */
function stdinShellTailKind(rest: string[], depth: number): "stdin" | "other" {
  const scan = scanShellFlags(rest);
  if (scan.kind === "C_FOUND") {
    // -c 形态：载荷写面由 judgeShellCSegment 载荷递归承担；载荷自身是 stdin 读入
    // shell 时本段是 stdin 中继，写面在管道内容里 → "stdin" 交管道喂入判定（严重 1）。
    // attached 旗标组含 c（-xc）不被 scanShellFlags 认作 C_FOUND——载荷落旗标位
    // FAIL_CLOSED 由结构通道 fail-closed 收口，不静默放行。
    const cIdx = rest.indexOf("-c");
    const payload = rest[cIdx + 1];
    if (payload === undefined) return "other"; // -c 后无载荷词——结构通道 FAIL_CLOSED 收口
    return depth <= 0 || isStdinRelayPayload(payload, depth - 1) ? "stdin" : "other";
  }
  if (scan.kind === "FAIL_CLOSED") return "other"; // 文件参/白名单外旗标——judgeShellCSegment fail-closed 收口（既有口径）
  // FILE：无 -c 纯旗标形态——按 stdin 语义分类
  if (rest.some(r => /^[-+][A-Za-z]*s[A-Za-z]*$/.test(r))) return "stdin"; // -s 读 stdin（操作数 $0/$n 不改喂入——`bash -s -`≡`bash -s`）
  if (rest.includes("-")) return "other"; // lone `-` 族 pre-existing 放行面——残余记档不扩面
  return "stdin"; // 裸 bash/纯旗标：管道在场即 stdin 喂入（无管道由调用方 joiner 过滤）
}

/** stdin 喂入 shell 段分类（F20261020c2sm）：段首（跳赋值前缀/wrapper 词）是 shell
 *  解释器且 stdin 是命令文本来源 → "stdin"（写面在 stdin 内容里）。
 *  r1 delta（检视獭1565 裁决——保护回退面收口，三件）：
 *  ①`-c` 载荷是裸 shell（stdin 中继）→ "stdin"（严重 1，见 isStdinRelayPayload）；
 *  ②wrapper 解析对齐 WRAPPER_SPECS+skipWrapperArgs 基座（严重 2——旧自立 6 词表与
 *    仓库词表漂移，timeout/env/setsid/watch/stdbuf/xargs 带参形态静默漏判）；
 *  ③`-s` 旗标语义（建议 3a：`bash -s -` ≡ `bash -s`，lone `-` 是 $0 操作数不改喂入）。
 *  文件参/形态异常 → "other"（U5/FILE/FAIL_CLOSED 既有口径不收）；lone `-` 族
 * （`bash -`/`bash -e -`）pre-existing 放行面保持不扩面（建议 3b 残余记档）。 */
function stdinShellKind(seg: Segment, depth = 3): "stdin" | "other" | "none" {
  const evals = seg.words.map(w => w.evaluated);
  if (evals.some(e => e === null)) return "other"; // 动态词——既有口径不收
  const texts = evals as string[];
  // delta r1（检视獭1604 严重 3）：段首解析收敛 resolveExecHead 共享内层——多调分发器
  //  子命令归位（busybox sh ≡ sh）+ 裸分发器默认 applet ash（curl|busybox 最短攻击
  //  形态收编）+ 版本名归一同基座，与 wte 侧同识别域。
  const head = resolveExecHead(seg);
  if (head === null || !SHELL_INTERP_NAMES.has(head.name)) return "none";
  return stdinShellTailKind(texts.slice(head.headIndex + 1), depth);
}

const STDIN_SHELL_OPAQUE_MSG = "管道喂入 shell 执行的脚本内容未经守卫逐条判定（上游非静态可判源：cat/curl/变量/命令替换），绕过面不可接受。该命令不允许：请改写为 bash -c '<载荷>' 形态（载荷可逐条判定）或把脚本内容拆成独立命令执行；若确认此命令本意安全，请改用保持原语义的不含管道喂 shell 的方式达成目的；无法规避时告知搭档人工执行。";

// ── M-38fb45c0 管道直执族 B 面：解释器 stdin 喂入（大獭 2026-10-21 裁决 A+B）──
const STDIN_INTERP_BLOCK_MSG = "管道喂入 shell/解释器（python/node 等）执行的脚本内容未能正面证明安全（上游不透明/载荷不完整/写调用落点不可求值/只读白名单外），fail-closed 拦截。该命令不允许：请把脚本内容落盘为文件后拆步执行（可逐条判定），或改写为可静态判定的载荷形态；若确认此命令本意安全，请告知搭档人工执行。";

/** 解释器 stdin 喂入段分类（M-38fb45c0 B 面）：段首是脚本解释器且程序来源是 stdin
 *  （裸词/单短旗标/lone -——-c/-e/--x=v/脚本文件参走既有载荷通道不收）→ stdin。
 *  delta r1（检视獭1604 严重 1/2 同根因收敛）：段首解析与 wte interpreterStdinFeedContent
 *  同走 resolveExecHead 共享内层（跳赋值前缀/wrapper/分发器 + 版本名归一）。旧注释宣称
 *  「wrapper 形态保守 fail-closed 只改文案」与实测相反（guard 归类 feed、求值器裸词域
 *  看不见 → evaluated 空集放行）——识别域两侧一致后 wrapper/版本别名形态真同判，
 *  该宣称随之成真并升级为完整判定（静态可判正面证明同尺放行/不可证 fail-closed）。
 *  （export：供「两侧识别域一致」参数化断言与 wte 侧对照——一条语义一个接口。） */
export function interpreterStdinKind(seg: Segment): { kind: "stdin"; lang: string } | { kind: "none" } {
  const head = resolveExecHead(seg);
  if (head === null || !SCRIPT_RUNNERS.has(head.name)) return { kind: "none" };
  const rest = seg.words.slice(head.headIndex + 1).map(w => w.evaluated);
  if (isStdinFeedRest(rest)) return { kind: "stdin", lang: head.name };
  return { kind: "none" };
}

/** M-38fb45c0：命令内是否存在管道 feed 形态（shell 族 stdinShellKind + 解释器族
 *  interpreterStdinKind，fail-closed 消息归因用——feed 家族的 fail-closed 一律按
 *  feed 口径归因，不被「落点为主仓」错定因带偏；写主仓 positive 归因不受影响）。 */
function interpreterFeedFormPresent(command: string): boolean {
  const model = parseOnce(command);
  if (!model.parseOk) return false;
  return model.segments.some(s => s.joiner === "|" && s.heredocs.length === 0
    && (interpreterStdinKind(s).kind === "stdin" || stdinShellKind(s) === "stdin"));
}

/** M-38fb45c0 B 面：解释器 stdin 喂入只读白名单正面证明（guard 侧证明器域）——全部 feed
 *  形态静态可判、无写词面、且语言只读白名单证明器判只读才 true（求值器窄提取据此放行
 *  空集面——红线3：空集本身不作放行依据，只有正面证明算数）。perl/ruby/osascript 无
 *  证明器恒 false（判不出 → fail-closed，宁可误拦微增不可漏放）。 */
function interpreterFeedReadOnlyFlag(command: string): boolean {
  const model = parseOnce(command);
  if (!model.parseOk) return false;
  const segs = model.segments;
  let seen = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const kind = interpreterStdinKind(seg);
    if (kind.kind !== "stdin" || seg.joiner !== "|" || seg.heredocs.length > 0) continue;
    const feeder = segs[i - 1];
    if (feeder === undefined) return false;
    // 内容源与 wte interpreterStdinFeedContent 同收窄（echo/printf 静态词；cat 馈体=#1308 契约不收）
    const content = segmentStdoutContent(feeder);
    if (content === null) return false;
    if (evalInterpreterStdinBody(content).kind !== "no-write") return false;
    const proven = kind.lang === "python" || kind.lang === "python3" ? pythonBodyReadOnly(content)
      : kind.lang === "node" ? nodeBodyReadOnly(content)
        : false;
    if (!proven) return false;
    seen = true;
  }
  return seen;
}
/** stdin 喂入 shell 载荷判定（F20261020c2sm，M-49a4909d C2 误判族现存活跃面）：arg-less
 *  shell 段（裸 bash/纯旗标无 -c——写面在 stdin 内容里）的判定。旧实现由 scanShellFlags
 *  空 token 陷阱（`"".trim().split(/\\s+/)`→[""]，幻影空 token 被当「旗标位非旗标」
 *  FAIL_CLOSED）意外拦下全部形态——连良性静态载荷（printf 'echo hi' | bash）与树外/
 *  工作区写都吃「落点解析到主仓」误拦且文案错定因；`bash -` 同语义却走 FILE 放行
 *  （判据分裂实证）；`bash -e` 等带旗标形态反而漏放（保护面碎片化）。
 *  语义：管道上游静态可判（echo/printf 静态词——segmentStdoutContent 与重定向写面同一
 *  重建基座）→ 载荷递归走同一 checkMainCheckoutWrite（与 bash -c 载荷同基座：写主仓
 *  拦/树外放/工作区豁免）；上游不透明 → fail-closed 拦（U5 族「脚本内容未经逐条判定」
 *  正确定因）；无管道上游（裸 bash stdin=EOF）→ 无写面放行（与 bash - 既有口径一致）。 */
/** F20261026gpg1（M-a09944aa②）：xargs replace-str 注入形态识别（stdinShellFeederVeto
 *  内层）。段首 xargs 且旗标区含 replace 旗标（-i / -I<str> / -I <str> / --replace[=<str>]，
 *  缺省 replace-str 为 {}）且旗标区后接 shell 解释器 + -c + 恰为 replace-str 词 → 返回
 *  replace-str 的模板与 replace-str 本身；否则 null。只认静态词（动态词 → null 走既有
 *  保守面，不猜展开）。语义：xargs 把上游内容作为独立 argv 传入 shell -c，载荷即上游
 *  内容本身——与管道喂 shell 同判定基座（feeder 递归）。 */
/** xargs 旗标区扫描内层：返回 { replaceStr, cmdStart }（replace 旗标位与命令区起点），
 *  无 replace 旗标返回 null；动态词返回 "dynamic"（不猜展开）。 */
function xargsScanFlags(words: Segment["words"]): { replaceStr: string; cmdStart: number } | null | "dynamic" {
  let replaceStr: string | null = null;
  let k = 1; // 跳过 xargs 本词
  while (k < words.length) {
    const ev = words[k].evaluated;
    if (typeof ev !== "string") return "dynamic"; // 动态词不猜
    const next = words[k + 1]?.evaluated;
    const parsed = xargsParseFlag(ev, typeof next === "string" ? next : undefined);
    if (parsed === "dynamic") return "dynamic";
    if (parsed === null) break; // 首个非旗标词 = 命令区起点
    if (parsed.replaceStr !== undefined) replaceStr = parsed.replaceStr;
    k += parsed.consume;
  }
  return replaceStr === null ? null : { replaceStr, cmdStart: k };
}

/** 单旗标解析：返回 { consume, replaceStr? } / null（非旗标词）/ "dynamic"（值位动态）。 */
function xargsParseFlag(ev: string, next: string | undefined): { consume: number; replaceStr?: string } | null | "dynamic" {
  if (ev === "-i") return { consume: 1, replaceStr: "{}" };
  const im = /^-I(.+)$/.exec(ev);
  if (im !== null) return { consume: 1, replaceStr: im[1] };
  if (ev === "-I") return next === undefined ? "dynamic" : { consume: 2, replaceStr: next };
  const rm = /^--replace(?:=(.*))?$/.exec(ev);
  if (rm !== null) return { consume: 1, replaceStr: rm[1] === undefined || rm[1] === "" ? "{}" : rm[1] };
  if (ev.startsWith("-")) return { consume: 1 }; // 其他旗标（-n/-P/-0/-r/-t 等）跳过
  return null; // 非旗标词
}

function xargsReplaceInjection(seg: Segment): { replaceStr: string; template: string } | null {
  const scan = xargsScanFlags(seg.words);
  if (scan === null || scan === "dynamic") return null; // 无 replace 旗标（默认追加形态非本类）/ 动态词不猜
  const { replaceStr, cmdStart } = scan;
  // 命令区：shell 解释器 + -c + 含 replace-str 的模板（两种注入位：整模板恰为
  // replace-str / 模板内含 replace-str 占位——xargs 实参替换后作为 shell -c 载荷执行，
  // 重建拼接后递归判）。cmdWords[3:] 额外 argv 是 $0 位不注入，不参与重建。
  const cmdWords = seg.words.slice(cmdStart);
  if (cmdWords.length < 3) return null;
  const shellEv = cmdWords[0].evaluated;
  if (typeof shellEv !== "string" || !SHELL_INTERP_NAMES.has(tokenBasename(shellEv))) return null;
  const flagEv = cmdWords[1].evaluated;
  if (flagEv !== "-c") return null;
  const payloadEv = cmdWords[2].evaluated;
  if (typeof payloadEv !== "string") return null;
  if (!payloadEv.includes(replaceStr)) return null; // 无占位符 = 无注入位，非本类
  return { replaceStr, template: payloadEv };
}

/** F20261026gpg1（M-a09944aa②）：xargs replace-str 注入段的同尺判定（stdinShellFeederVeto
 *  内层，抽函数控深度/语句数）。返回非 null = 拦截消息；null = 无判定（非注入形态或无上游）。
 *  语义：`echo "<cmd>" | xargs -i bash -c {}` —— xargs 把上游内容作为实参替换占位符，
 *  载荷即上游内容本身，与管道喂 shell 同一攻击面。静态上游 → 拼接重建递归判；
 *  不透明上游 → fail-closed。 */
function xargsInjectionVeto(seg: Segment, feeder: Segment | undefined, depth: number, ctx: { logger?: Logger; projectRoot?: string; sessionCwd?: string; writeChannelSkip?: "file-write" }, command: string): string | null {
  if (feeder === undefined) return null;
  const injected = xargsReplaceInjection(seg);
  if (injected === null || seg.joiner !== "|" || seg.heredocs.length > 0) return null;
  const content = segmentStdoutContent(feeder);
  if (content === null || depth <= 0) {
    ctx.logger?.warn("[bash-safety-guard] BLOCKED xargs replace-str injection (opaque stdin source)", { command: command.substring(0, 200) });
    return STDIN_SHELL_OPAQUE_MSG;
  }
  // 拼接重建：模板中每个 replace-str 位替换为上游内容（xargs 实参替换语义），
  // 重建载荷作为 shell -c 递归判（与 bash -c 载荷同基座）。
  const rebuilt = injected.template.split(injected.replaceStr).join(content);
  if (/\b(?:kill|pkill|killall|skill|killall5)\b/i.test(rebuilt)) return INDIRECT_KILL_BLOCK_MSG;
  return checkMainCheckoutWrite({ command: rebuilt, logger: ctx.logger, projectRoot: ctx.projectRoot, sessionCwd: ctx.sessionCwd, depth: depth - 1, writeChannelSkip: ctx.writeChannelSkip });
}

function stdinShellFeederVeto(
  command: string,
  depth: number,
  ctx: { logger?: Logger; projectRoot?: string; sessionCwd?: string; writeChannelSkip?: "file-write" },
): string | null {
  const model = parseOnce(command);
  if (!model.parseOk) return null; // 解析失败形态由 V1 兜底链既有 fail-closed 承担
  const segs = model.segments;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    // F20261026gpg1（M-a09944aa②）：xargs replace-str 注入等价类（同尺判定抽 xargsInjectionVeto）
    if (tokenBasename(seg.argv0 ?? "") === "xargs") {
      const hit = xargsInjectionVeto(seg, segs[i - 1], depth, ctx, command);
      if (hit !== null) return hit;
    }
    if (stdinShellKind(seg) !== "stdin") continue;
    if (seg.heredocs.length > 0) continue; // heredoc stdin 体在场——体判通道已逐条判
    if (seg.joiner !== "|") continue; // 裸 bash/非管道上游：stdin 无内容（EOF）无写面
    const feeder = segs[i - 1];
    if (feeder === undefined) continue;
    // 静态可判源：echo/printf 静态词（同一重建基座）；裸 cat + 定界 heredoc（体即 stdout）
    const heredoc = feeder.heredocs.length === 1 ? feeder.heredocs[0] : null;
    const catBody = heredoc !== null && ((feeder.argv0 ?? "").split("/").pop() === "cat" && feeder.words.length === 1 && (heredoc.delimQuoted || !/[$`]/.test(heredoc.body)))
      ? heredoc.body
      : null;
    const content = segmentStdoutContent(feeder) ?? catBody;
    if (content === null || depth <= 0) {
      ctx.logger?.warn("[bash-safety-guard] BLOCKED pipe-fed shell (opaque stdin source)", { command: command.substring(0, 200) });
      return STDIN_SHELL_OPAQUE_MSG;
    }
    // 性能债（r1 建议 4 记档不修）：载荷递归每层重复 parseOnce——载荷小、深度有限，
    // 优化需引入解析缓存/共享上下文（低收益高扰动），换取「载荷与命令同一判定基座」。
    // kill 面（B3 口径——载荷是被执行的真实命令文本）：词样拦截与上游词样检测同口径，
    // 递归上下文（bash -c 嵌套管道——模型层不递归跑 judgePipeToShell）由本检査兜住
    if (/\b(?:kill|pkill|killall|skill|killall5)\b/i.test(content)) return INDIRECT_KILL_BLOCK_MSG;
    const hit = checkMainCheckoutWrite({ command: content, logger: ctx.logger, projectRoot: ctx.projectRoot, sessionCwd: ctx.sessionCwd, depth: depth - 1, writeChannelSkip: ctx.writeChannelSkip });
    if (hit !== null) return hit; // 载荷写面命中——沿用命中通道文案（含正确落点定因）
  }
  return null;
}

/** 段级判定（checkSegmentStructuralWrite 的单段处理，抽函数控圈复杂度） */
/** gitdir 归属判定的轻量路径归一（与 write-target-evaluator 同形：折叠 ./重复斜杠/尾斜杠，
 *  不折叠 ..——路径真实语义由 safeRealpath 先穿透）。 */
function normalizePathForGuard(p: string): string {
  const abs = p.startsWith("/");
  const joined = p.split("/").filter(c => c !== "" && c !== ".").join("/");
  return abs ? `/${joined}` : (joined === "" ? "." : joined);
}

/** F20261026dwtg 案 B：树外 git 写是否可豁免（只读 fs；单函数承载 gitdir 归属，避免
 *  judgeSegment 主流程膨胀）。独立外仓及其 linked worktree 放行；非官方路径的主仓卫星
 *  gitdir 落主仓 .git 树则不豁免；R1 官方 worktree 由调用方先行豁免。 */
function treeOutsideGitWriteExempt(projectRoot: string, sessionCwd: string): boolean {
  if (!path.isAbsolute(sessionCwd)) return false;
  if ((path.normalize(sessionCwd) + path.sep).startsWith(path.normalize(projectRoot) + path.sep)) return false;
  const info = gitCrawlInfo(path.normalize(sessionCwd));
  if (info?.kind === "dir") return true; // 独立外仓本体：放行
  if (info?.kind === "file") {
    const mainGit = `${normalizePathForGuard(safeRealpath(projectRoot))}/.git/`;
    return info.gitdir !== null && !(`${normalizePathForGuard(safeRealpath(info.gitdir))}/`.startsWith(mainGit));
  }
  return true; // 真 git 树外：保留原 S1 放行面
}

// eslint-disable-next-line max-statements -- 每分支对应一种已实证形态；gitdir 归属另抽 treeOutsideGitWriteExempt 控制主流程
function judgeSegment(
  rawSeg: string,
  ctx: { logger?: Logger; projectRoot?: string; sessionCwd?: string; oneLinerReadOnly: boolean; depth: number; skipGitWrite?: boolean; onelinerPathsOutsideMain?: boolean; writeChannelSkip?: "file-write" },
): boolean {
  // #1285 r1 严重 1 连带：子壳包装剥壳（`(git commit)` / `{ git commit; }`）
  const seg = stripSubshellWrap(rawSeg);
  const parsed = parseSegmentHead(seg);
  const segHasShellC = /\b(?:bash|sh|zsh|dash|ksh)\d*\s+-c\s/i.test(seg);
  const segHasOneLiner = ONELINER_PRE_GATE.test(seg);
  if (parsed === null) {
    // 解析失败（未闭合引号等）——段内含 one-liner/shell 特征才拦
    // F20261016gsbx 2b：one-liner 文件写族随枚举表退役；shell -c 特征保持 fail-closed（缺表不退役）
    if (ctx.writeChannelSkip === "file-write") return segHasShellC;
    return segHasOneLiner || segHasShellC;
  }
  const { head, offset, wrapped } = parsed;
  if (head === "") return false;
  // ③a one-liner 解释器落点（python/node/ruby/perl，含版本号尾缀）。
  // F20261019gses F1 修复（检视对抗审视 + 大獭 L1 裁决）：收窄到**包装形态**
  // （wrapped=true——sudo/env/timeout/nohup 等前缀，求值器 argv 基座不含包装词，
  // 探针实证：sudo env/timeout/nohup 包装写主仓求值器全放——真盲区由本通道收口）。
  // plain/纯赋值前缀（FOO=1 python3 -c）交求值器落点判（判定完备：写主仓 BLOCK/
  // 写树外 ALLOW/动态 f-string fail-closed，探针 7 形态验证）——本通道不得重复
  // 形态判，否则写 /tmp 的合法 one-liner 被误拦（F1 实证：python3 -c 写 /tmp
  // 求值器 ALLOW 整链 BLOCK 的双判据冲突）。
  const interpKey = ONELINER_INTERP_NAMES[head.replace(/[\d.]+$/, "")];
  if (interpKey) {
    // 通道判定：段内含该解释器的 one-liner 形态（-c/-e/--eval）才命中——
    // 裸 `python3 script.py` 不是 one-liner 通道（写面由重定向/git 族承担）。
    // 只读豁免：oneLinerReadOnly（全命令基座，与正则通道同一豁免值——
    // 豁免基座对齐：拦截与豁免同一提取基座，载荷只读性由既有白名单承担）。
    // F1（F20261019gses delta 复核）：③a 收窄到包装形态——plain one-liner 交求值器
    // 落点判（形态判退位，双判据冲突根因修复）；求值器对包装形态无 argv 基座，
    // 结构通道是唯一拦截。
    // F20261016grdl 1a'-B：落点感知豁免——非只读载荷但全部绝对路径落主仓外
    //（或 cd 段锚定非主仓 cwd）时放行（例 6 实证：save('/tmp/x') 写动词 fail-closed 误拦）。
    // F20261016gsbx 二期 2b：沙箱接防时 one-liner 文件写族随 G3 枚举表退役
    if (ctx.writeChannelSkip === "file-write") return false;
    if (ctx.onelinerPathsOutsideMain) return false;
    return wrapped && segHasOneLiner && !ctx.oneLinerReadOnly;
  }
  // ③a' git 落点（#1285 r1 严重 1：词包装 git 写族全绕——正则锚只认赋值前缀，
  // `env git commit` / `sudo git commit` / `timeout 5 git commit` 曾全放）。
  // 剥包装前缀后落 git：写子命令拦（GIT_WRITE_SUBCOMMAND 承担，含 git push/
  // reset --hard/clean -f 等正则锚未覆盖的写族）；只读子命令放行（白名单由
  // allSegmentsGitReadonly 在上游承担——包装形态下 gitReadonlyCmd=false 会落入
  // 本层，这里显式放只读防误拦）。
  if (head === "git") {
    const rest = seg.slice(offset);
    // F20261016gwr1（M-46f0e74d）：写族判定词级化——旧 GIT_WRITE_SUBCOMMAND 正则 \S+
    // 词面对引号含空格/attached/反引号三形态整体失明（fail-open 实证），正则退役；
    // 词级判定=单一真相源 payload-extract-aux.gitWriteSubcommandHit（与 v2 求值器同款）。
    const gseg = parseOnce(rest, 1).segments[0] ?? null;
    if (gseg === null || gseg.argv0 !== "git") return true; // 词法与文本头不一致——保守按写族拦（fail-closed）
    if (!gitWriteSubcommandHit(gseg)) return false; // 只读子命令放行（原有语义）
    // F20261014cwsp S1 处置：cwd 上移豁免（skipGitWrite，由 checkWriteChannels 判定
    // 注入）——git 写族落点是 cwd 上移发现的 git 工作树，不是主仓写，放行。
    // 会话工作区（data/workspaces/，非 git 树）与相对 cwd 不注入本豁免。
    if (ctx.skipGitWrite) return false;
    // F20261015glfp（M-bf4049a3）：git -C 落点豁免（段级）——-C 目标累积解析后落
    // worktree 区时本段 git 写非主仓写，与 cwd 形态等价豁免；其他段照常判定。
    // F20261016grdl rebase 合并：#1519 词级化后探针改 gseg（词法段），glfp 豁免同吃 gseg；
    // grdl 的段内 cwd 豁免保留（1a'-E）。
    if (gitDashCTargetsWorktree(gseg, ctx.projectRoot, ctx.sessionCwd)) return false;
    // F20261016grdl 1a'-E：段内生效 cwd 落 worktree 区（段序列 cwd 跟踪注入）——
    // cd <worktree> 后的 git 写段落点是该树，与 skipGitWrite 同语义放行。
    // 保守面：sessionCwd 是 data/workspaces（非 git 树）或未跟踪 → 不豁免。
    if (ctx.projectRoot && ctx.sessionCwd && path.isAbsolute(ctx.sessionCwd)
        && (path.normalize(ctx.sessionCwd) + path.sep).startsWith(path.normalize(path.join(ctx.projectRoot, ".otter/worktrees")) + path.sep)) return false;
    // F20261026dwtg delta2 复核严重 1 案 B：树外 git 写按实际 gitdir 判，不再把
    // 「.git 文件」与「无 git 树」混为一谈。独立外仓（含其 linked worktree）放行；
    // 非官方路径的卫星仓若 gitdir 落主仓 .git 树则不豁免（拦）。
    if (ctx.projectRoot && ctx.sessionCwd && treeOutsideGitWriteExempt(ctx.projectRoot, ctx.sessionCwd)) return false;
    return true;
  }
  // ③b shell 解释器落点 → 洞1：提取 -c 载荷递归判定（r1 严重 2：三态拆分）
  if (SHELL_INTERP_NAMES.has(head.replace(/\d+$/, ""))) {
    return judgeShellCSegment(seg, offset, ctx);
  }
  // ③c 已知常见词 → 放行
  if (SEGMENT_HEAD_PASS_THROUGH.has(head)) return false;
  // F20261006gfvl 合并修：`-c` 孤立于 shell 名外（换行/命令分隔符导致 `-c` 段首）→ FAIL_CLOSED。
  // `bash -e\n-c 'rm -rf data'` 的 `\n` 被 splitShellSegments 当段分隔符，`bash -e` 段放行后
  // `-c 'rm -rf data'` 段段首是 `-c` 非 shell 名——异常形态，fail-closed 拦（检视獭实证逃逸）。
  if (head === "-c") return true;
  // ③d 未知落点——词表外包装词（timeout/watch/setsid/stdbuf/arch 曾全放）。
  // fail-closed 收窄版：未知词 + 段内含 one-liner/shell-c 特征才拦——
  // `timeout 5 node -e 写` 是典型包装绕过；纯未知命令（make/gradle build）
  // 不含 one-liner 形态不拦（误拦面收口）。
  // F20261016gsbx 2b：one-liner 特征随写面退役，shell -c 特征保持 fail-closed（缺表不退役）
  if (ctx.writeChannelSkip === "file-write") return segHasShellC;
  return segHasOneLiner || segHasShellC;
}

/** 主仓写判定的段首结构检测（洞1+洞2 统一入口）。
 *  判定链（fail-closed 原则）：
 *  ① 引号感知切段；② 段首解析（跳赋值+包装词）；③ 落点分类（judgeSegment）：
 *     one-liner 解释器+形态 → 命中；shell 解释器+-c → 载荷递归；未知落点+特征 → 拦。
 *  返回 true = 命中主仓写通道（拦）。 */
 
function checkSegmentStructuralWrite(
  command: string,
  oneLinerReadOnly: boolean,
  ctx: { logger?: Logger; projectRoot?: string; sessionCwd?: string; depth: number; skipGitWrite?: boolean; onelinerPathsOutsideMain?: boolean; writeChannelSkip?: "file-write" },
): boolean {
  const depth = ctx.depth;
  if (depth <= 0) return true; // 嵌套超深 → 保守拦（与 heredoc 体同先例）
  // F20261016grdl 1a'-E：段序列 cwd 跟踪——splitShellSegments 切段后遇 cd 段
  //  更新跟踪 cwd，git 段判定用「段内生效 cwd」而非命令级 sessionCwd。
  //  修复：`cat > <ws>/m <<EOF…EOF` + `cd <worktree> && git commit` 混合段命令
  //  ——cd 在中段，命令级豁免（modelCdExemption 首段链 / cwdInGitWorktree 锚
  //  sessionCwd）都够不到，git 写段被误拦（G1 例 1 族 E）。跟踪语义与 shell 一致：
  //  cd 段沿语句序影响后续段；被 &/| 切断的 cd 段不影响（splitShellSegments 段
  //  自带 joiner 语义不在此重建，保守面：cd 段含变量/不可静态求值 → 跳过不更新）。
  let trackedCwd = ctx.sessionCwd;
  // S1 修后 V9 面（2026-10-19）：纯赋值段入表，cd 目标 `\$W` 按赋值表展开——
  // 求值器 evalCdTarget 读赋值链（同基座），本通道保守跳过会把求值器已 ALLOW 的
  // 放行面拦下（`W=<wt>; cd \$W && git push` 整链 BLOCK 的双判据复现）。
  const assignVars = new Map<string, string>();
  const jctx = { logger: ctx.logger, projectRoot: ctx.projectRoot, sessionCwd: ctx.sessionCwd, oneLinerReadOnly, depth, skipGitWrite: ctx.skipGitWrite, onelinerPathsOutsideMain: ctx.onelinerPathsOutsideMain, writeChannelSkip: ctx.writeChannelSkip };
  for (const seg of splitShellSegments(command)) {
    const pureAssign = /^([A-Za-z_]\w*)=(\S+)$/.exec(seg.trim());
    if (pureAssign) { assignVars.set(pureAssign[1], pureAssign[2]); continue; }
    const cdMatch = /^cd\s+(?!\.\.?(?:\/|\s|$))(\S+)\s*$/.exec(seg.trim());
    if (cdMatch) {
      let t = cdMatch[1].replace(/^["']|["']$/g, "");
      // B7 定点修（条件解禁 2026-10-19）：`$W` 纯引用与 `$W/后缀` 拼接均按赋值表展开
      //（与求值器 evalCdTarget 同基座——后缀含 `..` 不展开保持保守跳过，与求值器
      // c-po 回落口径对齐）。
      const varRef = /^(\$(\w+))(\/.*)?$/.exec(t);
      if (varRef && assignVars.has(varRef[2]) && !(varRef[3] && varRef[3].includes(".."))) {
        t = assignVars.get(varRef[2])! + (varRef[3] ?? "");
      }
      if (t.startsWith("/") && !/[$`]/.test(t)) trackedCwd = t;
      continue; // cd 段自身非写段
    }
    if (judgeSegment(seg, trackedCwd === ctx.sessionCwd ? jctx : { ...jctx, sessionCwd: trackedCwd })) return true;
  }
  // 洞1d 补面：管道到 shell 且喂入内容含 one-liner 载荷（echo '…' | bash）
  if (/\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/.test(command) && ONELINER_PRE_GATE.test(command) && !oneLinerReadOnly) {
    return true;
  }
  // r1 严重 1 连带（预存洞）：子壳/命令组内 git 写族 fail-closed 收窄拦——
  // `(git commit)` 经剥壳重判已被上方段判定覆盖；本闸兜「壳内多命令」形态
  // （`{ git commit; git push; }`）与模型层不识命令组的缺口（parseOk=true 时
  //  V1 段判定链不跑——挂点见下方入口侧）。
  if (SUBSHELL_GIT_WRITE_GATE.test(command)) return true;
  return false;
}


/** F20261019gses P0 删除：MAIN_WRITE_PATTERNS / REDIRECT_PATTERN / GIT_WRITE_LITERAL_PATTERN /
 *  ONELINER_CHANNEL_PATTERNS / SUBSHELL_GIT_WRITE_GATE 的独立消费点（V1 写通道正则族——
 *  语义重叠面，evaluateWriteVerdict 落点语义覆盖；结构通道内的 git 写族段判定由
 *  checkSegmentStructuralWrite 内部正则承担）。*/

// ── #1207（F20260930l573）：heredoc 体感知判定（delta r1：豁免方向反转）──
// 根因：MAIN_WRITE_PATTERNS[1]（python heredoc patch 通道）按通道形态整体拦，
// 只读探查（open().read/print）与写补丁（open('w').write）共用同一通道形态被
// 无差别拦截（issue #1207 9/29 09:06 实时案例）。
// delta r1 修正（检视獭-1207 严重 1/2）：初版「写签名 denylist 不命中即豁免」是
// fail-open——别名 import / __import__ / getattr / pathlib unlink / 计算键等日常
// 形态 8/8 绕过（端到端利用链实证：真实 bash 写出文件、守卫判 ALLOW）。
// 反转为**只读白名单**：体被逐条确认为已知只读 API 才豁免，任何白名单外形态
// （含动态/别名/计算属性/未识别 API）→ 不豁免 → 通道拦截（fail-closed）。
// 白名单匹配用「分号/换行切分的子语句末表达式」而非全文体 search——
// 防「只读 API 前缀掩护同语句后半写操作」（read() if open('w') 型）。

/** heredoc 开行首词（跳过赋值前缀与 wrapper 词，basename 归一 /usr/bin/python3）——解释器判定用 */
function heredocInterpreter(header: string): string {
  const words = header.trim().split(/\s+/);
  let i = 0;
  while (i < words.length
    && (/^[A-Za-z_]\w*=/.test(words[i]) || ["sudo", "env", "nohup", "command", "nice", "exec", "time"].includes(words[i]))) i++;
  const w = words[i] ?? "";
  const base = w.includes("/") ? w.split("/").pop()! : w;
  return base;
}

const isPythonHeader = (header: string): boolean => /^python(?:\d+(?:\.\d+)?)?$/.test(heredocInterpreter(header));

/** 提取脚本语言 one-liner 的全部同型载荷（循环提取，非单次——S-2 修复）。
 *  只处理引号包裹的载荷实参（`python3 -c "…"` / `node -e '…'`）；
 *  任一载荷提取失败（无引号/未闭合/形态不识别）返回 null → 调用方保守拦（fail-closed）。
 *  多行载荷（引号内换行）同样提取——引号扫描用逐字符 escape 感知。 */
function extractOneLinerPayloads(command: string, interp: OneLinerInterp): string[] | null {
  const pattern = ONELINER_EXTRACT_PATTERNS[interp];
  pattern.lastIndex = 0;
  const payloads: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(command)) !== null) {
    const quote = m[1];
    let i = m.index + m[0].length;
    const start = i;
    while (i < command.length) {
      const ch = command[i];
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) break;
      i++;
    }
    if (i >= command.length) return null; // 未闭合引号 → 保守拦
    payloads.push(command.slice(start, i));
    pattern.lastIndex = i + 1; // 从闭合引号后继续找下一个同型载荷
  }
  return payloads.length > 0 ? payloads : null;
}

/** ruby/perl 只读白名单（S-5 fail-closed 起步：只读全拦，无豁免面）。
 *  后续如需放宽，按 python/node 同构建只读白名单（File.read/puts 等）。 */
function rubyPerlBodyReadOnly(_body: string): boolean {
  return false;
}

/** one-liner 载荷是否只读（python → pythonBodyReadOnly，node → nodeBodyReadOnly，
 *  ruby/perl → 全拦 fail-closed）。全部同型载荷提取成功且全部只读才豁免。 */
function oneLinerPayloadReadOnly(command: string): boolean {
  let sawPayload = false;
  for (const interp of ["python", "node", "ruby", "perl"] as const) {
    const payloads = extractOneLinerPayloads(command, interp);
    if (payloads === null) continue; // 该解释器无载荷或提取失败
    sawPayload = true;
    const readOnly = interp === "python"
      ? payloads.every(p => pythonBodyReadOnly(p))
      : interp === "node"
        ? payloads.every(p => nodeBodyReadOnly(p))
        : payloads.every(p => rubyPerlBodyReadOnly(p));
    if (!readOnly) return false;
  }
  return sawPayload;
}
const isNodeHeader = (header: string): boolean => /^node(?:\d+)?$/.test(heredocInterpreter(header));
const isShellHeader = (header: string): boolean => /^(?:bash|sh|zsh|dash|ksh)(?:\d+)?$/.test(heredocInterpreter(header));

/** python 只读白名单（F20260930l573 delta r1，可调用名门设计）：
 *  三道门全过才算只读——①体内出现的**所有**可调用名都在白名单集；②无危险
 *  属性接触面（`os` 模块访问面全量禁——os.kill/system/remove 与 os.getcwd 同以
 *  `os.` 开头，前缀扫描不可靠）；③无动态形态（__import__ / getattr / globals /
 *  eval / exec / 内联赋值 lambda / open 无 mode 或 mode 含 w/a/x/+）。
 *  否定检测先行（fail-closed 基线）+ 肯定白名单收口（豁免是例外）。
 *  语句切片只是为了提取「调用名」集合，不做逐行正则全匹配——切分边界
 *  （冒号/括号/字典）由门设计容错，不再依赖语句级完美切分。 */
const PY_READONLY_CALLS = new Set([
  "print", "open", "len", "range", "enumerate", "zip", "sorted", "reversed",
  "sum", "min", "max", "abs", "round", "str", "int", "float", "bool", "list",
  "dict", "set", "tuple", "isinstance", "repr", "hash", "id", "ord", "chr",
  "any", "all", "iter", "next", "filter", "map", "divmod", "pow",
  "re",       // re.findall/search/match/sub/compile 全只读
  "json",     // json.load/loads 只读；json.dump（写盘）由方法门拦（不在 METHODS）
  "Path", "PurePath", "PosixPath", "WindowsPath", // pathlib 构造只读；写面由方法门拦（unlink/write_text 等不在 METHODS）
  "glob",     // glob.glob/iglob 只读（delta 2 高频点：文件探查分析主形态）
  "pandas", "pd", "numpy", "np",  // 数据分析读面由方法门收口（read_csv 等白名单、to_csv 不在）
  "Counter", "defaultdict", "OrderedDict",  // #1416：collections 只读聚合器（构造面；写盘/执行面由方法门拦）
  "math", "ceil", "floor", "sqrt",  // #1416：math 纯计算模块（无 IO 面）
]);
const PY_READONLY_METHODS = new Set([
  "read", "readline", "readlines", "read_text", "read_bytes", "load", "loads", "dumps",
  "listdir", "getcwd", "stat", "exists", "isfile", "isdir", "islink", "walk",
  "getsize", "getmtime", "abspath", "realpath", "basename", "dirname", "join",
  "split", "splitext", "match", "search", "findall", "finditer", "subn",
  "groups", "group", "groupdict", "strip", "lstrip", "rstrip", "replace",
  "format", "lower", "upper", "title", "capitalize", "startswith", "endswith",
  "splitlines", "encode", "decode", "keys", "values", "items", "get", "copy",
  "index", "count", "find", "rfind", "append", "extend", "insert", "pop",
  "sort", "join", "isdigit", "isalpha", "isspace", "compile", "escape", "fullmatch",
  "glob", "iglob",                                                        // glob 模块只读 API（delta 2 高频点）
  "safe_load", "safe_load_all",                                           // yaml 定域化后的纯读面（delta 4，检视 Y6 建议）
  "read_csv", "read_json", "read_excel", "read_table", "read_parquet",    // pandas 读族（delta 2 高频点）
  "describe", "head", "tail", "info",                                    // DataFrame 只读探查
  "open",                                                                  // Path.open('r')——mode 由 ② 门独立把关
  "update",                                                                // #1416：set/dict.update——原地聚合非写盘（keys.update(x.keys()) 日常统计形态，今晨 dbe4f743 实证）
  "add",                                                                   // #1416：set.add——同上原地集合操作
  "most_common", "elements",                                              // #1416：Counter 只读探查面
]);

/** python 只读门 ②：open 调用的 mode 实参必须是字面 'r'/'rb' 或无（默认 'r'）。
 *  delta 3（检视 delta 2 终轮 (a) 类修）：mode 槽位（首参之后的任意位置实参）
 *  见裸标识符即不豁免——变量 mode（m='w'; open(p, m)）此前因检查正则误写
 * （\/ 应为 ,）全部漏过，open 即截断主仓文件。路径位裸标识符（open(p)）
 *  不构成写向量（无 mode 默认 'r'），保留豁免（E5 主形态可用性）。
 *  mode= 关键字：值必须字面 'r'/'rb'（变量值/写 mode 均拒）；
 *  其他关键字实参（encoding='utf-8' 等不影响可写性）字面值放行。 */
/** 按顶层逗号切分实参串（括号/引号感知——供 open mode 门分类判定用） */
function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr: string | null = null;
  for (const ch of args) {
    if (inStr) { cur += ch; if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** 单个位置实参是否可能携带变量 mode（裸标识符/表达式 → true；字面串/数字 → 查写 mode） */
function positionalArgMayBeVariableMode(p: string): boolean {
  if (/^(?:['"]|\d)/.test(p)) {
    const m3 = p.match(/^['"]([rwbax+]*)['"]/);
    if (m3 && !/^[rb]{1,2}$/.test(m3[1])) return true;                    // 字面写 mode
    return false;                                                        // 字面 'r'/'rb'/数字
  }
  return !/^[A-Za-z_]\w*\s*=/.test(p);                                   // 关键字实参不涉变量 mode；其余（裸标识符/表达式）→ true
}

/** python 只读门 ②：open 调用的 mode 实参必须是字面 'r'/'rb' 或无（默认 'r'）。
 *  delta 4（检视 delta 3 出口不变式 1/2 类修）：
 *  不变式 1（检测面 over-broad）：对 body 中**每一个** open( 子串做实参检查，
 *  不管前字符（.open(/p.open(/io.open(/builtins.open( 全部可见）——禁止用前字符
 *  正则收窄检测面（delta 3 的 (^|[^\w.]) 让 p.open( 整类不可见，比修复前更窄）。
 *  内建/方法签名用「匹配串是否以点开头」区分：方法 → 全部位置实参按 mode 槽位
 *  查；内建 → 首参是路径位（裸标识符不构成写向量——无 mode 默认 'r'），跳过。
 *  不变式 2（关键字白名单）：关键字仅接受 mode（值必须字面 'r'/'rb'）、
 *  encoding/errors/newline（值必须字面串）；其余（opener=/closefd=/mode=变量/
 *  **kwargs）一律不豁免（opener= 可携带任意 callable）。 */
const PY_OPEN_KNOWN_KEYWORDS = new Set(["mode", "encoding", "errors", "newline"]);

/** 关键字实参白名单判定（不变式 2）：仅 mode（字面 'r'/'rb'）与
 *  encoding/errors/newline（字面串）可接受；未知关键字（opener=/closefd=）/
 *  变量值/写 mode → false（不豁免）。非关键字实参返回 null（交位置判定）。 */
function keywordArgReadOnly(p: string): boolean | null {
  if (/^\*\*/.test(p)) return false;                                     // **kwargs 不可静态判
  const kw = p.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
  if (!kw) return null;
  if (!PY_OPEN_KNOWN_KEYWORDS.has(kw[1])) return false;                  // opener=/closefd=/未知关键字
  const v = kw[2].trim();
  if (kw[1] === "mode") return /^(?:['"][rb]{1,2}['"])$/.test(v);       // mode= 变量值/写 mode → false
  return /^(?:['"][^'"]*['"])$/.test(v);                                // encoding/errors/newline 值必须字面串
}

function pythonOpenModesReadOnly(body: string): boolean {
  // over-broad（不变式 1）：所有 open( 子串全查（含 .open( / p.open( / io.open( 等）
  for (const om of body.matchAll(/(\.?open)\s*\(([^)]*)\)/g)) {
    const isMethodCall = om[1].startsWith(".");
    const args = om[2];
    if (/\/\*/.test(args)) return false;                                 // 注释不可静态判
    // S1 修复（检视獭-1278b delta r3）：实参区见嵌套 `(` 即不豁免（fail-closed）——
    // [^)]* 遇嵌套括号截断，mode 实参整体不可见（open(chr(99),chr(119)) 穿透）。
    // 对齐 allow_pickle 门 delta 4 先例（:911 注释同文件同教训）。
    if (/\(/.test(args)) return false;
    let pathArgSeen = false;                                             // 内建签名首参 = 路径位标记
    for (const raw of splitTopLevelArgs(args)) {
      const p = raw.trim();
      if (p === "") continue;
      // S1 同族修复（检视獭-1278b delta r4）：位置实参遇 `*` 前缀（解包）→ fail-closed
      // 不豁免——mode 藏在解包元组里完全不可见（open(*a) 穿透，a=('f','w')）。
      // 对齐 :858 `**kwargs` 同款先例（解包不可静态判即拒）。
      if (/^\*/.test(p)) return false;
      const kwVerdict = keywordArgReadOnly(p);
      if (kwVerdict !== null) {
        if (!kwVerdict) return false;
        continue;
      }
      // 位置实参：方法签名全部是 mode 槽位；内建签名首参是路径位（裸标识符不构成写向量，跳过）
      if (isMethodCall || pathArgSeen) {
        if (positionalArgMayBeVariableMode(p)) return false;
      } else {
        pathArgSeen = true;
      }
    }
  }
  return true;
}

/** python 只读门 ④：模块接触面否定——os/sys 只放白名单子面，危险模块全禁。 */
function pythonModuleSurfaceReadOnly(body: string): boolean {
  if (/\bos\.\w/.test(body) && !/\bos\.(?:getcwd|listdir|walk|stat|path)\b/.test(body)) return false;
  if (/\bsys\.\w/.test(body) && !/\bsys\.(?:argv|stdin|stdout)\b/.test(body)) return false;
  // delta 2：csv 移出——无代码执行面（写盘由 open mode 门兜底），且文件名字面量
  // 'x.csv' 会被 \bcsv\b 误伤；pickle 保留（反序列化可执行 payload，只读也不行）
  // delta 3（检视 delta 2 终轮 (b) 类修）：反序列化执行面全禁——pickle 之外
  // 补 dill/joblib/shelve/marshal（yaml 定域化见下——safe_load 白名单化）；#1423 审视发现①：
  //  补 dbm——dbm.open 缺省 mode='c' 创建可写（pythonOpenModesReadOnly 假设缺省='r'
  //  的例外面），与 shelve/sqlite 同族数据库写模块，不入白名单直接拒
  if (/\b(?:fileinput|mmap|shutil|subprocess|socket|ctypes|pickle|sqlite|urllib|requests|http|ftplib|pty|dill|joblib|shelve|marshal|dbm)\b/.test(body)) return false;
  // delta 4（检视建议项）：yaml 定域化——safe_load 是配置读取高频只读形态
  // （检视 Y6 实证误拦），只禁 (unsafe_)?load(_all)?（子串级，无括号盲区，
  // 与不变式 3 同法）；safe_load/safe_load_all 等纯读面放行
  if (/\bimport\s+yaml\b|\bfrom\s+yaml\s+import/.test(body)) {
    if (/\byaml\s*\.\s*(?:unsafe_)?load(?:_all)?\s*\(/.test(body)) return false;
  }
  if (/\bimport\s+csv\b/.test(body)) return false; // csv 模块 import 仍拦（写入面不靠字面量）
  // delta 4（不变式 3）：allow_pickle 子串级——body 中出现（非紧邻 =False 字面）
  // 即不豁免，不做跨括号上下文匹配（delta 3 的 [^)]* 遇嵌套调用即停，
  // np.load(open(p,'rb'), allow_pickle=True) 穿过）
  if (/\ballow_pickle\b/.test(body) && !/\ballow_pickle\s*=\s*False\b/.test(body)) return false;
  if (/\ballow_pickle\s*=\s*[^F\s]/.test(body)) return false;             // allow_pickle 非 False 开头的形态保守拒
  return true;
}

function pythonBodyReadOnly(body: string): boolean {
  // ① 否定检测：动态/危险形态出现即非只读（别名/计算属性本质都是动态面）
  if (/[`\\]/.test(body)) return false;                                    // 反斜杠续行/转义不可静态判
  if (/\b(?:__import__|getattr|setattr|delattr|globals|locals|vars|eval|exec|compile|breakpoint)\b/.test(body)) return false;
  if (/\bimport\s+\w+\s+as\b/.test(body)) {
    // delta 2：社区标准固定别名放行（pandas as pd / numpy as np）——其余别名
    //（import os as o 等）仍不豁免（引用面失控）
    const am = body.match(/\bimport\s+(\w+)\s+as\s+(\w+)\b/g) ?? [];
    const ok = am.every(s => {
      const mm = s.match(/\bimport\s+(\w+)\s+as\s+(\w+)\b/)!;
      return (mm[1] === "pandas" && mm[2] === "pd") || (mm[1] === "numpy" && mm[2] === "np");
    });
    if (!ok) return false;
  }
  if (/\w\s*\[\s*['"][^'"]*['"]\s*\]\s*\(/.test(body)) return false;     // 计算键调用 obj['x'](...)
  if (/\blambda\b/.test(body)) return false;
  // ② open mode 门
  if (!pythonOpenModesReadOnly(body)) return false;
  // #1275：os 模块 import 面否定（one-liner 常见形态）——import os 即不豁免（保守拦）。
  // 建议 3：本门与 ④ 门（os 白名单子面）语义分叉是保守设计——import os 的完整面无法静态
  // 确认无写面调用（os.remove/system 与 os.getcwd 同以 os. 开头），from os import getcwd
  // 则可精确匹配只读子面。两语义并存：import 面保守拦，from-import 面按白名单放行。
  if (/\bimport\s+os\b/.test(body)) return false;
  // ③ 可调用名白名单收口：所有 callee 根名与尾方法名都在白名单集
  const dotted = [...body.matchAll(/\.\s*([A-Za-z_]\w*)\s*\(/g)].map(m2 => m2[1]);
  const bare = [...body.matchAll(/(?:^|[^\w.])\.?\s*([A-Za-z_]\w*)\s*\(/g)].map(m2 => m2[1]).filter(c => !dotted.includes(c));
  if (bare.some(c => !PY_READONLY_CALLS.has(c))) return false;
  if (dotted.some(c => !PY_READONLY_METHODS.has(c))) return false;
  // ④ 模块接触面门
  return pythonModuleSurfaceReadOnly(body);
}

/** node 只读白名单（同构可调用名门）：require 限 fs/util 只读面 +
 *  fs 只读 API + console + process 只读属性 + 纯 JS 数据语法。 */
const NODE_READONLY_METHODS = new Set([
  "readFileSync", "readFile", "existsSync", "statSync", "readdirSync",
  "readlinkSync", "realpathSync", "accessSync", "constants",
  "toString", "trim", "split", "slice", "join", "replace", "match", "concat",
  "toLowerCase", "toUpperCase", "includes", "indexOf", "charAt", "charCodeAt",
  "padStart", "padEnd", "repeat", "startsWith", "endsWith", "normalize",
  "log", "error", "warn", "info", "debug", "table", "keys", "values", "entries",
  "stringify", "parse", "from", "isArray", "push", "map", "filter", "reduce",
  "forEach", "flat", "sort", "reverse", "test", "exec",
  // F20261006gfpn (#1310)：path 模块只读 API（日常取证高频，无写面对应物）
  "basename", "dirname", "extname", "isAbsolute", "relative", "resolve",
  // F20261006gfpn (#1310)：process.cwd() 只读方法形态（dotted 门走方法白名单）
  "cwd",
  // #1416：EventEmitter.on——流式读取最常用形态（process.stdin.on('data',…)
  //  管道消费 curl/grep 输出的日常取证，今晨 90d8307f 实证）；监听器注册无
  //  写盘/执行面，回调体内的写调用仍被方法门/写词门拦
  "on",
  // #1432：Promise 链方法（import('./x').catch(…)）——链式方法无写面，
  //  回调体内的写调用仍被方法门/写词门拦
  "then", "catch", "finally",
]);

/** node 体只读白名单（F20260927madr，#1275）：node -e 日常取证（fs.readFileSync 等只读 API）
 *  放行——F20260905rwcb 防的是 exec 类执行旁路，不是「代码字符串含 kill 字样」。
 *  白名单法（fail-closed）：体由 require('fs') + 只读方法调用 + 字符串/数组处理构成才豁免。
 *  F20261006gfpn (#1310) 导出：供探针/测试直调（同基座对齐——豁免与拦截同一函数）。 */
export function nodeBodyReadOnly(body: string): boolean {
  // F20261006gfpn (#1310)：反斜杠放行（正则需要 \n 等转义），模板串仍拒（${} 展开面）
  if (/`/.test(body)) return false;
  if (/\b(?:eval|Function|setTimeout|setInterval)\b/.test(body)) return false;
  // #1432：import/require 目标只读豁免——纯字符串字面量目标是模块解析（固有只读，
  //  加载≠写落点）；动态拼接目标（import(p)/require('./a'+p)）不豁免（目标不可静态判定）。
  //  危险模块面（child_process 等）由下方词面禁独立拦；模块方法使用面由调用名白名单收口。
  //  目标表达式必须整体是纯字符串字面量——含拼接/变量/嵌套调用一律不豁免。
  for (const mm of body.matchAll(/(?:^|[^\w$.])(?:import|require)\s*\(\s*([^)]*)\)/g)) {
    if (!/^['"][^'"]*['"]$/.test(mm[1].trim())) return false;
  }
  // #1275：否定检测扩展——child_process/worker_threads/vm/net/http/https/fs.promises 全禁（执行/网络面）
  // F20261006gfpn (#1310)：process 面扩 env——NODE_ENV 等环境查询是日常只读高频
  if (/\bprocess\s*\.\s*(?!pid\b|platform\b|argv\b|version\b|cwd\b|stdout\b|stderr\b|env\b|stdin\b)/.test(body)) return false; // #1416：扩 stdin——流式消费面（process.stdin.on('data',…) 管道取证形态，今晨六连拦 90d8307f 实证）
  if (/\b(?:child_process|worker_threads|vm|net|http|https|fs\.promises)\b/.test(body)) return false;
  // 计算成员调用 obj['x'](...)——对 callee 名提取不可见，出现即不豁免（动态面）
  if (/\]\s*\(/.test(body)) return false;
  const dotted = [...body.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m2 => m2[1]);
  // F20261006gfpn (#1310)：bare 正则要求「标识符后紧跟 ( 且 ( 后非空格/等号」——
  // 原实现 `\s*\(` 允许标识符与 ( 之间有空格 → for/if/while 条件里的 ( 被误判为函数调用。
  // 修正：标识符后必须紧跟 (（无空格）才认调用，控制流词 for/if/while 不入 bare。
  const bare = [...body.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\(/g)].map(m2 => m2[1]).filter(c => !dotted.includes(c));
  //  #1432：import 入白名单——动态导入目标是模块解析（固有只读，目标字面量门在上文已把关）
  if (bare.some(c => !/^(?:console|JSON|Math|String|Number|Boolean|Array|Object|require|import|parseInt|parseFloat|isNaN)$/.test(c))) return false;
  for (const d of dotted) {
    if (!NODE_READONLY_METHODS.has(d)) return false;
  }
  if (/(?:write|append|unlink|rmdir|chmod|chown|rename|copy|mkdir|truncate|openSync|create)/i.test(body)) return false;
  return true;
}

/** 全部 heredoc 体均为「已闭合 + 解释器 + 只读白名单」→ true。
 *  bare（裸定界符）体仅在体不含 $ 与反引号时豁免（无展开面则 bare ≡ quoted；
 *  $(...) 命令替换是 bare 体的核心危险，出现即不豁免）。未闭合永不豁免。 */
function scriptBodiesReadOnly(command: string, check: (body: string) => boolean, isHeader: (h: string) => boolean): boolean {
  const spans = extractHeredocSpans(command);
  if (spans.length === 0) return false;
  return spans.every(sp => sp.closed && isHeader(sp.header) && check(sp.body)
    && (sp.quoted || !/[$`]/.test(sp.body)));
}

export function pythonHeredocBodiesReadOnly(command: string): boolean {
  return scriptBodiesReadOnly(command, pythonBodyReadOnly, isPythonHeader);
}




/** 主仓写检测（F20260922scwd）：未 cd 时拦截落点为主仓的写命令。
 *  与 #1038 数据破坏检测的差异：不跟踪 cd（感知对齐方案下 LLM 需显式 cd），
 *  只做「当前文本是否含主仓写形态」的静态判定——简单可靠，无状态。 */

/** F20261016grdl 1a'（G1 归因族 A治根）：运行时区域排除——判定基元下沉。
 *  data/workspaces（对话工作区）、.otter/worktrees（worktree）、.otter/workforms
 *  物理在主仓树内但语义不属「主仓工作树」——R1 允许写区，写判定不应看见。
 *  同源契约：区域清单与 write-target-evaluator.ts OTTER_RUNTIME_REGIONS
 *  （:124）语义同步，改动须两侧同步。M-cf899ad2 A′（2026-10-20）：两侧边界匹配语义
 *  已统一（本函数原生即精确名+子树，wv 侧同日跟进）。
 *  root 级锚定防 decoy：区域 = projectRoot/<region> 前缀精确锚定，
 *  主仓内 src/data/workspaces 之类的同名嵌套路径不匹配（G1 对照组）。 */
const MAIN_CHECKOUT_WRITE_EXEMPT_REGIONS = ["data/workspaces", ".otter/worktrees", ".otter/workforms"] as const;

function isInsideMainCheckout(target: string, projectRoot: string): boolean {
  // F20261019syml（M-ed285d7c）：symlink 穿透归一——写穿链（echo > <link>/f）真实落点
  //  判主仓；区基同 realpath（.otter/worktrees 本身是链时豁免面不塌）。
  const r = path.normalize(safeRealpath(projectRoot)).toLowerCase();
  const t = path.normalize(safeRealpath(target)).toLowerCase();
  if (!(t === r || t.startsWith(r + path.sep))) return false;
  // F20261016grdl 1a'：排除区下沉到基元——此前豁免以「通道×形态」散落修补
  // （redirect 相对路径 :2015 / 相对路径写 :2025 / git -C :1044），绝对路径形态
  // （heredoc cat >、字面落点）没有任何豁免分支，10/16 六例误拦族 A 的结构根因
  // （G1 归因报告族 A：healing 043bb7e9/2828e798/0765e2e7/bc49f605）。
  // 基元级下沉 = 三通道（redirect/字面/one-liner 锚）一次继承豁免。
  for (const region of MAIN_CHECKOUT_WRITE_EXEMPT_REGIONS) {
    const regionAbs = path.normalize(safeRealpath(path.join(projectRoot, region))).toLowerCase();
    if (t === regionAbs || t.startsWith(regionAbs + path.sep)) return false;
  }
  return true;
}

/** #1240（F20261006c1240）：heredoc 解释器判定（负门专用，python/node 双族）。
 *  isPythonHeader/isNodeHeader 是「首词语义」——`cd /tmp && python3 - <<'PY'` 的 header 首词是 cd，
 *  提取出 cd 非 python → 整链 filter 为空，负门失效（#1240 正是该形态）。
 *  本函数按 shell 语义取 header 中 `<<` 之前的最后一个命令段（&&/||/;/| 切分），
 *  对该段跑 heredocInterpreter——`cd /tmp && env python3 - <<'PY'` → 段 `env python3 -`
 *  → heredocInterpreter 跳过 wrapper 词 env → python（wrapper 形态同样识别）。
 *  #1308（F20261009cphr）：管道右段识别——`cat <<'PY' | python3 -` 的 header
 *  `<<` 前最后段是 cat，但体实际进入管道右段的 python 执行。按真管道（非 ||）切
 *  header，任一右段段首（跳 wrapper）是目标解释器 → 按解释器体判定。多级管道
 *  `cat <<PY | grep x | python3 -` 循环判定每个右段。tee/grep 等数据通道右段
 *  不命中（体不执行，语义归 #1304 数据体剥除）。
 *  保守侧：切不出段/段内提取非目标解释器 → false（不触发阻断，回到既有判定链）。 */
function heredocHeaderIsInterpreter(header: string, family: "python" | "node"): boolean {
  const beforeOpen = header.split(/<<-?/)[0] ?? "";
  const segs = beforeOpen.split(/&&|\|\||[;|]/).map(s => s.trim()).filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  const it = heredocInterpreter(last);
  if (family === "python" ? /^python(?:\d+(?:\.\d+)?)?$/.test(it) : /^node(?:\d+)?$/.test(it)) {
    return true;
  }
  // #1308：开行右段识别——`<<` 定界符之后的同头行剩余部分（`<<'PY' | python3 -` 的
  // `| python3 -`）。定界符域（段 0，`<<'PY'`）跳过，逐右段判定；真管道切分
  // lookaround 语义（单管道，`||` 短路或不是管道连接——右侧命令不执行，归段内文本），
  // 与通道 pattern[5]/[6] 及 hasRealCdSegment 的 lookaround 语义对齐（检视 r1 发现 2：
  // 初版把 `||` 当切分符，cd+短路或形态误拦且与无 cd 通道链判定相反）。
  const afterOpen = header.split(/<<-?/).slice(1).join("<<") ?? "";
  for (const seg of afterOpen.split(/(?<!\|)\|(?!\|)/).slice(1)) {
    const t = seg.trim();
    if (!t) continue;
    const segInterp = heredocInterpreter(t);
    if (family === "python" ? /^python(?:\d+(?:\.\d+)?)?$/.test(segInterp) : /^node(?:\d+)?$/.test(segInterp)) {
      return true;
    }
  }
  return false;
}

/** #1240：段感知版脚本 heredoc 体只读判定（python/node 双族）。
 *  pythonHeredocBodiesReadOnly/nodeHeredocBodiesReadOnly 用 isPythonHeader/isNodeHeader
 *  （首词语义）——`cd /tmp && python3 - <<'PY'` 形态下体判定失效返回 false（fail-closed）。
 *  该形态原靠顶层 cd 豁免放行，体判定结果从不被消费；#1240 负门触发后（体含绝对路径
 *  落主仓 → cd 豁免被阻断）体判定结果被负门直接消费（不再经通道正则接力）——必须用
 *  段感知版算出真实只读性，否则纯读探查被误拦（可用性回归）。
 *  体判定逻辑与 #1207 同构：python → pythonBodyReadOnly，node → nodeBodyReadOnly；
 *  混合族（python+node 多 heredoc）任一非只读 → false（fail-closed）；
 *  非解释器 heredoc（cat/tee 数据体）不参与判定（跳过）——与 blankDataHeredocBodies
 *  同语义：数据体无 shell 执行语义，非本族不属负门触发条件（负门仅锚解释器体），
 *  若要求非解释器体也「只读」则 python 只读 + cat 数据正道被误拦（检视 r1 P1）。 */
function scriptHeredocBodiesReadOnlySegmentAware(command: string): boolean {
  const spans = extractHeredocSpans(command);
  if (spans.length === 0) return false;
  return spans.every(sp => {
    if (!sp.closed) return false;
    const isPy = heredocHeaderIsInterpreter(sp.header, "python");
    const isNode = heredocHeaderIsInterpreter(sp.header, "node");
    if (!isPy && !isNode) return true; // 非解释器 heredoc（cat/tee 数据体）与体只读性无关，跳过
    const bodyOk = isPy ? pythonBodyReadOnly(sp.body) : nodeBodyReadOnly(sp.body);
    return bodyOk && (sp.quoted || !/[$`]/.test(sp.body));
  });
}

/** #1240（F20261006c1240）：python/node heredoc 体含「绝对路径落主仓」时阻断 cd 豁免。
 *  modelCdExemption 粒度是整条命令——`cd /tmp && python3 - <<'PY'…open('<repo>/data/x','w')…PY`
 *  的 cd 落点非主仓 → 顶层豁免放行，但 heredoc 体内绝对路径操作绕过 cwd 直达主仓（#1240 逃逸）。
 *  本函数是 cd 豁免的负门前置：任一 python/node heredoc 体（无论只读与否）出现绝对路径字面量
 *  且解析落主仓树 → 返回 true。
 *  检视 r1 处置（发现 1/2/4）：负门触发后不再依赖 MAIN_WRITE_PATTERNS[0] 通道正则接力——
 *  通道正则要求 `python[\d.]*\s+-\s*<<` 形态，wrapper（env/sudo python3）与无 `-` 形态
 *  负门正确触发却拦不住（拦截链解耦缺口）；node 侧 isNodeHeader 同型首词语义失效，
 *  checkHeredocScriptBodies 白名单门在 cd 前缀形态下同样失效（文档原论证失实）。
 *  调用方语义：负门 true && 体非只读 → 直接拦（体感知判定不依赖通道形态）；
 *  负门 true && 体只读 → 放行（纯读探查正道）；负门 false → 回到既有判定链。
 *  判定保守侧：路径解析失败/未闭合体不触发阻断（按既有体判定链处理，不扩面）。 */
function scriptHeredocAbsPathsInsideMain(command: string, projectRoot: string): boolean {
  const spans = extractHeredocSpans(command).filter(sp => sp.closed
    && (heredocHeaderIsInterpreter(sp.header, "python") || heredocHeaderIsInterpreter(sp.header, "node")));
  for (const sp of spans) {
    // 体内容里绝对路径字面量（POSIX/Windows 两类）；匹配后剥引号/空白归一
    const ABS_PATH = /(?:^|[\s'"=(,])(\/[A-Za-z0-9_~][A-Za-z0-9_~./\\-]*|[A-Za-z]:[\\/][^\s'"),]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = ABS_PATH.exec(sp.body)) !== null) {
      const raw = m[1];
      // POSIX 绝对路径才与本仓 projectRoot 同族可判；Windows 盘符路径在 mac/linux 主仓
      // 判定下永不落主仓（normalize 后不含 projectRoot 前缀）——直接跳过不阻断。
      if (!raw.startsWith("/")) continue;
      const resolved = raw; // 不词法折叠（F20261019syml 二轮）；isInsideMainCheckout 内 safeRealpath 收口
      if (isInsideMainCheckout(resolved, projectRoot)) return true;
    }
  }
  return false;
}

// r3：oneLinerReadOnlyOverride 为外部预计算的 one-liner 只读豁免（基座对齐——
// 豁免判定与拦截判定同一提取基座，差异只允许来自引号形式归一）。
// 缺省时函数内部自算（旧调用方兼容）；显式传入时以外部值为准。
/** checkMainCheckoutWrite 参数打包（#1285：max-params lint 约束——洞1 递归
 *  新增 depth 后参数超上限，与 HeredocJudgeCtx 同先例打包） */
interface MainCheckoutWriteCtx {
  command: string;
  logger?: Logger;
  projectRoot?: string;
  /** F20261014cwsp：session 工作目录——cwd 感知的写落点判定基准（重定向相对路径、
   *  cwd 内 git 写族）；缺省时退回旧行为（凡含写形态未 cd 即拦，仅限主仓 cwd 旧世界） */
  sessionCwd?: string;
  heredocReadOnly?: boolean;
  oneLinerReadOnlyOverride?: boolean;
  /** 洞1 bash -c 递归深度（默认 3，嵌套超深保守拦） */
  depth?: number;
  /** F20261016gsbx 二期 2b：="file-write" 时 main_write 文件写族退役（沙箱接防） */
  writeChannelSkip?: "file-write";
}

/** F20261019gses P0 路由切换后的主仓写判定（见下方 checkMainCheckoutWrite 本体）。 */

/** heredoc 体负门（后置兜底，S1 裁决方向 A 2026-10-19）：求值器 ALLOW 后兜
 *  wrapper/管道段 heredoc 载荷不入求值的残余（#1240/#1308 语义；cd 与无 cd 同语义，
 *  原则②——求值器 payload 附件根治面立 B issue）。按 shell 语义提取 heredoc 解释器
 *（wrapper/sudo、管道右段、cd 短链）识别 python/node 体——任一体含绝对路径字面量
 *  解析落主仓，或含动态源落点形态（os.environ/input/process.env——#1309 声明面），
 *  且体非只读 → 拦；体只读（纯读探查正道）/无负门面 → null 继续。只加拦不放行：
 *  上游求值器判 BLOCK 的不会到达此处。调用点已判 projectRoot 非空。 */
const PY_DYNAMIC_PATH_SOURCE = /\b(?:os\.)?environ\b|\bgetenv\s*\(|\binput\s*\(|\bsys\.argv\b/;
const NODE_DYNAMIC_PATH_SOURCE = /\bprocess\.env\b/;
function scriptHeredocBodiesTouchDynamicPathSource(command: string): boolean {
  for (const sp of extractHeredocSpans(command)) {
    if (!sp.closed) continue;
    if (heredocHeaderIsInterpreter(sp.header, "python") && PY_DYNAMIC_PATH_SOURCE.test(sp.body)) return true;
    if (heredocHeaderIsInterpreter(sp.header, "node") && NODE_DYNAMIC_PATH_SOURCE.test(sp.body)) return true;
  }
  return false;
}

function heredocWriteVeto(command: string, logger: Logger | undefined, ctx: GuardCwdCtx): string | null {
  // 调用点（checkMainCheckoutWrite）已判 projectRoot 非空才走到——非空断言收窄
  const projectRoot = ctx.projectRoot as string;
  const absPathVeto = scriptHeredocAbsPathsInsideMain(command, projectRoot);
  const dynamicVeto = !absPathVeto && scriptHeredocBodiesTouchDynamicPathSource(command);
  if (!absPathVeto && !dynamicVeto) return null;
  // 负门触发：体非只读 → 拦（写/执行签名）；体只读 → 放行（纯读探查正道）。
  // 两触发条件同构消费：绝对路径负门拦「可见落点」面，动态源负门拦「不可见落点」面。
  if (!scriptHeredocBodiesReadOnlySegmentAware(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED main-checkout write (heredoc body veto, post-eval backstop)", { command: command.substring(0, 200), dynamic: dynamicVeto });
    return rewriteMainWriteBlockMsg(ctx.sessionCwd);
  }
  return null;
}

/** F20261008h304（#1304）：数据型 heredoc 体等长隐去——cat/tee 等非解释器 heredoc 的体是
 *  纯文件内容，无 shell 执行语义；体内 git 写族/one-liner 字样是数据不是操作，主仓写
 *  判定不应看见（当日实拦：体含 `git stash push` 字样被当真写拦、体含 `node -e \"…\"`
 *  转义引号使载荷提取失败保守拦——healing 47c443e7/f80f7559）。
 *  判据全保守（任一不满足即保留原文 fail-closed）：① closed；② 非解释器头
 *  （python/node/bash 体是真执行面，保持可见由体级判定承担）；③ 开行无管道 |
 *  与命令替换 $()（`cat <<EOF | bash` 体经下游真执行，隐去即攻击面）；
 *  ④ quoted 定界或体无 $ `（裸定界体经 shell 展开可被解释）；⑤ 裸定界体无
 *  kill 词元——仅作用于裸定界（shell 可展开面）；quoted 数据体不查 kill：
 *  kill 族通道有独立的剥体基座（C2 探针对照实证，不消费本通道文本），
 *  对 quoted 体重复检查是纯负收益（delta r1 检视发现 1：体内运维笔记
 *  「kill 旧进程」字样被残留误拦，#1304 同族）。
 *  落点：仅 git 写族/one-liner 通道判定基座（与重定向通道既有的
 *  stripQuotedTextSpans 基座语义不同源，不共用）。 */
function blankDataHeredocBodies(command: string): string {
  const spans = extractHeredocSpans(command).filter(sp => sp.closed
    && !isPythonHeader(sp.header) && !isNodeHeader(sp.header) && !isShellHeader(sp.header)
    && !/[|]/.test(sp.header) && !/\$\(/.test(sp.header)
    && (sp.quoted || (!/[$`]/.test(sp.body) && !/\bkill\b/.test(sp.body))));
  if (spans.length === 0) return command;
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    out += command.slice(cursor, sp.start);
    out += " ".repeat(sp.end - sp.start);
    cursor = sp.end;
  }
  return out + command.slice(cursor);
}

/** F20261014cwsp：会话工作目录感知的主仓写拦截文案——统一工作区下獭 bash cwd=
 *  对话工作区，拦截语义从「位置判定」（未 cd 即拦）转为「落点判定」（解析后主仓内才拦）。
 *  sessionCwd 在场时给出落点语义文案；缺省（旧调用形态）保持原文案。 */
/** F20261014cwsp：会话工作目录感知的主仓写拦截文案。F20261019gses P0 结构化输出：
 *  verdict 的 mainHits 落点 / fail-closed 原因进文案。 */
function rewriteMainWriteBlockMsg(sessionCwd: string | undefined, verdict?: ReturnType<typeof evaluateWriteVerdict>): string {
  const detail = verdict === undefined
    ? ""
    : verdict.mode === "fail-closed"
      ? "（写落点求值不出，fail-closed）"
      : "mainHits" in verdict && verdict.mainHits !== undefined && verdict.mainHits.length > 0
        ? `（写落点：${verdict.mainHits.slice(0, 3).map(t => t.path).join("、")}${verdict.mainHits.length > 3 ? " 等" : ""}）`
        : "";
  if (sessionCwd) {
    return `写命令落点解析到主仓（session 工作目录=${sessionCwd}）被拦截${detail}——写代码/文档请用 worktree（.otter/worktrees/）绝对路径；写主仓受 R1 红线约束，请确认意图。`;
  }
  return MAIN_WRITE_BLOCK_MSG + detail;
}

 
function checkMainCheckoutWrite(ctx: MainCheckoutWriteCtx): string | null {
  const { command, logger, projectRoot, sessionCwd } = ctx;
  const depth = ctx.depth ?? 3;
  if (!projectRoot) return null; // 无 projectRoot 时保守放行（与 resolvesToMainData 同策略）
  // F20261019gses P0 路由切换：判定主体换 evaluateWriteVerdict（语义求值器）——
  // 主仓写判定这一类规则升级为语义判据（同一套 bash 守卫的规则更新，非双系统）。
  // S1 裁决（方向 A，2026-10-19 大獭拍板）：求值器先判 + 负门后置兜底——
  // 删除面：cd 豁免门先行 return（形态判覆盖落点判：`cd X && <写主仓>` 经
  // modelCdExemption→cdExemptionWithVeto 短路求值器，delta2 复核 S1 整条放行）。
  // 删除面（语义重叠，求值器落点语义覆盖）：MAIN_WRITE_PATTERNS 通道循环（git 写族
  // /heredoc/one-liner 正则）、REDIRECT_PATTERN 重定向落点、echo 敏感词豁免、
  // oneLinerReadOnly 预计算（正则只认通道形态不认落点）。
  // 保留面后置（互补非重叠——求值器无对应基座）：checkSegmentStructuralWrite
  // （包装词/子壳/管道喂 shell 的段首结构——sudo env python -c 写、timeout 5 node -e
  // 写的逃生面收口）与 heredoc 体感知（python/node 体白名单——kill/os.remove
  // 非重叠危险面）。
  // F20261016gsbx 二期 2b：沙箱接防时 main_write 文件写族退役（G3 枚举表门控）——
  // 求值器（文件写落点语义）与 heredoc 写面负门让位于沙箱 deny file-write* 物理接防；
  // 保留面（段结构 fail-closed/git 写族/data 破坏族/2c 窄规则）照跑；沙箱不可用=写面回位。
  if (ctx.writeChannelSkip !== "file-write") {
    // M-38fb45c0 B 面：解释器 stdin 喂入只读白名单正面证明结果线程进求值器（窄提取空集面
    //  只认正面证明放行——红线3）；fail-closed 归因映射在下方返回点（红线4 feed 口径）
    const feedReadOnly = interpreterFeedReadOnlyFlag(command);
    const verdict = evaluateWriteVerdict(command, projectRoot, sessionCwd ?? projectRoot, undefined, feedReadOnly);
    if (verdict.verdict === "BLOCK") {
      logger?.warn("[bash-safety-guard] BLOCKED main-checkout write (write-verdict)", {
        command: command.substring(0, 200),
        mode: verdict.mode,
        reason: verdict.mode === "fail-closed" ? verdict.reason : undefined,
        targets: "mainHits" in verdict ? verdict.mainHits?.slice(0, 5).map(t => `${t.access}:${t.path}`) : undefined,
      });
      // M-38fb45c0 红线 4：feed 形态的 fail-closed 归因走 feed 口径消息——不再被
      //  「落点为主仓的写命令」错定因带偏（写主仓 positive 归因仍走落点文案）
      return verdict.mode === "fail-closed" && interpreterFeedFormPresent(command)
        ? STDIN_INTERP_BLOCK_MSG
        : rewriteMainWriteBlockMsg(sessionCwd, verdict);
    }
    // 负门后置兜底（只加拦不放行，cd/无 cd 同语义——裁决原则②）：求值器 ALLOW 后
    // 兜 heredoc 体绝对路径/动态源写主仓（wrapper/管道段 heredoc 载荷不入求值的 Y 类
    // 残余——求值器 payload 附件根治面立 B issue 继续）；体只读/无负门面 → null 继续。
    const veto = heredocWriteVeto(command, logger, { projectRoot, sessionCwd });
    if (veto) return veto;
  }
  // 互补面后置：段首结构判定（包装词/子壳/管道——求值器无此基座，旧通道保留）。
  // 只读豁免保留（oneLinerPayloadReadOnly + wrappedOneLinerPayloadsReadOnly 双基座）——
  // 结构通道的拦截面是「包装形态下的 one-liner 写」，载荷只读仍是豁免面（求值器
  // 判 ALLOW 的只读载荷不应被结构通道重复拦——但写载荷求值器判 BLOCK 已在上方
  // 返回，此处只处理求值器 ALLOW 但结构通道命中写形态的残余——只读豁免同口径）。
  const oneLinerReadOnly = ONELINER_PRE_GATE.test(command)
    ? (oneLinerPayloadReadOnly(command) || wrappedOneLinerPayloadsReadOnly(command))
    : false;
  // git 写族段豁免：cwd 在显式 git 工作树内（sessionCwd 绝对路径锚定）时，git 写族
  // 段的落点是该树自身（旧链 cwdInGitWorktree 同语义——求值器已按落点判过 ALLOW，
  // 结构通道不再重复拦 git 写族段；包装词/子壳等其余段结构照常跑）。
  const GIT_WORKTREE_PREFIX = ".otter/worktrees";
  // F20261026dwtg delta2 复核严重 1（检视獭1636）案 B：扩面「真 git 树外」——sessionCwd
  //  爬升发现 .git 目录（树外本体 repo，git 写真落该树自身非主仓）同语义豁免；收窄面：
  //  爬升发现 .git 文件（linked worktree 卫星仓——gitdir 落主仓 .git/worktrees/<n>，
  //  stash/commit 实写主仓 gitdir，取舍 6 攻击面同族）不豁免（拦）。
  const approvedWorktreeCwd = sessionCwd !== undefined && path.isAbsolute(sessionCwd)
    && (path.normalize(sessionCwd) + path.sep).startsWith(path.normalize(path.join(projectRoot, GIT_WORKTREE_PREFIX)) + path.sep);
  const crawl = sessionCwd !== undefined && path.isAbsolute(sessionCwd)
    ? gitCrawlInfo(path.normalize(sessionCwd)) : null;
  const externalIndependentGit = crawl !== null && (() => {
    // 沙箱（data/workspaces）与主仓任意子目录不得因 pathWithinMain=false 获 git 豁免；
    // 仅 cwd 字面树外且实际 gitdir 不落主仓 .git 树时才扩独立仓/独立卫星豁免。
    const mainRoot = `${normalizePathForGuard(safeRealpath(projectRoot))}/`;
    const cwd = `${normalizePathForGuard(safeRealpath(sessionCwd!))}/`;
    if (cwd.startsWith(mainRoot)) return false;
    if (crawl.kind === "dir") return true;
    if (crawl.gitdir === null) return false;
    const mainGit = `${mainRoot}.git/`;
    return !(`${normalizePathForGuard(safeRealpath(crawl.gitdir))}/`.startsWith(mainGit));
  })();
  const cwdInGitWorktree = approvedWorktreeCwd || externalIndependentGit;
  if (checkSegmentStructuralWrite(blankDataHeredocBodies(command), oneLinerReadOnly, { logger, projectRoot, sessionCwd, depth, skipGitWrite: cwdInGitWorktree, writeChannelSkip: ctx.writeChannelSkip })) {
    logger?.warn("[bash-safety-guard] BLOCKED main-checkout write via wrapped one-liner (no cd)", { command: command.substring(0, 200) });
    // M-38fb45c0 红线 4：feed 形态命中（wget 写面未知落点等先手面）归因走 feed 口径
    return interpreterFeedFormPresent(command) ? STDIN_INTERP_BLOCK_MSG : rewriteMainWriteBlockMsg(sessionCwd);
  }
  // F20261020c2sm：stdin 喂入 shell 载荷判定（M-49a4909d C2 现存面）——管道静态载荷递归判
  //（与 bash -c 载荷同基座）/ 不透明源 fail-closed 正确定因 / 裸 bash 无写面放行
  const stdinVeto = stdinShellFeederVeto(command, depth, { logger, projectRoot, sessionCwd, writeChannelSkip: ctx.writeChannelSkip });
  if (stdinVeto !== null) return stdinVeto;
  return null;
}

// ── #1207（F20260930l573）：shell/node heredoc 体级判定（delta r1：白名单反转）──
// 初版 node 体用危险签名 denylist（不命中即放行）——计算键 p['k'+'ill'] /

// ── #1207（F20260930l573）：shell/node heredoc 体级判定（delta r1：白名单反转）──
// 初版 node 体用危险签名 denylist（不命中即放行）——计算键 p['k'+'ill'] /
// require()['w'+'riteFileSync'] 等 JS 日常形态绕过（检视獭探针实证），且「V1
// OnText 挂点」声明失实。delta r1：node 体反转为只读白名单（白名单外一律拦，
// fail-closed）；挂点：统一入口 + PID 缺失路径 + V1 OnText 链（delta 2 订正：
// 初版注释「V1 OnText 不挂」为 stale 残留，实际已挂载于 checkBashCommandSafetyOnText——
// 剥体输入 extractHeredocSpans 只命中空白体自然 no-op；未闭合保留原文时体判定生效）。
// bash/sh/zsh 体是真执行 shell 脚本 → 递归 V1 全量判定（语义精确：体段位判定
// 与顶层一致，echo kill N 的数据位词元不误拦）；体中嵌套 shell 解释器 heredoc
// 不递归判定，出现即拦（delta 2 措辞订正：非「限深一层后拦」——depth=1 时内层
// shell 体即触发超深分支保守拦，行为为「嵌套即拦」，与 fail-closed 方向一致）。

const NODE_HEREDOC_BODY_MSG = "bash 命令通过 heredoc 向 node 传入非白名单只读形态的脚本体，无法静态确认其安全。该命令不允许：分析类脚本请限定在 fs 只读 API（readFileSync/existsSync/statSync 等）+ console 输出，或落盘到 /tmp 后审阅执行；确需其他形态时告知搭档人工执行。";
const SHELL_HEREDOC_BODY_MSG = "bash 命令通过 heredoc 向 shell 传入的脚本体中检测到危险操作（体内容会被直接执行）。该命令不允许：若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop/start；请把体内容拆成独立命令或落盘 /tmp 后审阅执行；确需此形态时告知搭档人工执行。";

/** heredoc 体级判定的调用上下文（参数打包——max-params lint 约束） */
interface HeredocJudgeCtx {
  mainPid: number;
  logger?: Logger;
  allowedServices: AllowedService[];
  projectRoot?: string;
  /** F20261014cwsp：session 工作目录（透传供壳体递归 V1 链的 cwd 感知判定） */
  sessionCwd?: string;
  /** F20261016gsbx 二期 2b：写面退役标记透传（壳体递归 V1 链的写判定） */
  writeChannelSkip?: "file-write";
}

/** shell 体分支：递归体级判定（限深）+ V1 全量链；命中返回拦截文案 */
function judgeShellHeredocBody(sp: { header: string; body: string }, ctx: HeredocJudgeCtx, depth: number): string | null {
  if (depth <= 0) {
    return `${SHELL_HEREDOC_BODY_MSG}\n【体内命中】shell 体嵌套超过判定深度上限（保守拦）`;
  }
  const inner = checkHeredocScriptBodies(sp.body, ctx, depth - 1);
  const r = inner ?? checkBashCommandSafetyOnText(sp.body, ctx.mainPid, ctx.logger, ctx.allowedServices, { projectRoot: ctx.projectRoot, sessionCwd: ctx.sessionCwd, writeChannelSkip: ctx.writeChannelSkip });
  if (r) {
    ctx.logger?.warn("[bash-safety-guard] BLOCKED dangerous op in shell heredoc body", { header: sp.header.substring(0, 80) });
    return `${SHELL_HEREDOC_BODY_MSG}\n【体内命中】${r.split("\n")[0]}`;
  }
  return null;
}

/** heredoc 体级判定（delta r1）：shell 体递归 V1 全量链；python 体由主仓写检测
 *  的只读白名单豁免路径承担；node 体非 shell 语法无法递归 → 只读白名单反向豁免
 *  （白名单外一律拦）。挂点：统一入口 + checkWhenMainPidMissing + V1 OnText 链
 *  （剥体输入自然 no-op；未闭合保留原文时体在场生效）。 */
function checkHeredocScriptBodies(command: string, ctx: HeredocJudgeCtx, depth = 1): string | null {
  for (const sp of extractHeredocSpans(command)) {
    if (isShellHeader(sp.header)) {
      const hit = judgeShellHeredocBody(sp, ctx, depth);
      if (hit) return hit;
      continue;
    }
    if (isPythonHeader(sp.header)) {
      // F20261019gses P0：python 体判定与 node 同构化——旧链靠 mainWrite 的 python
      // heredoc 通道形态拦截（pythonBodyReadOnly fail-closed），路由切换后通道删除，
      // 体感知白名单判定归位到本函数（kill/os.remove/shutil.rmtree 等非重叠危险面在
      // 白名单外拦；写落点语义已由 evaluateWriteVerdict 判过，此处只看非重叠面）。
      // 与 mainWrite 同口径：无 projectRoot 时不判（链头「无 projectRoot 保守放行」约定，
      // 体判定不扩大无 root 场景的拦截面——guard-v2-behavior 无 opts 用例口径）。
      if (ctx.projectRoot === undefined) continue;
      if (!(sp.closed && pythonBodyReadOnly(sp.body) && (sp.quoted || !/[$`]/.test(sp.body)))) {
        ctx.logger?.warn("[bash-safety-guard] BLOCKED non-readonly python heredoc body", { header: sp.header.substring(0, 80) });
        return NODE_HEREDOC_BODY_MSG.replace("node", "python");
      }
      continue;
    }
    if (isNodeHeader(sp.header) && !(sp.closed && nodeBodyReadOnly(sp.body) && (sp.quoted || !/[$`]/.test(sp.body)))) {
      ctx.logger?.warn("[bash-safety-guard] BLOCKED non-readonly node heredoc body", { header: sp.header.substring(0, 80) });
      return NODE_HEREDOC_BODY_MSG;
    }
  }
  return null;
}

// ──────────── F20261016gsbx 二期 2c：保留面窄规则（R1 直推 + .git 直写 + S5 网络外发）────────────
// 与写面退役无关（沙箱对网络/gitDir 全放），双路径恒跑；自带拦截消息（判定说真话，
// 不借道写面文案）。走查复用写面同款原语（切段/落点解析/shell -c 载荷递归/尾段重判），
// argv 落点判定——引号内提及（echo 'git push origin main'）不误拦。
// 声明边界：one-liner（node -e 等）载荷内嵌套 shell 字符串不追（#1513 间接构造同界）；
// 词包装首词不在落点解析器（xargs curl）不追；数据 heredoc 体是数据不是操作。

/** 受保护分支集（R1：main/develop/生产分支禁止直推）；命中即拦，不分 cwd。 */
const PROTECTED_PUSH_BRANCHES = new Set(["main", "master", "develop", "production", "prod"]);

const PROTECTED_PUSH_BLOCK_MSG = "git push 目标含受保护分支、动态 refspec 或 --all/--mirror 不可枚举多引用形态——R1 红线：禁止直推受保护分支，请走 feature 分支 + PR（git push -u origin feature/xxx 字面 refspec）；确需批量/镜像推送请呈搭档确认后人工执行。";

/** S5 网络外发白名单（合法 POST 目标）：项目自身 MCP 端点 + 回环；扩展=改本常量走 PR。 */
const NETWORK_EXFIL_WHITELIST = ["huawei-colink.com", "localhost", "127.0.0.1", "::1"];

const NETWORK_EXFIL_BLOCK_MSG = "检测到向非白名单目标 POST/PUT 上传数据（S5 密钥外发面预判）。合法外发目标请登记 NETWORK_EXFIL_WHITELIST（含项目 MCP 端点 huawei-colink.com/回环）或改用 MCP/项目工具通道；确需临时外发请呈搭档确认后人工执行。";

/** 2c 窄规则通用走查：命令文本 → 原子（段/壳内/shell -c 载荷/命令替换），逐原子 probe。
 *  probe 返回消息 = 命中；depth 限递归（与写面递归同保守面）。 */
function narrowRuleWalk(command: string, depth: number, probe: (segText: string) => string | null): string | null {
  if (depth <= 0) return null;
  for (const rawSeg of splitShellSegments(blankDataHeredocBodies(command))) {
    const hit = narrowWalkAtom(stripSubshellWrap(rawSeg), depth, probe);
    if (hit) return hit;
  }
  return null;
}

/** shell -c 形态落点定位（段首解析器 + 包装词定位，与写面 ③d 同口径）。 */
function locateShellCOffset(seg: string): number {
  const parsed = parseSegmentHead(seg);
  if (parsed !== null && SHELL_INTERP_NAMES.has(parsed.head.replace(/\d+$/, ""))) return parsed.offset;
  const m = /\b((?:[\w./-]*\/)?(?:bash|sh|zsh|dash|ksh)\d*)\s+-c\s/i.exec(seg);
  return m && m.index !== undefined ? m.index : -1;
}

/** 单原子（段）走查：probe → shell -c 载荷/尾段递归 → 命令替换递归。 */
function narrowWalkAtom(seg: string, depth: number, probe: (segText: string) => string | null): string | null {
  const hit = probe(seg);
  if (hit) return hit;
  const shellOffset = locateShellCOffset(seg);
  if (shellOffset >= 0) {
    const ex = extractShellCPayload(seg, shellOffset);
    if (ex.kind !== "FILE" && ex.kind !== "FAIL_CLOSED") {
      const inner = narrowRuleWalk(ex.payload, depth - 1, probe);
      if (inner) return inner;
      const tail = seg.slice(ex.consumedEnd).trim();
      return tail ? narrowRuleWalk(tail, depth - 1, probe) : null;
    }
  }
  // 命令替换递归（`X=$(curl -X POST …)`——$()/反引号内是执行面）
  for (const m of seg.matchAll(/\$\(([^()]*)\)|`([^`]+)`/g)) {
    const sub = narrowRuleWalk(m[1] ?? m[2] ?? "", depth - 1, probe);
    if (sub) return sub;
  }
  return null;
}

/** git 旗标/取值旗标消费 → 子命令位（与 payload-extract-aux.gitWriteSubcommandHit 同语义）。 */
function gitSubcommandIndex(words: { evaluated: string | null }[]): number {
  let i = 1;
  while (i < words.length) {
    const w = words[i].evaluated;
    if (w === null) return -1; // 动态词位——间接构造不追（#1513 同界）
    if (GIT_VALUE_FLAGS.has(w)) {
      const nxt = words[i + 1]?.evaluated ?? null;
      i += words[i + 1] !== undefined && !(nxt ?? "").startsWith("-") ? 2 : 1;
      continue;
    }
    if (w.startsWith("-")) { i++; continue; }
    return i;
  }
  return -1;
}

/** refspec 是否指向受保护分支（dst 侧；无冒号=同名 dst）。 */
function refspecHitsProtectedBranch(refspec: string): boolean {
  const rs = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  const colon = rs.indexOf(":");
  const dst = colon >= 0 ? rs.slice(colon + 1) : rs;
  if (dst === "") return false;
  const name = dst.replace(/^refs\/heads\//, "");
  return PROTECTED_PUSH_BRANCHES.has(name.toLowerCase());
}

/** R1 窄规则探针：git push 直推受保护分支（词级 refspec 判定）。
 *  静态命中受保护 refspec → 拦；refspec 位动态词 → fail-closed（R1 红线不盲跑）；
 *  bare push（无 refspec）不动（保留面语义——feature 分支推送是合法正道）。 */
function protectedPushHit(segText: string): string | null {
  const parsed = parseSegmentHead(segText);
  if (parsed === null || parsed.head !== "git") return null;
  const gseg = parseOnce(segText.slice(parsed.offset), 1).segments[0] ?? null;
  if (gseg === null || gseg.argv0 !== "git") return null;
  const words = gseg.words;
  const subIdx = gitSubcommandIndex(words);
  if (subIdx < 0 || words[subIdx]?.evaluated !== "push") return null;
  // 既有语义继承（r2-C）：--dry-run/-n 不产生写效果——与 isWriteVerbAt 同口径（只看紧邻词）
  const nextAfterPush = words[subIdx + 1]?.evaluated ?? null;
  if (nextAfterPush === "--dry-run" || nextAfterPush === "-n") return null;
  let sawRemote = false;
  for (let i = subIdx + 1; i < words.length; i++) {
    const w = words[i].evaluated;
    if (w === null) {
      if (sawRemote) return PROTECTED_PUSH_BLOCK_MSG; // refspec 位动态——目标不可校验，fail-closed
      continue; // remote 位动态可容忍（remote 名不等于目标分支）
    }
    // 审视严重2（delta 1）：--all/--mirror 引用集不可枚举（--all 会把 main 一并推上
    // origin=直推；--mirror 含 refs/heads/*）——与动态 refspec 同款 fail-closed。
    // --delete 不在此列：冻结双签口径「git push --delete（远端目标）非写」（corpus 条目
    // 6c93a372/61d75232 等钉 worktree→ALLOW），受保护 refspec/动态组合已被下文覆盖。
    if (w === "--all" || w === "--mirror") return PROTECTED_PUSH_BLOCK_MSG;
    if (w === "-o" || w === "--push-option") { i++; continue; } // 取值旗标吞值
    if (w.startsWith("-")) continue;
    if (!sawRemote) { sawRemote = true; continue; } // 首个非旗标词=remote
    if (refspecHitsProtectedBranch(w)) return PROTECTED_PUSH_BLOCK_MSG;
  }
  return null;
}

/** .git 目录/文件路径段判定（任何仓根的 .git——主仓/worktree 共享 gitDir，路径段比 root 锚定多盖伪相对路径）。 */
function gitDirPathHit(p: string): boolean {
  return /(^|\/)\.git(\/|$)/.test(p);
}

const GIT_DIR_WRITE_BLOCK_MSG = "落点为 .git 内文件的写操作恒拦（git 元数据直写=HEAD/config/refs 操纵面；不经 git 命令的 .git 文件写与 git 写族同辖，沙箱 .git 白名单不构成许可）。请改用 git 命令操作仓库；确需动 .git 元数据请呈搭档确认。";

/** 写 API 实参正则（open/writeFileSync 等，抽取实参路径供 gitDirPathHit 判）。 */
const WRITE_API_CALL = /(?:^|[^\w.])(?:with\s+)?(?:[A-Za-z_]\w*\s*=\s*)?(?:open|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|File\.(?:open|write|open3)|IO\.(?:write|binwrite))\s*\(\s*(['"])([^'"]+)\1/;

/** 审视严重1探针（delta 1）：.git 落点写恒拦（双路径恒跑）——重定向落点（词级+剥引号裸文本双扫）
 *  + tee 实参 + 译器载荷内写 API 实参（head 门控防 echo 引号提及误拦）。
 *  边界：rm 等破坏形归 data 破坏族（含 corpus 3b399252 双签条件口径）；cp/dd 等间接写不追。 */
function gitDirWriteHit(segText: string): string | null {
  // ① 重定向落点：词级（引号精确）
  const seg = parseOnce(segText, 2).segments[0] ?? null;
  if (seg) {
    for (let i = 0; i < seg.words.length - 1; i++) {
      const w = seg.words[i].evaluated;
      const nxt = seg.words[i + 1].evaluated;
      if (w !== null && /^>{1,2}$|^\d+>{1,2}$/.test(w) && nxt !== null && gitDirPathHit(nxt)) return GIT_DIR_WRITE_BLOCK_MSG;
    }
  }
  // ①b 粘连形态（hack>/x/.git/y）：剥引号文本正则扫（引号提及已剥，不误拦）
  const stripped = stripQuotedTextSpans(segText);
  for (const m of stripped.matchAll(/(?:^|[^>=-])>{1,2}\s*([^\s;|&]+)/g)) {
    if (gitDirPathHit(m[1])) return GIT_DIR_WRITE_BLOCK_MSG;
  }
  // ② tee 实参（词级 evaluated）
  const parsed = parseSegmentHead(segText);
  if (parsed && parsed.head === "tee" && seg) {
    for (const word of seg.words) {
      if (word.evaluated !== null && gitDirPathHit(word.evaluated)) return GIT_DIR_WRITE_BLOCK_MSG;
    }
  }
  // ③ 写 API 实参：译器头（python/node/ruby/perl -c 载荷）或裸语句形态（heredoc 体行）
  const headIsInterp = parsed !== null && SCRIPT_RUNNERS.has(parsed.head.replace(/\d+$/, ""));
  const stmtStart = /^\s*(?:with\s+)?(?:[A-Za-z_]\w*\s*=\s*)?(?:open|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|File\.(?:open|write|open3)|IO\.(?:write|binwrite))\s*\(/.test(segText);
  if (headIsInterp || stmtStart) {
    for (const m of segText.matchAll(new RegExp(WRITE_API_CALL.source, "g"))) {
      if (gitDirPathHit(m[2])) return GIT_DIR_WRITE_BLOCK_MSG;
    }
  }
  return null;
}

/** 目的地址是否白名单（回环 + 项目 MCP 端点；子域同享）。 */
function networkDestWhitelisted(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return NETWORK_EXFIL_WHITELIST.some(w => h === w || h.endsWith("." + w));
}

/** curl/wget 上传动词判定（抽函数控 max-statements）：POST/PUT 上传族全形态。 */
function uploadVerbHit(head: string, words: { evaluated: string | null }[]): boolean {
  const isCurl = head === "curl";
  for (let i = 0; i < words.length; i++) {
    const w = words[i].evaluated;
    if (w === null) continue;
    if (isCurl) {
      if (w === "-X" || w === "--request") {
        const v = (words[i + 1]?.evaluated ?? "").toUpperCase();
        if (v === "POST" || v === "PUT") return true;
      } else if (/^(?:-X|--request=)(?:POST|PUT)$/i.test(w)) {
        return true;
      } else if (w === "-d" || w === "-F" || w === "-T" || /^--(?:data|form|upload-file|json)/.test(w)) {
        return true;
      } else if ((/^-\w$/.test(w) && /[dFT]/.test(w.slice(1))) || /^-[dFT]\S/.test(w)) {
        return true; // 短参簇/attached 值形（-sSd / -d@f / -Ff=@x）
      }
    } else {
      if (/^--post-(?:data|file)/.test(w) || /^--method=(?:POST|PUT)$/i.test(w)) return true;
      if (w === "--method") {
        const v = (words[i + 1]?.evaluated ?? "").toUpperCase();
        if (v === "POST" || v === "PUT") return true;
      }
    }
  }
  return false;
}

/** S5 窄规则探针：POST/PUT 上传族 + 非白名单目的（密钥外发面预判）。
 *  上传动词 + 无可静态校验的目的 → fail-closed；GET/下载面不动（窄规则）。 */
function networkExfilHit(segText: string): string | null {
  const parsed = parseSegmentHead(segText);
  if (parsed === null || (parsed.head !== "curl" && parsed.head !== "wget")) return null;
  const gseg = parseOnce(segText.slice(parsed.offset), 1).segments[0] ?? null;
  if (gseg === null) return null;
  const words = gseg.words;
  if (!uploadVerbHit(parsed.head, words)) return null;
  const hosts: string[] = [];
  for (const word of words) {
    const w = word.evaluated;
    if (w === null) continue;
    const um = /^https?:\/\/(?:[^@\s/]*@)?(\[[^\]]+\]|[^/:\s]+)(?::\d+)?/.exec(w.replace(/^--url=/, ""));
    if (um) hosts.push(um[1]);
  }
  if (hosts.length === 0) return NETWORK_EXFIL_BLOCK_MSG; // 上传但目的不可静态校验——fail-closed
  return hosts.every(networkDestWhitelisted) ? null : NETWORK_EXFIL_BLOCK_MSG;
}

/** 2c 窄规则唯一实现点（checkBashCommandSafety 入口 + checkPidIndependentRules 递归面共用）。 */
function checkNarrowRules(command: string, logger?: Logger): string | null {
  const push = narrowRuleWalk(command, 3, protectedPushHit);
  if (push) {
    logger?.warn("[bash-safety-guard] BLOCKED protected-branch push (R1 narrow)", { command: command.substring(0, 200) });
    return push;
  }
  const gitDirWrite = narrowRuleWalk(command, 3, gitDirWriteHit);
  if (gitDirWrite) {
    logger?.warn("[bash-safety-guard] BLOCKED .git direct write (R1-adjacent narrow)", { command: command.substring(0, 200) });
    return gitDirWrite;
  }
  const exfil = narrowRuleWalk(command, 3, networkExfilHit);
  if (exfil) {
    logger?.warn("[bash-safety-guard] BLOCKED network exfil upload (S5 narrow)", { command: command.substring(0, 200) });
    return exfil;
  }
  return null;
}

/** F20260922pmgd：不依赖 mainPid 的独立规则合集（PR 合入 + data 破坏）——
 *  抽出供 checkBashCommandSafetyOnText 与 checkWhenMainPidMissing 共用（圈复杂度控制）。 */
function checkPidIndependentRules(command: string, logger: Logger | undefined, ctx: GuardCwdCtx): string | null {
  const prMerge = checkPrMergeCommand(command, logger);
  if (prMerge) return prMerge;
  // F20261016gsbx 二期 2c 保留面窄规则（R1 直推 + .git 直写 + S5 网络外发）——与写面退役
  //  无关恒跑；自带消息（判定说真话）。实现单点 checkNarrowRules，此处为 OnText 递归面
  // （heredoc/子壳体）的入口镜像（与既有规则族同放置模式）。
  const narrow = checkNarrowRules(command, logger);
  if (narrow) return narrow;
  const preGate = ONELINER_PRE_GATE.test(command);
  const oneLinerReadOnly = preGate
    ? oneLinerPayloadSet(command) !== null
    : false;
  const mainWrite = checkMainCheckoutWrite({ command, logger, projectRoot: ctx.projectRoot, sessionCwd: ctx.sessionCwd, oneLinerReadOnlyOverride: oneLinerReadOnly, writeChannelSkip: ctx.writeChannelSkip });
  if (mainWrite) return mainWrite;
  return checkDataDirDestructive(command, logger, ctx);
}


function checkWhenMainPidMissing(
  command: string,
  logger?: Logger,
  guardOptions?: GuardOptions,
): string | null {
  const scriptKill = checkServiceScriptKill(command, 0, logger, guardOptions?.projectRoot);
  if (scriptKill) return withDiagnostics(scriptKill, command, null);
  // F20260922pmgd / #1038：PR 合入与 data 破坏判定不依赖 mainPid（与 kill 族保守放行的
  // 差异：只需命令文本/projectRoot，无退化理由）
  const pidFree = checkPidIndependentRules(command, logger, { projectRoot: guardOptions?.projectRoot, sessionCwd: guardOptions?.sessionCwd, writeChannelSkip: guardOptions?.sandboxGuarded ? "file-write" : undefined });
  if (pidFree) return withDiagnostics(pidFree, command, null);
  // #1207（F20260930l573）：heredoc 体级判定不依赖 PID（shell 体递归在 PID=0 下
  // 与 V1 主链同口径保守放行 kill，不引入额外缺口）
  const bodyHit = checkHeredocScriptBodies(command, { mainPid: 0, logger, allowedServices: [], projectRoot: guardOptions?.projectRoot, sessionCwd: guardOptions?.sessionCwd, writeChannelSkip: guardOptions?.sandboxGuarded ? "file-write" : undefined });
  return bodyHit ? withDiagnostics(bodyHit, command, null) : null;
}

/** F20260916gtlr：脱敏扫描路径（#858）——抽为独立函数控制主入口圈复杂度。
 *  脱敏后干净（纯数据操作）→ 返回 null 信号外层直接放行；仍命中 → 继续原文本路径。 */
 
function checkSanitizedPath(
  command: string,
  mainPid: number,
  logger: Logger | undefined,
  allowedServices: AllowedService[],
  ctx: GuardCwdCtx,
): string | null | undefined {
  if (!shouldSanitizeForScan(command)) return undefined;
  return checkBashCommandSafetyOnText(sanitizeQuotedText(command), mainPid, logger, allowedServices, ctx);
}

/* eslint-disable complexity, max-statements -- V1/V2 双链路由是本入口的本质形态（模型路径+兜底路径+规则补位）；F20261014cwsp：sessionCwd 提取 +1 语句 +1 分支 */
export function checkBashCommandSafety(
  command: string,
  mainPid: number | null,
  logger?: Logger,
  guardOptions?: GuardOptions,
): string | null {
  if (!command.trim()) return null;
  // F20261016gsbx 二期 2c：保留面窄规则（R1 直推/.git 直写 + S5 网络外发）在双链分派前
  //  统一执行（唯一实现点 checkNarrowRules；V2 模型链不跑 checkPidIndependentRules，
  //  V1 脱敏快路径会把引号载荷当数据——故在此入口处先判）。
  const narrowHit = checkNarrowRules(command, logger);
  if (narrowHit) return withDiagnostics(narrowHit, command, mainPid);
  if (mainPid === null) return checkWhenMainPidMissing(command, logger, guardOptions);

  // #844：白名单热加载（与 PID 文件同策略：每次判定重读，mtime 缓存去抖）
  const allowedServices = guardOptions?.projectRoot ? loadAllowedServicePorts(guardOptions.projectRoot) : [];
  const projectRoot = guardOptions?.projectRoot;
  const sessionCwd = guardOptions?.sessionCwd;
  // F20261016gsbx 二期 2b：沙箱接防位（GuardOptions.sandboxGuarded，session 创建点绑定）
  //  → main_write 文件写族退役标记（唯一入口换算，全链透传）
  const writeChannelSkip = guardOptions?.sandboxGuarded ? ("file-write" as const) : undefined;

  // F20260928grv2（guard-v2-redesign）：统一结构模型判定层——kill 族/管道到 shell/
  // U1 kill 0/U5 bash<file 由模型层承担（#1170 管道豁免误杀、#1171 文本误伤、
  // 位置参数/$VAR 传参等判定语义随模型继承）。parseOk=false（未闭合引号/$(/heredoc/
  // 深度超限）时走 V1 文本链全量兜底（D3：kill 族解析失败必拦，兜底链语义=V1 保守侧）。
  // F20261015gali（M-edd889c2）：git alias shell 展开注入在模型判定前先跑（真执行体
  // 载荷拆解，宪法 L4 bypass_guard）——载荷递归走 checkBashCommandSafety 全量规则链。
  const aliasHitMain = checkGitAliasShellInjection(command, mainPid, logger, guardOptions);
  if (aliasHitMain) return withDiagnostics(aliasHitMain, command, mainPid);
  // 模型判定通过时：kill 族文本判定不再重复跑（模型已判干净，重复文本扫描是
  // 8000 段/528KB 病态输入的性能热点）——但模型层未覆盖的 PID 无关规则
  //（脚本自杀/PR merge/data 破坏/主仓写）仍在文本路径执行（映射表「保留」项）。
  const modelOk = modelParseOk(command);
  if (modelOk) {
    const modelResult = checkWithModel(command, mainPid, logger, allowedServices, projectRoot);
    if (modelResult) return withDiagnostics(modelResult, command, mainPid);
    // 模型已放行 kill 族——只补模型层没有的规则（脚本自杀/data 破坏/主仓写；
    // PR merge 已由模型 argv 位判定，不再跑文本版）
    const scriptKill = checkServiceScriptKill(command, mainPid, logger, projectRoot);
    if (scriptKill) return withDiagnostics(scriptKill, command, mainPid);
    // F20261006gfvl 合并修：bash -c 载荷的 rm 感知由 judgeShellCSegment 的完整通道处理
    // （含载荷内 cd 跟踪）——V1 层对原始命令的 checkDataDirDestructive 段拆分不剥引号，
    // `bash -c 'cd /tmp && rm -rf data'` 的引号内 && 被切开导致 cd 跟踪失效误拦。
    // 跳过：含 bash -c 载荷的命令走 judgeShellCSegment（checkMainCheckoutWrite 内部），
    // 纯 rm/mv/find 命令（无 bash -c）仍走本层。
    // 旗标组 `(?:\S+\s+)*?` 非贪婪匹配任意 token（含带值旗标的值 token）——
    // `-o pipefail -c` 的 `pipefail` 值无前缀也能被跳过组消费（检视獭实证 -o 路径误拦）。
    if (!/(?:bash|sh|zsh|dash|ksh)\d*\s+(?:\S+\s+)*?-c\s/.test(command)) {
      const dataDestructive = checkDataDirDestructive(command, logger, { projectRoot, sessionCwd });
      if (dataDestructive) return withDiagnostics(dataDestructive, command, mainPid);
    }
    // #1207（F20260930l573）：主仓写检测在原始命令上跑（heredoc 体在场），
    // 体感知判定在此计算后传入——只豁免纯只读 python heredoc 体。
    // #1240 检视 r1：负门触发后内部直接调用 scriptHeredocBodiesReadOnlySegmentAware
    // 体感知拦（不经通道正则接力）；此传入值只服务非 cd 豁免形态（负门未触发面）——
    // python/node 双族段感知版替换 python-only 版，覆盖 node heredoc 同型失效。
    const mainWrite = checkMainCheckoutWrite({ command, logger, projectRoot, sessionCwd, heredocReadOnly: scriptHeredocBodiesReadOnlySegmentAware(command), writeChannelSkip });
    if (mainWrite) return withDiagnostics(mainWrite, command, mainPid);
    // #1207（F20260930l573）：shell/node heredoc 体级危险判定（原始命令，体在场）
    const bodyHit = checkHeredocScriptBodies(command, { mainPid, logger, allowedServices, projectRoot, sessionCwd, writeChannelSkip });
    if (bodyHit) return withDiagnostics(bodyHit, command, mainPid);
    return null;
  }

  // V1 判定链（parseOk=false 时的全量兜底）

  // F20260924gfpn：heredoc 载荷整体剥离——python3 - <<EOF 的 stdin 体对 shell 层判定
  // 是数据（kill 字样测试文本曾触发「脚本 one-liner + kill + 数字」cmdLevel 拦截并
  // abort 整个 invoke + 重试刷屏，9/23 台账连环拦主因之一）。fail-closed：未闭合/
  // 裸定界符+展开特征 → 原样保留（stripHeredocPayloads 内部判定）。
  // 替换是等长的，其后命令的 offset/分段不受影响。
  const heredocStripped = stripHeredocPayloads(command);

  // #858：内嵌文本脱敏——脱敏后干净（纯数据操作）→ 放行；仍命中 → 继续原文本路径
  const sanitizedResult = checkSanitizedPath(heredocStripped, mainPid, logger, allowedServices, { projectRoot, sessionCwd, writeChannelSkip });
  if (sanitizedResult === null) return null;

  // F20260928slan：sleep 拦截标记（SLEEP_REASON_PREFIX）保留至发射点——circuit-breaker-helpers
  // 据此分流 `bash_sleep:` 前缀并自行剥离（此发射点是 bash_sleep: 唯一产源，D5a）。诊断文案用干净文案。
  const scan = (text: string): string | null => {
    const r = checkBashCommandSafetyOnText(text, mainPid, logger, allowedServices, { projectRoot, sessionCwd, writeChannelSkip });
    if (!r) return null;
    return r.startsWith(SLEEP_REASON_PREFIX)
      ? SLEEP_REASON_PREFIX + withDiagnostics(stripSleepMarkerIfPresent(r), text, mainPid)
      : withDiagnostics(r, text, mainPid);
  };
  const result = scan(heredocStripped);
  if (result) return result;

  // F20261019gses F1 修订：原文语义判定（write-verdict）已 ALLOW 时，归一化文本的
  // 判读翻转不采纳——剥引号是归一化链自造形态（open('f','w') 剥成 open('f',w)，
  // 引号内 mode 变裸词→判读翻转 fail-closed），非原文真风险。归一化链只兜「剥引号
  // 出土新写词面」的真差异（差分集合逻辑）。
  const ctxHere = { projectRoot, sessionCwd, writeChannelSkip };
  if (ctxHere.projectRoot !== undefined
      && evaluateWriteVerdict(command, ctxHere.projectRoot, ctxHere.sessionCwd ?? ctxHere.projectRoot).verdict === "ALLOW") {
    return null;
  }

  return scanNormalizedWithOneLinerExemption(heredocStripped, command, scan);
}

/** r2 严重 1 处置：归一化二次扫描的 one-liner 只读豁免收紧为「载荷集合差分安全」。
 *  基座对齐原则（r3 设计约束）：豁免判定与拦截判定必须基于同一提取基座，差异
 *  只允许来自引号形式归一——原始文本载荷集合 ⊆ 归一化文本载荷集合才豁免
 *  （同一载荷引号形式变化如 require('fs')→require(fs) 归一化后仍含原载荷，
 *  差分为空放行；'node' -e 掩蔽写归一化后出土新载荷，差分非空拦）。 */
function scanNormalizedWithOneLinerExemption(
  heredocStripped: string, originalCommand: string, scan: (text: string) => string | null,
): string | null {
  const normalized = normalizeForDetection(heredocStripped);
  if (normalized === heredocStripped) return null;
  const normalizedResult = scan(normalized);
  if (!normalizedResult) return null;
  const originalSet = oneLinerPayloadSet(originalCommand);
  if (!originalSet) return normalizedResult; // 原文提取不出只读集合 → 不豁免
  // 差分基座对齐补正（r3）：剥引号是唯一允许的文本差异。原文载荷逐一经归一化后
  // 与归一化产物中的载荷比对——剥引号差异豁免；其他差异（新载荷出土/载荷消失）拦。
  // 安全门：剥除全部 one-liner 载荷后残余仍命中拦截 → 不豁免（bash -c 载荷等
  // shell 段被 wrapper 吸收后差分等价误判的护栏，F20260923glay Part A）。
  const normalizedPayload = oneLinerPayloadSetFromNormalized(normalized);
  if (normalizedPayload === null) return normalizedResult; // 归一化产物连提取都失败 → 保守拦
  if (normalizedPayload.size !== originalSet.size) return normalizedResult; // 载荷数变化 → 新段出土，拦
  const origNormalized = new Set([...originalSet].map(p => normalizeForDetection(p)));
  for (const np of normalizedPayload) {
    if (!origNormalized.has(np)) return normalizedResult; // 归一化后载荷不在原集合 → 出土，拦
  }
  // 剥除全部 one-liner 载荷后，残余文本仍命中拦截扫描 → 不豁免（危险段在场）
  const residual = stripOneLinerPayloads(normalized, normalizedPayload);
  const residualScan = scan(residual);
  if (residualScan !== null) return normalizedResult;
  return null; // 载荷集合归一化等价且残余干净 → 豁免放行
}

/** 提取命令中全部 one-liner 载荷的只读集合——全部同型载荷提取成功且全部只读
 *  才返回集合；否则返回 null（fail-closed：提取失败/非只读/无载荷都不豁免）。 */
/** 从文本中剥除全部 one-liner 载荷（等长替换为空格，保持 offset），
 *  供差分残余扫描用——残余是 one-liner 之外的 shell 段。 */
function stripOneLinerPayloads(command: string, payloads: Set<string>): string {
  let result = command;
  for (const p of payloads) {
    // 载荷文本替换为等长空格（保 offset），只替换一次（同一载荷多处出现逐次替换）
    const idx = result.indexOf(p);
    if (idx >= 0) result = result.slice(0, idx) + " ".repeat(p.length) + result.slice(idx + p.length);
  }
  return result;
}

/** 从归一化文本提取载荷原文（不做只读判定——归一化产物只读白名单已不可信，
 *  只读性由原文侧担保；此处只做差分比对原料）。 */
function oneLinerPayloadSetFromNormalized(command: string): Set<string> | null {
  const all = new Set<string>();
  let sawPayload = false;
  for (const interp of ["python", "node", "ruby", "perl"] as const) {
    const payloads = extractOneLinerPayloads(command, interp);
    if (payloads === null) continue;
    sawPayload = true;
    for (const p of payloads) all.add(p);
  }
  return sawPayload ? all : null;
}

function oneLinerPayloadSet(command: string): Set<string> | null {
  const all = new Set<string>();
  let sawPayload = false;
  for (const interp of ["python", "node", "ruby", "perl"] as const) {
    const payloads = extractOneLinerPayloads(command, interp);
    if (payloads === null) continue; // 该解释器无载荷或提取失败
    sawPayload = true;
    const readOnly = interp === "python"
      ? payloads.every(p => pythonBodyReadOnly(p))
      : interp === "node"
        ? payloads.every(p => nodeBodyReadOnly(p))
        : payloads.every(p => rubyPerlBodyReadOnly(p));
    if (!readOnly) return null;
    for (const p of payloads) all.add(p);
  }
  return sawPayload ? all : null;
}

// F20260928slan：sleep 检测拆至 sleep-command-guard.ts（控文件行数）——import + re-export 保持 API 稳定
import { checkSleepCommand, SLEEP_REASON_PREFIX, stripSleepMarkerIfPresent } from "./sleep-command-guard";
export { SLEEP_REASON_PREFIX, stripSleepMarkerIfPresent };
