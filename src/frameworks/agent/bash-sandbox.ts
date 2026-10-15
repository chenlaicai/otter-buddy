/**
 * F20261015phys：bash 物理沙箱——sandbox-exec 包裹獭 bash 执行面。
 *
 * 设计要点：
 * - 守卫收敛（F20261015gsub）后绕过面由 OS 层硬边界兜底：主仓只读 + 进程信号隔离
 * - 注入点：pi-coding-agent SDK 的 createAllTools(cwd, { bash: { spawnHook } })，
 *   spawnHook 在每条 bash 命令执行前改写 command，裹上 sandbox-exec profile
 * - profile 路径必须 realpath 解析（实证坑：macOS /tmp 是 /private/tmp 符号链接，
 *   profile 写 /tmp 不拦，写 /private/tmp 才拦）
 * - 非 macOS 平台降级为 no-op（spawnHook 原样透传），语义等价于无沙箱
 * - 环境变量 OTTER_BASH_SANDBOX=off 显式禁用（调试/排障逃生口）
 *
 * 白名单边界（可写路径）：
 * - data/workspaces/  —— 獭会话工作区
 * - .otter/worktrees/ —— 獭开发 worktree
 * - ~/.otter/alpha/   —— alpha 隔离实例数据根
 * - $TMPDIR / /tmp    —— 临时文件
 * 其余主仓路径全部 deny file-write*（只读）。
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
 * 构建 sandbox-exec profile。
 *
 * @param repoRoot 主仓根目录（getRepoRoot()）
 * @param dataDir  主仓 data/ 目录绝对路径
 * @returns sandbox-exec profile 字符串
 */
export function buildSandboxProfile(repoRoot: string, dataDir: string): string {
  const repo = toRealPath(repoRoot);
  const workspaces = toRealPath(join(dataDir, "workspaces"));
  const worktrees = toRealPath(join(repo, ".otter", "worktrees"));
  const alphaRoot = toRealPath(join(homedir(), ".otter", "alpha"));
  const tmp = toRealPath(tmpdir());

  // profile 缓存 key：所有路径拼接——路径不变则 profile 不变
  const key = [repo, workspaces, worktrees, alphaRoot, tmp].join("|");
  if (cachedProfile && cachedProfileKey === key) return cachedProfile;

  // deny 优先级高于 allow：先 deny 主仓全集，再 allow 白名单子路径。
  // sandbox-exec 语义：后面的规则覆盖前面的——allow 在 deny 之后写才生效。
  const profile = [
    "(version 1)",
    "(allow default)",
    // 主仓只读——写拒读放
    `(deny file-write* (subpath "${repo}"))`,
    // 白名单：獭的合法写面
    `(allow file-write* (subpath "${workspaces}"))`,
    `(allow file-write* (subpath "${worktrees}"))`,
    `(allow file-write* (subpath "${alphaRoot}"))`,
    `(allow file-write* (subpath "${tmp}"))`,
    // 进程信号隔离——獭不能 kill 主进程（或任何其他进程）
    "(deny process*)",
  ].join("\n");

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
 * - 原命令通过 JSON.stringify 转义（双引号 + 内部转义），交给 /bin/bash -c 执行
 * - sandbox-exec 是 OS 层拦截，进程内无法逃逸——獭无法在 bash 内脱掉沙箱
 * - spawnHook 由 SDK 在每次 execute 时调用，獭无法跳过
 */
export function createSandboxSpawnHook(repoRoot: string, dataDir: string): BashSpawnHook {
  const profile = buildSandboxProfile(repoRoot, dataDir);
  return (ctx: BashSpawnContext): BashSpawnContext => ({
    ...ctx,
    command: `sandbox-exec -p ${JSON.stringify(profile)} /bin/bash -c ${JSON.stringify(ctx.command)}`,
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
