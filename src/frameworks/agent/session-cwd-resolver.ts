/**
 * F20261013cwsp：海獭 cwd 统一切换对话工作区——
 * 按 conversationId 解析当前对话的工作区绝对路径，
 * 作为 createAgentSession({cwd}) 的唯一事实源。
 *
 * 设计意图（Why）：
 * - 海獭 bash cwd 恒为主仓根是主目录污染的系统级根因（9/22 事故链 + 10/13 污染事件）
 * - 统一 cwd = 对话工作区是搭档的第一性原理拍板（「读写要一致」）
 * - 无 conversationId 的场景（定时任务/系统级调用）落到 _system 兜底目录
 */

import path from "node:path";
import fs from "node:fs";

/**
 * 解析当前对话的工作区绝对路径。
 * @param conversationId 当前对话 ID（invoke 入口传入）
 * @param dataDir 主仓 data/ 目录的绝对路径（app.ts 注入，不再从 process.cwd() 派生）
 * @returns 工作区绝对路径（已确保目录存在）
 */
export function resolveSessionCwd(conversationId: string, dataDir: string): string {
  const workspaceDir = conversationId
    ? path.join(dataDir, "workspaces", conversationId)
    : path.join(dataDir, "workspaces", "_system");
  // Why: SDK bash.js:57 对不存在 cwd 抛错——构造前必须确保目录存在
  fs.mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}
