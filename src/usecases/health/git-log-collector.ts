/**
 * GitLogCollector: 从 git log 中采集 commit 信息（只读操作）
 * 
 * 使用 child_process 执行 git log，提取 commit SHA 和 message。
 * 不修改任何 git 数据，仅读取。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommit {
  sha: string;
  message: string;
}

/**
 * 从 git log 中采集 commit 信息
 * @param repoPath 仓库根目录路径
 * @param options 可选参数
 * @param options.since 起始日期（ISO 格式），默认不限制
 * @param options.until 结束日期（ISO 格式），默认不限制
 * @param options.maxCount 最大 commit 数，默认不限制
 * @returns commit 列表
 */
export async function collectGitLog(
  repoPath: string,
  options?: {
    since?: string;
    until?: string;
    maxCount?: number;
  }
): Promise<GitCommit[]> {
  const args = [
    "log",
    "--format=%H %s",  // SHA + 第一行 message
  ];

  if (options?.since) {
    args.push(`--since=${options.since}`);
  }
  if (options?.until) {
    args.push(`--until=${options.until}`);
  }
  if (options?.maxCount) {
    args.push(`--max-count=${options.maxCount}`);
  }

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,  // 10MB buffer
    });

    const commits: GitCommit[] = [];
    const lines = stdout.trim().split("\n").filter(line => line.length > 0);

    for (const line of lines) {
      const spaceIndex = line.indexOf(" ");
      if (spaceIndex === -1) continue;

      const sha = line.substring(0, spaceIndex);
      const message = line.substring(spaceIndex + 1);
      commits.push({ sha, message });
    }

    return commits;
  } catch (error) {
    throw new Error(`Failed to collect git log: ${error}`, { cause: error });
  }
}

/**
 * 获取 commit 的详细信息（包含修改的文件列表）
 * @param repoPath 仓库根目录路径
 * @param commitSha commit SHA
 * @returns commit 详情（包含修改的文件列表）
 */
export async function getCommitDetails(
  repoPath: string,
  commitSha: string
): Promise<{ sha: string; message: string; filesChanged: string[] }> {
  try {
    // 获取 commit message
    const { stdout: messageStdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%s", commitSha],
      { cwd: repoPath }
    );
    const message = messageStdout.trim();

    // 获取修改的文件列表
    const { stdout: filesStdout } = await execFileAsync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha],
      { cwd: repoPath }
    );
    const filesChanged = filesStdout.trim().split("\n").filter(f => f.length > 0);

    return {
      sha: commitSha,
      message,
      filesChanged,
    };
  } catch (error) {
    throw new Error(`Failed to get commit details for ${commitSha}: ${error}`, { cause: error });
  }
}
