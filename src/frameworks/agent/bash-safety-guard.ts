/**
 * Bash 命令安全守卫（F20260830bsgr）。
 *
 * 防止 LLM 通过 bash 工具直接 kill 主进程 PID。
 * 8/30 事故根因：小獭 7708a033 在开发任务中执行 `kill 42877` 直接杀了主进程。
 *
 * 对抗 LLM 自适应变形设计（F20260830bsgr-r2，对抗审视修正）：
 * - 字面量黑名单必输：LLM 可用变量、$()、反引号、xargs、base64、eval 绕过
 * - 翻转策略：非字面量 kill 目标保守拦截，字面量 kill 精确匹配
 * - 每次检查实时读 PID 文件（不缓存，支持热重启换 PID）
 */

import fs from "fs";
import path from "path";
import type { Logger } from "@usecases/ports/logger";
import { loadAllowedServicePorts, extractWhitelistedPortRefs, type AllowedService } from "./allowed-service-ports";
import { shouldSanitizeForScan, sanitizeQuotedText, stripQuotedTextSpans } from "./quoted-text-sanitizer";
import { findKillSegments, isKillAtCommandPosition } from "./kill-segment-finder";

export type { AllowedService };

/** 守卫放行判定输入（#844）：projectRoot 用于定位白名单文件 */
export interface GuardOptions {
  projectRoot?: string;
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

/** kill 族命令名（含路径穿透、~ 路径、变量赋值前缀、wrapper 命令、bash -c 引号内嵌）
 * F20260903gh698：(1) bash -c 支持引号包裹的内嵌命令（'kill N'/"kill N"/kill N）
 *                (2) 全模式加 i 标志（大小写不敏感）
 */

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
 */
function hasIndirectPidTarget(segment: string): boolean {
  return INDIRECT_PID_PATTERNS.some(pat => pat.test(segment));
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
  const lower = segment.toLowerCase();
  return OTTER_PROCESS_PATTERNS.some(
    pat => new RegExp("\\b" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(lower),
  );
}

/** F20260916gtlr：脚本路径提取（捕获组），与 SERVICE_SCRIPT_KILL 路径词元口径 + 前导约束一致，改动需同步。
 *  前导分组（^/操作符/命令替换位）保证只匹配命令位置——中文语境裸文本提及（echo otter-buddy.sh restart 是危险操作）不误拦。 */
const SCRIPT_PATH_EXTRACT = /(?:^|[;&|`$(])\s*(?:sudo\s+)?(?:(?:bash|sh)\s+)?((?:[\w.~/-]*\/)?(?:scripts\/)?otter-buddy\.sh)\s+(?:stop|restart)\b/gi;
/** F20260916gtlr：脚本引用（间接形态检测用） */
const SCRIPT_REFERENCE = /otter-buddy\.sh/i;
/** F20260916gtlr：间接调用特征（$VAR / $(...) / ${...} / 反引号），与 INDIRECT_PID_PATTERNS 同族 */
const INDIRECT_CALL_FEATURE = /\$[{({A-Za-z_]|`/;

/** F20260916gtlr：脚本路径解析——相对路径基于 projectRoot（=主仓根，海獭 bash cwd 恒为主仓）resolve 并归一化。
 *  返回 true 表示解析到主仓 scripts（目标是进程1 的管理脚本）。projectRoot 缺失时保守按主仓对待。
 *  大小写归一化与 resolvesToMainData 同步（同根因：macOS case-insensitive FS 漏拦）。 */
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

const PR_MERGE_MSG = "bash 命令包含 gh pr merge——PR 合入是搭档专属动作（PR 后硬规则：LLM 执行 PR 创建和呈终审，合入按钮属于搭档）。请改用 merge_pr 工具，并在 partnerApproval 参数中原样引用搭档的授权原话（如搭档说「1095合入」就填那句话）。无授权原话不得合入；搭档尚未拍板时先呈终审简报（决策简报卡）。";

function checkPrMergeCommand(command: string, logger?: Logger): string | null {
  if (GH_PR_MERGE.test(command) || GH_API_PULLS_MERGE.test(command) || GH_API_REPOS_MERGES.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED gh pr merge (partner-gate)", { command: command.substring(0, 200) });
    return PR_MERGE_MSG;
  }
  return null;
}

/** F20260916gsrd：主服务脚本自杀命令检测（独立规则，调用点在 checkBashCommandSafetyOnText）
 *  F20260916gtlr：从全局文本拦改为主仓路径限定拦（worktree 绝对路径调用放行，脚本层兜底已删，
 *  守卫是唯一防线）+ 间接调用保守拦截（变量/命令替换隐藏 stop/restart 的形态）。 */
function checkServiceScriptKill(command: string, mainPid: number, logger?: Logger, projectRoot?: string): string | null {
  // 形态 1：字面 stop/restart——提取全部脚本路径，任一解析到主仓 scripts 即拦；全部不在主仓（worktree 自管实例）放行
  const matches = [...command.matchAll(SCRIPT_PATH_EXTRACT)];
  if (matches.length > 0) {
    const hitsMain = matches.some((m) => resolvesToMainCheckout(m[1], projectRoot));
    if (!hitsMain) return null;
    logger?.warn("[bash-safety-guard] BLOCKED otter-buddy.sh stop/restart targeting main checkout", { mainPid, command: command.substring(0, 200) });
    return "bash 命令调用的 otter-buddy.sh 解析到主仓，其 stop/restart 会终止主进程。该命令不允许：主进程是海獭运行环境，任何形态不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；确需管理主服务时请用脚本绝对路径 + 字面子命令，由搭档人工执行；服务异常请报告搭档。";
  }
  // 形态 2：间接调用——含脚本引用 + 间接特征（$VAR/$()/反引号）但无字面 stop/restart，保守拦截。
  // 与形态 1 的分工：形态 1（路径限定）只拦解析到主仓的字面 stop/restart，放行 worktree 自管实例；
  // 形态 2 是全局保守拦截（不区分主仓/worktree）——变量替换子命令（otter-buddy.sh $S）静态无法
  // 判定子命令与路径，按 INDIRECT_PID_PATTERNS 先例向安全侧倾斜（检视獭-pr990 建议发现 2 留痕）。
  if (SCRIPT_REFERENCE.test(command) && INDIRECT_CALL_FEATURE.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED otter-buddy.sh indirect invocation", { mainPid, command: command.substring(0, 200) });
    return "bash 命令包含 otter-buddy.sh 引用与间接调用特征（变量/命令替换），无法静态确认是否终止主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；确需调用 otter-buddy.sh 时请用字面命令（脚本绝对路径 + 字面子命令）；服务异常请报告搭档。";
  }
  return null;
}

function checkCommandLevelPatterns(
  command: string,
  cmdLower: string,
  mainPid: number,
  logger?: Logger,
): string | null {
  // eval 包装 + 数字参数 → 保守拦截（eval "kil""l 42877" 等字符串拼接绕过）。
  // 词边界限定命令位置（F20260902gvrd）：原 /\beval\b/ 匹配路径/标识符中的 eval-xxx
  //（连字符是词边界，eval-activation-p0 / guard-eval-fix 均命中），叠加任意 2-6 位数字
  //（路径里的日期、行号）即误拦纯 git/grep 命令。收紧为：行首或 shell 操作符/管道后的
  // 独立 eval 单词——字符串拼接绕过仍被覆盖（eval 必在命令位置才执行），路径中的
  // eval-xxx 不再触发。归一化文本同步收紧（塔死 k\ill 后接 eval 的拼接形态由
  // normalizeForDetection 段落化后仍在命令位置）。
  const evalInCommandPosition = /(?:^|[;&|]\s*|\|\s*)eval\s/.test(cmdLower) || /(?:^|[;&|]\s*)eval\b"/.test(cmdLower);
  if (evalInCommandPosition && /\b\d{2,6}\b/.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED eval with numeric arguments", { mainPid, command: command.substring(0, 200) });
    return "bash 命令使用 eval 包装了含数字参数的操作，可能隐藏终止进程的命令。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  // 管道到 shell 执行且含 kill 关键词
  if (/\|\s*(sh|bash|zsh)\b/.test(command) && /\bkill\b/.test(cmdLower)) {
    logger?.warn("[bash-safety-guard] BLOCKED pipe-to-shell with kill content", { mainPid, command: command.substring(0, 200) });
    return "bash 命令通过管道传入 shell 执行且包含终止进程操作，可能针对主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  // 脚本语言 one-liner 执行 kill：perl/ruby/python -e '...kill N...'
  if (/(?:perl|ruby|python\d?)\s+.*(?:-e|-c)\s/.test(cmdLower) && /\bkill\b/.test(cmdLower) && /\b\d{2,6}\b/.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED scripting language one-liner with kill", { mainPid, command: command.substring(0, 200) });
    return "bash 命令通过脚本语言执行了终止进程操作，无法判断目标。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  return null;
}

/** 检查 kill 段：pkill/killall 模式 或 kill 间接/字面量 PID */
function checkKillSegment(
  segment: string,
  isPkill: boolean,
  mainPid: number,
  command: string,
  logger?: Logger,
): string | null {
  if (isPkill) {
    if (pkillTargetsOtter(segment)) {
      logger?.warn("[bash-safety-guard] BLOCKED pkill/killall targeting otter processes", { mainPid, segment: segment.substring(0, 200) });
      return "bash 命令包含按名匹配的批量终止命令（pkill/killall），可能影响主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
    }
    return null;
  }
  if (hasIndirectPidTarget(segment)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill with indirect PID target", { mainPid, segment: segment.substring(0, 200) });
    return "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop（alpha 实例的标准清理方式，勿用组合杀）；若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  if (PID_FILE_REFERENCE.test(segment)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill referencing .otter-buddy.pid file", { mainPid, segment: segment.substring(0, 200) });
    return "bash 命令中终止进程的命令引用了主进程 PID 文件。主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
  }
  const pids = extractLiteralPids(segment);
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

/** 路径参数解析到主仓 data/ 下（含 data/ 本身）？
 *  cwd：相对路径的解析基准（跟踪 cd 后的当前目录）；projectRoot：主仓根（data 根的比较基准）。
 *  两者角色不同——cwd 只影响解析，主仓归属只看 projectRoot。
 *  大小写归一化：比较双侧 toLowerCase（macOS case-insensitive FS 上 `dAta/` 实际命中
 *  主仓 data/，区分大小写比较会漏拦——检视獭-1040 严重发现，修复与本函数同步应用于
 *  resolvesToMainCheckout） */
function resolvesToMainData(target: string, cwd: string, projectRoot?: string): boolean {
  if (!projectRoot) return true; // projectRoot 缺失时保守拦截（与 resolvesToMainCheckout 同策略）
  if (target.startsWith("~")) return true; // ~ 不展开，保守拦截（~/…/otter-buddy/data 可能指向主仓）
  // 尾部 glob 剥除：data/metrics/* → data/metrics（glob 只影响目录内容范围，不影响目录归属）
  const stripped = target.replace(/\/+$/, "").replace(/\/[*?]+$/, "");
  if (!stripped) return false;
  // 相对路径且 cwd 不可知（cd ~ 后）→ 静态无法解析，保守拦截
  if (!path.isAbsolute(stripped) && !cwd) return true;
  const resolved = path.isAbsolute(stripped)
    ? path.normalize(stripped)
    : path.normalize(path.resolve(cwd, stripped));
  const dataRoot = path.normalize(path.join(projectRoot, "data"));
  // 大小写归一化后比较（同上注释）
  const resolvedLower = resolved.toLowerCase();
  const dataRootLower = dataRoot.toLowerCase();
  return resolvedLower === dataRootLower || resolvedLower.startsWith(dataRootLower + path.sep);
}

/** 提取段内非 flag 路径参数（去引号，滤 flag） */
function pathArgsOf(seg: string): string[] {
  return seg.split(/\s+/).slice(1)
    .map(a => a.replace(/^["']|["']$/g, ""))
    .filter(a => a && !a.startsWith("-"));
}

/** 形态检测：段是否对主仓 data/ 执行删除/移动（cwd 为相对路径解析基准） */
function segmentDestructive(seg: string, cwd: string, projectRoot?: string): { kind: string; hit: boolean } {
  if (isKillAtCommandPosition(seg, /\br(?:m|mdir)\b/)) {
    return { kind: "rm", hit: pathArgsOf(seg).some(a => resolvesToMainData(a, cwd, projectRoot)) };
  }
  if (isKillAtCommandPosition(seg, /\bmv\b/)) {
    const args = pathArgsOf(seg);
    return { kind: "mv", hit: args.length > 0 && resolvesToMainData(args[0], cwd, projectRoot) };
  }
  if (isKillAtCommandPosition(seg, /\bfind\b/) && /(?:^|\s)-delete\b/.test(seg)) {
    return { kind: "find -delete", hit: pathArgsOf(seg).some(a => resolvesToMainData(a, cwd, projectRoot)) };
  }
  return { kind: "", hit: false };
}

/** #1038：主仓 data/ 破坏性操作检测。返回拦截文案或 null。
 *  cwd 跟踪：逐段扫 cd <dir> 更新当前目录，相对路径按当前 cwd 解析（
 *  `cd worktree && rm -rf data/…` 是验证正道，必须放行；子 shell / pushd 不跟踪，
 *  Known Limitations 记录）。 */
function checkDataDirDestructive(command: string, logger?: Logger, projectRoot?: string): string | null {
  const segments = command.split(/&&|\|\||[;&\n]/).map(s => s.trim()).filter(Boolean);
  let cwd = projectRoot ? path.normalize(projectRoot) : "";
  for (const seg of segments) {
    // 形态 0：cd 更新跟踪 cwd（后续段的相对路径基准）
    if (isKillAtCommandPosition(seg, /\bcd\b/)) {
      const target = seg.split(/\s+/)[1]?.replace(/^["']|["']$/g, "");
      if (!target || target.startsWith("~")) { cwd = ""; continue; } // ~ / 无参无法静态解析 → 后续按保守路径处理
      cwd = path.isAbsolute(target) ? path.normalize(target) : (cwd ? path.normalize(path.resolve(cwd, target)) : "");
      continue;
    }
    const { kind, hit } = segmentDestructive(seg, cwd, projectRoot);
    if (hit) {
      logger?.warn(`[bash-safety-guard] BLOCKED ${kind} targeting main-checkout data/`, { command: command.substring(0, 200) });
      return DATA_DESTRUCTIVE_MSG;
    }
  }
  return null;
}

// eslint-disable-next-line complexity -- F20260922scwd 主仓写拦截并入 checkPidIndependentRules（+1 分支）；规则编排入口，拆分反而割裂「按优先级短路」连贯性
function checkBashCommandSafetyOnText(
  text: string,
  mainPid: number,
  logger?: Logger,
  allowedServices: AllowedService[] = [],
  projectRoot?: string,
): string | null {
  // F20260916gsrd：主服务脚本自杀命令——最优先判定（9/16 事故：otter-buddy.sh restart
  // 杀主进程，kill 族检测看不到脚本名；脚本调用语义明确，无需保守降级）
  const scriptKill = checkServiceScriptKill(text, mainPid, logger, projectRoot);
  if (scriptKill) return scriptKill;
  // F20260922pmgd + #1038：不依赖 mainPid 的独立规则（PR 合入 / data 破坏）——
  // 提前判定，两路调用链（正常 / PID 缺失）都覆盖；抽函数控圈复杂度
  const pidFree = checkPidIndependentRules(text, logger, projectRoot);
  if (pidFree) return pidFree;
  // 全命令级高危模式检测（在分段前检查，防止 eval/pipe-to-shell 绕过分段检测）。
  // #918 检视严重 1：必须先于白名单放行——否则 `lsof -t -i:3100 | sh -c 'k...'` 类
  // 形态借白名单端口 lsof 做左段，跳过 pipe-to-shell 检测（defense-in-depth 失效）
  const cmdLevelResult = checkCommandLevelPatterns(text, text.toLowerCase(), mainPid, logger);
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

  for (const { segment, isPkill } of killSegments) {
    const result = checkKillSegment(segment, isPkill, mainPid, text, logger);
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
    ["进程名模式", /\b(?:otter-buddy|otter_buddy|dist\/src\/main|main\.js|node)\b/g],
  ];
  for (const [name, pat] of patterns) {
    const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null && hits.length < 6) {
      const start = Math.max(0, m.index - 10);
      const end = Math.min(command.length, m.index + m[0].length + 10);
      // PID 脱敏铁律（F20260831aksp）：片段中的真实主进程 PID 替换为占位符——
      // 防「错误试探 → 文案回显真实 PID → 精准二次打击」。其他数字（日期/行号）无害保留。
      const raw = command.slice(start, end).replace(/\n/g, " ");
      const snippet = mainPid !== null ? raw.split(String(mainPid)).join("<main-pid>") : raw;
      hits.push(`${name}：…${snippet}… @${m.index}`);
    }
  }
  return hits;
}

/** 拦截文案附加诊断块（#730）：被拦的獭能看到命中了什么、在哪，自诊断不再靠人肉读源码。
 *  scanText = 诊断扫描文本：拦截命中自哪份文本（原始/归一化）就用哪份——归一化路径的
 *  触发词在原命令里可能被引号拆开（e""val），扫原文会零命中。 */
function withDiagnostics(message: string, scanText: string, mainPid: number | null): string {
  const hits = locateTriggerContext(scanText, mainPid);
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

/** 主仓写操作形态（F20260922scwd）：重定向/heredoc/python patch/git 写族 */
const REDIRECT_PATTERN = /(?:^|[;&\n]|&&|\|\|)\s*(?:>|>>|<<<)\s*[^|&;\n]+|(?<!["'\w])\d*>>?\s*[^|&;\n'"]+/;  // 重定向（含 echo x > file 中段形态 + 2> 数字前缀）
const MAIN_WRITE_PATTERNS = [
  REDIRECT_PATTERN,
  /(?:^|&&|\|\||[;&\n])\s*python3?\s+-\s*<<[/"']?/,       // python heredoc patch
  // D2：段首锚含单 | / &（`cd /wt | git commit` / `& git commit` 同样是新命令段）
  /(?:^|[|&]|&&|\|\||[;\n])\s*git\s+(?:commit|rebase|merge|cherry-pick|apply|stash\s+push)\b/,  // git 写族
] as const;

/** 复合命令判定（D2 处置：单 & 后台 / | 管道同样切开命令段——
 *  `cd /wt & git commit` 的 cd 在后台子 shell，父 shell cwd 不变，commit 落主仓；
 *  `echo 'find x' > f & git commit` 与 && 形态一字符之差） */
const COMPOUND_SEPARATOR = /&&|\|\||[;&\n|]/;

/** 提取重定向目标路径（去引号，取 > 后第一个词元；剥 2>/1> 数字前缀） */
function extractRedirectTarget(command: string): string | null {
  const m = command.match(/\d*>>?\s*["']?([^|&;\n'"\s]+)/);
  return m?.[1] ?? null;
}

/** cd 段精确判定（检视严重 1/D2 处置）：首段真 cd 且无后台/管道符才豁免。
 *  首段 cd（`git commit && cd /tmp` 写在 cd 前不算）、非平凡目标（cd . 不算）、
 *  无 & / |（后台子 shell / 管道切断 cd 父 shell 效应，`cd /wt & git commit` 落主仓）。
 *  F20260923qbsw：复合切断检查在引号剥离基准上进行——引号内 | & 是数据（gh comment
 *  body 里的 markdown 表格/逻辑或），不构成 shell 复合（#984 第二误拦面）。 */
function hasRealCdSegment(command: string): boolean {
  const basis = stripQuotedTextSpans(command);
  if (/(?<!&)&(?!&)|\|/.test(basis)) return false; // (?<!&)&(?!&) 防 && 误命中
  const first = basis.split(/&&|\|\||[;\n]/).map(s => s.trim()).filter(Boolean)[0];
  if (!first) return false;
  const m = first.match(/^cd\s+(.+)$/);
  if (!m) return false;
  const target = m[1].replace(/^["']|["']$/g, "").trim();
  return target !== "" && target !== ".";
}

/** 主仓写检测（F20260922scwd）：未 cd 时拦截落点为主仓的写命令。
 *  与 #1038 数据破坏检测的差异：不跟踪 cd（感知对齐方案下 LLM 需显式 cd），
 *  只做「当前文本是否含主仓写形态」的静态判定——简单可靠，无状态。 */
// eslint-disable-next-line complexity -- mimo 终审处置后豁免分支增至 4（首段 cd/echo 纯重定向/data 目标/绝对路径非主仓），每分支对应一条已实证的绕过形态，合并会牺牲「一形态一分支」的可读性
function checkMainCheckoutWrite(command: string, logger?: Logger, projectRoot?: string): string | null {
  if (!projectRoot) return null; // 无 projectRoot 时保守放行（与 resolvesToMainData 同策略）
  // 段首真 cd 才放行（检视严重 1 处置：整条豁免 → 段级精确判定，写在 cd 前的/引号假 cd/平凡 cd 不豁免）
  if (hasRealCdSegment(command)) return null;
  // #1038 语义兼容：echo '...' >> file 形态，引号内含 rm/mv/find 敏感词元且目标非 data/ → 放行。
  // 豁免粒度收窄到重定向段（检视严重 1 处置）：整条 return null 会连带放行 && 后的 git 写族
  // （`echo 'find x' > notes.md && git commit -m y` 的 commit 被误豁免）——只豁免纯重定向命令。
  // D2：复合判定含单 & / |（后台/管道同样连带）。
  if (!COMPOUND_SEPARATOR.test(command) && !/>>?\s*['"]?[^'"\s]*data[^'"\s]*['"]?/.test(command)
      && /echo\s+['"].*\b(?:rm|mv|find)\b.*['"].*>>?/.test(command)) {
    return null; // echo 'rm ...' >> file：引号内文本，目标非 data/，无复合命令，与 #1038 同口径放行
  }
  // F20260923qbsw：重定向判定在引号剥离基准上进行——引号内 > >> --> 是文本数据
  // （gh issue comment --body 的 HTML 注释/markdown 引用），不是 shell 重定向
  // （#984 循环拦截事故：连拦 3 次中断獭回合，healing 4d692fb6/e671f577）。
  // 危险通道（bash -c/heredoc）内引号不剥离，载荷内重定向仍可见（stripQuotedTextSpans 守住）。
  const syntaxBasis = stripQuotedTextSpans(command);
  // 重定向形态单独判定（D1 处置：abs-target 豁免只适用重定向，不跨 pattern 泄漏——
  // git 写族落点是 .git/cwd 不是重定向目标，`git commit -m x > /dev/null` 高频尾缀形态曾全豁免）
  if (REDIRECT_PATTERN.test(syntaxBasis)) {
    const target = extractRedirectTarget(syntaxBasis);
    const isAbsNonMain = target && path.isAbsolute(target)
      && (() => {
        const r = path.normalize(projectRoot).toLowerCase();
        const t = path.normalize(target).toLowerCase();
        // F20260923hsyn：主仓树下但属合法工作区（data/workspaces/）——重定向落点豁免
        // （9/23 排查实证：tail log > data/workspaces/<id>/x.log 被误拦；工作区是 sandbox 语义，
        //  与 data/metrics|logs 等运行时数据性质不同，DATA_DESTRUCTIVE 层另有 rm/mv 防线）。
        const workspacesDir = path.join(r, 'data', 'workspaces') + path.sep;
        if (t.startsWith(workspacesDir)) return true;
        return !t.startsWith(r + path.sep) && t !== r;
      })();
    if (!isAbsNonMain) {
      logger?.warn("[bash-safety-guard] BLOCKED main-checkout write via redirect (no cd)", { command: command.substring(0, 200) });
      return MAIN_WRITE_BLOCK_MSG;
    }
  }
  // heredoc / git 写族形态（无 abs-target 豁免——落点是 cwd/.git，与重定向目标无关）
  for (const pattern of MAIN_WRITE_PATTERNS.slice(1)) {
    if (pattern.test(command)) {
      logger?.warn("[bash-safety-guard] BLOCKED main-checkout write (no cd)", { command: command.substring(0, 200) });
      return MAIN_WRITE_BLOCK_MSG;
    }
  }
  return null;
}


/** F20260922pmgd：不依赖 mainPid 的独立规则合集（PR 合入 + data 破坏）——
 *  抽出供 checkBashCommandSafetyOnText 与 checkWhenMainPidMissing 共用（圈复杂度控制）。 */
function checkPidIndependentRules(command: string, logger?: Logger, projectRoot?: string): string | null {
  const prMerge = checkPrMergeCommand(command, logger);
  if (prMerge) return prMerge;
  const mainWrite = checkMainCheckoutWrite(command, logger, projectRoot);
  if (mainWrite) return mainWrite;
  return checkDataDirDestructive(command, logger, projectRoot);
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
  const pidFree = checkPidIndependentRules(command, logger, guardOptions?.projectRoot);
  return pidFree ? withDiagnostics(pidFree, command, null) : null;
}

/** F20260916gtlr：脱敏扫描路径（#858）——抽为独立函数控制主入口圈复杂度。
 *  脱敏后干净（纯数据操作）→ 返回 null 信号外层直接放行；仍命中 → 继续原文本路径。 */
function checkSanitizedPath(
  command: string,
  mainPid: number,
  logger: Logger | undefined,
  allowedServices: AllowedService[],
  projectRoot: string | undefined,
): string | null | undefined {
  if (!shouldSanitizeForScan(command)) return undefined;
  return checkBashCommandSafetyOnText(sanitizeQuotedText(command), mainPid, logger, allowedServices, projectRoot);
}

export function checkBashCommandSafety(
  command: string,
  mainPid: number | null,
  logger?: Logger,
  guardOptions?: GuardOptions,
): string | null {
  if (!command.trim()) return null;
  if (mainPid === null) return checkWhenMainPidMissing(command, logger, guardOptions);

  // #844：白名单热加载（与 PID 文件同策略：每次判定重读，mtime 缓存去抖）
  const allowedServices = guardOptions?.projectRoot ? loadAllowedServicePorts(guardOptions.projectRoot) : [];
  const projectRoot = guardOptions?.projectRoot;

  // #858：内嵌文本脱敏——脱敏后干净（纯数据操作）→ 放行；仍命中 → 继续原文本路径
  const sanitizedResult = checkSanitizedPath(command, mainPid, logger, allowedServices, projectRoot);
  if (sanitizedResult === null) return null;

  const result = checkBashCommandSafetyOnText(command, mainPid, logger, allowedServices, projectRoot);
  if (result) return withDiagnostics(result, command, mainPid);

  const normalized = normalizeForDetection(command);
  if (normalized !== command) {
    const nResult = checkBashCommandSafetyOnText(normalized, mainPid, logger, allowedServices, projectRoot);
    return nResult ? withDiagnostics(nResult, normalized, mainPid) : null;
  }
  return null;
}
