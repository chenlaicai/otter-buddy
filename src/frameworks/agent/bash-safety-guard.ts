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

/** kill 族命令名（含路径穿透） */
const KILL_COMMANDS = /\b(sudo\s+)?(\/usr\/(local\/)?bin\/)?(kill|skill)\b/;
/** pkill/killall 族（含路径穿透） */
const PKILL_COMMANDS = /\b(sudo\s+)?(\/usr\/(local\/)?bin\/)?(pkill|pgrep|killall|killall5)\b/;

/** otter 主进程相关关键词模式（pkill/killall 的 -f/-n 参数值） */
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
  /`[^`]+`/, // `cmd` 反引号
  /\|.*\bkill\b/, // 管道到 kill（如 ... | xargs kill）
  /xargs\s+(sudo\s+)?\bkill\b/, // xargs kill
  /\beval\b/, // eval 包装
  /\\x[0-9a-f]{2}/i, // hex 转义
  /\$\(cat\b.*pid/i, // $(cat ...pid)
  /cat\b.*\.otter-buddy\.pid.*kill/i, // cat pid file → kill
];

/** .otter-buddy.pid 文件引用模式 */
const PID_FILE_REFERENCE = /\.otter-buddy\.pid/;

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
  return stripped.replace(/(?<=[a-zA-Z])\\(?=[a-zA-Z])/g, "");
}

/**
 * 检查命令是否包含 kill 族操作。
 * 返回匹配的 kill 段（按 shell 操作符分段后逐段扫描）。
 */
function findKillSegments(command: string): { segment: string; isPkill: boolean }[] {
  const results: { segment: string; isPkill: boolean }[] = [];
  // 按 shell 操作符分段（不含 | 管道——管道到 kill 是间接攻击向量，由 hasIndirectPidTarget 整体拦截）
  const segments = command.split(/&&|\|\||[;&\n]/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (PKILL_COMMANDS.test(trimmed)) {
      results.push({ segment: trimmed, isPkill: true });
    } else if (KILL_COMMANDS.test(trimmed)) {
      results.push({ segment: trimmed, isPkill: false });
    }
  }
  return results;
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
 */
function extractLiteralPids(segment: string): number[] {
  const pids: number[] = [];
  // 去掉命令名部分，只看参数
  const afterCmd = segment.replace(/^.*?\b(?:kill|skill)\b\s*/, "");
  const words = afterCmd.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (w.startsWith("-")) continue; // 跳过信号参数
    const pid = parseInt(w, 10);
    if (!isNaN(pid) && pid > 0 && String(pid) === w) pids.push(pid);
  }
  return pids;
}

/**
 * 检查 pkill/killall 命令是否可能命中 otter 主进程。
 * 检查 -f/-n 参数值和位置参数中的关键词。
 */
function pkillTargetsOtter(segment: string): boolean {
  const lower = segment.toLowerCase();
  return OTTER_PROCESS_PATTERNS.some(pat => lower.includes(pat));
}

function checkCommandLevelPatterns(
  command: string,
  cmdLower: string,
  mainPid: number,
  logger?: Logger,
): string | null {
  // eval 包装 + 数字参数 → 保守拦截（eval "kil""l 42877" 等字符串拼接绕过）
  if (/\beval\b/.test(cmdLower) && /\b\d{2,6}\b/.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED eval with numeric arguments", { mainPid, command: command.substring(0, 200) });
    return "bash 命令使用 eval 包装了含数字参数的操作，可能隐藏终止进程的命令。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  // 管道到 shell 执行且含 kill 关键词
  if (/\|\s*(sh|bash|zsh)\b/.test(command) && /\bkill\b/.test(cmdLower)) {
    logger?.warn("[bash-safety-guard] BLOCKED pipe-to-shell with kill content", { mainPid, command: command.substring(0, 200) });
    return "bash 命令通过管道传入 shell 执行且包含终止进程操作，可能针对主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  // 脚本语言 one-liner 执行 kill：perl/ruby/python -e '...kill N...'
  if (/(?:perl|ruby|python\d?)\s+.*-e\s/.test(cmdLower) && /\bkill\b/.test(cmdLower) && /\b\d{2,6}\b/.test(command)) {
    logger?.warn("[bash-safety-guard] BLOCKED scripting language one-liner with kill", { mainPid, command: command.substring(0, 200) });
    return "bash 命令通过脚本语言执行了终止进程操作，无法判断目标。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
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
      return "bash 命令包含按名匹配的批量终止命令（pkill/killall），可能影响主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。";
    }
    return null;
  }
  if (hasIndirectPidTarget(segment)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill with indirect PID target", { mainPid, segment: segment.substring(0, 200) });
    return "bash 命令中终止进程的目标为变量或命令替换（非字面量 PID），无法判断是否针对主进程。该命令不允许——若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }
  if (PID_FILE_REFERENCE.test(segment)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill referencing .otter-buddy.pid file", { mainPid, segment: segment.substring(0, 200) });
    return "bash 命令中终止进程的命令引用了主进程 PID 文件。主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。";
  }
  const pids = extractLiteralPids(segment);
  if (pids.length > 0 && pids.includes(mainPid)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill targeting main process PID", { mainPid, commandPids: pids, segment: segment.substring(0, 200) });
    // F20260831aksp：PID 数字脱敏——堵「错误 PID 试探 → 拦截文案回显真实 PID → 精准二次打击」链（结构化日志字段 commandPids 保留数值）
    return "bash 命令包含针对主进程 PID 的终止命令。主进程是海獭运行环境，任何情况下不得终止——你不存在需要重启或停止主进程的合法场景。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。";
  }
  return null;
}

/**
 * 在单份文本上执行全量检测（原始与归一化文本各调一次）。
 */
function checkBashCommandSafetyOnText(
  text: string,
  mainPid: number,
  logger?: Logger,
): string | null {
  // 全命令级高危模式检测（在分段前检查，防止 eval/pipe-to-shell 绕过分段检测）
  const cmdLevelResult = checkCommandLevelPatterns(text, text.toLowerCase(), mainPid, logger);
  if (cmdLevelResult) return cmdLevelResult;

  const killSegments = findKillSegments(text);
  if (killSegments.length === 0) return null;

  // 全命令级：有 kill 段 + 全命令含 .otter-buddy.pid 引用（跨段检测）
  if (PID_FILE_REFERENCE.test(text)) {
    logger?.warn("[bash-safety-guard] BLOCKED kill with cross-segment PID file reference", { mainPid, command: text.substring(0, 200) });
    return "bash 命令中包含主进程 PID 文件引用和终止进程操作，可能针对主进程。该命令不允许：主进程是海獭运行环境，任何情况下不得终止。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。若确认此命令本意安全（如查询语句恰好含敏感字样），请改用保持原语义的不含敏感字样的方式达成目的（如换检索关键词，不得用模糊匹配/字符替换变相达成原检索）；无法规避时告知搭档人工执行。";
  }

  for (const { segment, isPkill } of killSegments) {
    const result = checkKillSegment(segment, isPkill, mainPid, text, logger);
    if (result) return result;
  }
  return null;
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
export function checkBashCommandSafety(
  command: string,
  mainPid: number | null,
  logger?: Logger,
): string | null {
  if (!command.trim() || mainPid === null) return null;

  const result = checkBashCommandSafetyOnText(command, mainPid, logger);
  if (result) return result;

  const normalized = normalizeForDetection(command);
  if (normalized !== command) {
    return checkBashCommandSafetyOnText(normalized, mainPid, logger);
  }
  return null;
}
