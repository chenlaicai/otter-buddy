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

/* eslint-disable max-lines -- V1 判定链保留（fail-closed 兜底）+ V2 路由共存期 */
import fs from "fs";
import path from "path";
import type { Logger } from "@usecases/ports/logger";
import { loadAllowedServicePorts, extractWhitelistedPortRefs, type AllowedService } from "./allowed-service-ports";
import { shouldSanitizeForScan, sanitizeQuotedText, stripQuotedTextSpans, stripHeredocPayloads, extractHeredocSpans } from "./quoted-text-sanitizer";
import { findKillSegments, isKillAtCommandPosition } from "./kill-segment-finder";

/** F20260928slan：sleep 命令位置判定——复用 kill-segment-finder 的位置感知
 * （isKillAtCommandPosition 对任意 pattern 通用，sleep 词元复用同一套位置白名单） */
const isCommandPositionFor = (text: string, pattern: RegExp): boolean => isKillAtCommandPosition(text, pattern);
import { allSegmentsGitReadonly } from "./git-readonly-whitelist";
import { checkWithModel, modelParseOk, modelCdExemption } from "./guard-model-judge";

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
  // F20260923glay：加 node -e/--eval（与 SCRIPT_ONELINER_CHANNEL 口径对齐——脚本载荷剥离后，
  // kill 检测必须覆盖全部 one-liner 形态，防 node -e 'process.kill(42877)' 绕过；
  // 审视焦点 2 实证 node --eval 等价旗标此前漏覆盖）
  if (/(?:perl|ruby|python\d?)\s+.*(?:-e|-c)\s|\bnode\s+.*(?:-e|--eval)\s/.test(cmdLower) && /\bkill\b/.test(cmdLower) && /\b\d{2,6}\b/.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED scripting language one-liner with kill", { mainPid, command: command.substring(0, 200) });
    return "bash 命令通过脚本语言执行了终止进程操作，无法判断目标。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
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
      return "bash 命令包含按名匹配的批量终止命令（pkill/killall），可能影响主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；服务异常请报告搭档。";
    }
    return null;
  }
  if (hasIndirectPidTarget(pidTextA, pipeSourced) || hasIndirectPidTarget(pidTextB, pipeSourced)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill with indirect PID target", { mainPid, segment: segment.substring(0, 200) });
    return "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——若需终止/重启验证实例，在 worktree 内跑 scripts/alpha.sh stop（alpha 实例的标准清理方式，勿用组合杀）；若需验证代码变更，在 worktree 内跑 scripts/alpha.sh start 起隔离实例（3100+ 端口、独立数据根）；若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
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

/* eslint-disable-next-line complexity -- sleep 检测挂点（F20260928slan）新增一分支：V1 判定链原 12 分支 + sleep 检测，合并后 13——每分支对应一条已断言语义 */
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
  // #1207 delta r1：heredoc 体级判定挂进 V1 OnText 链（检视严重 2b 修正——初版
  // 漏挂致未闭合 node heredoc 体 process.kill 主 PID 放行）。入口已剥闭合体的输入
  // 在此 extractHeredocSpans 只命中空白体 → 自然 no-op；未闭合（fail-closed 保留
  // 原文）时体在场 → 白名单判定生效。与 shell 体递归互调按输入长度严格递减收敛。
  const bodyHit = checkHeredocScriptBodies(text, { mainPid, logger, allowedServices, projectRoot });
  if (bodyHit) return bodyHit;
  // F20260928slan：裸 sleep 静默等待检测——独立于 kill 域（感知问题非安全问题），
  // 命中返回带 SLEEP_REASON_PREFIX 标记的文案，出口处由 checkBashCommandSafety 剥离标记
  const sleepBlock = checkSleepCommand(text, logger, { isCommandPosition: isCommandPositionFor });
  if (sleepBlock) return sleepBlock;
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
    ["进程名模式", /\b(?:otter-buddy|otter_buddy|dist\/src\/main|main\.js|node)\b/g],
  ];
  for (const [name, pat] of patterns) {
    const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g");
    let m: RegExpExecArray | null;
    // F20260923glay：同类命中只取首条 + 计数（路径类命中一拦 5-6 段长路径无信息量，刷屏）
    let typeCount = 0;
    let firstSnippet = "";
    let firstIndex = 0;
    while ((m = re.exec(command)) !== null && hits.length < 6) {
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

/** 通道正则（MAIN_WRITE_PATTERNS slice 后 index 1-4）。 */
const ONELINER_CHANNEL_PATTERNS: Record<OneLinerInterp, RegExp> = {
  python: new RegExp(ONELINER_ANCHOR + PY_ONELINER_FORM),
  node: new RegExp(ONELINER_ANCHOR + NODE_ONELINER_FORM),
  ruby: new RegExp(ONELINER_ANCHOR + RUBY_ONELINER_FORM),
  perl: new RegExp(ONELINER_ANCHOR + PERL_ONELINER_FORM),
};

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
const SHELL_INTERP_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** one-liner 解释器名 → 通道 key（洞2 落点判定）。 */
const ONELINER_INTERP_NAMES: Record<string, OneLinerInterp> = {
  python: "python", python3: "python", node: "node", ruby: "ruby", perl: "perl",
};

/** 包装词旗标形态表：包装词 → 跳过时吞食后续 token 的规则。
 *  词表外未知包装词一律 fail-closed——三轮枚举爆破的教训：不扩词表换结构，
 *  但「已知包装词」仍需一张表承载其旗标语法；表的职责从「枚举全宇宙包装词」
 *  收窄为「描述已知词的旗标形态」，未知词由结构兜底拦。
 *  吞食规则（确定性，防贪婪误吞解释器名）：
 *    flags: 吞连续的 - 开头 token；
 *    args:  吞「前一 token 是带参旗标」的后随一个非 - token（如 -n 5 / -o0 不同——
 *           -o0 是合写旗标属 flags；-n 5 分写则 5 属 args）。简单可靠规则：
 *           flags 吞完后，若最后一个被吞旗标在 takesValue 集合且其本身无内联值
 *           （长度==2 的短旗标），再吞一个 token；
 *    assigns: env 专有——吞 FOO=v 形态；
 *    duration: timeout 专有——旗标吞完后吞一个时长 token（\d 开头或数字+单位）。 */
interface WrapperSpec {
  flags?: boolean;   // 吞连续 - 开头 token
  assigns?: boolean; // 吞 FOO=v token（可夹于 flags 之后）
  duration?: boolean; // 吞一个时长/数值 token（timeout/watch -n 之外的独立参数）
}
const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  env: { flags: true, assigns: true },
  nice: { flags: true, duration: true },      // nice -n 5（-n 带值）/ nice -5
  timeout: { flags: true, duration: true },   // timeout [-s KILL] 5 cmd
  watch: { flags: true, duration: true },     // watch -n 1 cmd
  setsid: { flags: true },
  stdbuf: { flags: true },                    // stdbuf -o0 -eL（值内联旗标）
  arch: {},
  sudo: { flags: true },
  nohup: {},
  command: { flags: true },
  exec: { flags: true },
  time: { flags: true },
  xargs: { flags: true },                     // xargs -I{}（值内联）——-I {} 分写形态保守不吞（落点 {} 非解释器自然放行交后续层）
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

const tokenBasename = (t: string): string => {
  const stripped = t.replace(/^["']|["']$/g, "");
  const base = stripped.includes("/") ? stripped.split("/").pop()! : stripped;
  return base.toLowerCase();
};

/** 跳过一个包装词及其旗标参数（parseSegmentHead 内层，抽函数控圈复杂度）。
 *  确定性吞食（防贪婪误吞解释器名）：flags 连续 - 开头 / assigns FOO=v / duration 单个数值。 */
function skipWrapperArgs(tokens: { text: string; offset: number }[], k: number, spec: WrapperSpec): number {
  if (spec.flags) while (k < tokens.length && /^-/.test(tokens[k].text)) k++;
  if (spec.assigns) while (k < tokens.length && /^[A-Za-z_]\w*=\S*$/.test(tokens[k].text)) k++;
  if (spec.duration && k < tokens.length && /^\d/.test(tokens[k].text)) k++;
  return k;
}

/** 段首 token 解析器（洞2 换结构核心）：跳过「赋值前缀 + 已知包装词（含旗标）」
 *  后返回落点 token。引号感知——引号内空格不切 token。解析失败（未闭合引号等）
 *  返回 null → 调用方保守拦。 */
function parseSegmentHead(seg: string): SegmentHead | null {
  const tokens = tokenizeSegment(seg);
  if (tokens === null) return null;
  if (tokens.length === 0) return { head: "", offset: -1 };
  let k = 0;
  for (;;) {
    if (k >= tokens.length) return { head: "", offset: -1 };
    const t = tokens[k].text;
    // 赋值前缀（含空值 #1285 洞3：FOO= 合法赋值）
    if (/^[A-Za-z_]\w*=\S*$/.test(t)) { k++; continue; }
    const base = tokenBasename(t);
    const spec = WRAPPER_SPECS[base];
    if (!spec) return { head: base, offset: tokens[k].offset };
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
  // 逐 token 扫：白名单短旗标跳过；遇 -c 进载荷提取；其他 → 判 FAIL_CLOSED 或 FILE
  // r2 严重 B：旗标 token 形态含 [+-] 前缀（bash `+x` 关 xtrace 合法）——argM 只认
  // `\s+-\S+` 时 `+x` 不进旗标位，整串匹配失败返回 FILE 放行（`sh +x -c '写'` 曾绕）。
  const argM = after.match(/^((?:\s+[+-]\S+)*?)\s*-c(\s|$)/);
  if (!argM) {
    // 无 -c：bash script.sh / bash -x script.sh → 文件落点放行
    //（-c 后无空格的空字符串 -c'' 形态走下方载荷为空 → FAIL_CLOSED）
    return { kind: "FILE" };
  }
  const flagStr = argM[1].trim();
  if (flagStr) {
    const flags = flagStr.split(/\s+/);
    if (!flags.every(f => SHELL_FLAG_WHITELIST.test(f))) return { kind: "FAIL_CLOSED" };
  }
  const i = nameM[0].length + argM[0].length;
  if (i >= rest.length) return { kind: "FAIL_CLOSED" }; // -c 后无载荷
  const q = rest[i];
  if (q === "'" || q === '"' || q === "`") return scanQuotedPayload(rest, i, shellOffset);
  // 无引号载荷（bash -c node…）——取至段尾
  const payload = rest.slice(i).trim();
  return payload ? { kind: "PAYLOAD", payload, consumedEnd: seg.length } : { kind: "FAIL_CLOSED" };
}

/** splitShellSegments 单字符处理。
 *  返回消耗后的新 index；命中分隔符时把 cur 推入 segs 并重置。 */
// eslint-disable-next-line complexity -- 引号/转义/四类分隔符的逐字符状态机，分支与字符类别一一对应，再拆会割裂状态机可读性
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
const GIT_WRITE_SUBCOMMAND = /^git\s+(?:-C\s+\S+\s+|--git-dir=\S+\s+|--work-tree=\S+\s+|-c\s+\S+\s+)*(?:commit(?!-tree)|rebase|merge(?!-)|cherry-pick|apply|stash\s+push|push\b(?!\s+(?:--dry-run|-n)\b)|reset\s+--hard|clean\s+-[a-zA-Z]*f)/;

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
const SUBSHELL_GIT_WRITE_GATE = /[({][^)}]*\bgit\s+(?:commit(?!-tree)|rebase|merge(?!-)|cherry-pick|apply|stash\s+push|push\b|reset\s+--hard|clean\s+-[a-zA-Z]*f)/;

/** ③b shell 落点处理（judgeSegment 内层，抽函数控圈复杂度/语句数）：
 *  三态拆分（r1 严重 2）+ 载荷递归 + 剩余 token 重判（r1 严重 3）。 */
function judgeShellCSegment(
  seg: string,
  offset: number,
  ctx: { logger?: Logger; projectRoot?: string; oneLinerReadOnly: boolean; depth: number },
): boolean {
  const ex = extractShellCPayload(seg, offset);
  if (ex.kind === "FILE") return false; // bash script.sh——写面在脚本文件自身，不在本层
  if (ex.kind === "FAIL_CLOSED") return true; // -c 存在但旗标形态白名单外/未闭合 → fail-closed
  // 递归：载荷作为独立命令重走主仓写判定（基座对齐——同一 checkMainCheckoutWrite）
  const payloadHit = checkMainCheckoutWrite({ command: ex.payload, logger: ctx.logger, projectRoot: ctx.projectRoot, depth: ctx.depth - 1 }) !== null;
  if (payloadHit) return true;
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

/** 段级判定（checkSegmentStructuralWrite 的单段处理，抽函数控圈复杂度） */
function judgeSegment(
  rawSeg: string,
  ctx: { logger?: Logger; projectRoot?: string; oneLinerReadOnly: boolean; depth: number },
): boolean {
  // #1285 r1 严重 1 连带：子壳包装剥壳（`(git commit)` / `{ git commit; }`）
  const seg = stripSubshellWrap(rawSeg);
  const parsed = parseSegmentHead(seg);
  const segHasShellC = /\b(?:bash|sh|zsh|dash|ksh)\d*\s+-c\s/i.test(seg);
  const segHasOneLiner = ONELINER_PRE_GATE.test(seg);
  if (parsed === null) {
    // 解析失败（未闭合引号等）——段内含 one-liner/shell 特征才拦
    return segHasOneLiner || segHasShellC;
  }
  const { head, offset } = parsed;
  if (head === "") return false;
  // ③a one-liner 解释器落点（python/node/ruby/perl，含版本号尾缀）
  const interpKey = ONELINER_INTERP_NAMES[head.replace(/[\d.]+$/, "")];
  if (interpKey) {
    // 通道判定：段内含该解释器的 one-liner 形态（-c/-e/--eval）才命中——
    // 裸 `python3 script.py` 不是 one-liner 通道（写面由重定向/git 族承担）。
    // 只读豁免：oneLinerReadOnly（全命令基座，与正则通道同一豁免值——
    // 豁免基座对齐：拦截与豁免同一提取基座，载荷只读性由既有白名单承担）。
    return segHasOneLiner && !ctx.oneLinerReadOnly;
  }
  // ③a' git 落点（#1285 r1 严重 1：词包装 git 写族全绕——正则锚只认赋值前缀，
  // `env git commit` / `sudo git commit` / `timeout 5 git commit` 曾全放）。
  // 剥包装前缀后落 git：写子命令拦（GIT_WRITE_SUBCOMMAND 承担，含 git push/
  // reset --hard/clean -f 等正则锚未覆盖的写族）；只读子命令放行（白名单由
  // allSegmentsGitReadonly 在上游承担——包装形态下 gitReadonlyCmd=false 会落入
  // 本层，这里显式放只读防误拦）。
  if (head === "git") {
    const rest = seg.slice(offset);
    return GIT_WRITE_SUBCOMMAND.test(rest);
  }
  // ③b shell 解释器落点 → 洞1：提取 -c 载荷递归判定（r1 严重 2：三态拆分）
  if (SHELL_INTERP_NAMES.has(head.replace(/\d+$/, ""))) {
    return judgeShellCSegment(seg, offset, ctx);
  }
  // ③c 已知常见词 → 放行
  if (SEGMENT_HEAD_PASS_THROUGH.has(head)) return false;
  // ③d 未知落点——词表外包装词（timeout/watch/setsid/stdbuf/arch 曾全放）。
  // fail-closed 收窄版：未知词 + 段内含 one-liner/shell-c 特征才拦——
  // `timeout 5 node -e 写` 是典型包装绕过；纯未知命令（make/gradle build）
  // 不含 one-liner 形态不拦（误拦面收口）。
  return segHasOneLiner || segHasShellC;
}

/** 主仓写判定的段首结构检测（洞1+洞2 统一入口）。
 *  判定链（fail-closed 原则）：
 *  ① 引号感知切段；② 段首解析（跳赋值+包装词）；③ 落点分类（judgeSegment）：
 *     one-liner 解释器+形态 → 命中；shell 解释器+-c → 载荷递归；未知落点+特征 → 拦。
 *  返回 true = 命中主仓写通道（拦）。 */
function checkSegmentStructuralWrite(
  command: string,
  logger: Logger | undefined,
  projectRoot: string | undefined,
  oneLinerReadOnly: boolean,
  depth: number,
): boolean {
  if (depth <= 0) return true; // 嵌套超深 → 保守拦（与 heredoc 体同先例）
  const ctx = { logger, projectRoot, oneLinerReadOnly, depth };
  for (const seg of splitShellSegments(command)) {
    if (judgeSegment(seg, ctx)) return true;
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


/** 主仓写操作形态（F20260922scwd）：重定向/heredoc/python patch/git 写族 */
const REDIRECT_PATTERN = /(?:^|[;&\n]|&&|\|\|)\s*(?:>|>>|<<<)\s*[^|&;\n]+|(?<!["'\w])\d*>>?\s*[^|&;\n'"]+/;  // 重定向（含 echo x > file 中段形态 + 2> 数字前缀）
const MAIN_WRITE_PATTERNS = [
  REDIRECT_PATTERN,
  /(?:^|&&|\|\||[;&\n])\s*(?:[\w./-]+\/)?python[\d.]*\s+-\s*<<["']?/,       // python heredoc patch（delta r1：含版本号/路径形态；delta 2：多级+绝对路径）
  // #1275：pattern[1]-pattern[4] 是 one-liner 通道（python -c / node -e / ruby -e / perl -e）。
  // 载荷是否只读不由正则承担（正则只认通道形态），由下方 oneLinerReadOnly 预计算豁免。
  ONELINER_CHANNEL_PATTERNS.python,
  ONELINER_CHANNEL_PATTERNS.node,
  ONELINER_CHANNEL_PATTERNS.ruby,
  ONELINER_CHANNEL_PATTERNS.perl,
  // D2：段首锚含单 | / &（`cd /wt | git commit` / `& git commit` 同样是新命令段）
  // F20260924gfpn：① merge → merge(?!-) 负向断言——`git merge-base`（只读）曾被 merge\b
  // 吞成写操作（9/23 台账实测 BLOCKED）；同组其他词审计：commit→commit(?!-tree)（commit-tree
  // 是 plumbing 只读，前缀吞噬同型），cherry-pick/apply/rebase/stash push 无 - 开头只读派生。
  // ② 段首锚前加赋值前缀串（[A-Za-z_]\w*=\S+\s+）*——`FOO=1 git commit` 的赋值是 shell
  // 前缀不是子命令，原锚要求 git 紧邻段首会漏此形态（写族判定绕过面）。
  /(?:^|[|&]|&&|\|\||[;\n])\s*(?:[A-Za-z_]\w*=\S*\s+)*git\s+(?:commit(?!-tree)|rebase|merge(?!-)|cherry-pick|apply|stash\s+push)\b/,  // git 写族（#1285 洞3：赋值前缀 \S+→\S*，空赋值 `FOO= git commit` 同拦）
] as const;

/** F20260924gfpn：git 只读子命令白名单（精确全称，非前缀匹配）。
 *  9/23 台账根因②：黑名单思维缺白名单出口——git 后跟明确只读子命令时仍走主仓写判定，
 *  merge-base 之外的只读面（log/diff/show/…）全靠「恰好不在写族正则里」兜底，脆弱。
 *  安全红线：① 白名单词必须精确匹配子命令全称（首词元相等），`git log-f` 等变形不命中；
 *  ② 白名单只管「跳过 git 写族判定」——整条命令的重定向/data 破坏/kill 族判定照常跑，
 *  链式绕过（`git log && git commit` / `git log; rm -rf data`）仍被拦。
 *  注意：白名单不含 merge——merge 的真写判定已由写族正则 merge(?!-) 精确承担，
 *  merge-base 走「既不在写族、又不在白名单需要确认」的路径：它不是写族（负向断言后），
 *  且不需要 cd 豁免（只读），因此自然放行。
 */
/** 复合命令判定（D2 处置：单 & 后台 / | 管道同样切开命令段——
 *  `cd /wt & git commit` 的 cd 在后台子 shell，父 shell cwd 不变，commit 落主仓；
 *  `echo 'find x' > f & git commit` 与 && 形态一字符之差） */
const COMPOUND_SEPARATOR = /&&|\|\||[;&\n|]/;

/** 提取重定向目标路径（去引号，取 > 后第一个词元；剥 2>/1> 数字前缀） */
function extractRedirectTarget(command: string): string | null {
  const m = command.match(/\d*>>?\s*["']?([^|&;\n'"\s]+)/);
  return m?.[1] ?? null;
}

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
  // 补 dill/joblib/shelve/marshal（yaml 定域化见下——safe_load 白名单化）
  if (/\b(?:fileinput|mmap|shutil|subprocess|socket|ctypes|pickle|sqlite|urllib|requests|http|ftplib|pty|dill|joblib|shelve|marshal)\b/.test(body)) return false;
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
]);

function nodeBodyReadOnly(body: string): boolean {
  if (/\\|`/.test(body)) return false;
  if (/\b(?:eval|Function|setTimeout|setInterval|require\s*\(\s*(?!['"](?:fs|util|path)['"]))/.test(body)) return false;
  // #1275：否定检测扩展——child_process/worker_threads/vm/net/http/https/fs.promises 全禁（执行/网络面）
  if (/\bprocess\s*\.\s*(?!pid\b|platform\b|argv\b|version\b|cwd\b|stdout\b|stderr\b)/.test(body)) return false;
  if (/\b(?:child_process|worker_threads|vm|net|http|https|fs\.promises)\b/.test(body)) return false;
  // 计算成员调用 obj['x'](...)——对 callee 名提取不可见，出现即不豁免（动态面）
  if (/\]\s*\(/.test(body)) return false;
  const dotted = [...body.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m2 => m2[1]);
  const bare = [...body.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map(m2 => m2[1]).filter(c => !dotted.includes(c));
  if (bare.some(c => !/^(?:console|JSON|Math|String|Number|Boolean|Array|Object|require|parseInt|parseFloat|isNaN)$/.test(c))) return false;
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

/** 从命令文本中把「已验证只读」的 script 解释器 heredoc 体等长替换为空格
 *  （重定向判定用）。依据：验证过的 python/node 体内容对 shell 重定向语义不可见
 *  （体里 > 是语言内语法不是 shell 重定向）；bare/未闭合/非 python/node 体原样
 *  保留——bash/sh 体是可执行内容（`bash <<EOF` 直接执行体），体里 `> file` 是
 *  shell 层真实重定向，隐去即攻击面（delta r1 自查修正：初版对 bare python 体
 *  也隐去，`python3 - <<EOF\n...\n> src/x` 的体尾重定向会逃过 REDIRECT 判定）。 */
function blankVerifiedScriptBodies(command: string): string {
  const spans = extractHeredocSpans(command)
    .filter(sp => sp.closed && (isPythonHeader(sp.header) && pythonBodyReadOnly(sp.body)
      || isNodeHeader(sp.header) && nodeBodyReadOnly(sp.body))
      && (sp.quoted || !/[$`]/.test(sp.body)));
  if (spans.length === 0) return command;
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    out += command.slice(cursor, sp.start) + " ".repeat(sp.end - sp.start);
    cursor = sp.end;
  }
  return out + command.slice(cursor);
}

/** 段首内容是否纯赋值前缀（VAR=value 形态，可任意多个） */
function isPureAssignPrefix(seg: string): boolean {
  const words = seg.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every(w => /^[A-Za-z_]\w*=\S*$/.test(w));
}

/** cd 段精确判定（检视严重 1/D2 处置）：首段真 cd 且无后台/管道符才豁免。
 *  首段 cd（`git commit && cd /tmp` 写在 cd 前不算）、非平凡目标（cd . 不算）、
 *  无 & / |（后台子 shell / 管道切断 cd 父 shell 效应，`cd /wt & git commit` 落主仓）。
 *  F20260923qbsw：复合切断检查在引号剥离基准上进行——引号内 | & 是数据（gh comment
 *  body 里的 markdown 表格/逻辑或），不构成 shell 复合（#984 第二误拦面）。
 *  F20260924gfpn：首段判定跳过纯赋值前缀段——`W=/path; cd $W/...` 的赋值段
 *  不改变 shell 状态（9/23 台账连环拦现场形态）；剥除赋值前缀后首个「真命令段」
 *  须为 cd（赋值前缀后 cd 前再出现其他命令段 → 该段不是 cd，不豁免）。 */
function hasRealCdSegment(command: string): boolean {
  const basis = stripQuotedTextSpans(command);
  if (/(?<!&)&(?!&)|\|/.test(basis)) return false; // (?<!&)&(?!&) 防 && 误命中
  const segs = basis.split(/&&|\|\||[;\n]/).map(s => s.trim()).filter(Boolean);
  let first = "";
  for (const s of segs) {
    if (isPureAssignPrefix(s)) continue; // 赋值段跳过（不改变 shell 状态）
    first = s;
    break;
  }
  if (!first) return false;
  const m = first.match(/^cd\s+(.+)$/);
  if (!m) return false;
  const target = m[1].replace(/^["']|["']$/g, "").trim();
  return target !== "" && target !== ".";
}

/** 主仓写检测（F20260922scwd）：未 cd 时拦截落点为主仓的写命令。
 *  与 #1038 数据破坏检测的差异：不跟踪 cd（感知对齐方案下 LLM 需显式 cd），
 *  只做「当前文本是否含主仓写形态」的静态判定——简单可靠，无状态。 */

function isInsideMainCheckout(target: string, projectRoot: string): boolean {
  const r = path.normalize(projectRoot).toLowerCase();
  const t = path.normalize(target).toLowerCase();
  return t === r || t.startsWith(r + path.sep);
}

/** #1240（F20261005g1240）：python heredoc 体含「绝对路径落主仓」时阻断 cd 豁免。
 *  modelCdExemption 粒度是整条命令——`cd /tmp && python3 - <<'PY'…open('<repo>/data/x','w')…PY`
 *  的 cd 落点非主仓 → 顶层豁免放行，但 heredoc 体内绝对路径操作绕过 cwd 直达主仓（#1240 逃逸）。
 *  本函数是 cd 豁免的负门前置：任一 python heredoc 体（无论只读与否）出现绝对路径字面量
 *  且解析落主仓树 → 返回 true，调用方按「不豁免」走完整判定链（写形态被 MAIN_WRITE_PATTERNS[0]
 *  + 体只读门 拦；纯读形态后续 heredocReadOnly 门放行，不误伤正道）。
 *  判定保守侧：路径解析失败/未闭合体不触发阻断（按既有体判定链处理，不扩面）。 */
/** #1240：heredoc 解释器判定（负门专用）。
 *  isPythonHeader 是「首词语义」——`cd /tmp && python3 - <<'PY'` 的 header 首词是 cd，
 *  提取出 cd 非 python → 整链 filter 为空，负门失效（#1240 正是该形态）。
 *  本函数按 shell 语义取 header 中 `<<` 之前的最后一个命令段（&&/||/;/| 切分），
 *  对该段跑 heredocInterpreter——`cd /tmp && python3 - <<'PY'` → 段 `python3 -` → python。
 *  保守侧：切不出段/段内提取非 python → false（不触发阻断，回到既有判定链）。 */
function heredocHeaderIsPython(header: string): boolean {
  const beforeOpen = header.split(/<<-?/)[0] ?? "";
  const segs = beforeOpen.split(/&&|\|\||[;|]/).map(s => s.trim()).filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  return /^python(?:\d+(?:\.\d+)?)?$/.test(heredocInterpreter(last));
}

/** #1240：段感知版 python heredoc 体只读判定。
 *  pythonHeredocBodiesReadOnly 用 isPythonHeader（首词语义）——`cd /tmp && python3 - <<'PY'`
 *  形态下体判定失效返回 false（fail-closed）。该形态原靠顶层 cd 豁免放行，体判定结果
 *  从不被消费；#1240 负门触发后（体含绝对路径落主仓 → cd 豁免被阻断）体判定结果首次
 *  被消费——必须用段感知版算出真实只读性，否则纯读探查被误拦（可用性回归）。
 *  与 pythonHeredocBodiesReadOnly 的唯一差异：isHeader 换 heredocHeaderIsPython。 */
function pythonHeredocBodiesReadOnlySegmentAware(command: string): boolean {
  const spans = extractHeredocSpans(command);
  if (spans.length === 0) return false;
  return spans.every(sp => sp.closed && heredocHeaderIsPython(sp.header) && pythonBodyReadOnly(sp.body)
    && (sp.quoted || !/[$`]/.test(sp.body)));
}

function pythonHeredocAbsPathsInsideMain(command: string, projectRoot: string): boolean {
  const spans = extractHeredocSpans(command).filter(sp => sp.closed && heredocHeaderIsPython(sp.header));
  for (const sp of spans) {
    // 体内容里绝对路径字面量（POSIX/Windows 两类）；匹配后剥引号/空白归一
    const ABS_PATH = /(?:^|[\s'"=(,])(\/[A-Za-z0-9_~][A-Za-z0-9_~./\\-]*|[A-Za-z]:[\\/][^\s'"),]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = ABS_PATH.exec(sp.body)) !== null) {
      const raw = m[1];
      // POSIX 绝对路径才与本仓 projectRoot 同族可判；Windows 盘符路径在 mac/linux 主仓
      // 判定下永不落主仓（normalize 后不含 projectRoot 前缀）——直接跳过不阻断。
      if (!raw.startsWith("/")) continue;
      const resolved = path.normalize(raw);
      if (isInsideMainCheckout(resolved, projectRoot)) return true;
    }
  }
  return false;
}

// r3：oneLinerReadOnlyOverride 为外部预计算的 one-liner 只读豁免（基座对齐——
// 豁免判定与拦截判定同一提取基座，差异只允许来自引号形式归一）。
// 缺省时函数内部自算（旧调用方兼容）；显式传入时以外部值为准。
<<<<<<< HEAD
/** checkMainCheckoutWrite 参数打包（#1285：max-params lint 约束——洞1 递归
 *  新增 depth 后参数超上限，与 HeredocJudgeCtx 同先例打包） */
interface MainCheckoutWriteCtx {
  command: string;
  logger?: Logger;
  projectRoot?: string;
  heredocReadOnly?: boolean;
  oneLinerReadOnlyOverride?: boolean;
  /** 洞1 bash -c 递归深度（默认 3，嵌套超深保守拦） */
  depth?: number;
}
/** 写族通道循环（checkMainCheckoutWrite 内层，抽函数控圈复杂度）：
 *  git 写族/heredoc/one-liner 正则通道 + #1285 段首结构通道。
 *  命中返回拦截文案，未命中返回 null。 */
function checkWriteChannels(
  command: string,
  ctx: { logger?: Logger; projectRoot?: string; heredocReadOnly?: boolean; oneLinerReadOnly: boolean; depth: number },
): string | null {
  for (const [pi, pattern] of MAIN_WRITE_PATTERNS.slice(1).entries()) {
    if (!pattern.test(command)) continue;
    // #1207（F20260930l573）：pattern[0] 是 python heredoc patch 通道——体感知判定，
    // 纯只读体放行（写/执行签名、非 python 解释器体均不豁免，见 PY_BODY_WRITE_SIG 注）。
    // heredocReadOnly 缺省（V1 兑底链：体已剥离不可判定）→ 不豁免，保守拦。
    if (pi === 0 && ctx.heredocReadOnly) continue;
    // #1275：pattern[1]-pattern[4] 是 one-liner 通道（python -c / node -e / ruby -e / perl -e）——
    // 载荷白名单判定：全部同型载荷提取成功且全部只读才豁免，白名单外/提取失败保守拦。
    // ruby/perl 只读全拦（fail-closed 起步，S-5）。
    if (pi >= 1 && pi <= 4 && ctx.oneLinerReadOnly) continue;
    ctx.logger?.warn("[bash-safety-guard] BLOCKED main-checkout write (no cd)", { command: command.substring(0, 200) });
    return MAIN_WRITE_BLOCK_MSG;
  }
  // #1285 洞1/洞2：正则通道之外的段首结构检测——bash -c 载荷递归（洞1）+
  // 词表外包装词落点判定（洞2，换结构不扩词表）。与正则通道同一豁免基座
  // （oneLinerReadOnly），命中同一拦截文案（拦截面同口径）。
  // 挂点在 git 写族循环内：cd 豁免已过、git 只读白名单未命中才走到——
  // 与正则通道同一判定位置，无新增豁免面。
  if (checkSegmentStructuralWrite(command, ctx.logger, ctx.projectRoot, ctx.oneLinerReadOnly, ctx.depth)) {
    ctx.logger?.warn("[bash-safety-guard] BLOCKED main-checkout write via wrapped one-liner (no cd)", { command: command.substring(0, 200) });
    return MAIN_WRITE_BLOCK_MSG;
  }
  return null;
}

// eslint-disable-next-line complexity -- V1 分支语义保留（cd 豁免/git 白名单/echo 豁免/重定向 abs 豁免各对应一条已实证形态，见函数内注释）
function checkMainCheckoutWrite(ctx: MainCheckoutWriteCtx): string | null {
  const { command, logger, projectRoot, heredocReadOnly, oneLinerReadOnlyOverride } = ctx;
  const depth = ctx.depth ?? 3;
  if (!projectRoot) return null; // 无 projectRoot 时保守放行（与 resolvesToMainData 同策略）
  // #1170 根治：模型版 cd 豁免——管道/分号不再杀死豁免（`cd wt && git commit | tail` 放行）
  // #1240（F20261006c1240）：cd 豁免加负门——python/node heredoc 体含绝对路径落主仓时不豁免，
  // 防止 `cd /tmp && python3 - <<'PY'…open('<repo>/…','w')…PY` 顶层豁免放行逃逸。
  if (modelCdExemption(command, hasRealCdSegment)
      && !pythonHeredocAbsPathsInsideMain(command, projectRoot)) return null;
  // F20260924gfpn：git 写族字面判定先于只读白名单——写族正则
  // （merge(?!-) 负向断言后）在命令文本上跑，命中即拦；`git stash push` 的 push 在写族
  // 正则内，先于白名单命中，杜绝 stash 白名单词被显式写子命令借壳。
  // 判定基准：原始命令（非剥后）——heredoc 是 python/node 的 stdin 数据通道，patch 语义
  // 由 python 进程在运行时解释，静态层把 `python3 - <<EOF` 整体当写形态保守拦是对的；
  // 要跑 heredoc 分析脚本先 cd worktree（落点即 worktree，cd 豁免在最前）。
  // F20260924gfpn-r1（检视严重 F1 处置）：白名单命中只「跳过 git 写族循环」、不 return null——
  // 原实现命中即跳出整个 checkMainCheckoutWrite，把下方 REDIRECT_PATTERN 重定向防线整体旁路
  // （`git log > /repo/hacked.txt` 在 main 拦、PR 误放行，拦截侧回归）。白名单语义收窄为：
  // 仅免除 git 写族字面判定，重定向/data 破坏等其余判定照常跑。
  const gitReadonlyCmd = allSegmentsGitReadonly(command);
  // #1275：one-liner 载荷只读判定只在命令实际含 one-liner 形态时提取一次
  // （正则通道命中与否的豁免依据）；非 one-liner 命令无提取开销。
  // #1285 洞2：词表内包装形态下豁免基座补 wrappedOneLinerPayloadsReadOnly——
  // 拦截（段首解析器）与豁免（ONELINER_ANCHOR 词表）基座不同源时，以剥前缀后
  // 剩余文本为同一基座重算（基座对齐，timeout/env -i 只读不误拦）。
  const oneLinerReadOnly = oneLinerReadOnlyOverride !== undefined
    ? oneLinerReadOnlyOverride
    : ONELINER_PRE_GATE.test(command)
      ? (oneLinerPayloadReadOnly(command) || wrappedOneLinerPayloadsReadOnly(command))
      : false;
  if (!gitReadonlyCmd) {
    const channelHit = checkWriteChannels(command, { logger, projectRoot, heredocReadOnly, oneLinerReadOnly, depth });
    if (channelHit) return channelHit;
  }
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
  // #1207 delta r1：仅「引号定界+已闭合+只读白名单验证通过」的 python/node 体才
  // 等长隐去（体内容对 shell 重定向语义不可见）；bare/未闭合/白名单外体保留——
  // 体尾 `> file` 是 shell 层真实重定向，隐去即攻击面。V1 链（heredocReadOnly
  // 未传）输入已是体剥离文本，无需再处理。
  const syntaxBasis = heredocReadOnly !== undefined
    ? stripQuotedTextSpans(blankVerifiedScriptBodies(command))
    : stripQuotedTextSpans(command);
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
  return null;
}

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
}

/** shell 体分支：递归体级判定（限深）+ V1 全量链；命中返回拦截文案 */
function judgeShellHeredocBody(sp: { header: string; body: string }, ctx: HeredocJudgeCtx, depth: number): string | null {
  if (depth <= 0) {
    return `${SHELL_HEREDOC_BODY_MSG}\n【体内命中】shell 体嵌套超过判定深度上限（保守拦）`;
  }
  const inner = checkHeredocScriptBodies(sp.body, ctx, depth - 1);
  const r = inner ?? checkBashCommandSafetyOnText(sp.body, ctx.mainPid, ctx.logger, ctx.allowedServices, ctx.projectRoot);
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
    if (isPythonHeader(sp.header)) continue; // 豁免/拦截由主仓写检测体感知路径承担
    if (isNodeHeader(sp.header) && !(sp.closed && nodeBodyReadOnly(sp.body) && (sp.quoted || !/[$`]/.test(sp.body)))) {
      ctx.logger?.warn("[bash-safety-guard] BLOCKED non-readonly node heredoc body", { header: sp.header.substring(0, 80) });
      return NODE_HEREDOC_BODY_MSG;
    }
  }
  return null;
}

/** F20260922pmgd：不依赖 mainPid 的独立规则合集（PR 合入 + data 破坏）——
 *  抽出供 checkBashCommandSafetyOnText 与 checkWhenMainPidMissing 共用（圈复杂度控制）。 */
function checkPidIndependentRules(command: string, logger?: Logger, projectRoot?: string): string | null {
  const prMerge = checkPrMergeCommand(command, logger);
  if (prMerge) return prMerge;
  const preGate = ONELINER_PRE_GATE.test(command);
  const oneLinerReadOnly = preGate
    ? oneLinerPayloadSet(command) !== null
    : false;
  const mainWrite = checkMainCheckoutWrite({ command, logger, projectRoot, oneLinerReadOnlyOverride: oneLinerReadOnly });
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
  if (pidFree) return withDiagnostics(pidFree, command, null);
  // #1207（F20260930l573）：heredoc 体级判定不依赖 PID（shell 体递归在 PID=0 下
  // 与 V1 主链同口径保守放行 kill，不引入额外缺口）
  const bodyHit = checkHeredocScriptBodies(command, { mainPid: 0, logger, allowedServices: [], projectRoot: guardOptions?.projectRoot });
  return bodyHit ? withDiagnostics(bodyHit, command, null) : null;
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

/* eslint-disable-next-line complexity -- V1/V2 双链路由是本入口的本质形态（模型路径+兜底路径+规则补位） */
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

  // F20260928grv2（guard-v2-redesign）：统一结构模型判定层——kill 族/管道到 shell/
  // U1 kill 0/U5 bash<file 由模型层承担（#1170 管道豁免误杀、#1171 文本误伤、
  // 位置参数/$VAR 传参等判定语义随模型继承）。parseOk=false（未闭合引号/$(/heredoc/
  // 深度超限）时走 V1 文本链全量兜底（D3：kill 族解析失败必拦，兜底链语义=V1 保守侧）。
  // 模型判定通过时：kill 族文本判定不再重复跑（模型已判干净，重复文本扫描是
  // 8000 段/528KB 病态输入的性能热点）——但模型层未覆盖的 PID 无关规则
  //（脚本自杀/PR merge/data 破坏/主仓写）仍在文本路径执行（映射表「保留」项）。
  const modelOk = modelParseOk(command);
  if (modelOk) {
    const modelResult = checkWithModel(command, mainPid, logger, allowedServices);
    if (modelResult) return withDiagnostics(modelResult, command, mainPid);
    // 模型已放行 kill 族——只补模型层没有的规则（脚本自杀/data 破坏/主仓写；
    // PR merge 已由模型 argv 位判定，不再跑文本版）
    const scriptKill = checkServiceScriptKill(command, mainPid, logger, projectRoot);
    if (scriptKill) return withDiagnostics(scriptKill, command, mainPid);
    const dataDestructive = checkDataDirDestructive(command, logger, projectRoot);
    if (dataDestructive) return withDiagnostics(dataDestructive, command, mainPid);
    // #1207（F20260930l573）：主仓写检测在原始命令上跑（heredoc 体在场），
    // 体感知判定在此计算后传入——只豁免纯只读 python heredoc 体。
    // #1240：段感知版——`cd /tmp && python3 - <<'PY'` 形态下首词语义版失效返回 false；
    // 负门不触发时顶层 cd 豁免先 return null 不消费该值（零行为变化），
    // 负门触发后写体被拦、纯读体正确放行（不被误拦）。
    const mainWrite = checkMainCheckoutWrite({ command, logger, projectRoot, heredocReadOnly: pythonHeredocBodiesReadOnlySegmentAware(command) });
    if (mainWrite) return withDiagnostics(mainWrite, command, mainPid);
    // #1207（F20260930l573）：shell/node heredoc 体级危险判定（原始命令，体在场）
    const bodyHit = checkHeredocScriptBodies(command, { mainPid, logger, allowedServices, projectRoot });
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
  const sanitizedResult = checkSanitizedPath(heredocStripped, mainPid, logger, allowedServices, projectRoot);
  if (sanitizedResult === null) return null;

  // F20260928slan：sleep 拦截标记（SLEEP_REASON_PREFIX）保留至发射点——circuit-breaker-helpers
  // 据此分流 `bash_sleep:` 前缀并自行剥离（此发射点是 bash_sleep: 唯一产源，D5a）。诊断文案用干净文案。
  const scan = (text: string): string | null => {
    const r = checkBashCommandSafetyOnText(text, mainPid, logger, allowedServices, projectRoot);
    if (!r) return null;
    return r.startsWith(SLEEP_REASON_PREFIX)
      ? SLEEP_REASON_PREFIX + withDiagnostics(stripSleepMarkerIfPresent(r), text, mainPid)
      : withDiagnostics(r, text, mainPid);
  };
  const result = scan(heredocStripped);
  if (result) return result;

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
