/**
 * Bash 命令安全守卫（F20260830bsgr）。
 *
 * 防止 LLM 通过 bash 工具直接 kill 主进程 PID。
 * 8/30 事故根因：小獭 7708a033 在开发任务中执行 `kill 42877` 直接杀了主进程。
 * 该守卫在 tool_execution_start 事件中拦截，早于工具实际执行。
 *
 * 设计原则：
 * - 只拦截明确针对主进程的 kill 类命令（精确匹配，不误伤）
 * - 允许 kill 无关进程（如 ffmpeg、test 子进程等）
 * - 允许 otter-buddy.sh restart（通过脚本管理，有安全兜底）
 * - 主进程 PID 从 .otter-buddy.pid 文件实时读取（PID 可变）
 */

import fs from "fs";
import path from "path";
import type { Logger } from "@usecases/ports/logger";

/** 读取主进程 PID 文件，返回 PID 或 null */
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

/** 命令分类结果 */
type CommandKind = "pkill" | "killall" | "kill" | "other";

/** 识别命令类型（跳过 sudo 等包装） */
function classifyCommand(words: string[]): { kind: CommandKind; cmdIdx: number } {
  const WRAPPERS = new Set(["sudo", "time", "env", "nice"]);
  let cmdIdx = 0;
  while (cmdIdx < words.length && WRAPPERS.has(words[cmdIdx])) cmdIdx++;
  const raw = words[cmdIdx]?.toLowerCase();
  if (!raw) return { kind: "other", cmdIdx };
  const base = raw.split("/").pop() ?? raw;
  if (base === "pkill" || base === "pgrep") return { kind: "pkill", cmdIdx };
  if (base === "killall" || base === "killall5") return { kind: "killall", cmdIdx };
  if (base === "kill" || base === "skill") return { kind: "kill", cmdIdx };
  return { kind: "other", cmdIdx };
}

/** 提取 kill 命令参数中的数字 PID */
function extractKillPids(words: string[], startIdx: number): number[] {
  const pids: number[] = [];
  for (let i = startIdx + 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      if (w === "-s" || w === "--signal") i++; // 跳过信号值
      continue;
    }
    const pid = parseInt(w, 10);
    if (!isNaN(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * 解析 bash 命令中 kill 类操作的目标 PID 列表。
 * 按 shell 操作符分段，逐段识别命令类型。
 */
function extractKillTargets(command: string): { pids: number[]; hasPkill: boolean; hasKillall: boolean } {
  let pids: number[] = [];
  let hasPkill = false;
  let hasKillall = false;

  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const { kind, cmdIdx } = classifyCommand(words);
    if (kind === "pkill") hasPkill = true;
    else if (kind === "killall") hasKillall = true;
    else if (kind === "kill") pids = pids.concat(extractKillPids(words, cmdIdx));
  }

  return { pids, hasPkill, hasKillall };
}

/** 检查命令是否包含 otter 主进程相关关键词 */
function targetsOtterProcess(command: string, keywords: string[]): boolean {
  const lower = command.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

/**
 * 检查 bash 命令是否安全（不针对主进程的 kill 操作）。
 * @returns null 表示安全；字符串表示危险原因
 */
export function checkBashCommandSafety(
  command: string,
  mainPid: number | null,
  logger?: Logger,
): string | null {
  if (mainPid === null) return null;

  const { pids, hasPkill, hasKillall } = extractKillTargets(command);

  if (hasPkill && targetsOtterProcess(command, ["otter-buddy", "node.*main", "3000"])) {
    return "bash 命令包含 pkill，可能影响主进程。如需重启服务，请使用 otter-buddy.sh restart 或告知搭档。";
  }
  if (hasKillall && targetsOtterProcess(command, ["node", "otter"])) {
    return "bash 命令包含 killall，可能影响主进程。如需重启服务，请使用 otter-buddy.sh restart 或告知搭档。";
  }
  if (pids.length > 0 && pids.includes(mainPid)) {
    logger?.warn("[bash-safety-guard] Blocked kill command targeting main process", {
      mainPid, commandPids: pids, command: command.substring(0, 200),
    });
    return `bash 命令包含 kill ${mainPid}（主进程 PID）。主进程不可直接 kill——如需重启服务，请告知搭档使用 otter-buddy.sh restart。`;
  }

  return null;
}
