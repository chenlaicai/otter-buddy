/**
 * F20261015phys：bash 物理沙箱——sandbox-exec 包裹獭 bash 执行面。
 *
 * 设计要点：
 * - 守卫收敛（F20261015gsub）后绕过面由 OS 层硬边界兜底：主仓只读 + 进程信号隔离
 * - 注入点：pi-coding-agent SDK 的 baseToolsOverride + createBashTool({ spawnHook })，
 *   spawnHook 在每条 bash 命令执行前改写 command，裹上 sandbox-exec profile
 * - profile 路径必须 realpath 解析（实证坑：macOS /tmp 是 /private/tmp 符号链接，
 *   profile 写 /tmp 不拦，写 /private/tmp 才拦）
 * - profile 必须单行空格分隔（实证坑：多行 profile 经 JSON.stringify 后 \n 变字面两字符，
 *   SBPL 解析器报 unbound variable 崩溃）
 * - 命令必须转义 $ 和反引号（实证坑：JSON.stringify 不转义这两个字符，
 *   外层无沙箱 bash 会先做命令替换——沙箱被完全绕过）
 * - 进程隔离用 (deny signal) 不用 (deny process*)——后者连 sandbox-exec 自身
 *   exec 内层 bash 都拦（exit 71），deny signal 只拦信号发送不影响进程执行
 * - 非 macOS 平台降级为 no-op（spawnHook 原样透传），语义等价于无沙箱
 * - 环境变量 OTTER_BASH_SANDBOX=off 显式禁用（调试/排障逃生口）
 *
 * 白名单边界（可写路径）：
 * - data/workspaces/  —— 獭会话工作区
 * - .otter/worktrees/ —— 獭开发 worktree
 * - .git/             —— worktree 内 git 操作需要写 objects/worktrees/refs
 *                       （检视发现 4：worktree 的 .git 是文件指向主仓 .git/worktrees/<name>，
 *                        git hash-object -w / update-index 的落点在主仓 .git/ 下）
 * - ~/.otter/alpha/   —— alpha 隔离实例数据根
 * - $TMPDIR / /tmp    —— 临时文件
 * 其余主仓路径全部 deny file-write*（只读）。
 *
 * SBPL 规则优先级：顺序覆盖语义（后写胜出）——白名单 allow 写在 deny 之后才生效。
 * （检视发现 7 订正：「deny 优先级高于 allow」是错误心智模型，若真如此后写的 allow 不生效）
 */

import { realpathSync } from "node:fs";
import { tmpdir, platform, homedir } from "node:os";
import { join } from "node:path";
import type { BashSpawnContext, BashSpawnHook } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** sandbox-exec profile 缓存——同一进程内 profile 不变（路径在启动时确定） */
let cachedProfile: string | null = null;
let cachedProfileKey: string | null = null;

/**
 * 将路径解析为真实路径（符号链接展开）。
 * 解析失败（路径不存在）时原样返回——sandbox-exec 对不存在路径的 deny 仍然有效
 * （创建文件时 OS 会解析到真实路径再比对）。
 */
function toRealPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 转义命令字符串——防止外层无沙箱 bash 的命令替换逃逸。
 *
 * SDK 执行链：spawn(bash, ["-c", wrapped])——wrapped 会被外层 bash 再解析一遍。
 * JSON.stringify 只转义 " 和 \，不转义 $ 和 `——bash 双引号内 $() 与 ` 活跃，
 * 命令替换先于 sandbox-exec 启动、在无沙箱外层执行（检视发现 2 实测）。
 *
 * 修复：在 JSON.stringify 结果内追加 \$ 和 \` 转义——
 * 外层 bash 看到 \$ 产字面 $（不触发命令替换），内层沙箱 bash 同样看到 \$ 产字面 $。
 * 原命令的 $ 变量展开/命令替换在内层沙箱 bash 中失效——这是可接受的：
 * 沙箱内 $ 语义由 profile 控制，不需要外层展开。
 */
function escapeCommand(command: string): string {
  return JSON.stringify(command).replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

/**
 * 构建 sandbox-exec profile（单行空格分隔——多行经 JSON.stringify 后 \n 变字面两字符，
 * SBPL 解析器报 unbound variable: \n 崩溃，检视发现 1 实测）。
 *
 * @param repoRoot 主仓根目录（getRepoRoot()）
 * @param dataDir  主仓 data/ 目录绝对路径
 * @returns sandbox-exec profile 字符串（单行）
 */
export function buildSandboxProfile(repoRoot: string, dataDir: string): string {
  const repo = toRealPath(repoRoot);
  const workspaces = toRealPath(join(dataDir, "workspaces"));
  const worktrees = toRealPath(join(repo, ".otter", "worktrees"));
  const gitDir = toRealPath(join(repo, ".git"));
  const alphaRoot = toRealPath(join(homedir(), ".otter", "alpha"));
  const tmp = toRealPath(tmpdir());

  // profile 缓存 key：所有路径拼接——路径不变则 profile 不变
  const key = [repo, workspaces, worktrees, gitDir, alphaRoot, tmp].join("|");
  if (cachedProfile && cachedProfileKey === key) return cachedProfile;

  // SBPL 顺序覆盖语义（后写胜出）：先 deny 主仓全集，再 allow 白名单子路径。
  // 单行空格分隔——多行 profile 经 JSON.stringify 后 SBPL 解析崩溃（检视发现 1）。
  const profile = [
    "(version 1)",
    "(allow default)",
    // 主仓只读——写拒读放
    `(deny file-write* (subpath "${repo}"))`,
    // 白名单：獭的合法写面
    `(allow file-write* (subpath "${workspaces}"))`,
    `(allow file-write* (subpath "${worktrees}"))`,
    // worktree 内 git 操作需要写主仓 .git/（objects/worktrees/refs）——检视发现 4
    `(allow file-write* (subpath "${gitDir}"))`,
    `(allow file-write* (subpath "${alphaRoot}"))`,
    `(allow file-write* (subpath "${tmp}"))`,
    // 进程信号隔离——獭不能 kill 主进程（或任何其他进程）。
    // (deny signal) 而非 (deny process*)：后者连 sandbox-exec 自身 exec 内层 bash
    // 都拦（exit 71，检视发现 3 实测）；deny signal 只拦信号发送不影响进程执行。
    "(deny signal)",
  ].join(" ");

  cachedProfile = profile;
  cachedProfileKey = key;
  return profile;
}

/**
 * 判断当前环境是否启用 bash 沙箱。
 * - 非 macOS → 禁用（sandbox-exec 是 macOS 专属）
 * - OTTER_BASH_SANDBOX=off → 显式禁用
 */
export function isSandboxEnabled(): boolean {
  if (platform() !== "darwin") return false;
  if (process.env.OTTER_BASH_SANDBOX === "off") return false;
  return true;
}

/**
 * 构建 sandbox spawnHook——每条 bash 命令执行前改写 command，裹上 sandbox-exec。
 *
 * 包裹语义：`sandbox-exec -p '<profile>' /bin/bash -c '<原命令>'`
 * - profile 单行空格分隔（JSON.stringify 转义后 SBPL 可解析）
 * - 原命令通过 escapeCommand 转义（JSON.stringify + \$ + \`），防外层 bash 命令替换逃逸
 * - sandbox-exec 是 OS 层拦截，进程内无法逃逸——獭无法在 bash 内脱掉沙箱
 * - spawnHook 由 SDK 在每次 execute 时调用，獭无法跳过
 */
export function createSandboxSpawnHook(repoRoot: string, dataDir: string): BashSpawnHook {
  const profile = buildSandboxProfile(repoRoot, dataDir);
  return (ctx: BashSpawnContext): BashSpawnContext => ({
    ...ctx,
    command: `sandbox-exec -p ${JSON.stringify(profile)} /bin/bash -c ${escapeCommand(ctx.command)}`,
  });
}

/**
 * 创建沙箱包裹的完整工具集（read/write/edit/bash/grep/find/ls）。
 *
 * bash 工具用 spawnHook 裹 sandbox-exec；其他工具原样（它们不执行任意命令，
 * write/edit 的写面由守卫的 write-target-evaluator 覆盖，不在本沙箱范围）。
 *
 * 不用 SDK createAllTools（顶层未导出）——逐工具构建，语义等价。
 *
 * 已知取舍：baseToolsOverride 丢弃 SDK settings 透传（read 的 autoResizeImages、
 * bash 的 shellPath/commandPrefix）——当前项目未使用这些 settings（grep 无果），
 * 实际影响为零；若未来需要，从 settingsManager 透传（检视发现 6）。
 *
 * @param cwd 会话工作目录（对话工作区）
 * @param repoRoot 主仓根目录
 * @param dataDir 主仓 data/ 目录绝对路径
 * @returns 完整工具集（可直接传入 createAgentSession 的 baseToolsOverride）
 */
export function createSandboxedTools(cwd: string, repoRoot: string, dataDir: string): Record<string, AgentTool> {
  const base = {
    read: createReadTool(cwd),
    write: createWriteTool(cwd),
    edit: createEditTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };
  if (!isSandboxEnabled()) {
    // 非 macOS / 显式禁用——bash 无沙箱
    return { ...base, bash: createBashTool(cwd) };
  }
  const spawnHook = createSandboxSpawnHook(repoRoot, dataDir);
  return { ...base, bash: createBashTool(cwd, { spawnHook }) };
}
